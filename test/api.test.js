'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { open } = require('../lib/db');
const { createApp, ensureSecrets } = require('../server');
const { seedDemo } = require('../lib/seed');

let server, base, db;
const PIN = 'test-pin-1234';
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const txn = (over) => ({ kind: 'out', idem_key: crypto.randomUUID(), employee: 'Test User', project_code: '26-101', requester: 'Pat Rivera', location: '1818', items: [], ...over });
const ids = (...a) => a.map((id) => ({ id }));
const boot = async () => (await fetch(base + '/api/bootstrap')).json();
const status = async (id) => (await boot()).equipment.find((e) => e.id === id);
const adminCookie = async () => (await post('/api/admin/login', { pin: PIN, name: 'Sam Admin' })).headers.get('set-cookie').split(';')[0];

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

test('sample fleet mirrors the real tags (S01–S40, D01–D25, F01–F26) and pages are served', async () => {
  const b = await boot();
  assert.equal(b.equipment.length, 91);
  assert.deepEqual(b.categories.map((c) => c.prefix), ['S', 'D', 'F']);
  assert.deepEqual(b.locations.map((l) => l.name), ['1818', 'Cottontail']);
  assert.ok(b.equipment.some((e) => e.id === 'S40') && b.equipment.some((e) => e.id === 'D25') && b.equipment.some((e) => e.id === 'F26'));
  for (const p of ['/', '/admin', '/e/S05', '/app.js', '/sw.js']) assert.equal((await fetch(base + p)).status, 200, p);
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404);
});

test('one transaction can hold 90 items (the old sheet capped at 14; the biggest real submission was 84)', async () => {
  // return everything that is out (several people, several projects) in ONE return…
  const outNow = (await boot()).equipment.filter((e) => e.status === 'out').map((e) => ({ id: e.id }));
  assert.ok(outNow.length >= 10);
  const r0 = await post('/api/transactions', txn({ kind: 'in', employee: 'Warehouse Lead', project_code: '', requester: '', items: outNow }));
  assert.equal(r0.status, 201);
  // …then sign out every available item in ONE sign-out
  const items = (await boot()).equipment.filter((e) => e.status === 'available').map((e) => ({ id: e.id }));
  assert.equal(items.length, 90);                             // 91 minus the one in maintenance
  const r = await post('/api/transactions', txn({ items }));
  assert.equal(r.status, 201);
  assert.equal((await r.json()).txn.items.length, 90);
  const back = await post('/api/transactions', txn({ kind: 'in', items, location: 'Cottontail', project_code: '', requester: '' }));
  assert.equal(back.status, 201);
});

test('double sign-out is rejected with a clear conflict and changes nothing', async () => {
  assert.equal((await post('/api/transactions', txn({ items: ids('S05') }))).status, 201);
  const b = await post('/api/transactions', txn({ employee: 'Someone Else', items: ids('S05', 'S06') }));
  assert.equal(b.status, 409);
  const j = await b.json();
  assert.equal(j.conflicts[0].id, 'S05');
  assert.match(j.conflicts[0].message, /already signed out to Test User/);
  assert.equal((await status('S06')).status, 'available', 'all-or-nothing: S06 untouched');
  const unknown = await post('/api/transactions', txn({ items: ids('Z99') }));
  assert.equal(unknown.status, 409);
});

test('idempotency: the same request id never creates a second transaction', async () => {
  const body = txn({ items: ids('S07') });
  const r1 = await post('/api/transactions', body); const r2 = await post('/api/transactions', body);
  assert.equal(r1.status, 201); assert.equal(r2.status, 200);
  assert.equal((await r2.json()).replay, true);
  assert.equal(db.prepare('SELECT count(*) n FROM transactions WHERE idem_key=?').get(body.idem_key).n, 1);
});

test('race: 25 simultaneous attempts on one item → exactly one winner', async () => {
  const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => post('/api/transactions', txn({ employee: `Racer ${i}`, items: ids('S08') }))));
  const codes = rs.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 201).length, 1);
  assert.equal(codes.filter((c) => c === 409).length, 24);
});

test('return restores availability; reporting a problem sends it to maintenance', async () => {
  const r = await post('/api/transactions', txn({ kind: 'in', employee: 'Returner', location: 'Cottontail', items: [{ id: 'S05' }, { id: 'S07', condition: 'issue' }], notes: 'Fan rattles' }));
  assert.equal(r.status, 201);
  assert.equal((await status('S05')).status, 'available');
  assert.equal((await status('S05')).location, 'Cottontail');
  const m = await status('S07'); assert.equal(m.status, 'maintenance'); assert.match(m.issue, /rattles/);
  assert.equal((await post('/api/transactions', txn({ kind: 'in', items: ids('S05'), location: '1818' }))).status, 409);
  assert.equal((await post('/api/transactions', txn({ kind: 'out', items: ids('S07') }))).status, 409);
});

test('a problem report requires a description', async () => {
  const r = await post('/api/transactions', txn({ kind: 'in', items: [{ id: 'S08', condition: 'issue' }], location: '1818' }));
  assert.equal(r.status, 400);
});

