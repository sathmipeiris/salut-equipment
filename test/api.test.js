'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { open } = require('../lib/db');
const { createApp, ensureSecrets } = require('../server');
const { seedDemo } = require('../lib/seed');

let server, base, db;
const PIN = 'test-pin-1234';
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const txn = (over) => ({ kind: 'out', idem_key: crypto.randomUUID(), employee: 'Test User', project_code: 'P-2401', location: 'Project site', items: [], ...over });
const ids = (...a) => a.map((id) => ({ id }));
const boot = async () => (await fetch(base + '/api/bootstrap')).json();
const status = async (id) => (await boot()).equipment.find((e) => e.id === id);

before(async () => {
  process.env.ADMIN_PIN = PIN;
  db = open(':memory:');
  ensureSecrets(db, () => {});
  seedDemo(db);
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

test('seed loads ~100 items and the app serves pages', async () => {
  const b = await boot();
  assert.equal(b.equipment.length, 100);
  assert.ok(b.categories.length >= 9);
  for (const p of ['/', '/admin', '/e/AS-005', '/app.js', '/sw.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});

test('sign out 40 items in one transaction (old sheet limit was 14)', async () => {
  const free = (await boot()).equipment.filter((e) => e.status === 'available' && e.prefix === 'FN').slice(0, 11);
  const more = (await boot()).equipment.filter((e) => e.status === 'available' && e.prefix !== 'FN').slice(0, 29);
  const items = [...free, ...more].map((e) => ({ id: e.id }));
  assert.equal(items.length, 40);
  const r = await post('/api/transactions', txn({ items }));
  assert.equal(r.status, 201);
  const j = await r.json();
  assert.equal(j.txn.items.length, 40);
  assert.ok(j.undo_token);
  // give them all back so later tests have stock
  const back = await post('/api/transactions', txn({ kind: 'in', items, location: 'Warehouse – Washington, DC', project_code: '' }));
  assert.equal(back.status, 201);
});

test('double sign-out is rejected with a clear conflict and changes nothing', async () => {
  const a = await post('/api/transactions', txn({ items: ids('AS-005') }));
  assert.equal(a.status, 201);
  const b = await post('/api/transactions', txn({ employee: 'Someone Else', items: ids('AS-005', 'AS-006') }));
  assert.equal(b.status, 409);
  const j = await b.json();
  assert.equal(j.conflicts[0].id, 'AS-005');
  assert.match(j.conflicts[0].message, /already signed out to Test User/);
  assert.equal((await status('AS-006')).status, 'available', 'all-or-nothing: AS-006 untouched');
});

test('idempotency: the same request id never creates a second transaction', async () => {
  const body = txn({ items: ids('AS-007') });
  const r1 = await post('/api/transactions', body); const r2 = await post('/api/transactions', body);
  assert.equal(r1.status, 201); assert.equal(r2.status, 200);
  assert.equal((await r2.json()).replay, true);
  assert.equal(db.prepare('SELECT count(*) n FROM transactions WHERE idem_key=?').get(body.idem_key).n, 1);
});

test('race: 25 simultaneous attempts on one item → exactly one winner', async () => {
  const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/transactions', txn({ employee: `Racer ${i}`, items: ids('AS-008') }))));
  const codes = rs.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 24);
});

test('return restores availability; reporting a problem sends it to maintenance', async () => {
  const r = await post('/api/transactions', txn({ kind: 'in', employee: 'Returner', location: 'Warehouse – Glen Burnie, MD', items: [{ id: 'AS-005' }, { id: 'AS-007', condition: 'issue' }], notes: 'Fan rattles' }));
  assert.equal(r.status, 201);
  assert.equal((await status('AS-005')).status, 'available');
  const m = await status('AS-007'); assert.equal(m.status, 'maintenance'); assert.match(m.issue, /rattles/);
  const again = await post('/api/transactions', txn({ kind: 'in', items: ids('AS-005'), location: 'Project site' }));
  assert.equal(again.status, 409);
  const bad = await post('/api/transactions', txn({ kind: 'out', items: ids('AS-007') }));
  assert.equal(bad.status, 409);
});

test('a problem report requires a description', async () => {
  const r = await post('/api/transactions', txn({ kind: 'in', items: [{ id: 'AS-008', condition: 'issue' }], location: 'Project site' }));
  assert.equal(r.status, 400);
});

test('staff undo works with the secret token, not without it', async () => {
  const r = await (await post('/api/transactions', txn({ items: ids('NA-005') }))).json();
  assert.equal((await status('NA-005')).status, 'out');
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: 'nope' })).status, 403);
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: r.undo_token })).status, 200);
  assert.equal((await status('NA-005')).status, 'available');
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: r.undo_token })).status, 409);
});

