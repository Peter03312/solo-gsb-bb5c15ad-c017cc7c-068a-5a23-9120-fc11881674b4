'use strict';

const path = require('path');
const express = require('express');
const { db, getBasisVersion, bumpBasisVersion } = require('./db');
const {
  verifyPackage,
  wouldCreateCycle,
  validateUsage,
} = require('./verify');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function httpError(status, code, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

function getMaterialOr404(id) {
  const m = db.prepare(`SELECT * FROM materials WHERE id = ?`).get(id);
  if (!m) throw httpError(404, 'material_not_found', `素材 #${id} 不存在`);
  return m;
}

function getPackageOr404(id) {
  const p = db.prepare(`SELECT * FROM packages WHERE id = ?`).get(id);
  if (!p) throw httpError(404, 'package_not_found', `展览包 #${id} 不存在`);
  return p;
}

function packageItemIds(packageId) {
  return db
    .prepare(`SELECT material_id FROM package_items WHERE package_id = ? ORDER BY material_id`)
    .all(packageId)
    .map((r) => r.material_id);
}

/** 同上，但允许传入事务 runner（发布/重发事务内使用） */
function itemIdsWith(tx, packageId) {
  return tx
    .prepare(`SELECT material_id FROM package_items WHERE package_id = ? ORDER BY material_id`)
    .all(packageId)
    .map((r) => r.material_id);
}

function setPackageItems(packageId, materialIds) {
  const uniq = [...new Set(materialIds)];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO package_items(package_id, material_id) VALUES (?, ?)`
  );
  for (const mid of uniq) {
    if (!db.prepare(`SELECT 1 FROM materials WHERE id = ?`).get(mid)) {
      throw httpError(400, 'material_not_found', `素材 #${mid} 不存在，不能加入展览包`);
    }
    ins.run(packageId, mid);
  }
}

/**
 * 依据最新现场数据重算全部已发布包的资格。
 * 仅把“不再合格”的 published 包降为 needs_review；needs_review 不会自动恢复。
 * 必须在写事务提交后调用（basis_version 已更新）。
 */
function recomputeEligibilityTx(tx) {
  const rows = tx.prepare(`SELECT id FROM packages WHERE status = 'published'`).all();
  const basis = getBasisVersion();
  const demoted = [];
  for (const { id } of rows) {
    const pkg = tx.prepare(`SELECT * FROM packages WHERE id = ?`).get(id);
    const result = verifyPackage(tx, pkg, itemIdsWith(tx, id), basis);
    if (!result.qualified) {
      tx.prepare(`UPDATE packages SET status = 'needs_review' WHERE id = ?`).run(id);
      demoted.push(id);
    }
  }
  return demoted;
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

app.get('/api/materials', (req, res) => {
  const materials = db.prepare(`SELECT * FROM materials ORDER BY id`).all();
  const authCount = db
    .prepare(`SELECT material_id, COUNT(*) AS n FROM authorizations GROUP BY material_id`)
    .all();
  const countMap = new Map(authCount.map((r) => [r.material_id, r.n]));
  res.json(materials.map((m) => ({ ...m, authorization_count: countMap.get(m.id) || 0 })));
});

app.post('/api/materials', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  const note = (req.body && req.body.note || '').trim();
  if (!name) throw httpError(400, 'name_required', '素材名称不能为空');

  const result = db.transaction(() => {
    const info = db.prepare(`INSERT INTO materials(name, note) VALUES (?, ?)`).run(name, note);
    bumpBasisVersion();
    return info.lastInsertRowid;
  })();
  recomputeEligibilityTx(db);

  res.status(201).json(getMaterialOr404(result));
});

app.patch('/api/materials/:id', (req, res) => {
  const material = getMaterialOr404(Number(req.params.id));
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : material.name;
  const note = req.body && typeof req.body.note === 'string' ? req.body.note.trim() : material.note;
  if (!name) throw httpError(400, 'name_required', '素材名称不能为空');
  // 备注/名称变更不影响核验依据（资格取决于关系与授权），不 bump basis
  db.prepare(`UPDATE materials SET name = ?, note = ? WHERE id = ?`).run(name, note, material.id);
  res.json(getMaterialOr404(material.id));
});

