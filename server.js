'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { open } = require('./lib/db');
const svc = require('./lib/service');
const { seedBase, seedDemo } = require('./lib/seed');
const { HttpError } = svc;

const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
};

/* ---------- tiny in-memory rate limiter (per process; fine for one instance) ---------- */
function makeLimiter() {
  const m = new Map();
  return (key, max, windowMs) => {
    const now = Date.now(); const e = m.get(key);
    if (!e || e.reset < now) { m.set(key, { n: 1, reset: now + windowMs }); if (m.size > 5000) for (const [k, v] of m) if (v.reset < now) m.delete(k); return true; }
    return ++e.n <= max;
  };
}

/* ---------- admin PIN / feed token ---------- */
const hashPin = (pin, salt = crypto.randomBytes(16).toString('hex')) => `${salt}$${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
function checkPin(pin, stored) {
  const [salt, hash] = String(stored).split('$');
  if (!salt || !hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const a = crypto.scryptSync(String(pin), salt, 32); const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const getSetting = async (db, k) => (await db.get('SELECT value FROM settings WHERE key=?', [k]))?.value;
const setSetting = (db, k, v) => db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [k, v]);

async function ensureSecrets(db, log) {
  let announced = null;
  if (process.env.ADMIN_PIN) await setSetting(db, 'admin_pin', hashPin(process.env.ADMIN_PIN));
  else if (!(await getSetting(db, 'admin_pin'))) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    announced = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    await setSetting(db, 'admin_pin', hashPin(announced));
  }
  if (!(await getSetting(db, 'feed_token'))) await setSetting(db, 'feed_token', crypto.randomBytes(24).toString('hex'));
  if (announced) log(`\n  First start — generated ADMIN PIN: ${announced}\n  (set ADMIN_PIN in the environment to choose your own; change it any time in Admin → Settings)\n`);
}

function createApp(db, opts = {}) {
  const limit = makeLimiter();
  const trustProxy = opts.trustProxy ?? process.env.TRUST_PROXY === '1';
  const secureCookie = opts.secureCookie ?? process.env.COOKIE_SECURE === '1';
  let bootCache = { rev: -1, body: '', etag: '' };

  const ipOf = (req) => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const readJson = (req) => new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'JSON required.'));
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 400_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });

  /* --- sessions --- */
  const cookieOf = (req, name) => (req.headers.cookie || '').split(';').map((s) => s.trim().split('=')).find(([k]) => k === name)?.[1];
  async function session(req) {
    const tok = cookieOf(req, 'sid'); if (!tok) return null;
    const row = await db.get('SELECT * FROM sessions WHERE token_hash=?', [svc.sha(tok)]);
    if (!row || row.expires_at < Date.now()) return null;
    return row;
  }
  const requireAdmin = async (req) => { const s = await session(req); if (!s) throw new HttpError(401, 'Administrator sign-in required.'); return s.actor; };
  const feedAuth = async (req, url) => {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
    const real = await getSetting(db, 'feed_token');
    if (!t || t.length !== real.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(real))) {
      if (!(await session(req))) throw new HttpError(401, 'Valid feed token required.');
    }
  };

  /* --- static files --- */
  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/' || rel.startsWith('/e/')) rel = '/index.html';
    if (rel === '/admin') rel = '/admin.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'Not found');
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS };
      if (path.basename(file) === 'sw.js') headers['Service-Worker-Allowed'] = '/';
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
      res.writeHead(200, headers); fs.createReadStream(file).pipe(res);
    });
  }

  async function api(req, res, url) {
    const m = req.method; const p = url.pathname; const ip = ipOf(req);
    if (m === 'POST' || m === 'PUT' || m === 'DELETE') {
      if (!limit(`w:${ip}`, 240, 60_000)) throw new HttpError(429, 'Too many requests — please wait a moment.');
    }

    /* ----- public (staff, no login) ----- */
    if (m === 'GET' && p === '/api/health') return send(res, 200, { ok: true, time: svc.nowIso() });
    if (m === 'GET' && p === '/api/bootstrap') {
      if (bootCache.rev !== svc.getRev()) {
        const body = JSON.stringify(await svc.bootstrap(db));
        bootCache = { rev: svc.getRev(), body, etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
      }
      const h = { ETag: bootCache.etag, 'Cache-Control': 'no-cache' };
      if (req.headers['if-none-match'] === bootCache.etag) { res.writeHead(304, { ...h, ...SECURITY_HEADERS }); return res.end(); }
      return send(res, 200, bootCache.body, { ...h, 'Content-Type': 'application/json; charset=utf-8' });
    }
    if (m === 'POST' && p === '/api/transactions') {
      const out = await svc.createTransaction(db, await readJson(req), { device: req.headers['user-agent'] });
      return send(res, out.replay ? 200 : 201, { ok: true, ...out });
    }
    if (m === 'POST' && p === '/api/undo') {
      if (!limit(`undo:${ip}`, 30, 60_000)) throw new HttpError(429, 'Too many attempts.');
      const b = await readJson(req);
      return send(res, 200, { ok: true, ...(await svc.voidTransaction(db, { public_id: String(b.public_id || '') }, { undoToken: String(b.undo_token || '') })) });
    }

    /* ----- admin auth ----- */
    if (m === 'POST' && p === '/api/admin/login') {
      if (!limit(`login:${ip}`, 8, 10 * 60_000)) throw new HttpError(429, 'Too many sign-in attempts. Try again in a few minutes.');
      const b = await readJson(req);
      if (!checkPin(svc.clean(b.pin, 64), await getSetting(db, 'admin_pin'))) throw new HttpError(401, 'Incorrect PIN.');
      const tok = crypto.randomBytes(32).toString('hex'); const hours = 10;
      await db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]);
      const actor = svc.clean(b.name, 60) || 'Administrator';
      await db.run('INSERT INTO sessions(token_hash,actor,expires_at) VALUES (?,?,?)', [svc.sha(tok), actor, Date.now() + hours * 3600_000]);
      await svc.audit(db, actor, 'admin_login', ip);
      const httpsRequest = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
      const secure = secureCookie && httpsRequest;
      return send(res, 200, { ok: true, actor }, { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${hours * 3600}${secure ? '; Secure' : ''}` });
    }
    if (m === 'POST' && p === '/api/admin/logout') {
      const tok = cookieOf(req, 'sid'); if (tok) await db.run('DELETE FROM sessions WHERE token_hash=?', [svc.sha(tok)]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (m === 'GET' && p === '/api/admin/me') { const s = await session(req); return send(res, s ? 200 : 401, s ? { actor: s.actor } : { error: 'Not signed in.' }); }

    /* ----- read-only feed for dashboards (Power BI / Excel Power Query / SharePoint) ----- */
    if (m === 'GET' && p.startsWith('/api/feed/')) {
      await feedAuth(req, url);
      if (p === '/api/feed/equipment.json') return send(res, 200, { generated_at: svc.nowIso(), equipment: await svc.equipmentFeed(db) });
      if (p === '/api/feed/equipment.csv') return send(res, 200, svc.toCsv(svc.EQUIPMENT_COLS, await svc.equipmentFeed(db)), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="equipment-status.csv"' });
      if (p === '/api/feed/transactions.csv') return send(res, 200, svc.toCsv(svc.TXN_COLS, await svc.listTransactions(db, { limit: 500, offset: 0 })), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="transactions.csv"' });
      throw new HttpError(404, 'Unknown feed.');
    }

    /* ----- everything below needs an admin session ----- */
    if (!p.startsWith('/api/admin/')) throw new HttpError(404, 'Not found.');
    const actor = await requireAdmin(req);
    let mm;

    if (m === 'GET' && p === '/api/admin/overview') return send(res, 200, await svc.overview(db));
    if (m === 'GET' && p === '/api/admin/equipment') return send(res, 200, { equipment: await svc.allEquipment(db), categories: await svc.lookupList(db, 'categories'), locations: await svc.lookupList(db, 'locations') });
    if (m === 'POST' && p === '/api/admin/equipment') return send(res, 201, { ok: true, ...(await svc.createEquipment(db, await readJson(req), actor)) });
    if (m === 'POST' && p === '/api/admin/equipment/import') return send(res, 200, { ok: true, ...(await svc.importEquipment(db, (await readJson(req)).rows, actor)) });
    if (m === 'PUT' && (mm = p.match(/^\/api\/admin\/equipment\/([A-Za-z0-9-]+)$/))) return send(res, 200, await svc.updateEquipment(db, mm[1].toUpperCase(), await readJson(req), actor));
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/equipment\/([A-Za-z0-9-]+)\/status$/))) return send(res, 200, await svc.adjustStatus(db, mm[1].toUpperCase(), await readJson(req), actor));
    if (m === 'GET' && p === '/api/admin/transactions') return send(res, 200, { transactions: await svc.listTransactions(db, { q: url.searchParams.get('q'), limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }) });
    if (m === 'POST' && (mm = p.match(/^\/api\/admin\/transactions\/(\d+)\/void$/))) {
      const b = await readJson(req);
      if (svc.clean(b.reason, 300).length < 3) throw new HttpError(400, 'Please give a short reason.');
      return send(res, 200, { ok: true, ...(await svc.voidTransaction(db, { id: Number(mm[1]) }, { actor, reason: b.reason })) });
    }
    if (m === 'GET' && p === '/api/admin/audit') return send(res, 200, { audit: await db.all('SELECT at,actor,action,detail FROM audit ORDER BY id DESC LIMIT 200') });
    if (m === 'GET' && p === '/api/admin/settings') return send(res, 200, { feed_token: await getSetting(db, 'feed_token') });
    if (m === 'POST' && p === '/api/admin/settings/rotate-feed-token') { const t = crypto.randomBytes(24).toString('hex'); await setSetting(db, 'feed_token', t); await svc.audit(db, actor, 'rotate_feed_token'); return send(res, 200, { feed_token: t }); }
    if (m === 'POST' && p === '/api/admin/settings/pin') {
      const b = await readJson(req);
      if (!checkPin(svc.clean(b.current, 64), await getSetting(db, 'admin_pin'))) throw new HttpError(403, 'Current PIN is incorrect.');
      const next = svc.clean(b.next, 64); if (next.length < 6) throw new HttpError(400, 'Use at least 6 characters.');
      await setSetting(db, 'admin_pin', hashPin(next)); await db.run('DELETE FROM sessions WHERE token_hash != ?', [svc.sha(cookieOf(req, 'sid'))]); await svc.audit(db, actor, 'change_pin');
      return send(res, 200, { ok: true });
    }
    if ((mm = p.match(/^\/api\/admin\/(employees|projects|locations|categories)(?:\/(\d+))?$/))) {
      if (m === 'GET' && !mm[2]) return send(res, 200, { rows: await svc.lookupList(db, mm[1]) });
      if (m === 'POST' && !mm[2]) return send(res, 201, await svc.lookupCreate(db, mm[1], await readJson(req), actor));
      if (m === 'PUT' && mm[2]) return send(res, 200, await svc.lookupUpdate(db, mm[1], mm[2], await readJson(req), actor));
    }
    throw new HttpError(404, 'Not found.');
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(e);
      return send(res, 500, { error: 'Something went wrong on the server. Your data was not changed.' });
    }
  });
}

