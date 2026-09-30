'use strict';
// 授权核验核心逻辑：
// 沿展览包内每件素材的全部来源链（source_edge 的传递闭包）检查每个节点，
// 每个节点须至少有一份“未撤销 + 媒介/地区匹配 + 覆盖整段使用期”的授权。
const { getDb } = require('./db');

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkParams(input) {
  const errors = [];
  const medium = (input.medium || '').trim();
  const region = (input.region || '').trim();
  if (!medium) errors.push('展示媒介不能为空');
  if (!region) errors.push('地区不能为空');
  if (!isValidDate(input.start_date)) errors.push('开始日期不合法（应为 YYYY-MM-DD）');
  if (!isValidDate(input.end_date)) errors.push('结束日期不合法（应为 YYYY-MM-DD）');
  if (isValidDate(input.start_date) && isValidDate(input.end_date) &&
      input.start_date > input.end_date) {
    errors.push('开始日期不得晚于结束日期');
  }
  return { medium, region, errors };
}

// 媒介/地区匹配：精确匹配，'*' 为通配
function scopeMatches(value, required) {
  return value === '*' || value === required;
}

// 一份授权是否覆盖整段使用期且未撤销
function covers(auth, medium, region, startDate, endDate) {
  return !auth.revoked &&
    scopeMatches(auth.medium, medium) &&
    scopeMatches(auth.region, region) &&
    auth.start_date <= startDate &&
    auth.end_date >= endDate;
}

function loadMaterials() {
  return getDb().prepare(`SELECT id, name, kind, note FROM material ORDER BY id`).all();
}

function loadEdges() {
  return getDb().prepare(`SELECT id, source_id, target_id, relation FROM source_edge`).all();
}

function loadAuthorizations() {
  return getDb().prepare(`
    SELECT id, material_id, licensor, medium, region, start_date, end_date, revoked, document
    FROM authorization`).all();
}

// 若图中成环，返回环上的节点 id 序列；否则 null。
// 边方向 source -> target（来源指向使用者），DFS 检测回边。
function findCycle(edges) {
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.source_id)) adj.set(e.source_id, []);
    adj.get(e.source_id).push(e.target_id);
  }
  const state = new Map(); // 0=未访问 1=在栈中 2=完成
  const stack = [];
  let cycle = null;
  function dfs(u) {
    if (cycle) return;
    state.set(u, 1);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      if (state.get(v) === 1) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx).concat(v);
        return;
      }
      if (state.get(v) !== 2) dfs(v);
      if (cycle) return;
    }
    stack.pop();
    state.set(u, 2);
  }
  for (const u of adj.keys()) {
    if (!state.has(u)) dfs(u);
    if (cycle) break;
  }
  return cycle;
}

// 从 root 沿 source 边向上游枚举全部来源路径（含根节点的单节点路径）。
// 由于来源关系为 DAG（添加边时禁止成环），枚举必然终止。
function enumerateSourcePaths(root, sourceByTarget) {
  const paths = [];
  const MAX_PATHS = 500;
  function walk(nodeId, acc) {
    if (paths.length >= MAX_PATHS) return;
    acc.push(nodeId);
    const ups = sourceByTarget.get(nodeId) || [];
    if (ups.length === 0) {
      paths.push(acc.slice());
    } else {
      for (const s of ups) { walk(s, acc); if (paths.length >= MAX_PATHS) break; }
    }
    acc.pop();
  }
  walk(root, []);
  return paths;
}

/**
 * 核验一组素材。
 * 入参: { materialIds:[...], medium, region, start_date, end_date }
 * 返回:
 *   { valid:false, errors:[...] }                              参数错误
 *   { valid:true, qualified, reason, reachableNodeIds,
 *     nodeResults:{id:{materialId,name,qualified,reason,paths:[[...]],matchedAuths:[...]}},
 *     failures:[{materialId,name,reason,paths:[[...]]}],
 *     packageMaterials:[...] }
 * 其中 paths 为“从入选项到该节点”的来源链（节点 id 序列，方向：入选项 → … → 上游来源）。
 */