app.delete('/api/materials/:id', (req, res) => {
  const id = Number(req.params.id);
  getMaterialOr404(id);

  if (db.prepare(`SELECT 1 FROM source_relations WHERE parent_id = ? OR child_id = ?`).get(id, id)) {
    throw httpError(409, 'material_in_relations', `素材 #${id} 仍存在来源关系，请先删除相关关系`);
  }
  if (db.prepare(`SELECT 1 FROM package_items WHERE material_id = ?`).get(id)) {
    throw httpError(409, 'material_in_package', `素材 #${id} 已被展览包引用，请先从包中移除`);
  }

  db.transaction(() => {
    db.prepare(`DELETE FROM authorizations WHERE material_id = ?`).run(id);
    db.prepare(`DELETE FROM materials WHERE id = ?`).run(id);
    bumpBasisVersion();
  })();
  recomputeEligibilityTx(db);

  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 来源关系（不得成环）
// ---------------------------------------------------------------------------

app.get('/api/relations', (req, res) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.parent_id, r.child_id,
              p.name AS parent_name, c.name AS child_name, r.created_at
       FROM source_relations r
       JOIN materials p ON p.id = r.parent_id
       JOIN materials c ON c.id = r.child_id
       ORDER BY r.id`
    )
    .all();
  res.json(rows);
});

app.post('/api/relations', (req, res) => {
  const parentId = Number(req.body && req.body.parent_id);
  const childId = Number(req.body && req.body.child_id);
  if (!Number.isInteger(parentId) || !Number.isInteger(childId)) {
    throw httpError(400, 'bad_ids', 'parent_id 与 child_id 必须为整数');
  }
  getMaterialOr404(parentId);
  getMaterialOr404(childId);
  if (parentId === childId) {
    throw httpError(400, 'self_loop', '素材不能以自身为来源（自环）');
  }

  const exists = db
    .prepare(`SELECT 1 FROM source_relations WHERE parent_id = ? AND child_id = ?`)
    .get(parentId, childId);
  if (exists) throw httpError(409, 'relation_exists', '该来源关系已存在');

  if (wouldCreateCycle(db, parentId, childId)) {
    throw httpError(
      409,
      'cycle_detected',
      `添加 “#${parentId} -> #${childId}” 会导致来源关系成环，已拒绝`
    );
  }

  db.transaction(() => {
    db.prepare(`INSERT INTO source_relations(parent_id, child_id) VALUES (?, ?)`).run(
      parentId,
      childId
    );
    bumpBasisVersion();
  })();
  const demoted = recomputeEligibilityTx(db);

  res.status(201).json({
    id: db.prepare(`SELECT last_insert_rowid() AS id`).get().id,
    parent_id: parentId,
    child_id: childId,
    demoted_packages: demoted,
  });
});

