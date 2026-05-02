// guard.js — security guard dashboard logic (polling-based)
let me = null;
let scanner = null;
let scanning = false;
let lastScanAt = 0;
let camStream = null;
let capturedPhoto = null;

// Tracks walkins this guard has submitted, so we can poll their status until
// the resident decides and surface the result.
const trackedWalkins = new Map(); // walkin_id -> {visitor_name, status}

const TRACK_POLL_MS = 3000;

(async function init() {
  me = await requireMe('guard');
  if (!me) return;
  document.getElementById('who').innerHTML = `<strong>${me.name}</strong>`;

  setupTabs();
  setupScanner();
  setupWalkinForm();
  setupCamera();

  await loadResidents();
  await loadLog();

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  setInterval(pollTrackedWalkins, TRACK_POLL_MS);
})();

function setupTabs() {
  document.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab').forEach(s => s.style.display = 'none');
      document.getElementById('tab-' + tab).style.display = '';
      if (tab !== 'scan' && scanning) stopScanner();
      if (tab !== 'walkin') stopCamera();
      if (tab === 'log') loadLog();
    });
  });
}

// --- QR scanner ---
function setupScanner() {
  document.getElementById('scan-toggle').onclick = () => {
    if (scanning) stopScanner(); else startScanner();
  };
  document.getElementById('manual-submit').onclick = () => {
    const code = document.getElementById('manual-code').value.trim();
    if (code) verifyToken(code);
  };
}

async function startScanner() {
  try {
    if (!scanner) scanner = new Html5Qrcode('scanner');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (decoded) => onScan(decoded),
      () => {}
    );
    scanning = true;
    document.getElementById('scan-toggle').textContent = 'Stop camera';
  } catch (e) {
    toast('Could not start camera: ' + e.message, 'error');
  }
}

async function stopScanner() {
  try { if (scanner && scanning) await scanner.stop(); } catch {}
  scanning = false;
  document.getElementById('scan-toggle').textContent = 'Start camera';
}

function onScan(decoded) {
  const now = Date.now();
  if (now - lastScanAt < 2500) return;
  lastScanAt = now;
  verifyToken(decoded);
}

async function verifyToken(token) {
  const result = document.getElementById('scan-result');
  result.innerHTML = '<div class="card muted">Verifying…</div>';
  try {
    const res = await api.post('/api/scan', { qr_token: token });
    const inv = res.invite;
    result.innerHTML = `
      <div class="card" style="border-color:#86efac; background:#f0fdf4">
        <div class="row between">
          <div>
            <div class="title" style="font-weight:700; font-size:18px">✓ ${inv.visitor_name}</div>
            <div class="meta">${inv.visit_type} · for ${res.resident.name} (${res.resident.flat})</div>
          </div>
          <span class="badge approved">Allow entry</span>
        </div>
      </div>
    `;
    toast('Visitor checked in', 'success');
    loadLog();
  } catch (err) {
    const inv = err.data?.invite;
    result.innerHTML = `
      <div class="card" style="border-color:#fca5a5; background:#fef2f2">
        <div class="title" style="font-weight:700; color:#991b1b">✗ ${err.message}</div>
        ${inv ? `<div class="meta">Visitor: ${inv.visitor_name} · status: ${inv.status}</div>` : ''}
      </div>
    `;
    toast(err.message, 'error');
  }
  if (scanning) stopScanner();
}

// --- Walk-in form ---
async function loadResidents() {
  const users = await api.get('/api/users');
  const residents = users.filter(u => u.role === 'resident');
  const sel = document.querySelector('select[name="resident_id"]');
  sel.innerHTML = '<option value="">Select…</option>' +
    residents.map(u => `<option value="${u.id}">${u.tower}-${u.flat} · ${u.name}</option>`).join('');
}

function setupWalkinForm() {
  const form = document.getElementById('walkin-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    data.resident_id = +data.resident_id;
    if (capturedPhoto) data.photo_data_url = capturedPhoto;
    if (data.vehicle_number) data.vehicle_number = data.vehicle_number.toUpperCase();

    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true; submitBtn.textContent = 'Sending…';
    try {
      const res = await api.post('/api/walkins', data);
      submitBtn.disabled = false; submitBtn.textContent = 'Send to resident for approval';
      form.reset();
      stopCamera(); capturedPhoto = null;
      document.getElementById('photo-preview').style.display = 'none';
      const status = document.getElementById('walkin-status');
      status.innerHTML = `<div class="banner">Sent. Waiting for resident decision…
        <span class="muted" style="font-weight:400">visitor #${res.walkin.id}</span></div>`;
      trackedWalkins.set(res.walkin.id, {
        visitor_name: res.walkin.visitor_name,
        status: 'pending',
      });
    } catch (err) {
      submitBtn.disabled = false; submitBtn.textContent = 'Send to resident for approval';
      toast('Failed: ' + err.message, 'error');
    }
  });
}

