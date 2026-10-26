'use strict';
const crypto = require('node:crypto');
const { tx } = require('./db');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

const nowIso = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const nul = (v) => (v === undefined || v === '' ? null : v);
const localDate = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the server's time zone (set the TZ environment variable to your local zone)
const ID_RE = /^[A-Z]{1,3}\d{2,3}$/;                    // S01, D25, F26 — the tags already on the equipment
const MAX_ITEMS = 200;                                   // the largest real submission in the old sheet was 84
const STATE = ['status', 'txn_id', 'holder', 'project_code', 'project_name', 'site', 'unit', 'location', 'due_date', 'out_at', 'issue'];
const UNDO_WINDOW_MS = 15 * 60 * 1000;

let rev = 0;                       // bumped on every write; drives the cache/ETag for /api/bootstrap
const bump = () => { rev++; };
const getRev = () => rev;

async function audit(db, actor, action, detail) {
  await db.run('INSERT INTO audit(at,actor,action,detail) VALUES (?,?,?,?)', [nowIso(), clean(actor, 80) || 'system', action, detail ? String(detail).slice(0, 500) : null]);
}

/* ---------- reads for the staff app ---------- */
const EQ_SELECT = `SELECT e.id, e.name, e.serial, e.notes, e.status, e.holder, e.project_code, e.project_name, e.site, e.unit,
  e.location, e.due_date, e.out_at, e.issue, e.updated_at, c.id AS category_id, c.name AS category, c.prefix
  FROM equipment e JOIN categories c ON c.id = e.category_id`;

async function bootstrap(db) {
  const [categories, equipment, employees, projects, locations] = await Promise.all([
    db.all('SELECT id,name,prefix FROM categories ORDER BY sort,name'),
    db.all(`${EQ_SELECT} WHERE e.status != 'retired' ORDER BY c.sort, c.name, e.id`),
    db.all('SELECT name FROM employees WHERE active=1 ORDER BY name'),
    db.all('SELECT code,name,client,site FROM projects WHERE active=1 ORDER BY code'),
    db.all('SELECT name,kind FROM locations WHERE active=1 ORDER BY sort,name'),
  ]);
  return { categories, equipment, employees: employees.map((r) => r.name), projects, locations, today: localDate() };
}

/* ---------- transactions ---------- */
function validateTxn(i) {
  if (!i || typeof i !== 'object') throw new HttpError(400, 'Invalid request.');
  const kind = i.kind;
  if (kind !== 'out' && kind !== 'in') throw new HttpError(400, 'Choose sign out or return.');
  const idem = clean(i.idem_key, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(idem)) throw new HttpError(400, 'Missing request id.');
  const employee = clean(i.employee, 80);
  if (employee.length < 2) throw new HttpError(400, 'Please choose or type your name.', { field: 'employee' });
  const location = clean(i.location, 120);
  if (!location) throw new HttpError(400, 'Please choose a location.', { field: 'location' });
  const project_code = clean(i.project_code, 40);
  const project_name = clean(i.project_name, 120);
  if (kind === 'out' && !project_code && !project_name) throw new HttpError(400, 'Please enter the project.', { field: 'project' });
  const requester = clean(i.requester, 80);
  if (kind === 'out' && !requester) throw new HttpError(400, 'Please say who requested the equipment (project manager).', { field: 'requester' });
  const other_devices = clean(i.other_devices, 400);
  let due_date = clean(i.due_date, 10);
  if (due_date && (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || Number.isNaN(Date.parse(due_date)))) throw new HttpError(400, 'That expected-return date is not valid.', { field: 'due' });
  if (kind === 'in') due_date = '';
  if (!Array.isArray(i.items)) throw new HttpError(400, 'Invalid request.');
  if (i.items.length < 1 && !other_devices) throw new HttpError(400, 'Select at least one item, or describe the other equipment.');
  if (i.items.length > MAX_ITEMS) throw new HttpError(400, `Too many items in one transaction (max ${MAX_ITEMS}).`);
  const seen = new Set();
  const items = [];
  for (const it of i.items) {
    const id = clean(it && it.id, 12).toUpperCase();
    if (!ID_RE.test(id)) throw new HttpError(400, `"${id}" is not a valid equipment ID.`);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, condition: kind === 'in' && it.condition === 'issue' ? 'issue' : 'ok' });
  }
  const notes = clean(i.notes, 500);
  if (kind === 'in' && items.some((x) => x.condition === 'issue') && notes.length < 3) throw new HttpError(400, 'Please describe the problem so maintenance knows what to look for.', { field: 'notes' });
  let client_time = null;
  if (i.client_time && !Number.isNaN(Date.parse(i.client_time))) client_time = new Date(i.client_time).toISOString();
  return { kind, idem, employee, location, project_code, project_name, requester, site: clean(i.site, 200), unit: clean(i.unit, 40), other_devices, due_date, notes, items, client_time };
}

