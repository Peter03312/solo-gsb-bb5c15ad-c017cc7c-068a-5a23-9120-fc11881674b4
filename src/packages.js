'use strict';
// 展览包：发布（原子 + 不可变快照）、授权/素材变更后的资格重算
const { getDb, getBasisVersion } = require('./db');
const { verify, pathToNames, loadMaterials } = require('./verify');

const STATUS = { DRAFT: 'draft', PUBLISHED: 'published', NEEDS_REVIEW: 'needs_review' };

function snapshotListForPackage(pkgId) {
  return getDb().prepare(`
    SELECT id, created_at, basis_version, medium, region, start_date, end_date, qualified
    FROM verification_snapshot WHERE package_id = ? ORDER BY id DESC`).all(pkgId);
}

function getPackage(pkgId) {
  const pkg = getDb().prepare(`SELECT * FROM exhibition_package WHERE id = ?`).get(pkgId);
  if (!pkg) return null;
  pkg.items = getDb().prepare(`
    SELECT m.id, m.name, m.kind FROM package_material pm
    JOIN material m ON m.id = pm.material_id
    WHERE pm.package_id = ? ORDER BY m.id`).all(pkgId);
  pkg.snapshots = snapshotListForPackage(pkgId);
  return pkg;
}

function listPackages() {
  const rows = getDb().prepare(`
    SELECT * FROM exhibition_package ORDER BY id DESC`).all();
  const itemStmt = getDb().prepare(`SELECT material_id FROM package_material WHERE package_id = ?`);
  const snapStmt = getDb().prepare(`
    SELECT id, created_at, qualified FROM verification_snapshot
    WHERE package_id = ? ORDER BY id DESC LIMIT 1`);
  for (const p of rows) {
    p.material_ids = itemStmt.all(p.id).map(r => r.material_id);
    const s = snapStmt.get(p.id);
    p.latest_snapshot = s || null;
  }
  return rows;
}

// 授权/素材/来源变更后：沿全部来源链重新计算每个已发布包的资格。
// 自动重算只做“降级”：已发布且不再合格 → needs_review（原快照保留不动）。
// needs_review 的包即使资格恢复也不自动翻回已发布——须人工重新核验后再次发布。
// 仍然合格的已发布包状态不变（旧快照继续作为发布凭证）。
// 必须在触发变更的同一事务内调用。
function recomputePublished() {
  const d = getDb();
  const pkgs = d.prepare(`SELECT id, medium, region, start_date, end_date FROM exhibition_package
                          WHERE status = 'published'`).all();
  const itemStmt = d.prepare(`SELECT material_id FROM package_material WHERE package_id = ?`);
  const markStmt = d.prepare(`UPDATE exhibition_package SET status = 'needs_review', updated_at = datetime('now') WHERE id = ?`);
  const changed = [];
  for (const p of pkgs) {
    const ids = itemStmt.all(p.id).map(r => r.material_id);
    const res = verify({ materialIds: ids, medium: p.medium, region: p.region,
                         start_date: p.start_date, end_date: p.end_date });
    // 使用参数与素材清单在发布时已固定，正常不会参数错误；防御性处理为降级并提示复核
    if (!res.valid || !res.qualified) {
      markStmt.run(p.id);
      changed.push({ id: p.id, status: STATUS.NEEDS_REVIEW });
    }
  }
  return changed;
}

// 发布（或复核后重新发布）。返回 {ok:true,snapshotId} 或 {ok:false,status,errors/result}
function publishPackage(pkgId, expectedBasisVersion) {
  const d = getDb();
  return d.transaction(() => {
    const pkg = d.prepare(`SELECT * FROM exhibition_package WHERE id = ?`).get(pkgId);
    if (!pkg) return { ok: false, status: 404, errors: ['展览包不存在'] };

    const ids = d.prepare(`SELECT material_id FROM package_material WHERE package_id = ?`)
      .all(pkgId).map(r => r.material_id);

    // 1) 当前依据版本
    const currentVersion = getBasisVersion();
    if (expectedBasisVersion == null) {
      return { ok: false, status: 400, errors: ['缺少核验依据版本，请先执行核验'] };
    }
    // 2) 同时编辑导致核验依据过期 → 拒绝发布并提示重试
    if (Number(expectedBasisVersion) !== currentVersion) {
      return { ok: false, status: 409, stale: true, currentVersion,
               errors: ['核验依据已过期（期间素材、来源关系或授权有变更），请重新核验后再发布'] };
    }

    // 已发布且合格的包无需重复发布；仅草稿 / 需复核包可发布
    if (pkg.status === STATUS.PUBLISHED) {
      return { ok: false, status: 409,
               errors: ['该包已处于已发布状态；仅草稿或需复核的包可以发布'] };
    }

    // 3) 使用参数完整性
    const paramErrors = [];
    if (!pkg.medium || !pkg.region) paramErrors.push('请先填写展示媒介与地区');
    if (!pkg.start_date || !pkg.end_date) paramErrors.push('请先填写起止日期');
    if (paramErrors.length) return { ok: false, status: 400, errors: paramErrors };

    // 4) 重新计算资格（缺授权/日期非法/成环 → 不得发布）
    const result = verify({
      materialIds: ids, medium: pkg.medium, region: pkg.region,
      start_date: pkg.start_date, end_date: pkg.end_date
    });
    if (!result.valid) return { ok: false, status: 400, errors: result.errors };
    if (!result.qualified) {
      return { ok: false, status: 422, result,
               errors: ['存在不合格节点，不能发布'] };
    }

    // 二次确认版本（核验计算期间也可能有写入）
    if (getBasisVersion() !== currentVersion) {
      return { ok: false, status: 409, stale: true, currentVersion: getBasisVersion(),
               errors: ['核验依据已过期，请重新核验后再发布'] };
    }

    // 5) 原子写入：不可变快照（含节点判定、来源路径、素材清单）+ 包状态
    const mats = new Map(loadMaterials().map(m => [m.id, m]));
    const payload = {
      package_id: pkgId,
      package_name: pkg.name,
      basis_version: currentVersion,
      use_scope: { medium: result.medium, region: result.region,
                   start_date: result.start_date, end_date: result.end_date },
      qualified: true,
      materials: result.packageMaterials,
      nodes: result.reachableNodeIds.map(nid => {
        const nr = result.nodeResults[nid];
        return {
          material_id: nid, name: nr.name, kind: nr.kind, qualified: nr.qualified,
          paths: nr.paths.map(p => pathToNames(p, mats))
        };
      }),
      verified_at: new Date().toISOString()
    };
    const ins = d.prepare(`INSERT INTO verification_snapshot
      (package_id, basis_version, medium, region, start_date, end_date, qualified, payload)
      VALUES (?,?,?,?,?,?,1,?)`);
    const snap = ins.run(pkgId, currentVersion, result.medium, result.region,
      result.start_date, result.end_date, JSON.stringify(payload));
    d.prepare(`UPDATE exhibition_package SET status = 'published', updated_at = datetime('now') WHERE id = ?`)
      .run(pkgId);
    return { ok: true, snapshotId: snap.lastInsertRowid, basisVersion: currentVersion };
  })();
}

module.exports = { STATUS, getPackage, listPackages, recomputePublished, publishPackage };