module.exports = { createApp, ensureSecrets };

if (require.main === module) {
  (async () => {
    const PORT = Number(process.env.PORT) || 3000;
    const target = process.env.TURSO_DATABASE_URL || process.env.DB_FILE || path.join(__dirname, 'data', 'equipment.db');
    const db = await open(target, process.env.TURSO_AUTH_TOKEN);
    await ensureSecrets(db, console.log);
    if ((await db.get('SELECT count(*) AS n FROM categories')).n === 0) {
      if (process.env.DEMO_DATA === '0') { await seedBase(db); console.log('  Empty inventory (DEMO_DATA=0). Add equipment in Admin → Inventory → Add / bulk add.'); }
      else { await seedDemo(db); console.log('  Loaded SAMPLE data (fictional). Set DEMO_DATA=0 on a fresh database to start empty.'); }
    }
    createApp(db).listen(PORT, process.env.HOST || '0.0.0.0', () => {
      console.log(`  Database: ${db.isLocal ? 'local file' : 'cloud (Turso)'}\n  Equipment Sign-Out running:\n    Staff  →  http://localhost:${PORT}/\n    Admin  →  http://localhost:${PORT}/admin\n    Kiosk  →  http://localhost:${PORT}/?kiosk=1\n`);
    });
    const stop = async () => { try { if (db.isLocal) await db.run('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ignore */ } process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  })().catch((e) => { console.error(e); process.exit(1); });
}