app.delete('/api/relations/:id', (req, res) => {
  const id = Number(req.params.id);
  const rel = db.prepare(`SELECT * FROM source_relations WHERE id = ?`).get(id);
  if (!rel) throw httpError(404, 'relation_not_found', `来源关系 #${id} 不存在`);

  db.transaction(() => {
    db.prepare(`DELETE FROM source_relations WHERE id = ?`).run(id);
    bumpBasisVersion();
  })();
  // 删除边只会减少待核验节点，不会让已发布包失去资格；仍重算以保持一致
  recomputeEligibilityTx(db);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// 授权
// ---------------------------------------------------------------------------

function parseAuthBody(body, materialId) {
  const medium = (body && body.medium || '').trim();
  const region = (body && body.region || '').trim();
  const validFrom = (body && body.valid_from || '').trim();
  const validTo = (body && body.valid_to || '').trim();
  const licensor = (body && body.licensor || '').trim();
  const revoked = !!(body && body.revoked);

  if (!medium) throw httpError(400, 'medium_required', '授权媒介不能为空（可用 * 表示不限）');
  if (!region) throw httpError(400, 'region_required', '授权地区不能为空（可用 * 表示不限）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(validTo)) {
    throw httpError(400, 'date_invalid', '授权起止日期必须为 YYYY-MM-DD');
  }
  if (validFrom > validTo) {
    throw httpError(400, 'date_range_invalid', `授权起止日期倒置: ${validFrom} > ${validTo}`);
  }
  return { materialId, medium, region, validFrom, validTo, licensor, revoked };
}

app.get('/api/authorizations', (req, res) => {
  const materialId = req.query.material_id ? Number(req.query.material_id) : null;
  const rows = materialId
    ? db
        .prepare(
          `SELECT a.*, m.name AS material_name FROM authorizations a
           JOIN materials m ON m.id = a.material_id WHERE a.material_id = ? ORDER BY a.id`
        )
        .all(materialId)
    : db
        .prepare(
          `SELECT a.*, m.name AS material_name FROM authorizations a
           JOIN materials m ON m.id = a.material_id ORDER BY a.id`
        )
        .all();
  res.json(rows.map((a) => ({ ...a, revoked: !!a.revoked })));
});

app.post('/api/authorizations', (req, res) => {
  const materialId = Number(req.body && req.body.material_id);
  if (!Number.isInteger(materialId)) throw httpError(400, 'material_id_required', '缺少 material_id');
  getMaterialOr404(materialId);
  const a = parseAuthBody(req.body, materialId);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO authorizations(material_id, medium, region, valid_from, valid_to, revoked, licensor)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(a.materialId, a.medium, a.region, a.validFrom, a.validTo, a.revoked ? 1 : 0, a.licensor);
    bumpBasisVersion();
  })();
  const demoted = recomputeEligibilityTx(db);
  res.status(201).json({
    ...db.prepare(`SELECT * FROM authorizations WHERE id = last_insert_rowid()`).get(),
    revoked: a.revoked,
    demoted_packages: demoted,
  });
});

app.patch('/api/authorizations/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(id);
  if (!cur) throw httpError(404, 'authorization_not_found', `授权 #${id} 不存在`);

  const body = req.body || {};
  const next = {
    material_id: cur.material_id,
    medium: typeof body.medium === 'string' ? body.medium.trim() : cur.medium,
    region: typeof body.region === 'string' ? body.region.trim() : cur.region,
    valid_from: typeof body.valid_from === 'string' ? body.valid_from.trim() : cur.valid_from,
    valid_to: typeof body.valid_to === 'string' ? body.valid_to.trim() : cur.valid_to,
    licensor: typeof body.licensor === 'string' ? body.licensor.trim() : cur.licensor,
    revoked: typeof body.revoked === 'boolean' ? body.revoked : !!cur.revoked,
  };
  if (!next.medium) throw httpError(400, 'medium_required', '授权媒介不能为空');
  if (!next.region) throw httpError(400, 'region_required', '授权地区不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next.valid_from) || !/^\d{4}-\d{2}-\d{2}$/.test(next.valid_to)) {
    throw httpError(400, 'date_invalid', '授权起止日期必须为 YYYY-MM-DD');
  }
  if (next.valid_from > next.valid_to) {
    throw httpError(400, 'date_range_invalid', '授权起止日期倒置');
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE authorizations SET medium=?, region=?, valid_from=?, valid_to=?, revoked=?, licensor=?
       WHERE id=?`
    ).run(
      next.medium,
      next.region,
      next.valid_from,
      next.valid_to,
      next.revoked ? 1 : 0,
      next.licensor,
      id
    );
    bumpBasisVersion();
  })();
  const demoted = recomputeEligibilityTx(db);

  const row = db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(id);
  res.json({ ...row, revoked: !!row.revoked, demoted_packages: demoted });
});

app.delete('/api/authorizations/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(id);
  if (!cur) throw httpError(404, 'authorization_not_found', `授权 #${id} 不存在`);

  db.transaction(() => {
    db.prepare(`DELETE FROM authorizations WHERE id = ?`).run(id);
    bumpBasisVersion();
  })();
  const demoted = recomputeEligibilityTx(db);
  res.status(200).json({ ok: true, demoted_packages: demoted });
});

// ---------------------------------------------------------------------------
// 展览包
// ---------------------------------------------------------------------------

