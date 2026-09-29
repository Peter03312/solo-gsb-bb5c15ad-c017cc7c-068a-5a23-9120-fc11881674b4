'use strict';

// ============================== 状态与 API ==============================

const state = {
  materials: [],
  relations: [],
  authorizations: [],
  packages: [],
  basisVersion: null,
  detailPackageId: null,
  detailData: null,
  editingMaterialId: null,
  editingAuthId: null,
};

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.message) || `${method} ${url} -> ${res.status}`);
    err.payload = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ============================== 小工具 ==============================

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind = 'info', ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

const REASON_LABELS = {
  material_missing: '素材不存在',
  no_authorization: '该节点没有任何授权',
  all_revoked: '授权全部已撤销',
  no_covering_authorization: '没有覆盖整段使用的授权',
};
const AUTH_REASON_LABELS = {
  revoked: '已撤销',
  medium_mismatch: '媒介不覆盖',
  region_mismatch: '地区不覆盖',
  starts_too_late: '授权起始晚于展期开始',
  ends_too_early: '授权到期早于展期结束',
};
const STATUS_LABELS = { draft: '草稿', published: '已发布', needs_review: '需复核' };

function statusBadge(status) {
  return `<span class="badge badge-${status}">${STATUS_LABELS[status] || status}</span>`;
}

// ============================== 数据加载 ==============================

async function refreshAll() {
  const [materials, relations, auths, packages, meta] = await Promise.all([
    api('GET', '/api/materials'),
    api('GET', '/api/relations'),
    api('GET', '/api/authorizations'),
    api('GET', '/api/packages'),
    api('GET', '/api/meta'),
  ]);
  state.materials = materials;
  state.relations = relations;
  state.authorizations = auths;
  state.packages = packages;
  state.basisVersion = meta.basis_version;
  $('#basis-version').textContent = meta.basis_version;
  renderAll();
}

function renderAll() {
  renderMaterials();
  renderRelations();
  renderAuths();
  renderPackages();
  fillMaterialSelects();
}

function materialName(id) {
  const m = state.materials.find((x) => x.id === id);
  return m ? m.name : `#${id}`;
}

function fillMaterialSelects() {
  const opts = state.materials
    .map((m) => `<option value="${m.id}">${esc(m.id)} — ${esc(m.name)}</option>`)
    .join('');
  ['form-relation'].forEach(() => {});
  const relParent = document.querySelector('select[name=parent_id]');
  const relChild = document.querySelector('select[name=child_id]');
  const authMat = document.querySelector('#form-auth select[name=material_id]');
  const pkgMat = document.querySelector('#form-package select[name=material_ids]');
  if (relParent) relParent.innerHTML = opts;
  if (relChild) relChild.innerHTML = opts;
  if (authMat) authMat.innerHTML = opts;
  if (pkgMat) {
    const prev = [...pkgMat.selectedOptions].map((o) => o.value);
    pkgMat.innerHTML = opts;
    for (const v of prev) {
      const o = pkgMat.querySelector(`option[value="${v}"]`);
      if (o) o.selected = true;
    }
  }
}

// ============================== Tab ==============================

$$('.tab').forEach((btn) =>
  btn.addEventListener('click', () => {
    $$('.tab').forEach((b) => b.classList.toggle('active', b === btn));
    const tab = btn.dataset.tab;
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
    if (tab === 'snapshots') ensureSnapshotPackageOptions();
  })
);

// ============================== 素材 ==============================

function renderMaterials() {
  const tbody = $('#table-materials tbody');
  tbody.innerHTML = state.materials
    .map(
      (m) => `
      <tr>
        <td>${m.id}</td>
        <td>${esc(m.name)}</td>
        <td class="muted">${esc(m.note)}</td>
        <td>${m.authorization_count}</td>
        <td class="row-actions">
          <button class="small secondary" data-act="material-edit" data-id="${m.id}">编辑</button>
          <button class="small danger" data-act="material-del" data-id="${m.id}">删除</button>
        </td>
      </tr>`
    )
    .join('');
}

