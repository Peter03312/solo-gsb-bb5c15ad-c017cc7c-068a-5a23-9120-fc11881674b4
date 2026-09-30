'use strict';
// 前端：原生 JS，无构建。数据全部来自 /api。
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  materials: [],
  edges: [],
  auths: [],
  packages: [],
  basisVersion: null,
  currentPkg: null,
  verifyResult: null,
  pkgItemDirty: false
};

const REASON_TEXT = {
  NO_AUTH: '缺少授权',
  ALL_REVOKED: '仅有的授权均已撤销',
  NOT_COVERING: '没有授权同时覆盖媒介、地区与整段展期'
};
const STATUS_TEXT = { draft: '草稿', published: '已发布', needs_review: '需复核' };

// ---------- API ----------
async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const res = await fetch('/api' + url, opt);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.errors || ['请求失败']).join('；'));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isError ? 'error' : '';
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshAll() {
  const [materials, edges, auths, pkgs, basis] = await Promise.all([
    api('GET', '/materials'), api('GET', '/edges'),
    api('GET', '/authorizations'), api('GET', '/packages'), api('GET', '/basis')
  ]);
  state.materials = materials;
  state.edges = edges;
  state.auths = auths;
  state.packages = pkgs;
  state.basisVersion = basis.basisVersion;
  $('#basis').textContent = `核验依据版本：${basis.basisVersion}`;
  renderMaterials();
  renderEdges();
  renderAuths();
  renderPackages();
  fillMaterialSelects();
}

