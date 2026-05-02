// resident.js — resident dashboard logic (polling-based for Cloudflare)
let me = null;
let pendingWalkins = [];
let activeWalkin = null;
let lastPendingIds = new Set();
let lastVisitsCount = 0;

const POLL_MS = 3000;

(async function init() {
  me = await requireMe('resident');
  if (!me) return;

  document.getElementById('who').innerHTML = `<strong>${me.name}</strong> · ${me.flat}`;

  // Default expected_at to "now + 1 hour" rounded to 5min
  const dt = new Date(Date.now() + 60 * 60 * 1000);
  dt.setSeconds(0); dt.setMilliseconds(0);
  dt.setMinutes(Math.ceil(dt.getMinutes() / 5) * 5);
  document.querySelector('input[name="expected_at"]').value =
    new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0,16);

  setupTabs();
  setupInviteForm();
  setupQrModal();
  setupWalkinModal();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  await refreshAll();
  // Start polling for pending walk-ins (and detect invite check-ins / checkouts)
  startPolling();
})();

function setupTabs() {
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(s => s.style.display = 'none');
      document.getElementById('tab-' + tab).style.display = '';
      if (tab === 'list') loadInvites();
      if (tab === 'history') loadHistory();
    });
  });
}

function setupInviteForm() {
  const form = document.getElementById('invite-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.expected_at) data.expected_at = new Date(data.expected_at).toISOString();
    try {
      const submitBtn = form.querySelector('button[type="submit"]');
      submitBtn.disabled = true; submitBtn.textContent = 'Generating…';
      const res = await api.post('/api/invites', data);
      submitBtn.disabled = false; submitBtn.textContent = 'Generate QR';
      form.reset();
      const dt = new Date(Date.now() + 60 * 60 * 1000);
      dt.setSeconds(0); dt.setMilliseconds(0);
      dt.setMinutes(Math.ceil(dt.getMinutes() / 5) * 5);
      document.querySelector('input[name="expected_at"]').value =
        new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0,16);
      showQrModal(res.invite, res.qr_token);
    } catch (err) {
      toast('Could not create invite: ' + err.message, 'error');
    }
  });
}

function setupQrModal() {
  document.getElementById('qr-close').onclick = () => {
    document.getElementById('qr-modal').classList.remove('show');
  };
  document.getElementById('qr-share').onclick = async () => {
    const img = document.getElementById('qr-img');
    const meta = document.getElementById('qr-meta').textContent;
    const text = `Hi! I've invited you to ${me.flat}. Show this QR at the gate. ${meta}`;
    try {
      const blob = await (await fetch(img.src)).blob();
      const file = new File([blob], 'visitor-qr.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Visitor QR', text }); return;
      }
      if (navigator.share) { await navigator.share({ title: 'Visitor QR', text }); return; }
    } catch {}
    try { await navigator.clipboard.writeText(text); toast('Message copied. Save the QR image.', 'success'); }
    catch { toast('Long-press the QR to save it.', ''); }
  };
}

function showQrModal(invite, qr_token) {
  const img = document.getElementById('qr-img');
  renderQrToImg(img, qr_token, 320);
  document.getElementById('qr-visitor').textContent = `${invite.visitor_name} · ${invite.visit_type}`;
  document.getElementById('qr-meta').textContent =
    `Expected ${fmtDateTime(invite.expected_at)} · valid until ${fmtDateTime(invite.valid_until)}`;
  document.getElementById('qr-modal').classList.add('show');
}

async function refreshAll() {
  await Promise.all([loadInvites(), loadHistory(), loadPendingWalkins()]);
}

