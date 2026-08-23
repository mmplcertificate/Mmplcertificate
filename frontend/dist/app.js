// MMPL dashboard frontend - plain JS, no build step, no external dependencies.
(function () {
  'use strict';

  const state = {
    me: null, // {username, role, permissions}
    certificates: [],
    engagements: [],
    draftRequests: [],
    activeTab: 'overview',
    filters: { stage: '', owner: '', fy: '', category: '', q: '' },
    selectedIds: new Set(),
  };

  const PERMISSION_TABS = {
    tracking: ['overview', 'in_progress', 'pending_billing', 'billed', 'all', 'engagements'],
    billing: [],
    downloading: [],
    drafting: ['requests'],
  };

  // ---------- fetch helpers ----------
  async function api(path, opts) {
    const res = await fetch('/api' + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (res.status === 401) {
      showLogin();
      throw new Error('Not authenticated');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    const contentType = res.headers.get('content-type') || '';
    return contentType.includes('application/json') ? res.json() : res;
  }

  function toast(message) {
    const root = document.getElementById('toastRoot');
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    root.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ---------- boot / auth ----------
  function showLogin() {
    document.getElementById('loginScreen').hidden = false;
    document.getElementById('app').hidden = true;
    document.getElementById('clientPortal').hidden = true;
  }

  async function boot() {
    try {
      const me = await api('/auth/me');
      state.me = me;
      routeToShell();
    } catch (e) {
      showLogin();
    }
  }

  function routeToShell() {
    document.getElementById('loginScreen').hidden = true;
    if (state.me.role === 'client') {
      document.getElementById('app').hidden = true;
      document.getElementById('clientPortal').hidden = false;
      document.getElementById('clientWhoami').textContent = `${state.me.username} (client)`;
      renderClientPortal();
    } else {
      document.getElementById('clientPortal').hidden = true;
      document.getElementById('app').hidden = false;
      document.getElementById('whoami').textContent = `${state.me.username} (${state.me.role})`;
      renderTabs();
      loadAndRenderCertificates();
    }
  }

  function hasPermission(name) {
    if (state.me.role === 'admin') return true;
    if (state.me.role === 'team') return !!(state.me.permissions && state.me.permissions[name]);
    return false;
  }

  const togglePasswordBtn = document.getElementById('togglePassword');
  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', () => {
      const pwInput = document.getElementById('loginPassword');
      const showing = pwInput.type === 'text';
      pwInput.type = showing ? 'password' : 'text';
      togglePasswordBtn.textContent = showing ? '👁' : '🙈';
      togglePasswordBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    });
  }

  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.hidden = true;
    try {
      const me = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      }).then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const msg = body.error || (res.status === 401 ? 'Incorrect username or password.' : `Login failed (server responded ${res.status}).`);
          throw new Error(msg);
        }
        return res.json();
      });
      state.me = me;
      routeToShell();
    } catch (err) {
      // A free-tier host that's been idle can take 30-50s to wake up, and
      // during that window fetch() often fails outright (network error /
      // TypeError) rather than returning a real HTTP response - surface
      // that distinctly from a normal "wrong password" rejection so it's
      // clear a retry is what's needed, not different credentials.
      if (err instanceof TypeError) {
        errEl.textContent = 'Could not reach the server. If this app has been idle, it can take up to 50 seconds to wake up - please wait a bit and try again.';
      } else {
        errEl.textContent = err.message;
      }
      errEl.hidden = false;
    }
  });

  function wireLogout(btnId) {
    document.getElementById(btnId).addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      state.me = null;
      showLogin();
    });
  }
  wireLogout('logoutBtn');
  wireLogout('clientLogoutBtn');

  // ---------- admin/team tabs ----------
  const TAB_DEFS = [
    { id: 'overview', label: 'Overview', permission: 'tracking' },
    { id: 'in_progress', label: 'In Progress', permission: 'tracking' },
    { id: 'pending_billing', label: 'Pending Billing', permission: 'tracking' },
    { id: 'billed', label: 'Billed', permission: 'tracking' },
    { id: 'all', label: 'All Certificates', permission: 'tracking' },
    { id: 'engagements', label: 'Engagements & Documents', permission: 'tracking' },
    { id: 'requests', label: 'Client Requests', permission: 'drafting' },
  ];

  function renderTabs() {
    const nav = document.getElementById('tabs');
    nav.innerHTML = '';
    const visibleTabs = TAB_DEFS.filter((t) => hasPermission(t.permission));
    if (visibleTabs.length === 0) {
      document.getElementById('mainContent').innerHTML =
        '<div class="empty-state">Your account has no permissions assigned yet. Ask Akash to grant access.</div>';
      return;
    }
    visibleTabs.forEach((t) => {
      const btn = document.createElement('button');
      btn.className = 'tab-btn' + (t.id === state.activeTab ? ' active' : '');
      btn.textContent = t.label;
      btn.addEventListener('click', () => {
        state.activeTab = t.id;
        renderTabs();
        renderActiveTab();
      });
      nav.appendChild(btn);
    });
    if (!visibleTabs.find((t) => t.id === state.activeTab)) state.activeTab = visibleTabs[0].id;
  }

  async function loadAndRenderCertificates() {
    if (!hasPermission('tracking')) {
      renderActiveTab();
      return;
    }
    state.certificates = await api('/certificates');
    renderActiveTab();
  }

  function renderActiveTab() {
    const main = document.getElementById('mainContent');
    main.innerHTML = '';
    switch (state.activeTab) {
      case 'overview':
        return renderOverview(main);
      case 'in_progress':
        return renderCertTable(main, state.certificates.filter((c) => c.stage === 'in_progress'), 'In Progress');
      case 'pending_billing':
        return renderCertTable(main, state.certificates.filter((c) => c.stage === 'pending_billing'), 'Pending Billing');
      case 'billed':
        return renderCertTable(main, state.certificates.filter((c) => c.stage === 'billed'), 'Billed');
      case 'all':
        return renderAllCertificates(main);
      case 'engagements':
        return renderEngagements(main);
      case 'requests':
        return renderClientRequestsAdmin(main);
      default:
        return;
    }
  }

  function fmtAmount(n) {
    if (n == null) return '-';
    return '₹' + Number(n).toLocaleString('en-IN');
  }

  // ---------- Overview + charts ----------
  function renderOverview(main) {
    const certs = state.certificates;
    const pending = certs.filter((c) => c.stage !== 'billed');
    const billed = certs.filter((c) => c.stage === 'billed');
    const pendingAmt = pending.reduce((s, c) => s + (c.amount || 0), 0);
    const billedAmt = billed.reduce((s, c) => s + (c.amount || 0), 0);

    const kpiRow = document.createElement('div');
    kpiRow.className = 'kpi-row';
    kpiRow.innerHTML = `
      ${kpiTile(certs.length, 'Total certificates')}
      ${kpiTile(pending.length, 'Pending (not yet billed)')}
      ${kpiTile(billed.length, 'Billed')}
      ${kpiTile(fmtAmount(pendingAmt), 'Pending amount')}
      ${kpiTile(fmtAmount(billedAmt), 'Billed amount')}
    `;
    main.appendChild(kpiRow);

    main.appendChild(chartCard('Pending vs billed amount by category', byCategoryChartData(certs)));
    main.appendChild(chartCard('Certificates by FY', byFyChartData(certs)));
    main.appendChild(chartCard('Monthly volume', byMonthChartData(certs)));
  }

  function kpiTile(value, label) {
    return `<div class="kpi-tile"><div class="value">${value}</div><div class="label">${label}</div></div>`;
  }

  function byCategoryChartData(certs) {
    const map = new Map();
    certs.forEach((c) => {
      const cat = c.category || 'Uncategorized';
      if (!map.has(cat)) map.set(cat, { pending: 0, billed: 0 });
      const bucket = map.get(cat);
      if (c.stage === 'billed') bucket.billed += c.amount || 0;
      else bucket.pending += c.amount || 0;
    });
    return Array.from(map.entries()).map(([label, v]) => ({ label, values: [v.pending, v.billed] }));
  }

  function byFyChartData(certs) {
    const map = new Map();
    certs.forEach((c) => {
      const fy = c.fy || 'Unknown';
      map.set(fy, (map.get(fy) || 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([label, v]) => ({ label, values: [v] }));
  }

  function byMonthChartData(certs) {
    const map = new Map();
    certs.forEach((c) => {
      if (!c.document_date) return;
      const month = c.document_date.slice(0, 7);
      map.set(month, (map.get(month) || 0) + 1);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([label, v]) => ({ label, values: [v] }));
  }

  function chartCard(title, data) {
    const card = document.createElement('div');
    card.className = 'panel chart-card';
    const toggleId = 'toggle-' + Math.random().toString(36).slice(2);
    card.innerHTML = `<h2>${title} <button class="btn small" data-toggle="${toggleId}" style="float:right">Table view</button></h2>
      <canvas width="720" height="220" style="width:100%;height:220px"></canvas>
      <table hidden id="${toggleId}"><thead><tr><th>Label</th><th>Value</th></tr></thead><tbody>
        ${data.map((d) => `<tr><td>${d.label}</td><td>${d.values.join(' / ')}</td></tr>`).join('')}
      </tbody></table>`;
    const canvas = card.querySelector('canvas');
    drawBarChart(canvas, data);
    card.querySelector('[data-toggle]').addEventListener('click', () => {
      const table = card.querySelector(`#${toggleId}`);
      const isHidden = table.hidden;
      table.hidden = !isHidden;
      canvas.style.display = isHidden ? 'none' : '';
    });
    return card;
  }

  function drawBarChart(canvas, data) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (data.length === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.fillText('No data yet', 10, 20);
      return;
    }
    const maxVal = Math.max(1, ...data.flatMap((d) => d.values));
    const barGroupWidth = w / data.length;
    const colors = ['#2563eb', '#16a34a'];
    data.forEach((d, i) => {
      const groupX = i * barGroupWidth;
      const barWidth = (barGroupWidth - 16) / d.values.length;
      d.values.forEach((v, vi) => {
        const barHeight = (v / maxVal) * (h - 40);
        const x = groupX + 8 + vi * barWidth;
        const y = h - 30 - barHeight;
        ctx.fillStyle = colors[vi % colors.length];
        ctx.fillRect(x, y, barWidth - 4, barHeight);
      });
      ctx.fillStyle = '#334155';
      ctx.font = '10px sans-serif';
      ctx.save();
      ctx.translate(groupX + barGroupWidth / 2, h - 14);
      ctx.textAlign = 'center';
      ctx.fillText(String(d.label).slice(0, 12), 0, 0);
      ctx.restore();
    });
  }

  // ---------- certificate tables ----------
  function renderCertTable(main, rows, title) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h2>${title} (${rows.length})</h2>`;
    panel.appendChild(buildCertTable(rows, { showStageActions: true }));
    main.appendChild(panel);
  }

  function renderAllCertificates(main) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `<h2>All Certificates (${state.certificates.length})</h2>`;

    const filters = document.createElement('div');
    filters.className = 'filters';
    const owners = ['', 'AK', 'SJ', 'Harshit Jain', 'Other'];
    const categories = ['', ...new Set(state.certificates.map((c) => c.category).filter(Boolean))];
    const fys = ['', ...new Set(state.certificates.map((c) => c.fy).filter(Boolean))];
    filters.innerHTML = `
      <input type="text" placeholder="Search particulars / tender no. / UDIN" id="filterQ" />
      <select id="filterOwner">${owners.map((o) => `<option value="${o}">${o || 'Handled by (all)'}</option>`).join('')}</select>
      <select id="filterCategory">${categories.map((c) => `<option value="${c}">${c || 'Category (all)'}</option>`).join('')}</select>
      <select id="filterFy">${fys.map((f) => `<option value="${f}">${f || 'FY (all)'}</option>`).join('')}</select>
    `;
    panel.appendChild(filters);

    if (hasPermission('billing')) {
      const bulkBar = document.createElement('div');
      bulkBar.className = 'filters';
      bulkBar.innerHTML = `
        <span class="muted" id="selectedCount">0 selected</span>
        <select id="bulkOwner">
          <option value="">Assign preparer...</option>
          <option value="AK">AK</option>
          <option value="SJ">SJ</option>
          <option value="Harshit Jain">Harshit Jain</option>
          <option value="Other">Other</option>
        </select>
        <button class="btn primary" id="bulkAssignBtn">Assign to selected</button>
      `;
      panel.appendChild(bulkBar);
      bulkBar.querySelector('#bulkAssignBtn').addEventListener('click', async () => {
        const owner = bulkBar.querySelector('#bulkOwner').value;
        if (!owner || state.selectedIds.size === 0) return toast('Pick an owner and select at least one row.');
        await api('/certificates/bulk-assign', {
          method: 'POST',
          body: JSON.stringify({ ids: Array.from(state.selectedIds), owner }),
        });
        toast(`Assigned ${state.selectedIds.size} certificate(s) to ${owner}.`);
        state.selectedIds.clear();
        await loadAndRenderCertificates();
      });
    }

    const tableContainer = document.createElement('div');
    panel.appendChild(tableContainer);
    main.appendChild(panel);

    function applyFilters() {
      const q = filters.querySelector('#filterQ').value.toLowerCase();
      const owner = filters.querySelector('#filterOwner').value;
      const category = filters.querySelector('#filterCategory').value;
      const fy = filters.querySelector('#filterFy').value;
      const rows = state.certificates.filter((c) => {
        if (owner && c.owner !== owner) return false;
        if (category && c.category !== category) return false;
        if (fy && c.fy !== fy) return false;
        if (q) {
          const hay = `${c.particulars || ''} ${c.tender_no || ''} ${c.udin || ''}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
      tableContainer.innerHTML = '';
      tableContainer.appendChild(
        buildCertTable(rows, { showCheckboxes: hasPermission('billing'), showDocs: true, showZip: hasPermission('downloading'), showVisibility: hasPermission('billing') })
      );
      const countEl = panel.querySelector('#selectedCount');
      if (countEl) countEl.textContent = `${state.selectedIds.size} selected`;
    }

    filters.querySelectorAll('input, select').forEach((el) => el.addEventListener('input', applyFilters));
    applyFilters();
  }

  function buildCertTable(rows, opts) {
    opts = opts || {};
    const table = document.createElement('table');
    if (rows.length === 0) {
      table.innerHTML = '<tbody><tr><td class="empty-state">No certificates match.</td></tr></tbody>';
      return table;
    }
    const headCells = [
      opts.showCheckboxes ? '<th class="checkbox-cell"><input type="checkbox" id="selectAllVisible" /></th>' : '',
      '<th>Particulars</th><th>Category</th><th>FY</th><th>Owner</th><th>Amount</th><th>Stage</th>',
      opts.showDocs ? '<th>Docs</th>' : '',
      opts.showVisibility ? '<th>Client visible</th>' : '',
      '<th>Actions</th>',
    ].join('');
    table.innerHTML = `<thead><tr>${headCells}</tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');

    rows.forEach((c) => {
      const tr = document.createElement('tr');
      const cells = [];
      if (opts.showCheckboxes) {
        cells.push(`<td class="checkbox-cell"><input type="checkbox" data-select-id="${c.id}" ${state.selectedIds.has(c.id) ? 'checked' : ''} /></td>`);
      }
      cells.push(`<td>${c.particulars || '-'}</td>`);
      cells.push(`<td>${c.category || '-'}</td>`);
      cells.push(`<td>${c.fy || '-'}</td>`);
      cells.push(`<td>${c.owner || '<span class="muted">unassigned</span>'}</td>`);
      cells.push(`<td>${fmtAmount(c.amount)}</td>`);
      cells.push(`<td>${stageLabel(c.stage)}</td>`);
      if (opts.showDocs) {
        cells.push(`<td><button class="btn small" data-docs-id="${c.id}">Documents</button></td>`);
      }
      if (opts.showVisibility) {
        cells.push(`<td><input type="checkbox" data-visible-id="${c.id}" ${c.client_visible ? 'checked' : ''} /></td>`);
      }
      const actions = [];
      if (opts.showZip) actions.push(`<a class="btn small" href="/api/certificates/${c.id}/documents/zip" target="_blank">⬇</a>`);
      if (hasPermission('billing') && c.stage === 'in_progress') actions.push(`<button class="btn small" data-signoff-id="${c.id}">Sign off</button>`);
      if (hasPermission('billing') && c.stage === 'pending_billing') actions.push(`<button class="btn small" data-billed-id="${c.id}">Mark billed</button>`);
      cells.push(`<td>${actions.join(' ')}</td>`);
      tr.innerHTML = cells.join('');
      tbody.appendChild(tr);
    });

    if (opts.showCheckboxes) {
      const selectAll = table.querySelector('#selectAllVisible');
      selectAll.addEventListener('change', () => {
        rows.forEach((c) => (selectAll.checked ? state.selectedIds.add(c.id) : state.selectedIds.delete(c.id)));
        table.querySelectorAll('[data-select-id]').forEach((cb) => (cb.checked = selectAll.checked));
        const countEl = document.getElementById('selectedCount');
        if (countEl) countEl.textContent = `${state.selectedIds.size} selected`;
      });
      table.querySelectorAll('[data-select-id]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const id = Number(cb.dataset.selectId);
          if (cb.checked) state.selectedIds.add(id);
          else state.selectedIds.delete(id);
          const countEl = document.getElementById('selectedCount');
          if (countEl) countEl.textContent = `${state.selectedIds.size} selected`;
        });
      });
    }

    table.querySelectorAll('[data-docs-id]').forEach((btn) => {
      btn.addEventListener('click', () => openDocsModal(Number(btn.dataset.docsId)));
    });
    table.querySelectorAll('[data-visible-id]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const id = Number(cb.dataset.visibleId);
        await api(`/certificates/${id}`, { method: 'PATCH', body: JSON.stringify({ client_visible: cb.checked }) });
        toast(cb.checked ? 'Visible to client.' : 'Hidden from client.');
      });
    });
    table.querySelectorAll('[data-signoff-id]').forEach((btn) => {
      btn.addEventListener('click', () => signOffFlow(Number(btn.dataset.signoffId)));
    });
    table.querySelectorAll('[data-billed-id]').forEach((btn) => {
      btn.addEventListener('click', () => markBilledFlow(Number(btn.dataset.billedId)));
    });

    return table;
  }

  function stageLabel(stage) {
    const map = { in_progress: 'In Progress', pending_billing: 'Pending Billing', billed: 'Billed' };
    return map[stage] || stage;
  }

  async function signOffFlow(id) {
    const signing_date = prompt('Signing date (YYYY-MM-DD)?');
    if (!signing_date) return;
    const udin = prompt('UDIN?') || '';
    const amount = prompt('Fee amount?') || null;
    await api(`/certificates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage: 'pending_billing', signing_date, udin, amount }),
    });
    toast('Signed off - moved to Pending Billing.');
    await loadAndRenderCertificates();
  }

  async function markBilledFlow(id) {
    const bill_no = prompt('Bill number?');
    if (!bill_no) return;
    const bill_date = prompt('Bill date (YYYY-MM-DD)?') || null;
    await api(`/certificates/${id}`, { method: 'PATCH', body: JSON.stringify({ stage: 'billed', bill_no, bill_date }) });
    toast('Marked as billed.');
    await loadAndRenderCertificates();
  }

  // ---------- Docs modal ----------
  async function openDocsModal(certId) {
    const cert = state.certificates.find((c) => c.id === certId);
    const docs = await api(`/certificates/${certId}/documents`);
    const root = document.getElementById('modalRoot');
    root.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-card">
          <h3>Documents - ${cert.particulars || 'Certificate #' + certId}</h3>
          <p class="muted">Search hints: click a chip to prefill search.</p>
          <div>
            ${[cert.tender_no, cert.category, cert.fy].filter(Boolean).map((h) => `<span class="chip" data-hint="${h}">${h}</span>`).join('')}
          </div>
          <ul id="docsList">
            ${docs.map((d) => `<li>${d.original_name || d.display_name}
              <label style="float:right"><input type="checkbox" data-doc-visible="${d.id}" ${d.client_visible ? 'checked' : ''} /> Client</label>
              <button class="btn small" data-detach="${d.id}" style="float:right;margin-right:0.5rem">Remove</button>
            </li>`).join('') || '<li class="muted">No documents attached yet.</li>'}
          </ul>
          <form id="uploadForm">
            <input type="file" id="uploadFile" />
            <button class="btn primary" type="submit">Attach</button>
          </form>
          <button class="btn" id="closeModal" style="margin-top:1rem">Close</button>
        </div>
      </div>`;

    root.querySelector('#closeModal').addEventListener('click', () => (root.innerHTML = ''));
    root.querySelectorAll('[data-detach]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await api(`/certificates/${certId}/documents/${btn.dataset.detach}`, { method: 'DELETE' });
        openDocsModal(certId);
      });
    });
    root.querySelectorAll('[data-doc-visible]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        await api(`/certificates/${certId}/documents/${cb.dataset.docVisible}/visibility`, {
          method: 'PATCH',
          body: JSON.stringify({ client_visible: cb.checked }),
        });
        toast(cb.checked ? 'Document visible to client.' : 'Document hidden from client.');
      });
    });
    root.querySelector('#uploadForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = root.querySelector('#uploadFile');
      if (!fileInput.files[0]) return;
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      await fetch(`/api/certificates/${certId}/documents`, { method: 'POST', credentials: 'include', body: fd });
      toast('Document attached.');
      openDocsModal(certId);
      await loadAndRenderCertificates();
    });
  }

  // ---------- Engagements ----------
  async function renderEngagements(main) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<h2>Engagements & Documents</h2><p class="muted">Loading...</p>';
    main.appendChild(panel);
    const engagements = await api('/engagements');
    panel.innerHTML = `<h2>Engagements & Documents (${engagements.length})</h2>`;
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Folder</th><th>Files</th><th>Ready</th><th></th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    engagements.forEach((e, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${e.folder_name}</td><td>${e.file_count}</td><td>${e.ready_count}/${e.file_count} ready</td>
        <td><button class="btn small" data-view-eng="${e.id}">View files</button></td>`;
      tbody.appendChild(tr);
    });
    panel.appendChild(table);
    table.querySelectorAll('[data-view-eng]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const detail = await api(`/engagements/${btn.dataset.viewEng}/files`);
        alert(
          detail.files
            .map((f) => `${f.relative_path} - ${f.embedded ? 'Ready' : 'Folder only - Not embedded'}`)
            .join('\n') || 'No files in this folder.'
        );
      });
    });
  }

  // ---------- Client Requests (admin) ----------
  async function renderClientRequestsAdmin(main) {
    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = '<h2>Client Requests</h2><p class="muted">Loading...</p>';
    main.appendChild(panel);
    const requests = await api('/draft-requests');
    panel.innerHTML = `<h2>Client Requests (${requests.length})</h2>`;
    if (requests.length === 0) {
      panel.innerHTML += '<div class="empty-state">No requests yet.</div>';
      return;
    }
    requests.forEach((r) => {
      const card = document.createElement('div');
      card.className = 'panel';
      card.innerHTML = `
        <strong>${r.request_type.toUpperCase()}</strong> from ${r.submitted_by}
        <span class="badge badge-${r.status === 'pending' ? 'pending' : r.status === 'in_review' ? 'review' : 'delivered'}">${r.status}</span>
        ${r.auto_drafted ? '<span class="badge" style="background:#ede9fe;color:#5b21b6">AI-drafted, sent without review</span>' : ''}
        ${r.auto_draft_error ? `<p class="error">Auto-draft attempt failed, fell back to manual queue: ${r.auto_draft_error}</p>` : ''}
        <p>${r.notes || ''}</p>
        <p class="muted">Category: ${r.category || 'n/a'} | Matched template: ${r.matched_certificate_id ? '#' + r.matched_certificate_id : 'none found'}</p>
        <div>
          ${r.nit_file_id ? `<span class="muted">NIT uploaded</span>` : ''}
          ${r.status === 'pending' ? `<button class="btn small" data-review="${r.id}">Mark in review</button>` : ''}
          ${r.status !== 'delivered' ? `<button class="btn small" data-deliver="${r.id}">Upload & deliver</button>` : `<span class="muted">Delivered${r.auto_drafted ? ' (by AI)' : ''} — </span><button class="btn small" data-deliver="${r.id}">Replace with your own draft</button>`}
        </div>`;
      panel.appendChild(card);
      const reviewBtn = card.querySelector('[data-review]');
      if (reviewBtn) {
        reviewBtn.addEventListener('click', async () => {
          await api(`/draft-requests/${r.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'in_review' }) });
          renderActiveTab();
        });
      }
      const deliverBtn = card.querySelector('[data-deliver]');
      if (deliverBtn) {
        deliverBtn.addEventListener('click', async () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.onchange = async () => {
            if (!input.files[0]) return;
            const fd = new FormData();
            fd.append('result', input.files[0]);
            await fetch(`/api/draft-requests/${r.id}/deliver`, { method: 'POST', credentials: 'include', body: fd });
            toast('Delivered to client portal.');
            renderActiveTab();
          };
          input.click();
        });
      }
    });
  }

  // ---------- Client portal ----------
  async function renderClientPortal() {
    const main = document.getElementById('clientMainContent');
    main.innerHTML = '<div class="panel"><h2>Submit a request</h2></div>';
    const formPanel = main.querySelector('.panel');
    formPanel.innerHTML = `
      <h2>Submit a request</h2>
      <form id="clientRequestForm">
        <label>Type
          <select id="reqType"><option value="certificate">Certificate</option><option value="mrl">MRL</option></select>
        </label><br/>
        <label>Category (optional)<input type="text" id="reqCategory" /></label><br/>
        <label>Notice Inviting Tender (NIT) file<input type="file" id="reqFile" /></label><br/>
        <label>Notes<textarea id="reqNotes"></textarea></label><br/>
        <button class="btn primary" type="submit">Submit request</button>
      </form>`;
    formPanel.querySelector('#clientRequestForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData();
      fd.append('request_type', formPanel.querySelector('#reqType').value);
      fd.append('category', formPanel.querySelector('#reqCategory').value);
      fd.append('notes', formPanel.querySelector('#reqNotes').value);
      const file = formPanel.querySelector('#reqFile').files[0];
      if (file) fd.append('nit', file);
      const res = await fetch('/api/draft-requests', { method: 'POST', credentials: 'include', body: fd });
      if (!res.ok) return toast('Failed to submit request.');
      toast('Request submitted.');
      formPanel.querySelector('form').reset();
      renderClientPortal();
    });

    const requestsPanel = document.createElement('div');
    requestsPanel.className = 'panel';
    const requests = await api('/draft-requests/mine');
    requestsPanel.innerHTML = `<h2>Your requests</h2>` + (requests.length
      ? `<table><thead><tr><th>Type</th><th>Status</th><th></th></tr></thead><tbody>
          ${requests.map((r) => `<tr><td>${r.request_type}</td>
            <td><span class="badge badge-${r.status === 'pending' ? 'pending' : r.status === 'in_review' ? 'review' : 'delivered'}">${r.status.replace('_', ' ')}</span>
              ${r.auto_drafted ? '<br/><span class="muted">Auto-drafted — please have it reviewed before relying on it.</span>' : ''}</td>
            <td>${r.status === 'delivered' && r.result_file_id ? `<a class="btn small" href="/api/draft-requests/${r.id}/result" target="_blank">Download</a>` : ''}</td>
          </tr>`).join('')}
        </tbody></table>`
      : '<div class="empty-state">No requests yet.</div>');
    main.appendChild(requestsPanel);

    const certPanel = document.createElement('div');
    certPanel.className = 'panel';
    const certs = await api('/client-portal/certificates');
    certPanel.innerHTML = `<h2>Your certificates & documents</h2>` + (certs.length
      ? `<table><thead><tr><th>Particulars</th><th>Category</th><th>FY</th><th>Documents</th></tr></thead><tbody>
          ${certs.map((c) => `<tr><td>${c.particulars || '-'}</td><td>${c.category || '-'}</td><td>${c.fy || '-'}</td>
            <td>${c.documents.map((d) => `<a href="/api/client-portal/documents/${d.sha256}/download">${d.display_name || d.original_name}</a>`).join('<br/>') || '-'}</td>
          </tr>`).join('')}
        </tbody></table>`
      : '<div class="empty-state">Nothing shared with you yet.</div>');
    main.appendChild(certPanel);
  }

  boot();
})();