// ---------- Tabs ----------
$$('#tabs button').forEach(btn => btn.addEventListener('click', () => {
  $$('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
  $$('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + btn.dataset.tab));
}));

// ---------- 素材 ----------
function fillMaterialSelects() {
  const opts = state.materials.map(m => `<option value="${m.id}">${esc(m.name)}#${m.id}</option>`).join('');
  $$('select[name="source_id"], select[name="target_id"], select[name="material_id"]')
    .forEach(sel => {
      const keep = sel.value;
      sel.innerHTML = '<option value="">请选择…</option>' + opts;
      if (keep) sel.value = keep;
    });
}

function renderMaterials() {
  const tb = $('#table-materials tbody');
  tb.innerHTML = state.materials.map(m => `
    <tr>
      <td>${m.id}</td><td>${esc(m.name)}</td><td>${esc(m.kind || '')}</td>
      <td>${esc(m.note || '')}</td>
      <td>
        <button class="ghost small" onclick="editMaterial(${m.id})">编辑</button>
        <button class="ghost small" onclick="delMaterial(${m.id})">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">暂无素材</td></tr>';
}

window.editMaterial = (id) => {
  const m = state.materials.find(x => x.id === id);
  const f = $('#form-material');
  f.id.value = m.id; f.name.value = m.name; f.kind.value = m.kind || ''; f.note.value = m.note || '';
  f.querySelector('button.primary').textContent = '更新素材';
  f.name.focus();
};

window.delMaterial = async (id) => {
  if (!confirm('确认删除该素材？')) return;
  try { await api('DELETE', `/materials/${id}`); toast('已删除'); await refreshAll(); }
  catch (e) { toast(e.message, true); }
};

$('#form-material').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { name: f.name.value, kind: f.kind.value, note: f.note.value };
  try {
    if (f.id.value) { await api('PUT', `/materials/${f.id.value}`, body); toast('素材已更新'); }
    else { await api('POST', '/materials', body); toast('素材已登记'); }
    f.reset(); f.id.value = '';
    f.querySelector('button.primary').textContent = '保存素材';
    await refreshAll();
  } catch (e) { toast(e.message, true); }
});
$('#material-reset').addEventListener('click', () => {
  const f = $('#form-material'); f.reset(); f.id.value = '';
  f.querySelector('button.primary').textContent = '保存素材';
});

// ---------- 来源关系 ----------
function matName(id) { const m = state.materials.find(x => x.id === id); return m ? m.name : '#' + id; }

function renderEdges() {
  const tb = $('#table-edges tbody');
  tb.innerHTML = state.edges.map(e => `
    <tr>
      <td>${esc(matName(e.source_id))} <span class="hint">#${e.source_id}</span></td>
      <td>→</td>
      <td>${esc(matName(e.target_id))} <span class="hint">#${e.target_id}</span></td>
      <td>${esc(e.relation || '')}</td>
      <td><button class="ghost small" onclick="delEdge(${e.id})">删除</button></td>
    </tr>`).join('') || '<tr><td colspan="5" class="hint">暂无来源关系</td></tr>';
}

window.delEdge = async (id) => {
  if (!confirm('删除该来源关系？已发布包将重新计算资格。')) return;
  try { await api('DELETE', `/edges/${id}`); toast('已删除，已发布包已重算'); await refreshAll(); }
  catch (e) { toast(e.message, true); }
};

$('#form-edge').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = { source_id: Number(f.source_id.value), target_id: Number(f.target_id.value), relation: f.relation.value };
  try {
    await api('POST', '/edges', body);
    toast('来源关系已建立'); f.reset(); await refreshAll();
  } catch (e) { toast(e.message, true); }
});

// ---------- 授权 ----------
function renderAuths() {
  const tb = $('#table-auths tbody');
  tb.innerHTML = state.auths.map(a => `
    <tr style="${a.revoked ? 'opacity:.6' : ''}">
      <td>${a.id}</td>
      <td>${esc(a.material_name)} <span class="hint">#${a.material_id}</span></td>
      <td>${esc(a.licensor)}</td>
      <td>${esc(a.medium)}</td><td>${esc(a.region)}</td>
      <td>${a.start_date} ~ ${a.end_date}</td>
      <td>${a.revoked ? '<span class="pill revoked">已撤销</span>' : '<span class="pill ok">有效</span>'}</td>
      <td>${esc(a.document || '')}</td>
      <td>
        <button class="ghost small" onclick="editAuth(${a.id})">编辑</button>
        ${a.revoked ? '' : `<button class="ghost small" onclick="revokeAuth(${a.id})">撤销</button>`}
        <button class="ghost small" onclick="delAuth(${a.id})">删除</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="9" class="hint">暂无授权</td></tr>';
}

window.editAuth = (id) => {
  const a = state.auths.find(x => x.id === id);
  const f = $('#form-auth');
  f.id.value = a.id; f.material_id.value = a.material_id; f.licensor.value = a.licensor;
  f.medium.value = a.medium; f.region.value = a.region;
  f.start_date.value = a.start_date; f.end_date.value = a.end_date;
  f.document.value = a.document || ''; f.revoked.checked = !!a.revoked;
  $('#auth-form-title').textContent = '编辑授权 #' + a.id;
  f.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.revokeAuth = async (id) => {
  if (!confirm('撤销该授权？相关已发布包将立即重新计算资格。')) return;
  try {
    const r = await api('POST', `/authorizations/${id}/revoke`);
    toast(r.affectedPackages && r.affectedPackages.length
      ? `已撤销，${r.affectedPackages.length} 个包状态变更` : '已撤销');
    await refreshAll();
  } catch (e) { toast(e.message, true); }
};

window.delAuth = async (id) => {
  if (!confirm('删除该授权？相关已发布包将重新计算资格。')) return;
  try { await api('DELETE', `/authorizations/${id}`); toast('已删除'); await refreshAll(); }
  catch (e) { toast(e.message, true); }
};

$('#form-auth').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = {
    material_id: Number(f.material_id.value), licensor: f.licensor.value,
    medium: f.medium.value, region: f.region.value,
    start_date: f.start_date.value, end_date: f.end_date.value,
    document: f.document.value, revoked: f.revoked.checked
  };
  try {
    if (f.id.value) { await api('PUT', `/authorizations/${f.id.value}`, body); toast('授权已更新'); }
    else { await api('POST', '/authorizations', body); toast('授权已登记'); }
    f.reset(); f.id.value = '';
    $('#auth-form-title').textContent = '登记授权';
    await refreshAll();
  } catch (e) { toast(e.message, true); }
});
$('#auth-reset').addEventListener('click', () => {
  $('#form-auth').reset(); $('#form-auth').id.value = '';
  $('#auth-form-title').textContent = '登记授权';
});

// ---------- 展览包列表 ----------
function statusTag(s) {
  const cls = s === 'published' ? 'published' : s === 'needs_review' ? 'review' : 'draft';
  return `<span class="tag ${cls}">${STATUS_TEXT[s]}</span>`;
}

function renderPackages() {
  const tb = $('#table-packages tbody');
  tb.innerHTML = state.packages.map(p => {
    const scope = p.medium ? `${esc(p.medium)} / ${esc(p.region)}` : '<span class="hint">未设置</span>';
    const dates = p.start_date ? `${p.start_date} ~ ${p.end_date}` : '<span class="hint">未设置</span>';
    const snap = p.latest_snapshot
      ? `<span class="pill ${p.latest_snapshot.qualified ? 'ok' : 'no'}">#${p.latest_snapshot.id} · ${p.latest_snapshot.created_at}</span>`
      : '<span class="hint">无</span>';
    return `<tr>
      <td>${p.id}</td><td>${esc(p.name)}</td><td>${statusTag(p.status)}</td>
      <td>${scope}</td><td>${dates}</td><td>${p.material_ids.length}</td>
      <td>${snap}</td>
      <td><button class="primary small" onclick="openPkg(${p.id})">打开</button>
          ${p.status === 'draft' ? `<button class="ghost small" onclick="delPkg(${p.id})">删除</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="hint">暂无展览包</td></tr>';
}

$('#form-pkg').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    const r = await api('POST', '/packages', { name: ev.target.name.value });
    ev.target.reset();
    toast('草稿已创建');
    await refreshAll();
    openPkg(r.id);
  } catch (e) { toast(e.message, true); }
});

window.delPkg = async (id) => {
  if (!confirm('删除该草稿包？')) return;
  try { await api('DELETE', `/packages/${id}`); toast('已删除'); await refreshAll(); }
  catch (e) { toast(e.message, true); }
};

// ---------- 包详情 ----------
window.openPkg = async (id) => {
  await loadPkg(id);
  $('#pkg-list-view').hidden = true;
  $('#pkg-detail-view').hidden = false;
  window.scrollTo(0, 0);
};

$('#pkg-back').addEventListener('click', () => {
  state.currentPkg = null; state.verifyResult = null;
  $('#pkg-list-view').hidden = false;
  $('#pkg-detail-view').hidden = true;
  refreshAll();
});

async function loadPkg(id) {
  const p = await api('GET', `/packages/${id}`);
  state.currentPkg = p;
  state.verifyResult = null;
  $('#pkg-title').textContent = `#${p.id} ${p.name}`;
  const banner = $('#pkg-status-banner');
  if (p.status === 'published') {
    banner.className = 'banner published';
    banner.textContent = `状态：已发布。最近发布快照 #${p.snapshots[0]?.id || '?'}（${p.snapshots[0]?.created_at || ''}）。清单与使用范围已冻结，可随时试核验查看当前资格。`;
  } else if (p.status === 'needs_review') {
    banner.className = 'banner review';
    banner.textContent = '状态：需复核。授权或来源变更后，该包已不再满足全部来源链授权要求；原发布快照保留不变。请核验并在合格后重新发布。';
  } else {
    banner.className = '';
    banner.textContent = '状态：草稿。保存使用范围与素材清单后进行核验，核验合格方可发布。';
  }

  const f = $('#form-pkg-edit');
  f.name.value = p.name; f.medium.value = p.medium || ''; f.region.value = p.region || '';
  f.start_date.value = p.start_date || ''; f.end_date.value = p.end_date || '';
  const editable = p.status === 'draft';
  $$('#form-pkg-edit input, #form-pkg-edit select, #form-pkg-edit button').forEach(el => el.disabled = !editable);

  const selected = new Set(p.items.map(i => i.id));
  $('#pkg-item-picker').innerHTML = state.materials.map(m => `
    <label><input type="checkbox" value="${m.id}" ${selected.has(m.id) ? 'checked' : ''} ${editable ? '' : 'disabled'}>
      ${esc(m.name)} <span class="hint">#${m.id} ${esc(m.kind || '')}</span></label>`).join('')
    || '<span class="hint">请先登记素材</span>';
  $('#pkg-save-items').disabled = !editable;
  $('#pkg-publish').disabled = false;
  $('#verify-result').innerHTML = '';
  renderSnapshots(p.snapshots);
}

function renderSnapshots(list) {
  const tb = $('#table-snapshots tbody');
  tb.innerHTML = list.map(s => `
    <tr>
      <td>#${s.id}</td><td>${s.created_at}</td><td>${s.basis_version}</td>
      <td>${esc(s.medium)} / ${esc(s.region)}<br><span class="hint">${s.start_date} ~ ${s.end_date}</span></td>
      <td><span class="pill ok">合格（已发布）</span></td>
      <td><button class="ghost small" onclick="viewSnapshot(${s.id})">查看快照</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="hint">暂无快照（发布后生成，不可修改）</td></tr>';
}

window.viewSnapshot = async (id) => {
  const s = await api('GET', `/snapshots/${id}`);
  $('#modal-content').textContent = JSON.stringify(s.payload, null, 2);
  $('#modal').hidden = false;
};
$('#modal-close').onclick = () => { $('#modal').hidden = true; };
$('.modal-mask').addEventListener('click', () => { $('#modal').hidden = true; });

// 保存使用范围
$('#form-pkg-edit').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const p = state.currentPkg;
  const f = ev.target;
  try {
    await api('PUT', `/packages/${p.id}`, {
      name: f.name.value, medium: f.medium.value, region: f.region.value,
      start_date: f.start_date.value, end_date: f.end_date.value
    });
    toast('使用范围已保存');
    await Promise.all([refreshAll(), loadPkg(p.id)]);
  } catch (e) { toast(e.message, true); }
});

// 保存素材清单
$('#pkg-save-items').addEventListener('click', async () => {
  const p = state.currentPkg;
  const ids = $$('#pkg-item-picker input:checked').map(i => Number(i.value));
  try {
    await api('PUT', `/packages/${p.id}/items`, { material_ids: ids });
    toast('素材清单已保存');
    await Promise.all([refreshAll(), loadPkg(p.id)]);
  } catch (e) { toast(e.message, true); }
});

// ---------- 核验 ----------
$('#pkg-verify').addEventListener('click', () => doVerify(false));

async function doVerify(isPublishingRetry) {
  const p = state.currentPkg;
  try {
    const r = await api('POST', `/packages/${p.id}/verify`, {});
    state.basisVersion = r.basisVersion;
    $('#basis').textContent = `核验依据版本：${r.basisVersion}`;
    state.verifyResult = r;
    renderVerifyResult(r);
    return r;
  } catch (e) { toast(e.message, true); }
}

function renderVerifyResult(r) {
  const box = $('#verify-result');
  if (!r.valid) {
    box.innerHTML = `<div class="result-bad"><h4>无法核验，请修正以下问题：</h4>
      <ul class="path-list">${r.errors.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
    return;
  }
  if (r.qualified) {
    box.innerHTML = `<div class="result-ok">✓ 核验通过：来源链共 ${r.reachableNodeIds.length} 个节点，
      每个节点均有未撤销且覆盖整段使用期的授权。依据版本 ${r.basisVersion}，可发布。</div>`;
    return;
  }
  const items = r.failures.map(f => {
    const paths = (f.namePaths || []).map(p =>
      `<li>${p.map(x => esc(x)).join('  ←  ')}</li>`).join('');
    return `<div class="result-bad" style="margin-top:8px">
      <h4>✗ 节点：${esc(f.name)}（#${f.materialId}）— ${REASON_TEXT[f.reason] || f.reason}</h4>
      <div class="hint">该节点出现在以下来源路径上（方向：入选项 → … → 上游来源）：</div>
      <ul class="path-list">${paths || '<li>（入选项本身）</li>'}</ul>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="result-bad"><h4>核验未通过：${r.failures.length} 个节点不合格（依据版本 ${r.basisVersion}）</h4></div>${items}`;
}

// ---------- 发布 ----------
$('#pkg-publish').addEventListener('click', async () => {
  const p = state.currentPkg;

  // 发布前先自动保存草稿的使用范围与清单，保证核验的是最新内容
  if (p.status === 'draft') {
    const f = $('#form-pkg-edit');
    try {
      await api('PUT', `/packages/${p.id}`, {
        name: f.name.value, medium: f.medium.value, region: f.region.value,
        start_date: f.start_date.value, end_date: f.end_date.value
      });
      const ids = $$('#pkg-item-picker input:checked').map(i => Number(i.value));
      await api('PUT', `/packages/${p.id}/items`, { material_ids: ids });
    } catch (e) { toast('保存失败，无法发布：' + e.message, true); return; }
  }

  // 先核验，取最新依据版本
  const r = await doVerify();
  if (!r) return;
  if (!r.valid) { toast('核验参数不合法，不能发布：' + r.errors.join('；'), true); return; }
  if (!r.qualified) { toast('存在不合格节点，不能发布', true); return; }

  if (!confirm(p.status === 'needs_review'
    ? '复核通过，确认重新发布？将生成新的不可变快照。'
    : '确认发布？将原子保存不可变的核验快照与素材清单。')) return;

  try {
    const out = await api('POST', `/packages/${p.id}/publish`, { basisVersion: r.basisVersion });
    toast(`发布成功，快照 #${out.snapshotId}`);
    await refreshAll();
    await loadPkg(p.id);
  } catch (e) {
    if (e.status === 409 && /过期/.test(e.message)) {
      toast('核验依据已过期（期间有编辑），正在重新核验…', true);
      await doVerify();
    } else {
      toast(e.message, true);
      if (e.status === 422 && e.data && e.data.result) {
        state.verifyResult = e.data.result;
        renderVerifyResult(e.data.result);
      }
    }
  }
});

// ---------- init ----------
refreshAll().catch(e => toast('初始化失败：' + e.message, true));