test('unit / apartment number is stored with the sign-out and cleared on return', async () => {
  assert.equal((await post('/api/transactions', txn({ items: ids('F15'), unit: ' 4B ' }))).status, 201);
  assert.equal((await status('F15')).unit, '4B');
  assert.equal((await post('/api/transactions', txn({ kind: 'in', items: ids('F15'), location: '1818', requester: '' }))).status, 201);
  assert.equal((await status('F15')).unit, null);
});

test('"other equipment" can be recorded as free text, alone or with tracked items', async () => {
  const before = JSON.stringify((await boot()).equipment);
  const only = await post('/api/transactions', txn({ items: [], other_devices: 'Two 50 ft hose reels' }));
  assert.equal(only.status, 201);
  assert.equal(JSON.stringify((await boot()).equipment), before, 'no tracked item changed');
  const c = await adminCookie();
  const found = (await (await fetch(base + '/api/admin/transactions?q=hose%20reels', { headers: { cookie: c } })).json()).transactions;
  assert.equal(found.length, 1, 'admins can search the free-text field');
  assert.equal(found[0].other_devices, 'Two 50 ft hose reels'); assert.equal(found[0].n, 0);
  const byPm = (await (await fetch(base + '/api/admin/transactions?q=Pat%20Rivera', { headers: { cookie: c } })).json()).transactions;
  assert.ok(byPm.length > 3, 'and the requester');
  assert.equal((await post('/api/transactions', txn({ items: ids('F16'), other_devices: 'One hose reel' }))).status, 201);
  await post('/api/transactions', txn({ kind: 'in', items: ids('F16'), location: '1818', requester: '' }));
});

test('validation mirrors the old form: name, location, project, requester and project location are required', async () => {
  const bad = [
    [{ employee: '' }, 'employee'], [{ location: '' }, 'location'], [{ project_code: '', project_name: '' }, 'project'],
    [{ requester: '' }, 'requester'], [{ project_code: '', project_name: 'Free-text job', site: '' }, 'site'],
  ];
  for (const [over, field] of bad) {
    const r = await post('/api/transactions', txn({ items: ids('F20'), ...over }));
    assert.equal(r.status, 400, JSON.stringify(over)); assert.equal((await r.json()).field, field);
  }
  for (const over of [{ items: ids('zz-1') }, { items: ids('S1') }, { items: [] }, { kind: 'x' }, { idem_key: 'x' }, { due_date: '2026-13-45' }]) {
    assert.equal((await post('/api/transactions', txn({ items: ids('F20'), ...over }))).status, 400, JSON.stringify(over));
  }
  // free-text project is fine when the location is given
  const ok = await post('/api/transactions', txn({ items: ids('F20'), project_code: '', project_name: '23-108 DGS IH', site: '1229 Example St' }));
  assert.equal(ok.status, 201);
  await post('/api/transactions', txn({ kind: 'in', items: ids('F20'), location: '1818', requester: '' }));
  assert.equal((await post('/api/transactions', txn({ items: Array.from({ length: 201 }, (_, i) => ({ id: `Q${String(i + 100)}` })) }))).status, 400);
  assert.equal((await fetch(base + '/api/transactions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
});

test('staff undo works with the secret token, not without it', async () => {
  const r = await (await post('/api/transactions', txn({ items: ids('D05') }))).json();
  assert.equal((await status('D05')).status, 'out');
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: 'nope' })).status, 403);
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: r.undo_token })).status, 200);
  assert.equal((await status('D05')).status, 'available');
  assert.equal((await post('/api/undo', { public_id: r.txn.public_id, undo_token: r.undo_token })).status, 409);
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
  assert.ok((await ov.json()).totals.total >= 91);
});

test('admin: void blocked by newer activity, allowed when safe; corrections are logged', async () => {
  const c = await adminCookie();
  const A = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body) });
  const list = async () => (await (await fetch(base + '/api/admin/transactions?q=F21', { headers: { cookie: c } })).json()).transactions;

  await post('/api/transactions', txn({ items: ids('F21') }));
  const id1 = (await list())[0].id;
  await post('/api/transactions', txn({ kind: 'in', items: ids('F21'), location: 'Cottontail', requester: '' }));
  assert.equal((await A(`/api/admin/transactions/${id1}/void`, { reason: 'wrong item' })).status, 409);
  const id2 = (await list())[0].id;
  assert.equal((await A(`/api/admin/transactions/${id2}/void`, { reason: 'returned by mistake' })).status, 200);
  assert.equal((await status('F21')).status, 'out', 'reversing the return puts it back out');
  assert.equal((await A(`/api/admin/transactions/${id1}/void`, { reason: 'wrong item' })).status, 200);
  assert.equal((await status('F21')).status, 'available');

  await post('/api/transactions', txn({ items: ids('F22') }));
  assert.equal((await A('/api/admin/equipment/F22/status', { status: 'available' })).status, 400);
  assert.equal((await A('/api/admin/equipment/F22/status', { status: 'available', reason: 'found on shelf', location: 'Cottontail' })).status, 200);
  assert.equal((await status('F22')).status, 'available');
  assert.ok(db.prepare("SELECT count(*) n FROM audit WHERE action='adjust_status'").get().n >= 1);
});

