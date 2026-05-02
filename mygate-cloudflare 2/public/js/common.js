// common.js — small utilities used across pages
window.api = {
  async get(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) {
      let data = {}; try { data = await r.json(); } catch {}
      throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
    }
    return r.json();
  },
  async post(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = {}; try { data = await r.json(); } catch {}
    if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data, status: r.status });
    return data;
  },
};

window.toast = function (msg, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(window.__toastT);
  window.__toastT = setTimeout(() => { el.className = 'toast'; }, 3000);
};

window.fmtDateTime = function (iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit'
  });
};

window.fmtTime = function (iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

window.requireMe = async function (expectedRole) {
  try {
    const { user } = await window.api.get('/api/me');
    if (expectedRole && user.role !== expectedRole) {
      location.href = '/';
      return null;
    }
    return user;
  } catch {
    location.href = '/';
    return null;
  }
};

window.logout = async function () {
  try { await window.api.post('/api/logout'); } catch {}
  location.href = '/';
};

// Native browser notification helper (no service worker required)
window.notify = async function (title, body, opts = {}) {
  try {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      new Notification(title, { body, ...opts });
    } else if (Notification.permission !== 'denied') {
      const p = await Notification.requestPermission();
      if (p === 'granted') new Notification(title, { body, ...opts });
    }
  } catch {}
};

// Render a QR code into an <img> from a token, using the qrcode library
// loaded from a CDN (loaded inline by pages that need it).
window.renderQrToImg = function (img, token, sizePx = 320) {
  if (!window.QRCode) { console.warn('QRCode lib not loaded'); return; }
  const canvas = document.createElement('canvas');
  window.QRCode.toCanvas(canvas, token, { margin: 1, width: sizePx }, (err) => {
    if (err) { console.error(err); return; }
    img.src = canvas.toDataURL('image/png');
  });
};
