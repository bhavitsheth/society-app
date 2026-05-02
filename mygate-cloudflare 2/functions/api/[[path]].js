// Cloudflare Pages Function — handles all /api/* routes
// Bindings (configured in Cloudflare dashboard):
//   env.DB  → D1 database

const ALLOWED_VISIT_TYPES = ['Guest', 'Delivery', 'Cab', 'Service'];

// ---------- Utilities ----------
const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });

const err = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);

function parseCookies(req) {
  const out = {};
  const h = req.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

function setCookieHeader(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push('Path=/');
  parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.secure !== false) parts.push('Secure');
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getUser(req, env) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const row = await env.DB.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).bind(sid).first();
  return row || null;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------- Route handlers ----------
const routes = [
  // --- Public ---
  ['GET',  /^\/api\/users$/,                   listUsers],
  ['POST', /^\/api\/login$/,                   login],
  ['POST', /^\/api\/logout$/,                  logout],
  ['GET',  /^\/api\/me$/,                      me],

  // --- Resident ---
  ['POST', /^\/api\/invites$/,                 createInvite],
  ['GET',  /^\/api\/invites$/,                 listInvites],
  ['GET',  /^\/api\/invites\/(\d+)\/qr$/,      getInviteQr],
  ['POST', /^\/api\/invites\/(\d+)\/cancel$/,  cancelInvite],
  ['GET',  /^\/api\/walkins\/pending$/,        listPendingWalkins],
  ['POST', /^\/api\/walkins\/(\d+)\/decide$/,  decideWalkin],

  // --- Guard ---
  ['POST', /^\/api\/scan$/,                    scanQr],
  ['POST', /^\/api\/walkins$/,                 createWalkin],
  ['POST', /^\/api\/visits\/(\d+)\/checkout$/, checkoutVisit],

  // --- Either ---
  ['GET',  /^\/api\/visits$/,                  listVisits],
];

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  for (const [method, pattern, handler] of routes) {
    if (request.method !== method) continue;
    const m = url.pathname.match(pattern);
    if (m) {
      try {
        return await handler(request, env, m);
      } catch (e) {
        console.error(e);
        return err('Server error: ' + (e.message || e), 500);
      }
    }
  }
  return err('Not found', 404);
}