async function summary(db, t) {
  const items = await db.all('SELECT ti.equipment_id AS id, e.name, ti.condition FROM txn_items ti JOIN equipment e ON e.id = ti.equipment_id WHERE ti.txn_id = ? ORDER BY ti.equipment_id', [t.id]);
  return { public_id: t.public_id, kind: t.kind, employee: t.employee, project_code: t.project_code, project_name: t.project_name, requester: t.requester, site: t.site, unit: t.unit, other_devices: t.other_devices, location: t.location, due_date: t.due_date, notes: t.notes, created_at: t.created_at, voided_at: t.voided_at, items };
}

const EQ_UPDATE = 'UPDATE equipment SET status=?, txn_id=?, holder=?, project_code=?, project_name=?, site=?, unit=?, location=?, due_date=?, out_at=?, issue=?, updated_at=? WHERE id=?';
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

async function createTransaction(db, raw, meta = {}) {
  const v = validateTxn(raw);
  const dup = await db.get('SELECT * FROM transactions WHERE idem_key = ?', [v.idem]);
  if (dup) return { txn: await summary(db, dup), replay: true };

  const undoToken = crypto.randomBytes(16).toString('hex');
  const res = await tx(db, async (d) => {
    const again = await d.get('SELECT * FROM transactions WHERE idem_key = ?', [v.idem]);
    if (again) return { txn: await summary(d, again), replay: true };

    const ids = v.items.map((i) => i.id);
    const found = ids.length ? await d.all(`SELECT * FROM equipment WHERE id IN (${marks(ids.length)})`, ids) : [];
    const byId = new Map(found.map((e) => [e.id, e]));
    const rows = [];
    const conflicts = [];
    for (const it of v.items) {
      const e = byId.get(it.id);
      if (!e || e.status === 'retired') conflicts.push({ id: it.id, reason: 'unknown', message: `${it.id} is not in the inventory.` });
      else if (v.kind === 'out' && e.status === 'out') conflicts.push({ id: e.id, reason: 'out', holder: e.holder, message: `${e.id} is already signed out to ${e.holder}${e.project_name ? ` (${e.project_name})` : ''}.` });
      else if (v.kind === 'out' && e.status !== 'available') conflicts.push({ id: e.id, reason: e.status, message: `${e.id} is in maintenance and can't be signed out.` });
      else if (v.kind === 'in' && e.status !== 'out') conflicts.push({ id: e.id, reason: 'not_out', message: `${e.id} is not currently signed out.` });
      else rows.push({ e, condition: it.condition });
    }
    if (conflicts.length) throw new HttpError(409, 'Some items could not be processed.', { conflicts });

    // Fill project details from the project list when only a code was supplied.
    let { project_code, project_name, site } = v;
    if (project_code) {
      const p = await d.get('SELECT code,name,site FROM projects WHERE code = ?', [project_code]);
      if (p) { project_code = p.code; project_name = project_name || p.name; site = site || p.site; }
    }
    if (v.kind === 'out' && !site) throw new HttpError(400, 'Please enter the project location.', { field: 'site' });
    if (v.kind === 'in' && !project_code && !project_name) {
      const codes = new Set(rows.map((r) => `${r.e.project_code || ''}|${r.e.project_name || ''}`));
      if (codes.size === 1) { const [c, n] = [...codes][0].split('|'); project_code = c; project_name = n; }
      else if (codes.size > 1) project_name = 'Multiple projects';
    }

    const t = nowIso();
    const pid = crypto.randomUUID();
    const txnId = (await d.run(`INSERT INTO transactions(public_id,idem_key,kind,employee,project_code,project_name,requester,site,location,due_date,notes,created_at,client_time,device,undo_hash,unit,other_devices)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [pid, v.idem, v.kind, v.employee, nul(project_code), nul(project_name), nul(v.requester), nul(site), v.location, nul(v.due_date), nul(v.notes), t, v.client_time, clean(meta.device, 120) || null, sha(undoToken), v.kind === 'out' ? nul(v.unit) : null, nul(v.other_devices)])).lastInsertRowid;

    // All item rows in a single round trip (matters when the database is in the cloud).
    const stmts = [];
    for (const { e, condition } of rows) {
      const prev = Object.fromEntries(STATE.map((k) => [k, e[k] ?? null]));
      stmts.push(['INSERT INTO txn_items(txn_id,equipment_id,condition,prev_json) VALUES (?,?,?,?)', [txnId, e.id, condition, JSON.stringify(prev)]]);
      if (v.kind === 'out') stmts.push([EQ_UPDATE, ['out', txnId, v.employee, nul(project_code), nul(project_name), nul(site), nul(v.unit), v.location, nul(v.due_date), t, null, t, e.id]]);
      else stmts.push([EQ_UPDATE, [condition === 'ok' ? 'available' : 'maintenance', txnId, null, null, null, null, null, v.location, null, null, condition === 'ok' ? null : (v.notes || 'Problem reported on return'), t, e.id]]);
    }
    // First-time names become "self-added" entries an admin can review/merge.
    stmts.push(['INSERT OR IGNORE INTO employees(name,active,self_added) VALUES (?,1,1)', [v.employee]]);
    await d.batch(stmts);
    bump();
    return { txn: await summary(d, await d.get('SELECT * FROM transactions WHERE id = ?', [txnId])), replay: false };
  });
  if (!res.replay) res.undo_token = undoToken;
  return res;
}

/** Reverse a transaction. Only allowed while nothing newer has touched any of its items. */
async function voidTransaction(db, ref, { actor, reason, undoToken } = {}) {
  return tx(db, async (d) => {
    const t = ref.public_id
      ? await d.get('SELECT * FROM transactions WHERE public_id = ?', [ref.public_id])
      : await d.get('SELECT * FROM transactions WHERE id = ?', [ref.id]);
    if (!t) throw new HttpError(404, 'Transaction not found.');
    if (t.voided_at) throw new HttpError(409, 'That transaction was already reversed.');
    if (undoToken !== undefined) {
      const ok = t.undo_hash && undoToken && crypto.timingSafeEqual(Buffer.from(sha(undoToken)), Buffer.from(t.undo_hash));
      if (!ok) throw new HttpError(403, 'Undo is not available for this transaction.');
      if (Date.now() - Date.parse(t.created_at) > UNDO_WINDOW_MS) throw new HttpError(403, 'The undo window has passed — please ask an administrator to correct it.');
      actor = t.employee; reason = reason || 'Undone by user';
    }
    const items = await d.all('SELECT * FROM txn_items WHERE txn_id = ?', [t.id]);
    if (items.length) {
      const later = await d.get(`SELECT i2.equipment_id FROM txn_items i2 JOIN transactions t2 ON t2.id = i2.txn_id
        WHERE i2.equipment_id IN (${marks(items.length)}) AND t2.id > ? AND t2.voided_at IS NULL LIMIT 1`, [...items.map((i) => i.equipment_id), t.id]);
      if (later) throw new HttpError(409, `${later.equipment_id} has newer activity. Reverse the newer transaction first.`);
    }
    const at = nowIso();
    await d.batch([
      ...items.map((it) => { const p = JSON.parse(it.prev_json); return [EQ_UPDATE, [p.status, p.txn_id, p.holder, p.project_code, p.project_name, p.site, p.unit ?? null, p.location, p.due_date, p.out_at, p.issue, at, it.equipment_id]]; }),
      ['UPDATE transactions SET voided_at=?, voided_by=?, void_reason=? WHERE id=?', [at, clean(actor, 80) || 'admin', clean(reason, 300) || null, t.id]],
    ]);
    await audit(d, actor, 'void_transaction', `#${t.id} ${t.kind} by ${t.employee}: ${clean(reason, 200)}`);
    bump();
    return { txn: await summary(d, await d.get('SELECT * FROM transactions WHERE id = ?', [t.id])) };
  });
}

/* ---------- admin: inventory ---------- */
async function nextIds(db, prefix, count) {
  const re = new RegExp(`^${prefix}(\\d+)$`);                 // prefix is validated A–Z only
  let max = 0;
  for (const r of await db.all('SELECT id FROM equipment WHERE id LIKE ?', [`${prefix}%`])) { const m = r.id.match(re); if (m) max = Math.max(max, +m[1]); }
  return Array.from({ length: count }, (_, k) => `${prefix}${String(max + k + 1).padStart(2, '0')}`);
}

/**
 * Bulk import from a spreadsheet export. Columns: id, category (name or prefix), name, serial, notes, location.
 * All-or-nothing validation (a typo never half-imports); IDs that already exist are skipped, so it is safe to re-run.
 */
async function importEquipment(db, rows, actor) {
  if (!Array.isArray(rows) || !rows.length) throw new HttpError(400, 'There are no rows to import.');
  if (rows.length > 1000) throw new HttpError(400, 'Please import at most 1000 rows at a time.');
  const cats = await db.all('SELECT * FROM categories');
  const locs = new Set((await db.all('SELECT name FROM locations')).map((r) => r.name));
  const errors = []; const good = []; const seen = new Set();
  rows.forEach((r, idx) => {
    const line = idx + 2;                                     // line 1 of the file is the header
    const m = clean(r.id, 12).toUpperCase().replace(/[\s-]/g, '').match(/^([A-Z]{1,3})0*(\d{1,3})$/);
    if (!m || +m[2] === 0) { errors.push({ row: line, message: `"${clean(r.id, 12)}" is not a valid ID (letters then a number, like S01).` }); return; }
    const id = `${m[1]}${String(+m[2]).padStart(2, '0')}`;
    const key = clean(r.category, 80).toLowerCase();
    const cat = cats.find((c) => c.prefix.toLowerCase() === key || c.name.toLowerCase() === key) || (!key ? cats.find((c) => c.prefix === m[1]) : null);
    if (!cat) { errors.push({ row: line, message: `${id}: unknown category "${clean(r.category, 40)}".` }); return; }
    if (cat.prefix !== m[1]) { errors.push({ row: line, message: `${id} doesn't start with the ${cat.name} prefix "${cat.prefix}".` }); return; }
    const name = clean(r.name, 120) || cat.name.replace(/s$/, '');
    if (seen.has(id)) { errors.push({ row: line, message: `${id} appears twice in the file.` }); return; }
    seen.add(id);
    const loc = clean(r.location, 120);
    if (loc && !locs.has(loc)) { errors.push({ row: line, message: `${id}: unknown location "${loc}".` }); return; }
    good.push({ id, cat, name, serial: clean(r.serial, 80), notes: clean(r.notes, 300), location: loc || null });
  });
  if (errors.length) throw new HttpError(400, `${errors.length} row${errors.length > 1 ? 's' : ''} could not be read. Nothing was imported.`, { errors: errors.slice(0, 20) });
  return tx(db, async (d) => {
    const have = new Set((await d.all('SELECT id FROM equipment')).map((r) => r.id));
    const t = nowIso(); const added = []; const skipped = []; const stmts = [];
    for (const g of good) {
      if (have.has(g.id)) { skipped.push(g.id); continue; }
      stmts.push(['INSERT INTO equipment(id,category_id,name,serial,notes,status,location,updated_at) VALUES (?,?,?,?,?,?,?,?)', [g.id, g.cat.id, g.name, g.serial, g.notes, 'available', g.location, t]]); added.push(g.id);
    }
    await d.batch(stmts);
    await audit(d, actor, 'import_equipment', `${added.length} added, ${skipped.length} already existed`);
    bump();
    return { added: added.length, skipped };
  });
}

async function createEquipment(db, b, actor) {
  const cat = await db.get('SELECT * FROM categories WHERE id = ?', [Number(b.category_id)]);
  if (!cat) throw new HttpError(400, 'Choose a category.');
  const name = clean(b.name, 120);
  if (!name) throw new HttpError(400, 'Name / model is required.');
  const count = Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 100);
  return tx(db, async (d) => {
    let ids;
    if (b.id) {
      const id = clean(b.id, 12).toUpperCase();
      if (!ID_RE.test(id) || !new RegExp(`^${cat.prefix}\\d+$`).test(id)) throw new HttpError(400, `ID must look like ${cat.prefix}01.`);
      if (await d.get('SELECT 1 FROM equipment WHERE id = ?', [id])) throw new HttpError(409, `${id} already exists.`);
      ids = [id];
    } else ids = await nextIds(d, cat.prefix, count);
    const t = nowIso();
    const loc = clean(b.location, 120) || null;
    await d.batch(ids.map((id) => ['INSERT INTO equipment(id,category_id,name,serial,notes,status,location,updated_at) VALUES (?,?,?,?,?,?,?,?)', [id, cat.id, name, clean(b.serial, 80), clean(b.notes, 300), 'available', loc, t]]));
    await audit(d, actor, 'create_equipment', `${ids[0]}${ids.length > 1 ? `…${ids[ids.length - 1]}` : ''} (${ids.length}) ${name}`);
    bump();
    return { ids };
  });
}

async function updateEquipment(db, id, b, actor) {
  const e = await db.get('SELECT * FROM equipment WHERE id = ?', [id]);
  if (!e) throw new HttpError(404, 'Equipment not found.');
  const name = clean(b.name ?? e.name, 120);
  if (!name) throw new HttpError(400, 'Name / model is required.');
  await db.run('UPDATE equipment SET name=?, serial=?, notes=?, updated_at=? WHERE id=?', [name, clean(b.serial ?? e.serial, 80), clean(b.notes ?? e.notes, 300), nowIso(), id]);
  await audit(db, actor, 'update_equipment', id); bump();
  return { ok: true };
}

/** Manual correction by an administrator (e.g. item found on the shelf but never returned). Fully reversible. */
async function adjustStatus(db, id, b, actor) {
  const status = b.status;
  if (!['available', 'maintenance', 'retired'].includes(status)) throw new HttpError(400, 'Status must be available, maintenance or retired.');
  const reason = clean(b.reason, 300);
  if (reason.length < 3) throw new HttpError(400, 'Please give a short reason for the correction.', { field: 'reason' });
  return tx(db, async (d) => {
    const e = await d.get('SELECT * FROM equipment WHERE id = ?', [id]);
    if (!e) throw new HttpError(404, 'Equipment not found.');
    if (e.status === status) throw new HttpError(409, `${id} is already ${status}.`);
    const t = nowIso();
    const location = clean(b.location, 120) || e.location || null;
    const txnId = (await d.run('INSERT INTO transactions(public_id,kind,employee,location,notes,created_at,device) VALUES (?,?,?,?,?,?,?)',
      [crypto.randomUUID(), 'adjust', clean(actor, 80) || 'admin', location, `${e.status} → ${status}: ${reason}`, t, 'admin'])).lastInsertRowid;
    await d.batch([
      ['INSERT INTO txn_items(txn_id,equipment_id,condition,prev_json) VALUES (?,?,?,?)', [txnId, id, 'ok', JSON.stringify(Object.fromEntries(STATE.map((k) => [k, e[k] ?? null])))]],
      ['UPDATE equipment SET status=?, txn_id=?, holder=NULL, project_code=NULL, project_name=NULL, site=NULL, unit=NULL, location=?, due_date=NULL, out_at=NULL, issue=?, updated_at=? WHERE id=?', [status, txnId, location, status === 'maintenance' ? reason : null, t, id]],
    ]);
    await audit(d, actor, 'adjust_status', `${id}: ${e.status} → ${status} (${reason})`);
    bump();
    return { ok: true };
  });
}

/* ---------- admin: lookup tables (people, projects, locations, categories) ---------- */
const LOOKUPS = {
  employees: { cols: { name: 80, active: 'bool' }, req: ['name'], order: 'name' },
  projects: { cols: { code: 40, name: 120, client: 120, site: 200, active: 'bool' }, req: ['code', 'name'], order: 'code' },
  locations: { cols: { name: 120, kind: 20, sort: 'int', active: 'bool' }, req: ['name'], order: 'sort,name' },
  categories: { cols: { name: 80, prefix: 4, sort: 'int' }, req: ['name', 'prefix'], order: 'sort,name' },
};
async function lookupList(db, table) {
  const L = LOOKUPS[table]; if (!L) throw new HttpError(404, 'Unknown list.');
  return db.all(`SELECT * FROM ${table} ORDER BY ${L.order}`);
}
function lookupValues(table, b, partial) {
  const L = LOOKUPS[table]; const out = {};
  for (const [col, type] of Object.entries(L.cols)) {
    if (partial && b[col] === undefined) continue;
    if (type === 'bool') out[col] = b[col] ? 1 : 0;
    else if (type === 'int') out[col] = parseInt(b[col], 10) || 0;
    else out[col] = clean(b[col], type);
  }
  if (table === 'categories' && out.prefix !== undefined) { out.prefix = out.prefix.toUpperCase(); if (!/^[A-Z]{1,4}$/.test(out.prefix)) throw new HttpError(400, 'Prefix must be 1–4 letters.'); }
  if (!partial) for (const r of L.req) if (!out[r]) throw new HttpError(400, `${r[0].toUpperCase()}${r.slice(1)} is required.`);
  return out;
}
async function lookupCreate(db, table, b, actor) {
  if (!LOOKUPS[table]) throw new HttpError(404, 'Unknown list.');
  const v = lookupValues(table, b, false);
  const cols = Object.keys(v);
  try { await db.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${marks(cols.length)})`, Object.values(v)); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That entry already exists.'); throw e; }
  await audit(db, actor, `create_${table}`, JSON.stringify(v).slice(0, 200)); bump();
  return { ok: true };
}
async function lookupUpdate(db, table, id, b, actor) {
  if (!LOOKUPS[table]) throw new HttpError(404, 'Unknown list.');
  const v = lookupValues(table, b, true);
  if (table === 'categories') delete v.prefix; // prefix is baked into printed QR labels — never change it
  const cols = Object.keys(v);
  if (!cols.length) return { ok: true };
  try { await db.run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`, [...Object.values(v), Number(id)]); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That name/code is already used.'); throw e; }
  await audit(db, actor, `update_${table}`, `#${id} ${JSON.stringify(v).slice(0, 200)}`); bump();
  return { ok: true };
}