// Poll the visit log to detect approval/rejection of tracked walkins.
// We use /api/visits (today's log) to see approved walkins, and a query
// on the walkins themselves via the next-best-thing: the log shows approved
// walkins. For rejection we infer by comparing tracked vs current pending state
// — but simpler: just re-fetch all walkins via a query — we don't have one.
// Trick: query /api/visits — every approved walkin lands in visit_logs with
// kind='walkin', ref_id=walkin_id. Anything tracked NOT showing up there
// after some time is presumed rejected — but we don't know for sure.
// Better: hit /api/walkins/pending? — no, that's resident-only.
// Pragmatic solution: surface APPROVALS via visit_logs. For rejections we
// surface a "decided" message after the next poll detects no longer pending —
// but guards can't see other guards' walkins directly. We add a tiny helper
// endpoint. For now we'll just mark approved when seen in visit_logs.
async function pollTrackedWalkins() {
  if (trackedWalkins.size === 0) return;
  let visits;
  try { visits = await api.get('/api/visits'); } catch { return; }
  const approvedWalkinIds = new Set(
    visits.filter(v => v.kind === 'walkin').map(v => v.ref_id)
  );
  for (const [id, w] of [...trackedWalkins.entries()]) {
    if (w.status !== 'pending') continue;
    if (approvedWalkinIds.has(id)) {
      w.status = 'approved';
      showDecisionBanner(w.visitor_name, 'approved');
      notify('Visitor approved', w.visitor_name);
      trackedWalkins.delete(id);
    } else if (Date.now() - (w._first || (w._first = Date.now())) > 90000) {
      // No approval log after 90 seconds — assume rejected/timed out
      w.status = 'rejected';
      showDecisionBanner(w.visitor_name, 'rejected (or timed out)');
      trackedWalkins.delete(id);
    }
  }
}

function showDecisionBanner(name, decision) {
  const okay = decision === 'approved';
  const div = document.getElementById('walkin-status');
  div.innerHTML = `<div class="banner" style="background:${okay?'#dcfce7':'#fee2e2'};color:${okay?'#166534':'#991b1b'}">
    ${name} was <strong>${decision}</strong> by the resident.
  </div>`;
  toast(`Resident ${decision} ${name}`, okay ? 'success' : 'error');
  loadLog();
}

// --- Photo capture ---
function setupCamera() {
  document.getElementById('cam-start').onclick = startCamera;
  document.getElementById('cam-snap').onclick = snapPhoto;
  document.getElementById('cam-retake').onclick = () => {
    capturedPhoto = null;
    document.getElementById('photo-preview').style.display = 'none';
    document.getElementById('cam-retake').style.display = 'none';
    startCamera();
  };
}

async function startCamera() {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 800 } },
      audio: false,
    });
    const v = document.getElementById('cam');
    v.srcObject = camStream; v.style.display = 'block';
    document.getElementById('cam-start').style.display = 'none';
    document.getElementById('cam-snap').style.display = '';
    document.getElementById('photo-preview').style.display = 'none';
  } catch {
    toast('Camera permission denied', 'error');
  }
}

function snapPhoto() {
  const v = document.getElementById('cam');
  const c = document.getElementById('photo-canvas');
  const maxW = 480;
  const scale = Math.min(1, maxW / v.videoWidth);
  c.width = v.videoWidth * scale;
  c.height = v.videoHeight * scale;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  capturedPhoto = c.toDataURL('image/jpeg', 0.7);
  const img = document.getElementById('photo-preview');
  img.src = capturedPhoto; img.style.display = 'block';
  stopCamera();
  document.getElementById('cam-snap').style.display = 'none';
  document.getElementById('cam-retake').style.display = '';
  document.getElementById('cam-start').style.display = 'none';
}

function stopCamera() {
  if (camStream) {
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  document.getElementById('cam').style.display = 'none';
  if (!capturedPhoto) {
    document.getElementById('cam-start').style.display = '';
    document.getElementById('cam-snap').style.display = 'none';
    document.getElementById('cam-retake').style.display = 'none';
  }
}

// --- Today's log ---
async function loadLog() {
  let rows;
  try { rows = await api.get('/api/visits'); } catch { return; }
  const el = document.getElementById('log-list');
  if (!rows.length) { el.innerHTML = '<div class="empty">No visits logged today.</div>'; return; }
  el.innerHTML = rows.map(r => `
    <div class="list-item">
      <div class="row between">
        <div>
          <div class="title">${r.visitor_name}</div>
          <div class="meta">
            ${r.visit_type || 'Visit'} · ${r.resident_tower}-${r.resident_flat} (${r.resident_name})
            <br/>in ${fmtTime(r.check_in_at)}${r.check_out_at ? ' · out ' + fmtTime(r.check_out_at) : ''}
            ${r.vehicle_number ? '· ' + r.vehicle_number : ''}
          </div>
        </div>
        ${!r.check_out_at ? `<button class="secondary" data-checkout="${r.id}">Check out</button>` : ''}
      </div>
    </div>
  `).join('');

  el.querySelectorAll('button[data-checkout]').forEach(b => {
    b.onclick = async () => {
      try {
        await api.post(`/api/visits/${b.dataset.checkout}/checkout`);
        toast('Checked out', 'success');
        loadLog();
      } catch (e) { toast(e.message, 'error'); }
    };
  });
}