// ---------- Handlers ----------
async function listUsers(req, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, role, tower, flat FROM users ORDER BY role, tower, flat`
  ).all();
  return json(results || []);
}

async function login(req, env) {
  const body = await req.json().catch(() => ({}));
  const userId = +body.userId;
  if (!userId) return err('Missing userId');
  const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first();
  if (!user) return err('Unknown user');
  const token = randomHex(24);
  await env.DB.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).bind(token, user.id).run();
  return json({ user }, 200, {
    'Set-Cookie': setCookieHeader('sid', token, { maxAge: 60 * 60 * 24 * 30 }),
  });
}

async function logout(req, env) {
  const sid = parseCookies(req).sid;
  if (sid) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(sid).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookieHeader('sid') });
}

async function me(req, env) {
  const u = await getUser(req, env);
  if (!u) return err('Not logged in', 401);
  return json({ user: u });
}

async function createInvite(req, env) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  const body = await req.json().catch(() => ({}));
  const { visitor_name, visitor_phone, visit_type, expected_at, notes } = body;
  if (!visitor_name || !visit_type || !expected_at) return err('Missing required fields');
  if (!ALLOWED_VISIT_TYPES.includes(visit_type)) return err('Bad visit_type');
  const expected = new Date(expected_at);
  if (isNaN(expected)) return err('Bad expected_at');
  const validUntil = new Date(expected.getTime() + 2 * 60 * 60 * 1000);
  const qrToken = randomHex(16);
  const r = await env.DB.prepare(`
    INSERT INTO invites (resident_id, visitor_name, visitor_phone, visit_type,
      expected_at, valid_until, qr_token, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(u.id, visitor_name, visitor_phone || null, visit_type,
          expected.toISOString(), validUntil.toISOString(), qrToken, notes || null
  ).first();
  return json({ invite: r, qr_token: qrToken });
}

async function listInvites(req, env) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  // Auto-expire stale before listing
  await env.DB.prepare(
    `UPDATE invites SET status='expired'
     WHERE resident_id = ? AND status='active' AND datetime(valid_until) < datetime('now')`
  ).bind(u.id).run();
  const { results } = await env.DB.prepare(
    `SELECT * FROM invites WHERE resident_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(u.id).all();
  return json(results || []);
}

async function getInviteQr(req, env, m) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  const inv = await env.DB.prepare(
    `SELECT * FROM invites WHERE id = ? AND resident_id = ?`
  ).bind(+m[1], u.id).first();
  if (!inv) return err('Not found', 404);
  return json({ invite: inv, qr_token: inv.qr_token });
}

async function cancelInvite(req, env, m) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  const inv = await env.DB.prepare(
    `SELECT * FROM invites WHERE id = ? AND resident_id = ?`
  ).bind(+m[1], u.id).first();
  if (!inv) return err('Not found', 404);
  if (inv.status !== 'active') return err('Not active');
  await env.DB.prepare(`UPDATE invites SET status='cancelled' WHERE id = ?`).bind(inv.id).run();
  return json({ ok: true });
}

async function scanQr(req, env) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'guard') return err('Forbidden', 403);
  const { qr_token } = await req.json().catch(() => ({}));
  if (!qr_token) return err('Missing qr_token');
  const inv = await env.DB.prepare(`SELECT * FROM invites WHERE qr_token = ?`).bind(qr_token).first();
  if (!inv) return err('Invalid QR code', 404);
  if (inv.status === 'used')      return err('QR already used',  409, { invite: inv });
  if (inv.status === 'cancelled') return err('Invite cancelled', 409, { invite: inv });
  if (new Date(inv.valid_until) < new Date()) {
    await env.DB.prepare(`UPDATE invites SET status='expired' WHERE id = ?`).bind(inv.id).run();
    return err('QR expired', 409, { invite: { ...inv, status: 'expired' } });
  }
  const now = nowIso();
  await env.DB.prepare(`UPDATE invites SET status='used', used_at=? WHERE id = ?`).bind(now, inv.id).run();
  const logRow = await env.DB.prepare(`
    INSERT INTO visit_logs (kind, ref_id, resident_id, guard_id, visitor_name, visit_type, check_in_at)
    VALUES ('invite', ?, ?, ?, ?, ?, ?) RETURNING id
  `).bind(inv.id, inv.resident_id, u.id, inv.visitor_name, inv.visit_type, now).first();
  const resident = await env.DB.prepare(
    `SELECT name, tower, flat FROM users WHERE id = ?`
  ).bind(inv.resident_id).first();
  return json({ ok: true, log_id: logRow.id, invite: inv, resident });
}

async function createWalkin(req, env) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'guard') return err('Forbidden', 403);
  const body = await req.json().catch(() => ({}));
  const { resident_id, visitor_name, visitor_phone, visit_type,
          vehicle_number, photo_data_url, notes } = body;
  if (!resident_id || !visitor_name || !visit_type) return err('Missing required fields');
  if (!ALLOWED_VISIT_TYPES.includes(visit_type)) return err('Bad visit_type');
  const r = await env.DB.prepare(
    `SELECT id FROM users WHERE id = ? AND role = 'resident'`
  ).bind(+resident_id).first();
  if (!r) return err('Unknown resident');
  const w = await env.DB.prepare(`
    INSERT INTO walkins (guard_id, resident_id, visitor_name, visitor_phone,
      visit_type, vehicle_number, photo_data_url, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `).bind(u.id, +resident_id, visitor_name, visitor_phone || null,
          visit_type, vehicle_number || null, photo_data_url || null, notes || null
  ).first();
  return json({ walkin: w });
}

async function listPendingWalkins(req, env) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  const { results } = await env.DB.prepare(
    `SELECT * FROM walkins WHERE resident_id = ? AND status = 'pending' ORDER BY created_at DESC`
  ).bind(u.id).all();
  return json(results || []);
}

async function decideWalkin(req, env, m) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'resident') return err('Forbidden', 403);
  const { decision, notes } = await req.json().catch(() => ({}));
  if (!['approve', 'reject'].includes(decision)) return err('decision must be approve or reject');
  const w = await env.DB.prepare(
    `SELECT * FROM walkins WHERE id = ? AND resident_id = ?`
  ).bind(+m[1], u.id).first();
  if (!w) return err('Not found', 404);
  if (w.status !== 'pending') return err('Already decided');
  const now = nowIso();
  const newStatus = decision === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare(
    `UPDATE walkins SET status=?, decided_at=?, notes=COALESCE(?, notes) WHERE id = ?`
  ).bind(newStatus, now, notes || null, w.id).run();
  if (decision === 'approve') {
    await env.DB.prepare(`
      INSERT INTO visit_logs (kind, ref_id, resident_id, guard_id, visitor_name,
        vehicle_number, visit_type, check_in_at)
      VALUES ('walkin', ?, ?, ?, ?, ?, ?, ?)
    `).bind(w.id, w.resident_id, w.guard_id, w.visitor_name,
            w.vehicle_number, w.visit_type, now).run();
  }
  return json({ ok: true, status: newStatus });
}

async function listVisits(req, env) {
  const u = await getUser(req, env);
  if (!u) return err('Not logged in', 401);
  let results;
  if (u.role === 'resident') {
    ({ results } = await env.DB.prepare(`
      SELECT v.*, g.name AS guard_name
      FROM visit_logs v
      LEFT JOIN users g ON g.id = v.guard_id
      WHERE v.resident_id = ?
      ORDER BY v.check_in_at DESC LIMIT 100
    `).bind(u.id).all());
  } else {
    ({ results } = await env.DB.prepare(`
      SELECT v.*, r.name AS resident_name, r.tower AS resident_tower, r.flat AS resident_flat
      FROM visit_logs v
      JOIN users r ON r.id = v.resident_id
      WHERE date(v.check_in_at) = date('now')
      ORDER BY v.check_in_at DESC LIMIT 200
    `).all());
  }
  return json(results || []);
}

async function checkoutVisit(req, env, m) {
  const u = await getUser(req, env);
  if (!u || u.role !== 'guard') return err('Forbidden', 403);
  const log = await env.DB.prepare(`SELECT * FROM visit_logs WHERE id = ?`).bind(+m[1]).first();
  if (!log) return err('Not found', 404);
  if (log.check_out_at) return err('Already checked out');
  await env.DB.prepare(`UPDATE visit_logs SET check_out_at = ? WHERE id = ?`).bind(nowIso(), log.id).run();
  return json({ ok: true });
}