/* ---------- admin: reporting ---------- */
const allEquipment = (db) => db.all(`${EQ_SELECT} ORDER BY c.sort, c.name, e.id`);

async function listTransactions(db, { q, limit = 100, offset = 0 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500); offset = Math.max(parseInt(offset, 10) || 0, 0);
  const where = []; const args = [];
  if (q) {
    const like = `%${clean(q, 60)}%`;
    where.push(`(t.employee LIKE ? OR t.project_name LIKE ? OR t.project_code LIKE ? OR t.location LIKE ? OR t.requester LIKE ? OR t.other_devices LIKE ? OR EXISTS (SELECT 1 FROM txn_items i WHERE i.txn_id=t.id AND i.equipment_id LIKE ?))`);
    args.push(like, like, like, like, like, like, like);
  }
  const sql = `SELECT t.id, t.public_id, t.kind, t.employee, t.project_code, t.project_name, t.requester, t.site, t.unit, t.other_devices, t.location, t.due_date, t.notes, t.created_at, t.client_time, t.voided_at, t.voided_by, t.void_reason,
      (SELECT group_concat(equipment_id, ', ') FROM txn_items WHERE txn_id=t.id) AS items,
      (SELECT count(*) FROM txn_items WHERE txn_id=t.id) AS n
    FROM transactions t ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ? OFFSET ?`;
  return db.all(sql, [...args, limit, offset]);
}

