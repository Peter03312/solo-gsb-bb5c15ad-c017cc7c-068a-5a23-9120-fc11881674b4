'use strict';

// 核验核心：沿全部来源链展开节点，逐节点判定授权是否覆盖整段使用。
// 来源关系语义：parent（上游/被引用素材） -> child（引用方素材）
// 一个素材入选展览包时，其全部上游节点（parent 的递归闭包）都必须有授权。

const MAX_PATHS_PER_ROOT = 500; // 单个入选素材枚举路径上限（小型展馆场景保护）

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 严格校验 YYYY-MM-DD，且必须是真实日历日期 */
function isValidDate(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** 媒介/地区匹配：完全相等，或任一方为 '*' 通配 */
function fieldMatches(required, granted) {
  return granted === '*' || required === '*' || granted === required;
}

/**
 * 评估单条授权对某个使用需求的覆盖情况。
 * 返回 { covers, reasons }，reasons 为不满足的原因标签列表。
 */
function evaluateAuthorization(auth, usage) {
  const reasons = [];
  if (auth.revoked) reasons.push('revoked');
  if (!fieldMatches(usage.medium, auth.medium)) reasons.push('medium_mismatch');
  if (!fieldMatches(usage.region, auth.region)) reasons.push('region_mismatch');
  if (auth.valid_from > usage.start_date) reasons.push('starts_too_late');
  if (auth.valid_to < usage.end_date) reasons.push('ends_too_early');
  return { covers: reasons.length === 0, reasons };
}

/** 校验使用参数本身（媒介、地区、日期） */
function validateUsage(usage) {
  const errors = [];
  if (!usage || typeof usage.medium !== 'string' || !usage.medium.trim()) {
    errors.push({ code: 'medium_missing', message: '展示媒介不能为空' });
  }
  if (!usage || typeof usage.region !== 'string' || !usage.region.trim()) {
    errors.push({ code: 'region_missing', message: '展示地区不能为空' });
  }
  if (!isValidDate(usage && usage.start_date)) {
    errors.push({ code: 'start_date_invalid', message: `起始日期不合法: ${usage && usage.start_date}` });
  }
  if (!isValidDate(usage && usage.end_date)) {
    errors.push({ code: 'end_date_invalid', message: `结束日期不合法: ${usage && usage.end_date}` });
  }
  if (
    isValidDate(usage && usage.start_date) &&
    isValidDate(usage && usage.end_date) &&
    usage.start_date > usage.end_date
  ) {
    errors.push({
      code: 'date_range_invalid',
      message: `起止日期倒置: ${usage.start_date} > ${usage.end_date}`,
    });
  }
  return errors;
}

/** 载入核验所需全部现场数据 */
function loadContext(db) {
  const materials = db.prepare(`SELECT id, name, note FROM materials ORDER BY id`).all();
  const materialMap = new Map(materials.map((m) => [m.id, m]));
  const edges = db.prepare(`SELECT parent_id, child_id FROM source_relations`).all();
  const auths = db
    .prepare(
      `SELECT id, material_id, medium, region, valid_from, valid_to, revoked, licensor
       FROM authorizations`
    )
    .all()
    .map((a) => ({ ...a, revoked: !!a.revoked }));

  // parentsOf[childId] = [parentId, ...]
  const parentsOf = new Map();
  for (const m of materials) parentsOf.set(m.id, []);
  for (const e of edges) {
    if (!parentsOf.has(e.child_id)) parentsOf.set(e.child_id, []);
    parentsOf.get(e.child_id).push(e.parent_id);
  }
  const authsOf = new Map();
  for (const a of auths) {
    if (!authsOf.has(a.material_id)) authsOf.set(a.material_id, []);
    authsOf.get(a.material_id).push(a);
  }
  return { materials, materialMap, parentsOf, authsOf };
}

/**
 * 沿全部来源链（向上游方向）枚举路径。
 * 对每个出现的节点收集若干条从 root 到该节点的简单路径。
 * 路径以从入选素材（root）开始、到上游节点结束的 id 序列表示。
 * 返回 Map<nodeId, number[][]>
 */
function traverseUp(rootId, parentsOf) {
  const pathsByNode = new Map();
  pathsByNode.set(rootId, [[rootId]]);

  let total = 0;
  const stack = [{ nodeId: rootId, path: [rootId] }];

  while (stack.length) {
    const { nodeId, path } = stack.pop();
    const onPath = new Set(path);
    const parents = parentsOf.get(nodeId) || [];
    for (const pid of parents) {
      if (onPath.has(pid)) continue; // 理论上不应出现（写库时已拦截成环），防御性跳过
      const newPath = path.concat(pid);
      if (!pathsByNode.has(pid)) pathsByNode.set(pid, []);
      const list = pathsByNode.get(pid);
      // 去重（不同分支可能产生相同序列）
      const sig = newPath.join(',');
      if (!list.some((p) => p.join(',') === sig)) {
        list.push(newPath);
        total += 1;
      }
      if (total < MAX_PATHS_PER_ROOT) {
        stack.push({ nodeId: pid, path: newPath });
      }
    }
  }
  return pathsByNode;
}

function summarizeAuths(auths, usage) {
  return (auths || []).map((a) => ({
    id: a.id,
    medium: a.medium,
    region: a.region,
    valid_from: a.valid_from,
    valid_to: a.valid_to,
    revoked: a.revoked,
    licensor: a.licensor,
    ...evaluateAuthorization(a, usage),
  }));
}

/**
 * 对展览包执行完整核验（基于调用时的实时数据库内容）。
 * pkg: { id?, title, medium, region, start_date, end_date }
 * itemMaterialIds: 直接入选素材 id 列表
 * 返回结构可直接序列化为不可变快照。
 */
function verifyPackage(db, pkg, itemMaterialIds, basisVersion) {
  const usage = {
    medium: (pkg.medium || '').trim(),
    region: (pkg.region || '').trim(),
    start_date: pkg.start_date,
    end_date: pkg.end_date,
  };

  const usageErrors = validateUsage(usage);
  const packageErrors = [];
  if (itemMaterialIds.length === 0) {
    packageErrors.push({ code: 'no_materials', message: '展览包未选择任何素材' });
  }
  const items = [];
  const violatingNodes = new Map(); // nodeId -> node 结论（跨入选素材汇总）

  const ctx = loadContext(db);

  for (const rootId of itemMaterialIds) {
    const root = ctx.materialMap.get(rootId);
    const itemResult = {
      material_id: rootId,
      name: root ? root.name : `#${rootId}（已删除）`,
      missing: !root,
      nodes: [],
      paths_truncated: false,
      violating_nodes: [],
    };

    if (!root) {
      itemResult.violating_nodes.push(rootId);
      const key = rootId;
      if (!violatingNodes.has(key)) {
        violatingNodes.set(key, {
          material_id: rootId,
          name: itemResult.name,
          reasons: ['material_missing'],
          paths: [],
          authorizations: [],
        });
      }
      items.push(itemResult);
      continue;
    }

    const pathsByNode = traverseUp(rootId, ctx.parentsOf);
    itemResult.paths_truncated = false;

    for (const [nodeId, paths] of pathsByNode) {
      const material = ctx.materialMap.get(nodeId);
      const auths = ctx.authsOf.get(nodeId) || [];
      const authEval = summarizeAuths(auths, usage);
      const covering = authEval.filter((a) => a.covers);
      const reasons = [];
      if (!material) reasons.push('material_missing');
      if (auths.length === 0) reasons.push('no_authorization');
      else if (covering.length === 0) {
        const allRevoked = auths.every((a) => a.revoked);
        if (allRevoked) reasons.push('all_revoked');
        reasons.push('no_covering_authorization');
      }
      const ok = reasons.length === 0;

      const pathObjs = paths.map((ids) => ({
        material_ids: ids,
        names: ids.map((id) => (ctx.materialMap.get(id) || { name: `#${id}（已删除）` }).name),
      }));

      const nodeResult = {
        material_id: nodeId,
        name: material ? material.name : `#${nodeId}（已删除）`,
        depth: Math.max(...paths.map((p) => p.length - 1)),
        is_root: nodeId === rootId,
        ok,
        reasons,
        paths: pathObjs,
        authorizations: authEval,
      };
      itemResult.nodes.push(nodeResult);

      if (!ok) {
        itemResult.violating_nodes.push(nodeId);
        if (!violatingNodes.has(nodeId)) {
          violatingNodes.set(nodeId, {
            material_id: nodeId,
            name: nodeResult.name,
            reasons,
            paths: pathObjs,
            authorizations: authEval,
          });
        } else {
          // 合并来自不同入选素材的路径
          const agg = violatingNodes.get(nodeId);
          const existing = new Set(agg.paths.map((p) => p.material_ids.join(',')));
          for (const p of pathObjs) {
            const sig = p.material_ids.join(',');
            if (!existing.has(sig)) {
              agg.paths.push(p);
              existing.add(sig);
            }
          }
        }
      }
    }

    itemResult.nodes.sort((a, b) => a.depth - b.depth || a.material_id - b.material_id);
    items.push(itemResult);
  }

  const violations = [...violatingNodes.values()].sort(
    (a, b) => a.material_id - b.material_id
  );

  const result = {
    basis_version: basisVersion,
    generated_at: new Date().toISOString(),
    usage,
    usage_errors: usageErrors,
    package_errors: packageErrors,
    qualified: usageErrors.length === 0 && packageErrors.length === 0 && violations.length === 0,
    items,
    violations,
    summary: {
      selected_count: itemMaterialIds.length,
      node_count: new Set(items.flatMap((it) => it.nodes.map((n) => n.material_id))).size,
      violating_node_count: violations.length,
    },
  };
  return result;
}

/**
 * 新增来源关系前的成环检查：
 * 加入 parent -> child（parent 成为 child 的上游）会成环，
 * 当且仅当 child 已经是 parent 的上游（从 parent 向上游可到达 child）。
 */
function wouldCreateCycle(db, parentId, childId) {
  if (parentId === childId) return true;
  const row = db
    .prepare(
      `
    WITH RECURSIVE up(x) AS (
      SELECT ?
      UNION
      SELECT r.parent_id FROM source_relations r JOIN up ON r.child_id = up.x
    )
    SELECT 1 FROM up WHERE x = ? LIMIT 1`
    )
    .get(parentId, childId);
  return !!row;
}

module.exports = {
  isValidDate,
  validateUsage,
  evaluateAuthorization,
  verifyPackage,
  wouldCreateCycle,
  loadContext,
  traverseUp,
};