function parsePkgBody(body, cur) {
  const b = body || {};
  const out = {
    title: typeof b.title === 'string' ? b.title.trim() : cur.title,
    medium: typeof b.medium === 'string' ? b.medium.trim() : cur.medium,
    region: typeof b.region === 'string' ? b.region.trim() : cur.region,
    start_date: typeof b.start_date === 'string' ? b.start_date.trim() : cur.start_date,
    end_date: typeof b.end_date === 'string' ? b.end_date.trim() : cur.end_date,
  };
  if (!out.title) throw httpError(400, 'title_required', '展览包标题不能为空');
  return out;
}

function packageSnapshotView(row) {
  const itemIds = packageItemIds(row.id);
  const latestSnapshot = db
    .prepare(`SELECT id, basis_version, package_revision, created_at FROM snapshots WHERE package_id = ? ORDER BY id DESC LIMIT 1`)
    .get(row.id);
  const snapshotCount = db
    .prepare(`SELECT COUNT(*) AS n FROM snapshots WHERE package_id = ?`)
    .get(row.id).n;
  return {
    ...row,
    revoked: undefined,
    item_material_ids: itemIds,
    items_count: itemIds.length,
    latest_snapshot: latestSnapshot || null,
    snapshot_count: snapshotCount,
  };
}

app.get('/api/packages', (req, res) => {
  const rows = db.prepare(`SELECT * FROM packages ORDER BY id DESC`).all();
  res.json(rows.map(packageSnapshotView));
});

app.post('/api/packages', (req, res) => {
  const body = req.body || {};
  const title = (body.title || '').trim();
  if (!title) throw httpError(400, 'title_required', '展览包标题不能为空');
  const medium = (body.medium || '').trim();
  const region = (body.region || '').trim();
  const startDate = (body.start_date || '').trim();
  const endDate = (body.end_date || '').trim();
  const materialIds = Array.isArray(body.material_ids) ? body.material_ids.map(Number) : [];
  for (const mid of materialIds) {
    if (!db.prepare(`SELECT 1 FROM materials WHERE id = ?`).get(mid)) {
      throw httpError(400, 'material_not_found', `素材 #${mid} 不存在`);
    }
  }

  const info = db
    .prepare(
      `INSERT INTO packages(title, medium, region, start_date, end_date, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`
    )
    .run(title, medium, region, startDate, endDate);
  const id = info.lastInsertRowid;
  setPackageItems(id, materialIds);

  res.status(201).json(packageSnapshotView(getPackageOr404(id)));
});

app.get('/api/packages/:id', (req, res) => {
  const row = getPackageOr404(Number(req.params.id));
  const view = packageSnapshotView(row);
  const result = verifyPackage(db, row, view.item_material_ids, getBasisVersion());
  res.json({ ...view, live_verification: result });
});

app.patch('/api/packages/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getPackageOr404(id);
  if (row.status === 'published') {
    throw httpError(409, 'package_locked', '已发布包不可直接编辑；其已冻结为不可变快照');
  }
  const next = parsePkgBody(req.body, row);
  let materialIds = null;
  if (Array.isArray(req.body.material_ids)) {
    materialIds = [...new Set(req.body.material_ids.map(Number))];
    for (const mid of materialIds) {
      if (!db.prepare(`SELECT 1 FROM materials WHERE id = ?`).get(mid)) {
        throw httpError(400, 'material_not_found', `素材 #${mid} 不存在`);
      }
    }
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE packages SET title=?, medium=?, region=?, start_date=?, end_date=?, revision=revision+1 WHERE id=?`
    ).run(next.title, next.medium, next.region, next.start_date, next.end_date, id);
    if (materialIds) {
      db.prepare(`DELETE FROM package_items WHERE package_id = ?`).run(id);
      setPackageItems(id, materialIds);
    }
  })();

  // needs_review 包编辑后回到 draft，等待重新核验/发布
  if (row.status === 'needs_review') {
    db.prepare(`UPDATE packages SET status = 'draft' WHERE id = ?`).run(id);
  }

  res.json(packageSnapshotView(getPackageOr404(id)));
});

app.delete('/api/packages/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = getPackageOr404(id);
  if (row.status !== 'draft') {
    throw httpError(409, 'package_not_deletable', '仅草稿状态的展览包可删除（发布记录须保留）');
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM package_items WHERE package_id = ?`).run(id);
    db.prepare(`DELETE FROM packages WHERE id = ?`).run(id);
  })();
  res.status(204).end();
});