async function overview(db) {
  const today = localDate();
  const [byCategory, totals, outRows, attention, recent, self] = await Promise.all([
    db.all(`SELECT c.name, count(e.id) AS total,
      sum(e.status='available') AS available, sum(e.status='out') AS out, sum(e.status='maintenance') AS maintenance
    FROM categories c LEFT JOIN equipment e ON e.category_id=c.id AND e.status!='retired' GROUP BY c.id ORDER BY c.sort, c.name`),
    db.get(`SELECT count(*) AS total, coalesce(sum(status='available'),0) AS available, coalesce(sum(status='out'),0) AS out, coalesce(sum(status='maintenance'),0) AS maintenance FROM equipment WHERE status!='retired'`),
    db.all(`${EQ_SELECT} WHERE e.status='out' ORDER BY e.due_date IS NULL, e.due_date, e.id`),
    db.all(`${EQ_SELECT} WHERE e.status='maintenance' ORDER BY e.updated_at DESC`),
    listTransactions(db, { limit: 8 }),
    db.get('SELECT count(*) AS n FROM employees WHERE self_added=1 AND active=1'),
  ]);
  return { totals, byCategory, today, out: outRows, overdue: outRows.filter((r) => r.due_date && r.due_date < today), attention, recent, selfAdded: self.n };
}