$('#form-material').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = { name: f.name.value, note: f.note.value };
  try {
    if (state.editingMaterialId) {
      await api('PATCH', `/api/materials/${state.editingMaterialId}`, payload);
      toast('素材已更新', 'success');
    } else {
      await api('POST', '/api/materials', payload);
      toast('素材已登记；核验依据版本已更新', 'success');
    }
    f.reset();
    state.editingMaterialId = null;
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = Number(btn.dataset.id);

  if (act === 'material-edit') {
    const m = state.materials.find((x) => x.id === id);
    const f = $('#form-material');
    f.name.value = m.name;
    f.note.value = m.note;
    state.editingMaterialId = id;
    toast(`正在编辑素材 #${id}（改名称/备注不影响授权核验）`, 'info');
  }
  if (act === 'material-del') {
    if (!confirm(`确认删除素材 #${id}？该操作会级联删除其授权。`)) return;
    try {
      await api('DELETE', `/api/materials/${id}`);
      toast('素材已删除；已发布包资格已重算', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error', 6000);
    }
  }
  if (act === 'relation-del') {
    if (!confirm(`确认删除来源关系 #${id}？`)) return;
    try {
      await api('DELETE', `/api/relations/${id}`);
      toast('来源关系已删除', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (act === 'auth-edit') {
    const a = state.authorizations.find((x) => x.id === id);
    const f = $('#form-auth');
    f.material_id.value = a.material_id;
    f.medium.value = a.medium;
    f.region.value = a.region;
    f.valid_from.value = a.valid_from;
    f.valid_to.value = a.valid_to;
    f.licensor.value = a.licensor || '';
    f.revoked.checked = !!a.revoked;
    state.editingAuthId = id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast(`正在编辑授权 #${id}，保存后将重算已发布包资格`, 'info');
  }
  if (act === 'auth-toggle') {
    const a = state.authorizations.find((x) => x.id === id);
    try {
      await api('PATCH', `/api/authorizations/${id}`, { revoked: !a.revoked });
      toast(a.revoked ? '授权已恢复' : '授权已标记撤销；已发布包资格已重算', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (act === 'auth-del') {
    if (!confirm(`确认删除授权 #${id}？`)) return;
    try {
      await api('DELETE', `/api/authorizations/${id}`);
      toast('授权已删除；已发布包资格已重算', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  if (act === 'pkg-open') openPackageDetail(id);
  if (act === 'pkg-edit') editPackage(id);
  if (act === 'pkg-del') {
    if (!confirm(`确认删除草稿包 #${id}？`)) return;
    try {
      await api('DELETE', `/api/packages/${id}`);
      toast('草稿已删除', 'success');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
});

// ============================== 来源关系 ==============================

function renderRelations() {
  const tbody = $('#table-relations tbody');
  tbody.innerHTML = state.relations
    .map(
      (r) => `
      <tr>
        <td>${r.id}</td>
        <td>#${r.parent_id} ${esc(r.parent_name)}</td>
        <td>→</td>
        <td>#${r.child_id} ${esc(r.child_name)}</td>
        <td><button class="small danger" data-act="relation-del" data-id="${r.id}">删除</button></td>
      </tr>`
    )
    .join('');
}

$('#form-relation').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/relations', {
      parent_id: Number(f.parent_id.value),
      child_id: Number(f.child_id.value),
    });
    toast('来源关系已添加', 'success');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

// ============================== 授权 ==============================

function renderAuths() {
  const tbody = $('#table-auths tbody');
  tbody.innerHTML = state.authorizations
    .map((a) => {
      const badge = a.revoked
        ? '<span class="badge badge-revoked">已撤销</span>'
        : '<span class="badge badge-active">有效登记</span>';
      return `
      <tr>
        <td>${a.id}</td>
        <td>#${a.material_id} ${esc(a.material_name)}</td>
        <td>${esc(a.medium)}</td>
        <td>${esc(a.region)}</td>
        <td>${esc(a.valid_from)} ~ ${esc(a.valid_to)}</td>
        <td>${badge}</td>
        <td class="muted">${esc(a.licensor)}</td>
        <td class="row-actions">
          <button class="small" data-act="auth-toggle" data-id="${a.id}">${a.revoked ? '恢复' : '撤销'}</button>
          <button class="small secondary" data-act="auth-edit" data-id="${a.id}">编辑</button>
          <button class="small danger" data-act="auth-del" data-id="${a.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('');
}

$('#form-auth').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const payload = {
    material_id: Number(f.material_id.value),
    medium: f.medium.value.trim(),
    region: f.region.value.trim(),
    valid_from: f.valid_from.value,
    valid_to: f.valid_to.value,
    licensor: f.licensor.value.trim(),
    revoked: f.revoked.checked,
  };
  try {
    if (state.editingAuthId) {
      await api('PATCH', `/api/authorizations/${state.editingAuthId}`, payload);
      toast('授权已更新；已发布包资格已重算', 'success');
      state.editingAuthId = null;
    } else {
      await api('POST', '/api/authorizations', payload);
      toast('授权已录入；已发布包资格已重算', 'success');
    }
    f.reset();
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

// ============================== 展览包表单 ==============================

$('#pkg-reset-btn').addEventListener('click', () => {
  $('#form-package').reset();
  $('#form-package input[name=id]').value = '';
  $('#pkg-form-title').textContent = '新建展览包';
  $('#pkg-save-btn').textContent = '保存草稿';
});

$('#form-package').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const materialIds = [...f.material_ids.selectedOptions].map((o) => Number(o.value));
  const payload = {
    title: f.title.value.trim(),
    medium: f.medium.value.trim(),
    region: f.region.value.trim(),
    start_date: f.start_date.value,
    end_date: f.end_date.value,
    material_ids: materialIds,
  };
  const id = f.id.value;
  try {
    if (id) {
      await api('PATCH', `/api/packages/${id}`, payload);
      toast('展览包已更新', 'success');
    } else {
      const created = await api('POST', '/api/packages', payload);
      toast('草稿已创建', 'success');
      openPackageDetail(created.id);
    }
    f.reset();
    f.id.value = '';
    $('#pkg-form-title').textContent = '新建展览包';
    $('#pkg-save-btn').textContent = '保存草稿';
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
});

function editPackage(id) {
  const p = state.packages.find((x) => x.id === id);
  if (p.status === 'published') {
    toast('已发布包不可编辑（快照不可变）', 'error');
    return;
  }
  const f = $('#form-package');
  f.id.value = p.id;
  f.title.value = p.title;
  f.medium.value = p.medium;
  f.region.value = p.region;
  f.start_date.value = p.start_date;
  f.end_date.value = p.end_date;
  [...f.material_ids.options].forEach((o) => {
    o.selected = p.item_material_ids.includes(Number(o.value));
  });
  $('#pkg-form-title').textContent = `编辑展览包 #${id}`;
  $('#pkg-save-btn').textContent = '保存修改';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ============================== 展览包列表与详情 ==============================

function renderPackages() {
  const tbody = $('#table-packages tbody');
  tbody.innerHTML = state.packages
    .map(
      (p) => `
      <tr>
        <td>${p.id}</td>
        <td>${esc(p.title)}</td>
        <td>${statusBadge(p.status)}</td>
        <td>${p.items_count}</td>
        <td>${p.snapshot_count}</td>
        <td class="muted">${esc(p.published_at || '')}</td>
        <td class="row-actions">
          <button class="small" data-act="pkg-open" data-id="${p.id}">核验</button>
          <button class="small secondary" data-act="pkg-edit" data-id="${p.id}">编辑</button>
          ${p.status === 'draft' ? `<button class="small danger" data-act="pkg-del" data-id="${p.id}">删除</button>` : ''}
        </td>
      </tr>`
    )
    .join('');
}

function renderVerification(result) {
  const usageErrHtml = result.usage_errors.length
    ? `<div class="usage-errors"><strong>使用参数问题：</strong>
         <ul>${result.usage_errors
           .map((x) => `<li>${esc(x.message)}</li>`)
           .join('')}</ul></div>`
    : '';

  const pkgErrHtml = (result.package_errors || []).length
    ? `<div class="usage-errors"><strong>包内容问题：</strong>
         <ul>${result.package_errors
           .map((x) => `<li>${esc(x.message)}</li>`)
           .join('')}</ul></div>`
    : '';

  const verdict = result.qualified
    ? `<div class="verdict pass">✓ 核验通过：所有来源链节点均有未撤销且覆盖整段使用的授权
         <div class="sub">依据版本 ${result.basis_version} · 入选 ${result.summary.selected_count} 个 · 展开节点 ${result.summary.node_count} 个 · 生成于 ${esc(result.generated_at)}</div></div>`
    : `<div class="verdict fail">✗ 核验未通过：${result.summary.violating_node_count} 个节点不合格${result.usage_errors.length ? '，且使用参数存在问题' : ''}，禁止发布
         <div class="sub">依据版本 ${result.basis_version} · 入选 ${result.summary.selected_count} 个 · 展开节点 ${result.summary.node_count} 个</div></div>`;

  // 汇总不合格节点（含来源路径）
  let violHtml = '';
  if (result.violations.length) {
    violHtml = `<h3>不合格节点与来源路径</h3>` + result.violations.map(renderNodeBlock).join('');
  }

  // 每个入选素材的全链明细（可折叠）
  const itemsHtml = result.items
    .map((it) => {
      const nodeBlocks = it.nodes.map(renderNodeBlock).join('');
      return `
        <details>
          <summary>入选素材 #${it.material_id} ${esc(it.name)} — 展开链上 ${it.nodes.length} 个节点${it.violating_nodes.length ? `（${it.violating_nodes.length} 个不合格）` : ''}</summary>
          <div style="margin-top:6px">${nodeBlocks || '<p class="muted">无节点</p>'}</div>
        </details>`;
    })
    .join('');

  return `
    ${usageErrHtml}
    ${pkgErrHtml}
    ${verdict}
    ${violHtml}
    <h3>使用条件</h3>
    <div class="path-box">
      媒介：<b>${esc(result.usage.medium)}</b> ｜
      地区：<b>${esc(result.usage.region)}</b> ｜
      展期：<b>${esc(result.usage.start_date)} ~ ${esc(result.usage.end_date)}</b>
    </div>
    <h3>按入选素材查看来源链</h3>
    ${itemsHtml}
  `;
}

function renderNodeBlock(node) {
  const reasonTags = node.reasons
    .map((r) => `<span class="tag">${esc(REASON_LABELS[r] || r)}</span>`)
    .join('');
  const paths = node.paths.length
    ? node.paths
        .map((p) => {
          const chain = p.names
            .map((nm, i) => {
              const id = p.material_ids[i];
              const bad = node.material_id === id && !node.ok;
              return `<span class="${bad ? 'bad' : ''}">${esc(nm)}</span>`;
            })
            .join('<span class="sep">↑ 来源</span>');
          return `<div class="path-box"><span class="path-chain">${chain}</span></div>`;
        })
        .join('')
    : '<div class="path-box muted">（入选素材本身）</div>';

  const auths = node.authorizations.length
    ? node.authorizations
        .map((a) => {
          const tags = a.covers
            ? '<span class="tag ok-tag">覆盖整段使用</span>'
            : a.reasons.map((r) => `<span class="tag">${esc(AUTH_REASON_LABELS[r] || r)}</span>`).join('');
          return `<div class="auth-mini ${a.covers ? '' : 'fail'}">
            授权 #${a.id}：${esc(a.medium)} / ${esc(a.region)} / ${esc(a.valid_from)} ~ ${esc(a.valid_to)}
            ${a.revoked ? '（已撤销）' : ''} ${esc(a.licensor ? '· ' + a.licensor : '')}<br/>${tags}
          </div>`;
        })
        .join('')
    : '<div class="auth-mini fail">该素材节点未登记任何授权</div>';

  return `
    <div class="node-block ${node.ok ? '' : 'bad'}">
      <div class="node-head">
        <span class="name">#${node.material_id} ${esc(node.name)}</span>
        ${node.is_root ? '<span class="tag ok-tag">入选素材</span>' : `<span class="muted">上游 ${node.depth} 层</span>`}
        ${node.ok ? '<span class="tag ok-tag">合格</span>' : `<span class="tag">不合格</span>${reasonTags}`}
      </div>
      <div class="node-body">
        <div><strong>来源路径：</strong></div>
        ${paths}
        <details><summary>该节点授权判定（${node.authorizations.length} 条登记）</summary>${auths}</details>
      </div>
    </div>`;
}

async function openPackageDetail(id) {
  state.detailPackageId = id;
  $('#pkg-detail-card').classList.remove('hidden');
  $('#pkg-detail-title').textContent = `展览包 #${id} 核验详情（加载中…）`;
  $('#pkg-detail-body').innerHTML = '';
  await loadPackageDetail();
  $('#pkg-detail-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadPackageDetail() {
  const id = state.detailPackageId;
  const data = await api('GET', `/api/packages/${id}`);
  state.detailData = data;
  const r = data.live_verification;

  $('#pkg-detail-title').textContent = `展览包 #${data.id} ${data.title} ${statusBadge(data.status)}`;

  let actions = '';
  if (data.status === 'draft') {
    actions = `
      <button id="btn-verify">重新核验（试算）</button>
      <button id="btn-publish">发布（原子写入快照）</button>`;
  } else if (data.status === 'needs_review') {
    actions = `
      <button id="btn-recheck" class="secondary">执行复核（查看当前资格）</button>
      <button id="btn-republish">复核通过并重新发布（追加新快照，保留原快照）</button>`;
  } else {
    actions = `<button id="btn-recheck" class="secondary">重新计算资格（不改快照）</button>
      <span class="muted">已发布包编辑已锁定；授权/关系变更后将自动重算，失去资格时转为“需复核”。</span>`;
  }

  const snapLine = data.latest_snapshot
    ? `<p class="hint">最新不可变快照：#${data.latest_snapshot.id}（依据版本 ${data.latest_snapshot.basis_version}，包版本 ${data.latest_snapshot.package_revision}，${data.latest_snapshot.created_at}）；历史快照共 ${data.snapshot_count} 份，见“核验快照”页。</p>`
    : '<p class="hint">尚未发布，无快照。</p>';

  $('#pkg-detail-body').innerHTML = `
    <div class="btn-row" style="margin-bottom:12px">${actions}</div>
    ${snapLine}
    <div id="verification-box">${renderVerification(r)}</div>
    <div id="detail-messages"></div>`;

  // 按最新核验结果同步发布按钮可用性与发布依据
  const syncActionButtons = (ver) => {
    const apply = (btn) => {
      if (!btn) return;
      btn.disabled = !ver.qualified;
      btn.title = ver.qualified
        ? ''
        : '核验未通过，禁止发布（请先修正素材授权或使用参数后重新核验）';
    };
    apply($('#btn-publish'));
    apply($('#btn-republish'));
  };
  syncActionButtons(r);

  const verifyBtn = $('#btn-verify');
  if (verifyBtn)
    verifyBtn.addEventListener('click', async () => {
      try {
        const fresh = await api('POST', `/api/packages/${id}/verify`);
        state.detailData.live_verification = fresh;
        $('#verification-box').innerHTML = renderVerification(fresh);
        syncActionButtons(fresh);
        toast('已按最新现场数据重新核验', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
    });

  const publishBtn = $('#btn-publish');
  if (publishBtn)
    publishBtn.addEventListener('click', () =>
      doPublish(id, 'publish', {
        basis_version: state.detailData.live_verification.basis_version,
        revision: state.detailData.revision,
      })
    );

  const recheckBtn = $('#btn-recheck');
  if (recheckBtn)
    recheckBtn.addEventListener('click', async () => {
      try {
        const out = await api('POST', `/api/packages/${id}/recheck`);
        const v = out.live_verification;
        state.detailData.live_verification = v;
        $('#verification-box').innerHTML = renderVerification(v);
        syncActionButtons(v);
        const n = out.original_snapshots_preserved.length;
        toast(
          v.qualified
            ? `复核：当前已重新合格（原 ${n} 份快照均保留）；可点击“复核通过并重新发布”`
            : `复核：仍不合格（原 ${n} 份快照均保留）`,
          v.qualified ? 'success' : 'error',
          6000
        );
      } catch (err) {
        toast(err.message, 'error');
      }
    });

  const republishBtn = $('#btn-republish');
  if (republishBtn)
    republishBtn.addEventListener('click', () =>
      doPublish(id, 'republish', {
        basis_version: state.detailData.live_verification.basis_version,
      })
    );
}

async function doPublish(id, endpoint, payload) {
  try {
    const out = await api('POST', `/api/packages/${id}/${endpoint}`, payload);
    toast(
      endpoint === 'publish'
        ? `发布成功，已原子写入不可变快照 #${out.snapshot_id}`
        : `复核通过，已追加新快照 #${out.snapshot_id}，原快照保留`,
      'success',
      6000
    );
    await refreshAll();
    await openPackageDetail(id);
  } catch (err) {
    if (err.status === 409 && err.payload && err.payload.error === 'basis_stale') {
      toast(`${err.message} 请点击“重新核验”后重试发布。`, 'error', 8000);
      // 刷新详情中的依据版本，便于重试
      await loadPackageDetail();
    } else if (err.status === 422 && err.payload && err.payload.verification) {
      $('#verification-box').innerHTML = renderVerification(err.payload.verification);
      toast('发布被拒绝：核验未通过。不合格节点已列出，请补齐授权后重新核验。', 'error', 8000);
    } else {
      toast(err.message, 'error', 6000);
    }
  }
}

$('#pkg-detail-close').addEventListener('click', () => {
  $('#pkg-detail-card').classList.add('hidden');
  state.detailPackageId = null;
});

// ============================== 快照页 ==============================

function ensureSnapshotPackageOptions() {
  const sel = $('#snapshot-pkg-select');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML =
    '<option value="">— 选择展览包 —</option>' +
    state.packages
      .map((p) => `<option value="${p.id}">#${p.id} ${esc(p.title)}（${STATUS_LABELS[p.status]}，${p.snapshot_count} 份）</option>`)
      .join('');
  if (prev) sel.value = prev;
}

// 快照页是惰性渲染：注入最小骨架
$('#tab-snapshots .card').insertAdjacentHTML(
  'beforeend',
  `
  <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
    <select id="snapshot-pkg-select" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;min-width:320px"></select>
    <button id="snapshot-load-btn">查看快照历史</button>
  </div>
  <div id="snapshot-list-body"></div>`
);

$('#snapshot-load-btn').addEventListener('click', async () => {
  const id = Number($('#snapshot-pkg-select').value);
  const box = $('#snapshot-list-body');
  if (!id) {
    box.innerHTML = '<p class="muted">请选择展览包。</p>';
    return;
  }
  try {
    const snaps = await api('GET', `/api/packages/${id}/snapshots`);
    if (!snaps.length) {
      box.innerHTML = '<p class="muted">该包尚未发布，没有快照。</p>';
      return;
    }
    box.innerHTML = snaps
      .map(
        (s) => `
        <div class="snapshot-block">
          <strong>快照 #${s.id}</strong>
          <div class="meta-line">冻结时间：${esc(s.created_at)} ｜ 包版本 revision=${s.package_revision} ｜ 核验依据版本 basis=${s.basis_version}</div>
          <div class="meta-line">结论：${
            s.verification.qualified
              ? '<span style="color:var(--ok)">合格发布</span>'
              : '<span style="color:var(--danger)">不合格（不应存在，防御性记录）</span>'
          } ｜ 使用：${esc(s.verification.usage.medium)} / ${esc(s.verification.usage.region)} / ${esc(s.verification.usage.start_date)} ~ ${esc(s.verification.usage.end_date)}</div>
          <details>
            <summary>展开素材清单（含来源链节点与命中的授权 ID）</summary>
            <pre class="json">${esc(JSON.stringify(s.items, null, 2))}</pre>
          </details>
          <details>
            <summary>展开完整核验结果（全部节点 / 路径 / 授权判定）</summary>
            <pre class="json">${esc(JSON.stringify(s.verification, null, 2))}</pre>
          </details>
        </div>`
      )
      .join('');
  } catch (err) {
    toast(err.message, 'error');
  }
});

// ============================== 启动 ==============================

refreshAll().catch((err) => toast(`初始化失败: ${err.message}`, 'error', 10000));