/** 实时核验（不发布、不修改任何状态），供待发布包反复试算 */
app.post('/api/packages/:id/verify', (req, res) => {
  const id = Number(req.params.id);
  const row = getPackageOr404(id);
  const itemIds = packageItemIds(id);
  const result = verifyPackage(db, row, itemIds, getBasisVersion());
  res.json(result);
});

/**
 * 发布：
 * 1) 原子事务内重新读取包/依据版本并重新核验（防并发编辑导致依据过期）；
 * 2) 不合格（缺授权/媒介地区日期问题）一律拒绝；
 * 3) 合格则追加不可变快照，并置为 published。
 */
app.post('/api/packages/:id/publish', (req, res) => {
  const id = Number(req.params.id);
  const expectedBasis =
    req.body && Number.isInteger(Number(req.body.basis_version))
      ? Number(req.body.basis_version)
      : null;
  const expectedRevision =
    req.body && Number.isInteger(Number(req.body.revision))
      ? Number(req.body.revision)
      : null;

  let snapshotId = null;
  let finalResult = null;

  try {
    const outcome = db.transaction(() => {
      const row = db.prepare(`SELECT * FROM packages WHERE id = ?`).get(id);
      if (!row) throw httpError(404, 'package_not_found', `展览包 #${id} 不存在`);
      if (row.status === 'published') {
        throw httpError(409, 'already_published', '展览包已是发布状态');
      }

      // 乐观并发：前端试算依据必须与事务内现场一致
      const liveBasis = getBasisVersion();
      if (expectedBasis !== null && expectedBasis !== liveBasis) {
        throw httpError(
          409,
          'basis_stale',
          `核验依据已过期（试算版本 ${expectedBasis}，当前版本 ${liveBasis}），请重新核验后重试`,
          { expected_basis_version: expectedBasis, live_basis_version: liveBasis }
        );
      }
      if (expectedRevision !== null && expectedRevision !== row.revision) {
        throw httpError(
          409,
          'package_revised',
          '展览包在核验后被修改过，请重新核验后重试',
          { expected_revision: expectedRevision, live_revision: row.revision }
        );
      }

      const itemIds = itemIdsWith(db, id);
      const result = verifyPackage(db, row, itemIds, liveBasis);
      if (!result.qualified) {
        throw httpError(422, 'verification_failed', '核验未通过，禁止发布', {
          verification: result,
        });
      }

      const itemsManifest = result.items.map((it) => ({
        selected_material_id: it.material_id,
        selected_name: it.name,
        nodes: it.nodes.map((n) => ({
          material_id: n.material_id,
          name: n.name,
          depth: n.depth,
          is_root: n.is_root,
          paths: n.paths,
          covering_authorization_ids: n.authorizations.filter((a) => a.covers).map((a) => a.id),
        })),
      }));

      const info = db
        .prepare(
          `INSERT INTO snapshots(package_id, package_revision, basis_version, verification_json, items_json)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          id,
          row.revision,
          liveBasis,
          JSON.stringify(result),
          JSON.stringify(itemsManifest)
        );

      db.prepare(
        `UPDATE packages SET status='published', published_at=datetime('now') WHERE id=?`
      ).run(id);

      return { snapshotId: info.lastInsertRowid, result };
    })();
    snapshotId = outcome.snapshotId;
    finalResult = outcome.result;
  } catch (err) {
    throw err;
  }

  res.status(201).json({
    ok: true,
    snapshot_id: snapshotId,
    package: packageSnapshotView(getPackageOr404(id)),
    verification: finalResult,
  });
});

/** 对 needs_review 包执行复核：返回当前核验结果（不改状态、不改快照） */
app.post('/api/packages/:id/recheck', (req, res) => {
  const id = Number(req.params.id);
  const row = getPackageOr404(id);
  const result = verifyPackage(db, row, packageItemIds(id), getBasisVersion());

  const snapshots = db
    .prepare(
      `SELECT id, basis_version, package_revision, created_at FROM snapshots
       WHERE package_id = ? ORDER BY id DESC`
    )
    .all(id);

  res.json({
    package_id: id,
    status: row.status,
    current_basis_version: getBasisVersion(),
    live_verification: result,
    original_snapshots_preserved: snapshots,
  });
});

/**
 * 复核通过 / 重新发布：needs_review 包当前重新合格时，追加一份新快照并恢复 published。
 * 原快照始终保留。
 */
app.post('/api/packages/:id/republish', (req, res) => {
  const id = Number(req.params.id);
  const expectedBasis =
    req.body && Number.isInteger(Number(req.body.basis_version))
      ? Number(req.body.basis_version)
      : null;

  const outcome = db.transaction(() => {
    const row = db.prepare(`SELECT * FROM packages WHERE id = ?`).get(id);
    if (!row) throw httpError(404, 'package_not_found', `展览包 #${id} 不存在`);
    if (row.status !== 'needs_review') {
      throw httpError(409, 'not_needs_review', '仅“需复核”状态的包可以复核重发');
    }
    const liveBasis = getBasisVersion();
    if (expectedBasis !== null && expectedBasis !== liveBasis) {
      throw httpError(
        409,
        'basis_stale',
        `核验依据已过期（试算版本 ${expectedBasis}，当前版本 ${liveBasis}），请重新核验后重试`,
        { expected_basis_version: expectedBasis, live_basis_version: liveBasis }
      );
    }

    const itemIds = itemIdsWith(db, id);
    const result = verifyPackage(db, row, itemIds, liveBasis);
    if (!result.qualified) {
      throw httpError(422, 'verification_failed', '当前仍不合格，无法恢复发布', {
        verification: result,
      });
    }

    const itemsManifest = result.items.map((it) => ({
      selected_material_id: it.material_id,
      selected_name: it.name,
      nodes: it.nodes.map((n) => ({
        material_id: n.material_id,
        name: n.name,
        depth: n.depth,
        is_root: n.is_root,
        paths: n.paths,
        covering_authorization_ids: n.authorizations.filter((a) => a.covers).map((a) => a.id),
      })),
    }));

    const info = db
      .prepare(
        `INSERT INTO snapshots(package_id, package_revision, basis_version, verification_json, items_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, row.revision, liveBasis, JSON.stringify(result), JSON.stringify(itemsManifest));
    db.prepare(
      `UPDATE packages SET status='published', published_at=datetime('now') WHERE id=?`
    ).run(id);

    return { snapshotId: info.lastInsertRowid, result };
  })();

  res.status(201).json({
    ok: true,
    snapshot_id: outcome.snapshotId,
    package: packageSnapshotView(getPackageOr404(id)),
    verification: outcome.result,
  });
});

/** 读取某包全部快照（不可变历史） */
app.get('/api/packages/:id/snapshots', (req, res) => {
  const id = Number(req.params.id);
  getPackageOr404(id);
  const rows = db
    .prepare(`SELECT * FROM snapshots WHERE package_id = ? ORDER BY id DESC`)
    .all(id)
    .map((s) => ({
      ...s,
      verification: JSON.parse(s.verification_json),
      items: JSON.parse(s.items_json),
      verification_json: undefined,
      items_json: undefined,
    }));
  res.json(rows);
});

/** 读取单份快照 */
app.get('/api/snapshots/:id', (req, res) => {
  const id = Number(req.params.id);
  const s = db.prepare(`SELECT * FROM snapshots WHERE id = ?`).get(id);
  if (!s) throw httpError(404, 'snapshot_not_found', `快照 #${id} 不存在`);
  res.json({
    ...s,
    verification: JSON.parse(s.verification_json),
    items: JSON.parse(s.items_json),
  });
});

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

app.get('/api/meta', (req, res) => {
  res.json({ basis_version: getBasisVersion() });
});

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

// 404 兜底（API）
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not_found', message: `未知接口: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const body = { error: err.code || 'internal_error', message: err.message || '服务器内部错误' };
  for (const k of ['verification', 'expected_basis_version', 'live_basis_version',
    'expected_revision', 'live_revision']) {
    if (err[k] !== undefined) body[k] = err[k];
  }
  if (status >= 500) console.error(err);
  res.status(status).json(body);
});

app.listen(PORT, () => {
  console.log(`数字展品授权核验系统已启动: http://localhost:${PORT}`);
});

module.exports = app;