async function loadInvites() {
  let rows;
  try { rows = await api.get('/api/invites'); } catch { return; }
  const el = document.getElementById('invite-list');
  if (!rows.length) { el.innerHTML = '<div class="empty">No invites yet.</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="list-item">
      <div class="row between">
        <div>
          <div class="title">${r.visitor_name}</div>
          <div class="meta">
            ${r.visit_type} · expected ${fmtDateTime(r.expected_at)}
            ${r.visitor_phone ? '· ' + r.visitor_phone : ''}
          </div>
        </div>
        <span class="badge ${r.status}">${r.status}</span>
      </div>
      <div class="row" style="margin-top:10px; gap:6px">
        ${r.status === 'active' ? `
          <button class="secondary" data-show="${r.id}">Show QR</button>
          <button class="secondary" data-cancel="${r.id}">Cancel</button>
        ` : ''}
      </div>
    </div>
  `).join('');

  el.querySelectorAll('button[data-show]').forEach(b => {
    b.onclick = async () => {
      try {
        const res = await api.get(`/api/invites/${b.dataset.show}/qr`);
        showQrModal(res.invite, res.qr_token);
      } catch (e) { toast(e.message, 'error'); }
    };
  });
  el.querySelectorAll('button[data-cancel]').forEach(b => {
    b.onclick = async () => {
      if (!confirm('Cancel this invite?')) return;
      try {
        await api.post(`/api/invites/${b.dataset.cancel}/cancel`);
        toast('Invite cancelled', '');
        loadInvites();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}

async function loadHistory() {
  let rows;
  try { rows = await api.get('/api/visits'); } catch { return; }
  const el = document.getElementById('history-list');
  if (!rows.length) { el.innerHTML = '<div class="empty">No visits yet.</div>'; return; }
  // Detect new visits since last poll → notification
  if (rows.length > lastVisitsCount && lastVisitsCount > 0) {
    const fresh = rows.slice(0, rows.length - lastVisitsCount);
    for (const v of fresh) {
      if (!v.check_out_at) {
        toast(`${v.visitor_name} checked in`, 'success');
        notify('Visitor arrived', `${v.visitor_name} just checked in.`);
      }
    }
  }
  lastVisitsCount = rows.length;
  el.innerHTML = rows.map(r => `
    <div class="list-item">
      <div class="title">${r.visitor_name}</div>
      <div class="meta">
        ${r.visit_type || 'Visit'} ${r.kind === 'walkin' ? '· walk-in' : '· pre-invite'} ·
        in ${fmtDateTime(r.check_in_at)}
        ${r.check_out_at ? '· out ' + fmtTime(r.check_out_at) : '· still inside'}
        ${r.vehicle_number ? '· vehicle ' + r.vehicle_number : ''}
      </div>
    </div>
  `).join('');
}

async function loadPendingWalkins() {
  let rows;
  try { rows = await api.get('/api/walkins/pending'); } catch { return; }
  const newIds = new Set(rows.map(w => w.id));
  // Detect newly arrived walkins (in new but not in last)
  const fresh = rows.filter(w => !lastPendingIds.has(w.id));
  for (const w of fresh) {
    toast(`Visitor at the gate: ${w.visitor_name}`, '');
    notify('Visitor at the gate',
      `${w.visitor_name} (${w.visit_type}) is at the gate. Tap to approve or reject.`);
  }
  pendingWalkins = rows;
  lastPendingIds = newIds;
  renderBanner();
  // Auto-open modal for the most recent if no modal is currently open
  if (fresh.length && !document.querySelector('.modal-backdrop.show')) {
    openWalkinModal(fresh[0]);
  }
}

function renderBanner() {
  const slot = document.getElementById('banner-slot');
  if (!pendingWalkins.length) { slot.innerHTML = ''; return; }
  const w = pendingWalkins[0];
  slot.innerHTML = `
    <div class="banner">
      <div>
        <div>${pendingWalkins.length} visitor${pendingWalkins.length>1?'s':''} waiting at the gate</div>
        <div style="font-weight:400; font-size:13px; margin-top:2px">
          ${w.visitor_name} · ${w.visit_type}
        </div>
      </div>
      <button id="open-walkin">Review</button>
    </div>
  `;
  document.getElementById('open-walkin').onclick = () => openWalkinModal(w);
}

function setupWalkinModal() {
  document.getElementById('walkin-approve').onclick = () => decide('approve');
  document.getElementById('walkin-reject').onclick = () => decide('reject');
}

function openWalkinModal(w) {
  activeWalkin = w;
  document.getElementById('walkin-content').innerHTML = `
    ${w.photo_data_url ? `<img class="photo-preview" src="${w.photo_data_url}" alt="visitor photo" />` : ''}
    <div style="font-size:18px; font-weight:600">${w.visitor_name}</div>
    <div class="muted" style="margin-top:4px">
      ${w.visit_type}${w.visitor_phone ? ' · ' + w.visitor_phone : ''}
      ${w.vehicle_number ? '<br/>Vehicle: <strong>' + w.vehicle_number + '</strong>' : ''}
    </div>
  `;
  document.getElementById('walkin-modal').classList.add('show');
}

async function decide(decision) {
  if (!activeWalkin) return;
  try {
    await api.post(`/api/walkins/${activeWalkin.id}/decide`, { decision });
    pendingWalkins = pendingWalkins.filter(w => w.id !== activeWalkin.id);
    lastPendingIds.delete(activeWalkin.id);
    document.getElementById('walkin-modal').classList.remove('show');
    activeWalkin = null;
    renderBanner();
    toast(decision === 'approve' ? 'Approved' : 'Rejected',
          decision === 'approve' ? 'success' : '');
    if (decision === 'approve') loadHistory();
    if (pendingWalkins.length) setTimeout(() => openWalkinModal(pendingWalkins[0]), 400);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function startPolling() {
  setInterval(() => {
    loadPendingWalkins();
    // Refresh history every 4th tick (~12s) so check-ins show up
    if (((Date.now() / POLL_MS) | 0) % 4 === 0) loadHistory();
  }, POLL_MS);
}