/* ---------- CSV (with spreadsheet-formula-injection guard) ---------- */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (cols, rows) => `﻿${cols.join(',')}\r\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\r\n')}\r\n`;

async function equipmentFeed(db) {
  const today = localDate();
  return (await allEquipment(db)).map((e) => ({
    id: e.id, category: e.category, name: e.name, serial: e.serial, status: e.status, holder: e.holder, project_code: e.project_code,
    project_name: e.project_name, site: e.site, unit: e.unit, location: e.location, due_date: e.due_date, overdue: e.status === 'out' && e.due_date && e.due_date < today ? 'yes' : 'no',
    signed_out_at: e.out_at, issue: e.issue, updated_at: e.updated_at,
  }));
}
const EQUIPMENT_COLS = ['id', 'category', 'name', 'serial', 'status', 'holder', 'project_code', 'project_name', 'site', 'unit', 'location', 'due_date', 'overdue', 'signed_out_at', 'issue', 'updated_at'];
const TXN_COLS = ['id', 'created_at', 'kind', 'employee', 'project_code', 'project_name', 'requester', 'site', 'unit', 'location', 'due_date', 'items', 'n', 'other_devices', 'notes', 'voided_at', 'voided_by', 'void_reason'];

module.exports = {
  HttpError, clean, sha, nowIso, audit, bump, getRev, bootstrap, createTransaction, voidTransaction,
  createEquipment, importEquipment, updateEquipment, adjustStatus, lookupList, lookupCreate, lookupUpdate,
  allEquipment, listTransactions, overview, toCsv, equipmentFeed, EQUIPMENT_COLS, TXN_COLS, ID_RE,
};