test('admin: add equipment (bulk) continues the numbering; category prefix is immutable', async () => {
  const c = await adminCookie();
  const A = (p, body, method = 'POST') => fetch(base + p, { method, headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify(body) });
  const cats = (await (await fetch(base + '/api/admin/categories', { headers: { cookie: c } })).json()).rows;
  const fans = cats.find((x) => x.prefix === 'F');
  const r = await (await A('/api/admin/equipment', { category_id: fans.id, name: 'Air Mover', count: 3 })).json();
  assert.deepEqual(r.ids, ['F27', 'F28', 'F29']);
  assert.equal((await A('/api/admin/equipment', { category_id: fans.id, name: 'Air Mover', id: 'S99' })).status, 400);
  await A(`/api/admin/categories/${fans.id}`, { prefix: 'ZZ', name: 'Fans' }, 'PUT');
  assert.equal((await (await fetch(base + '/api/admin/categories', { headers: { cookie: c } })).json()).rows.find((x) => x.id === fans.id).prefix, 'F');
});

test('admin: CSV import accepts the old inventory-tab layout, skips existing IDs, and is all-or-nothing', async () => {
  const c = await adminCookie();
  const imp = (rows) => fetch(base + '/api/admin/equipment/import', { method: 'POST', headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify({ rows }) });
  const ok = await imp([
    { id: 's41', category: 'Air Scrubbers', name: 'HEPA Air Scrubber', serial: '27536', notes: 'Old name: NEW; Tag: Yes' },
    { id: 'D 26', category: 'D', name: '', serial: '1' },
    { id: 'S42', category: '' },                                  // category inferred from the ID's letter
    { id: 'F01', category: 'Fans' },                              // already exists → skipped
  ]);
  assert.equal(ok.status, 200);
  const j = await ok.json(); assert.equal(j.added, 3); assert.deepEqual(j.skipped, ['F01']);
  assert.equal((await status('S41')).serial, '27536');
  assert.equal((await status('S42')).category, 'Air Scrubbers');
  assert.equal((await status('D26')).name, 'Dehumidifier');
  const mixed = await imp([{ id: 'S43', category: 'Air Scrubbers' }, { id: 'X7', category: 'Nope' }, { id: 'D30', category: 'Fans' }]);
  assert.equal(mixed.status, 400);
  assert.equal((await mixed.json()).errors.length, 2);
  assert.equal(await status('S43'), undefined, 'nothing was imported from a bad file');
  assert.equal((await fetch(base + '/api/admin/equipment/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows: [{ id: 'S50' }] }) })).status, 401);
});

test('feed: needs token; CSV neutralises spreadsheet formulas and includes the new fields', async () => {
  assert.equal((await fetch(base + '/api/feed/equipment.csv')).status, 401);
  const token = db.prepare("SELECT value FROM settings WHERE key='feed_token'").get().value;
  db.prepare("UPDATE equipment SET status='out', holder=? WHERE id='F30'").run('x');   // no F30 → no-op, keeps test independent
  db.prepare("UPDATE equipment SET status='out', holder=? WHERE id='F29'").run('=HYPERLINK("http://evil")');
  const csv = await (await fetch(`${base}/api/feed/equipment.csv?token=${token}`)).text();
  assert.ok(csv.split('\r\n')[0].includes('unit'));
  assert.ok(!/,=HYPERLINK/.test(csv));
  assert.ok(csv.includes("'=HYPERLINK"));
  const tcsv = await (await fetch(`${base}/api/feed/transactions.csv?token=${token}`)).text();
  assert.ok(tcsv.split('\r\n')[0].includes('other_devices') && tcsv.split('\r\n')[0].includes('requester'));
  const json = await (await fetch(`${base}/api/feed/equipment.json`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(json.equipment.length, db.prepare('SELECT count(*) n FROM equipment').get().n);
});

test('databases created by the first release are upgraded in place', () => {
  const file = path.join(os.tmpdir(), `salut-migrate-${process.pid}.db`);
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE equipment(id TEXT PRIMARY KEY, category_id INTEGER, name TEXT, serial TEXT, notes TEXT, status TEXT, txn_id INTEGER, holder TEXT, project_code TEXT, project_name TEXT, site TEXT, location TEXT, due_date TEXT, out_at TEXT, issue TEXT, updated_at TEXT);
    CREATE TABLE transactions(id INTEGER PRIMARY KEY, public_id TEXT, idem_key TEXT, kind TEXT, employee TEXT, project_code TEXT, project_name TEXT, requester TEXT, site TEXT, location TEXT, due_date TEXT, notes TEXT, created_at TEXT, client_time TEXT, device TEXT, undo_hash TEXT, voided_at TEXT, voided_by TEXT, void_reason TEXT);`);
  old.close();
  const upgraded = open(file);
  const cols = (t) => upgraded.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('equipment').includes('unit') && cols('transactions').includes('unit') && cols('transactions').includes('other_devices'));
  upgraded.close();
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
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