test('validation: missing name / project / location / bad ids / empty cart', async () => {
  for (const over of [{ employee: '' }, { project_code: '', project_name: '' }, { location: '' }, { items: ids('zz-1') }, { items: [] }, { kind: 'x' }, { idem_key: 'x' }, { due_date: '2026-13-45' }]) {
    const r = await post('/api/transactions', txn({ items: ids('FN-020'), ...over }));
    assert.equal(r.status, 400, JSON.stringify(over));
  }
  assert.equal((await status('FN-020')).status, 'available');
  const big = await post('/api/transactions', txn({ items: Array.from({ length: 101 }, (_, i) => ({ id: `FN-${String(i + 100).padStart(3, '0')}` })) }));
  assert.equal(big.status, 400);
  const notJson = await fetch(base + '/api/transactions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(notJson.status, 415);
});

test('admin API is locked without a session; wrong PIN fails; right PIN works', async () => {
  assert.equal((await fetch(base + '/api/admin/overview')).status, 401);
  assert.equal((await post('/api/admin/login', { pin: 'wrong' })).status, 401);
  const ok = await post('/api/admin/login', { pin: PIN, name: 'Sam Admin' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const ov = await fetch(base + '/api/admin/overview', { headers: { cookie: cookie.split(';')[0] } });
  assert.equal(ov.status, 200);
  assert.ok((await ov.json()).totals.total >= 100);
});

test('admin: void blocked by newer activity, allowed when safe; corrections are logged and reversible', async () => {
  const c = (await post('/api/admin/login', { pin: PIN, name: 'Sam Admin' })).headers.get('set-cookie').split(';')[0];
  const A = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body) });

  const t1 = await (await post('/api/transactions', txn({ items: ids('HV-001') }))).json();
  const rows = (await (await fetch(base + '/api/admin/transactions?q=HV-001', { headers: { cookie: c } })).json()).transactions;
  const id1 = rows[0].id;
  await post('/api/transactions', txn({ kind: 'in', items: ids('HV-001'), location: 'Project site' }));
  const blocked = await A(`/api/admin/transactions/${id1}/void`, { reason: 'wrong item' });
  assert.equal(blocked.status, 409);
  const id2 = (await (await fetch(base + '/api/admin/transactions?q=HV-001', { headers: { cookie: c } })).json()).transactions[0].id;
  assert.equal((await A(`/api/admin/transactions/${id2}/void`, { reason: 'returned by mistake' })).status, 200);
  assert.equal((await status('HV-001')).status, 'out', 'void of the return puts it back out');
  assert.equal((await A(`/api/admin/transactions/${id1}/void`, { reason: 'wrong item' })).status, 200);
  assert.equal((await status('HV-001')).status, 'available');
  assert.ok(t1.txn);

  // force-return correction needs a reason, and can be reversed
  await post('/api/transactions', txn({ items: ids('HV-002') }));
  assert.equal((await A('/api/admin/equipment/HV-002/status', { status: 'available' })).status, 400);
  assert.equal((await A('/api/admin/equipment/HV-002/status', { status: 'available', reason: 'found on shelf', location: 'Warehouse – Washington, DC' })).status, 200);
  assert.equal((await status('HV-002')).status, 'available');
  assert.ok(db.prepare("SELECT count(*) n FROM audit WHERE action='adjust_status'").get().n >= 1);
});

test('admin: add equipment (bulk) gets sequential IDs; category prefix is immutable', async () => {
  const c = (await post('/api/admin/login', { pin: PIN })).headers.get('set-cookie').split(';')[0];
  const A = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body) });
  const cats = (await (await fetch(base + '/api/admin/categories', { headers: { cookie: c } })).json()).rows;
  const wp = cats.find((x) => x.prefix === 'WP');
  const r = await (await A('/api/admin/equipment', { category_id: wp.id, name: 'Trash Pump 2 in', count: 3 })).json();
  assert.deepEqual(r.ids, ['WP-007', 'WP-008', 'WP-009']);
  await A(`/api/admin/categories/${wp.id}`, { prefix: 'ZZ', name: 'Water Pumps' }, 'PUT');
  const after = (await (await fetch(base + '/api/admin/categories', { headers: { cookie: c } })).json()).rows.find((x) => x.id === wp.id);
  assert.equal(after.prefix, 'WP');
});

test('feed: needs token; CSV neutralises spreadsheet formulas', async () => {
  assert.equal((await fetch(base + '/api/feed/equipment.csv')).status, 401);
  const token = db.prepare("SELECT value FROM settings WHERE key='feed_token'").get().value;
  db.prepare("UPDATE equipment SET notes=?, holder=? WHERE id='FN-030'").run('x', '=HYPERLINK("http://evil")');
  db.prepare("UPDATE equipment SET status='out', holder=? WHERE id='FN-030'").run('=HYPERLINK("http://evil")');
  const csv = await (await fetch(`${base}/api/feed/equipment.csv?token=${token}`)).text();
  assert.ok(csv.split('\r\n').length > 100);
  assert.ok(!/,=HYPERLINK/.test(csv));
  const json = await (await fetch(`${base}/api/feed/equipment.json`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(json.equipment.length, 100 + 3);
});

test('security headers present, API not cacheable', async () => {
  const r = await fetch(base + '/api/health');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('login is rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = (await post('/api/admin/login', { pin: 'bad' })).status;
  assert.equal(last, 429);
});
