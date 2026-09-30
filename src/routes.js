'use strict';
// HTTP API：素材 / 来源关系 / 授权 / 展览包；并托管前端静态页面
const path = require('path');
const express = require('express');
const { getDb, getBasisVersion } = require('./db');
const { verify, isValidDate, findCycle, loadMaterials, loadEdges, loadAuthorizations } = require('./verify');
const { STATUS, getPackage, listPackages, recomputePublished, publishPackage } = require('./packages');

const router = express.Router();

const badRequest = (res, errors, code = 400) => res.status(code).json({ error: true, errors: Array.isArray(errors) ? errors : [errors] });

// 核验依据版本（素材/关系/授权的任何变更都会使其递增）
router.get('/basis', (req, res) => res.json({ basisVersion: getBasisVersion() }));

// ---------- 素材 ----------
router.get('/materials', (req, res) => {
  res.json(loadMaterials());
});

router.post('/materials', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return badRequest(res, '素材名称不能为空');
  const d = getDb();
  const info = d.prepare(`INSERT INTO material(name, kind, note) VALUES (?,?,?)`)
    .run(name, (req.body.kind || '').trim() || null, (req.body.note || '').trim() || null);
  res.status(201).json({ id: info.lastInsertRowid, basisVersion: getBasisVersion() });
});