function verify({ materialIds, medium, region, start_date: startDate, end_date: endDate }) {
  const p = checkParams({ medium, region, start_date: startDate, end_date: endDate });
  if (p.errors.length) return { valid: false, errors: p.errors };
  medium = p.medium; region = p.region;

  const ids = [...new Set((materialIds || []).map(Number).filter(Boolean))];
  if (ids.length === 0) {
    return { valid: false, errors: ['请至少选择一件素材'] };
  }

  const materials = loadMaterials();
  const matById = new Map(materials.map(m => [m.id, m]));
  const missing = ids.filter(id => !matById.has(id));
  if (missing.length) return { valid: false, errors: [`素材不存在：${missing.join(', ')}`] };

  const edges = loadEdges();
  const cycle = findCycle(edges);
  if (cycle) {
    const names = cycle.map(id => matById.get(id)?.name || `#${id}`);
    return { valid: false, errors: [`来源关系存在成环（${names.join(' → ')}），请先修正后再核验`] };
  }

  const sourceByTarget = new Map(); // target -> [source,...]
  for (const e of edges) {
    if (!sourceByTarget.has(e.target_id)) sourceByTarget.set(e.target_id, []);
    sourceByTarget.get(e.target_id).push(e.source_id);
  }

  const auths = loadAuthorizations();
  const authsByMat = new Map();
  for (const a of auths) {
    if (!authsByMat.has(a.material_id)) authsByMat.set(a.material_id, []);
    authsByMat.get(a.material_id).push(a);
  }

  // 1) 枚举每个入选项的来源路径，得到可达节点及“如何到达”的路径集合
  const pathsToNode = new Map(); // nodeId -> Set(路径指纹)
  const reachable = new Set(ids);
  for (const root of ids) {
    const allPaths = enumerateSourcePaths(root, sourceByTarget);
    for (const path of allPaths) {
      for (const nid of path) {
        reachable.add(nid);
        if (!pathsToNode.has(nid)) pathsToNode.set(nid, new Set());
        pathsToNode.get(nid).add(path.join(','));
      }
    }
  }

  // 2) 逐节点判定授权
  const nodeResults = {};
  const failures = [];
  let qualified = true;
  for (const nid of reachable) {
    const mat = matById.get(nid);
    const list = authsByMat.get(nid) || [];
    const matched = list.filter(a => covers(a, medium, region, startDate, endDate));
    let ok = matched.length > 0;
    let reason = null;
    if (list.length === 0) reason = 'NO_AUTH';
    else if (!ok) {
      if (list.every(a => a.revoked === 1 || a.revoked === true)) reason = 'ALL_REVOKED';
      else reason = 'NOT_COVERING';
    }
    if (!ok) qualified = false;

    // 失败时给出从每个相关入选项到该节点的来源路径（便于定位来源链）
    let paths = [];
    if (!ok) {
      const seen = new Set();
      for (const root of ids) {
        for (const path of enumerateSourcePaths(root, sourceByTarget)) {
          if (path.includes(nid)) {
            const fp = path.join(',');
            if (!seen.has(fp)) { seen.add(fp); paths.push(path); }
          }
        }
      }
      failures.push({ materialId: nid, name: mat.name, reason, paths,
                      namePaths: paths.map(p => pathToNames(p, matById)) });
    }
    nodeResults[nid] = {
      materialId: nid,
      name: mat.name,
      kind: mat.kind,
      qualified: ok,
      reason,
      paths,
      namePaths: paths.map(p => pathToNames(p, matById)),
      matchedAuths: matched.map(a => ({
        id: a.id, licensor: a.licensor, medium: a.medium, region: a.region,
        start_date: a.start_date, end_date: a.end_date, document: a.document
      }))
    };
  }

  // 入选项本身的素材清单（快照用）
  const packageMaterials = ids.map(id => ({ materialId: id, name: matById.get(id).name, kind: matById.get(id).kind }));

  return {
    valid: true,
    qualified,
    reason: qualified ? 'QUALIFIED' : 'NODE_NOT_COVERED',
    medium, region, start_date: startDate, end_date: endDate,
    reachableNodeIds: [...reachable].sort((a, b) => a - b),
    nodeResults,
    failures,
    packageMaterials
  };
}

// 将 id 路径转成名称路径
function pathToNames(path, matById) {
  return path.map(id => matById.get(id)?.name || `#${id}`);
}

module.exports = { verify, isValidDate, checkParams, findCycle, loadMaterials, loadEdges, loadAuthorizations, pathToNames };