router.put('/materials/:id', (req, res) => {
  const d = getDb();
  const row = d.prepare(`SELECT id FROM material WHERE id=?`).get(req.params.id);
  if (!row) return badRequest(res, '素材不存在', 404);
  const name = (req.body.name || '').trim();
  if (!name) return badRequest(res, '素材名称不能为空');
  d.prepare(`UPDATE material SET name=?, kind=?, note=? WHERE id=?`)
    .run(name, (req.body.kind || '').trim() || null, (req.body.note || '').trim() || null, row.id);
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

router.delete('/materials/:id', (req, res) => {
  const d = getDb();
  const id = Number(req.params.id);
  const usedEdge = d.prepare(`SELECT 1 FROM source_edge WHERE source_id=? OR target_id=? LIMIT 1`).get(id, id);
  if (usedEdge) return badRequest(res, '该素材存在来源关系，不能删除（请先删除相关关系）', 409);
  const usedAuth = d.prepare(`SELECT 1 FROM authorization WHERE material_id=? LIMIT 1`).get(id);
  if (usedAuth) return badRequest(res, '该素材存在授权记录，不能删除', 409);
  const usedPkg = d.prepare(`SELECT 1 FROM package_material WHERE material_id=? LIMIT 1`).get(id);
  if (usedPkg) return badRequest(res, '该素材已被展览包使用，不能删除', 409);
  const info = d.prepare(`DELETE FROM material WHERE id=?`).run(id);
  if (info.changes === 0) return badRequest(res, '素材不存在', 404);
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

// ---------- 来源关系 ----------
router.get('/edges', (req, res) => res.json(loadEdges()));

router.post('/edges', (req, res) => {
  const d = getDb();
  const sourceId = Number(req.body.source_id);
  const targetId = Number(req.body.target_id);
  if (!sourceId || !targetId) return badRequest(res, '请选择来源素材与使用素材');
  if (sourceId === targetId) return badRequest(res, '素材不能以自身为来源');
  const exist = (id) => d.prepare(`SELECT 1 FROM material WHERE id=?`).get(id);
  if (!exist(sourceId) || !exist(targetId)) return badRequest(res, '素材不存在');
  const dup = d.prepare(`SELECT 1 FROM source_edge WHERE source_id=? AND target_id=?`).get(sourceId, targetId);
  if (dup) return badRequest(res, '该来源关系已存在', 409);

  // 成环检测：加入 source->target 后，若 target 已能（经任意路径）到达 source，则成环
  const edges = loadEdges().concat([{ source_id: sourceId, target_id: targetId }]);
  const cycle = findCycle(edges);
  if (cycle) {
    const mats = new Map(loadMaterials().map(m => [m.id, m.name]));
    return badRequest(res, `该来源关系会导致来源链成环：${cycle.map(id => mats.get(id) || '#' + id).join(' → ')}`);
  }
  const info = d.prepare(`INSERT INTO source_edge(source_id, target_id, relation) VALUES (?,?,?)`)
    .run(sourceId, targetId, (req.body.relation || '').trim() || null);
  d.transaction(() => recomputePublished())();
  res.status(201).json({ id: info.lastInsertRowid, basisVersion: getBasisVersion() });
});

router.delete('/edges/:id', (req, res) => {
  const d = getDb();
  const info = d.prepare(`DELETE FROM source_edge WHERE id=?`).run(req.params.id);
  if (info.changes === 0) return badRequest(res, '来源关系不存在', 404);
  d.transaction(() => recomputePublished())();
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

// ---------- 授权 ----------
router.get('/authorizations', (req, res) => {
  const d = getDb();
  const rows = d.prepare(`SELECT a.*, m.name AS material_name FROM authorization a
    JOIN material m ON m.id = a.material_id ORDER BY a.id DESC`).all();
  res.json(rows.map(r => ({ ...r, revoked: !!r.revoked })));
});

function readAuthBody(body) {
  const materialId = Number(body.material_id);
  const licensor = (body.licensor || '').trim();
  const medium = (body.medium || '').trim();
  const region = (body.region || '').trim();
  const { start_date, end_date } = body;
  const errors = [];
  if (!materialId) errors.push('请选择素材');
  if (!licensor) errors.push('授权方不能为空');
  if (!medium) errors.push('授权媒介不能为空（可填 * 表示全媒介）');
  if (!region) errors.push('授权地区不能为空（可填 * 表示全球）');
  if (!isValidDate(start_date)) errors.push('授权开始日期不合法');
  if (!isValidDate(end_date)) errors.push('授权结束日期不合法');
  if (isValidDate(start_date) && isValidDate(end_date) && start_date > end_date) {
    errors.push('授权开始日期不得晚于结束日期');
  }
  return { materialId, licensor, medium, region, start_date, end_date,
           revoked: body.revoked ? 1 : 0,
           document: (body.document || '').trim() || null, errors };
}

router.post('/authorizations', (req, res) => {
  const d = getDb();
  const b = readAuthBody(req.body);
  if (b.errors.length) return badRequest(res, b.errors);
  if (!d.prepare(`SELECT 1 FROM material WHERE id=?`).get(b.materialId)) return badRequest(res, '素材不存在');
  const info = d.prepare(`INSERT INTO authorization
    (material_id, licensor, medium, region, start_date, end_date, revoked, document)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(b.materialId, b.licensor, b.medium, b.region, b.start_date, b.end_date, b.revoked, b.document);
  d.transaction(() => recomputePublished())();
  res.status(201).json({ id: info.lastInsertRowid, basisVersion: getBasisVersion() });
});

router.put('/authorizations/:id', (req, res) => {
  const d = getDb();
  const row = d.prepare(`SELECT * FROM authorization WHERE id=?`).get(req.params.id);
  if (!row) return badRequest(res, '授权不存在', 404);
  const b = readAuthBody({ ...req.body, material_id: req.body.material_id || row.material_id });
  if (b.errors.length) return badRequest(res, b.errors);
  d.prepare(`UPDATE authorization SET material_id=?, licensor=?, medium=?, region=?,
    start_date=?, end_date=?, revoked=?, document=? WHERE id=?`)
    .run(b.materialId, b.licensor, b.medium, b.region, b.start_date, b.end_date, b.revoked, b.document, row.id);
  d.transaction(() => recomputePublished())();
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

router.post('/authorizations/:id/revoke', (req, res) => {
  const d = getDb();
  const row = d.prepare(`SELECT id FROM authorization WHERE id=?`).get(req.params.id);
  if (!row) return badRequest(res, '授权不存在', 404);
  d.prepare(`UPDATE authorization SET revoked=1 WHERE id=?`).run(row.id);
  const changed = d.transaction(() => recomputePublished())();
  res.json({ ok: true, basisVersion: getBasisVersion(), affectedPackages: changed });
});

router.delete('/authorizations/:id', (req, res) => {
  const d = getDb();
  const info = d.prepare(`DELETE FROM authorization WHERE id=?`).run(req.params.id);
  if (info.changes === 0) return badRequest(res, '授权不存在', 404);
  d.transaction(() => recomputePublished())();
  res.json({ ok: true, basisVersion: getBasisVersion() });
});

// ---------- 展览包 ----------
router.get('/packages', (req, res) => res.json(listPackages()));

router.get('/packages/:id', (req, res) => {
  const pkg = getPackage(Number(req.params.id));
  if (!pkg) return badRequest(res, '展览包不存在', 404);
  res.json(pkg);
});

// 仅草稿可增删素材、改使用参数；发布后清单与使用范围冻结
function assertEditable(pkg) {
  if (!pkg) return '展览包不存在';
  if (pkg.status !== STATUS.DRAFT) return '已发布的包不可编辑；如需调整请复制为新包或在复核通过前使用草稿';
  return null;
}

router.post('/packages', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return badRequest(res, '展览包名称不能为空');
  const d = getDb();
  const info = d.prepare(`INSERT INTO exhibition_package(name) VALUES (?)`).run(name);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/packages/:id', (req, res) => {
  const d = getDb();
  const pkg = d.prepare(`SELECT * FROM exhibition_package WHERE id=?`).get(req.params.id);
  const err = assertEditable(pkg);
  if (err === '展览包不存在') return badRequest(res, err, 404);
  if (err) return badRequest(res, err, 409);

  const medium = (req.body.medium || '').trim();
  const region = (req.body.region || '').trim();
  const { start_date, end_date } = req.body;
  if (!medium || !region) return badRequest(res, '媒介与地区不能为空');
  if (!isValidDate(start_date) || !isValidDate(end_date)) return badRequest(res, '日期不合法（YYYY-MM-DD）');
  if (start_date > end_date) return badRequest(res, '开始日期不得晚于结束日期');

  d.prepare(`UPDATE exhibition_package SET name=?, medium=?, region=?, start_date=?, end_date=?,
    updated_at=datetime('now') WHERE id=?`)
    .run((req.body.name || pkg.name).trim() || pkg.name, medium, region, start_date, end_date, pkg.id);
  res.json({ ok: true });
});

router.put('/packages/:id/items', (req, res) => {
  const d = getDb();
  const pkg = d.prepare(`SELECT * FROM exhibition_package WHERE id=?`).get(req.params.id);
  const err = assertEditable(pkg);
  if (err === '展览包不存在') return badRequest(res, err, 404);
  if (err) return badRequest(res, err, 409);
  const ids = [...new Set((req.body.material_ids || []).map(Number).filter(Boolean))];
  if (ids.length === 0) return badRequest(res, '请至少选择一件素材');
  const missing = ids.filter(id => !d.prepare(`SELECT 1 FROM material WHERE id=?`).get(id));
  if (missing.length) return badRequest(res, `素材不存在：${missing.join(', ')}`);

  const tx = d.transaction((list) => {
    d.prepare(`DELETE FROM package_material WHERE package_id=?`).run(pkg.id);
    const ins = d.prepare(`INSERT OR IGNORE INTO package_material(package_id, material_id) VALUES (?,?)`);
    for (const id of list) ins.run(pkg.id, id);
    d.prepare(`UPDATE exhibition_package SET updated_at=datetime('now') WHERE id=?`).run(pkg.id);
  });
  tx(ids);
  res.json({ ok: true });
});

router.delete('/packages/:id', (req, res) => {
  const d = getDb();
  const pkg = d.prepare(`SELECT status FROM exhibition_package WHERE id=?`).get(req.params.id);
  if (!pkg) return badRequest(res, '展览包不存在', 404);
  if (pkg.status !== STATUS.DRAFT) return badRequest(res, '仅草稿可以删除（已发布包及其快照须保留）', 409);
  d.prepare(`DELETE FROM exhibition_package WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// 试核验：不写入，返回不合格节点、原因与来源路径
router.post('/packages/:id/verify', (req, res) => {
  const d = getDb();
  const pkg = d.prepare(`SELECT * FROM exhibition_package WHERE id=?`).get(req.params.id);
  if (!pkg) return badRequest(res, '展览包不存在', 404);
  const ids = d.prepare(`SELECT material_id FROM package_material WHERE package_id=?`)
    .all(pkg.id).map(r => r.material_id);
  const result = verify({
    materialIds: ids,
    medium: pkg.medium, region: pkg.region,
    start_date: pkg.start_date, end_date: pkg.end_date
  });
  res.json({ basisVersion: getBasisVersion(), ...result });
});

// 发布（原子保存快照）；needs_review 复核通过后可重新发布生成新快照
router.post('/packages/:id/publish', (req, res) => {
  const out = publishPackage(Number(req.params.id), req.body.basisVersion);
  if (!out.ok) {
    return res.status(out.status || 400).json({
      error: true,
      errors: out.errors || ['发布失败'],
      result: out.result || null
    });
  }
  res.status(201).json(out);
});

router.get('/packages/:id/snapshots', (req, res) => {
  const pkg = getPackage(Number(req.params.id));
  if (!pkg) return badRequest(res, '展览包不存在', 404);
  res.json(pkg.snapshots);
});

router.get('/snapshots/:id', (req, res) => {
  const row = getDb().prepare(`SELECT * FROM verification_snapshot WHERE id=?`).get(req.params.id);
  if (!row) return badRequest(res, '快照不存在', 404);
  let payload;
  try { payload = JSON.parse(row.payload); } catch { payload = row.payload; }
  res.json({ ...row, qualified: !!row.qualified, payload });
});

// 手动触发已发布包重算（正常情况下授权变更已自动重算）
router.post('/recompute', (req, res) => {
  const changed = getDb().transaction(() => recomputePublished())();
  res.json({ ok: true, basisVersion: getBasisVersion(), changed });
});

module.exports = router;
