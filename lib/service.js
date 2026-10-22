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
const ID_RE = /^[A-Z]{1,4}-\d{3,4}$/;
const STATE = ['status', 'txn_id', 'holder', 'project_code', 'project_name', 'site', 'location', 'due_date', 'out_at', 'issue'];
const UNDO_WINDOW_MS = 15 * 60 * 1000;

let rev = 0;                       // bumped on every write; drives the cache/ETag for /api/bootstrap
const bump = () => { rev++; };
const getRev = () => rev;

function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit(at,actor,action,detail) VALUES (?,?,?,?)').run(nowIso(), clean(actor, 80) || 'system', action, detail ? String(detail).slice(0, 500) : null);
}

/* ---------- reads for the staff app ---------- */
const EQ_SELECT = `SELECT e.id, e.name, e.serial, e.notes, e.status, e.holder, e.project_code, e.project_name, e.site,
  e.location, e.due_date, e.out_at, e.issue, e.updated_at, c.id AS category_id, c.name AS category, c.prefix
  FROM equipment e JOIN categories c ON c.id = e.category_id`;

function bootstrap(db) {
  return {
    categories: db.prepare('SELECT id,name,prefix FROM categories ORDER BY sort,name').all(),
    equipment: db.prepare(`${EQ_SELECT} WHERE e.status != 'retired' ORDER BY c.sort, c.name, e.id`).all(),
    employees: db.prepare('SELECT name FROM employees WHERE active=1 ORDER BY name').all().map((r) => r.name),
    projects: db.prepare('SELECT code,name,client,site FROM projects WHERE active=1 ORDER BY code').all(),
    locations: db.prepare('SELECT name,kind FROM locations WHERE active=1 ORDER BY sort,name').all(),
    today: localDate(),
  };
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
  let due_date = clean(i.due_date, 10);
  if (due_date && (!/^\d{4}-\d{2}-\d{2}$/.test(due_date) || Number.isNaN(Date.parse(due_date)))) throw new HttpError(400, 'That expected-return date is not valid.', { field: 'due' });
  if (kind === 'in') due_date = '';
  if (!Array.isArray(i.items) || i.items.length < 1) throw new HttpError(400, 'Select at least one item.');
  if (i.items.length > 100) throw new HttpError(400, 'Too many items in one transaction (max 100).');
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
  return { kind, idem, employee, location, project_code, project_name, requester: clean(i.requester, 80), site: clean(i.site, 200), due_date, notes, items, client_time };
}

function summary(db, t) {
  const items = db.prepare('SELECT ti.equipment_id AS id, e.name, ti.condition FROM txn_items ti JOIN equipment e ON e.id = ti.equipment_id WHERE ti.txn_id = ? ORDER BY ti.equipment_id').all(t.id);
  return { public_id: t.public_id, kind: t.kind, employee: t.employee, project_code: t.project_code, project_name: t.project_name, requester: t.requester, site: t.site, location: t.location, due_date: t.due_date, notes: t.notes, created_at: t.created_at, voided_at: t.voided_at, items };
}

function createTransaction(db, raw, meta = {}) {
  const v = validateTxn(raw);
  const byKey = db.prepare('SELECT * FROM transactions WHERE idem_key = ?');
  const dup = byKey.get(v.idem);
  if (dup) return { txn: summary(db, dup), replay: true };

  const undoToken = crypto.randomBytes(16).toString('hex');
  const res = tx(db, () => {
    const again = byKey.get(v.idem);
    if (again) return { txn: summary(db, again), replay: true };

    const getEq = db.prepare('SELECT * FROM equipment WHERE id = ?');
    const rows = [];
    const conflicts = [];
    for (const it of v.items) {
      const e = getEq.get(it.id);
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
      const p = db.prepare('SELECT code,name,site FROM projects WHERE code = ?').get(project_code);
      if (p) { project_code = p.code; project_name = project_name || p.name; site = site || p.site; }
    }
    if (v.kind === 'in' && !project_code && !project_name) {
      const codes = new Set(rows.map((r) => `${r.e.project_code || ''}|${r.e.project_name || ''}`));
      if (codes.size === 1) { const [c, n] = [...codes][0].split('|'); project_code = c; project_name = n; }
      else if (codes.size > 1) project_name = 'Multiple projects';
    }

    const t = nowIso();
    const pid = crypto.randomUUID();
    const txnId = Number(db.prepare(`INSERT INTO transactions(public_id,idem_key,kind,employee,project_code,project_name,requester,site,location,due_date,notes,created_at,client_time,device,undo_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(pid, v.idem, v.kind, v.employee, nul(project_code), nul(project_name), nul(v.requester), nul(site), v.location, nul(v.due_date), nul(v.notes), t, v.client_time, clean(meta.device, 120) || null, sha(undoToken)).lastInsertRowid);

    const insItem = db.prepare('INSERT INTO txn_items(txn_id,equipment_id,condition,prev_json) VALUES (?,?,?,?)');
    const upd = db.prepare(`UPDATE equipment SET status=?, txn_id=?, holder=?, project_code=?, project_name=?, site=?, location=?, due_date=?, out_at=?, issue=?, updated_at=? WHERE id=?`);
    for (const { e, condition } of rows) {
      const prev = Object.fromEntries(STATE.map((k) => [k, e[k] ?? null]));
      insItem.run(txnId, e.id, condition, JSON.stringify(prev));
      if (v.kind === 'out') upd.run('out', txnId, v.employee, nul(project_code), nul(project_name), nul(site), v.location, nul(v.due_date), t, null, t, e.id);
      else upd.run(condition === 'ok' ? 'available' : 'maintenance', txnId, null, null, null, null, v.location, null, null, condition === 'ok' ? null : (v.notes || 'Problem reported on return'), t, e.id);
    }
    // First-time names become "self-added" entries an admin can review/merge.
    db.prepare('INSERT OR IGNORE INTO employees(name,active,self_added) VALUES (?,1,1)').run(v.employee);
    bump();
    return { txn: summary(db, db.prepare('SELECT * FROM transactions WHERE id = ?').get(txnId)), replay: false };
  });
  if (!res.replay) res.undo_token = undoToken;
  return res;
}

/** Reverse a transaction. Only allowed while nothing newer has touched any of its items. */
function voidTransaction(db, ref, { actor, reason, undoToken } = {}) {
  const res = tx(db, () => {
    const t = ref.public_id
      ? db.prepare('SELECT * FROM transactions WHERE public_id = ?').get(ref.public_id)
      : db.prepare('SELECT * FROM transactions WHERE id = ?').get(ref.id);
    if (!t) throw new HttpError(404, 'Transaction not found.');
    if (t.voided_at) throw new HttpError(409, 'That transaction was already reversed.');
    if (undoToken !== undefined) {
      const ok = t.undo_hash && undoToken && crypto.timingSafeEqual(Buffer.from(sha(undoToken)), Buffer.from(t.undo_hash));
      if (!ok) throw new HttpError(403, 'Undo is not available for this transaction.');
      if (Date.now() - Date.parse(t.created_at) > UNDO_WINDOW_MS) throw new HttpError(403, 'The undo window has passed — please ask an administrator to correct it.');
      actor = t.employee; reason = reason || 'Undone by user';
    }
    const items = db.prepare('SELECT * FROM txn_items WHERE txn_id = ?').all(t.id);
    const later = db.prepare(`SELECT t2.id FROM txn_items i2 JOIN transactions t2 ON t2.id = i2.txn_id
      WHERE i2.equipment_id = ? AND t2.id > ? AND t2.voided_at IS NULL LIMIT 1`);
    for (const it of items) {
      if (later.get(it.equipment_id, t.id)) throw new HttpError(409, `${it.equipment_id} has newer activity. Reverse the newer transaction first.`);
    }
    const restore = db.prepare(`UPDATE equipment SET status=?, txn_id=?, holder=?, project_code=?, project_name=?, site=?, location=?, due_date=?, out_at=?, issue=?, updated_at=? WHERE id=?`);
    const at = nowIso();
    for (const it of items) {
      const p = JSON.parse(it.prev_json);
      restore.run(p.status, p.txn_id, p.holder, p.project_code, p.project_name, p.site, p.location, p.due_date, p.out_at, p.issue, at, it.equipment_id);
    }
    db.prepare('UPDATE transactions SET voided_at=?, voided_by=?, void_reason=? WHERE id=?').run(at, clean(actor, 80) || 'admin', clean(reason, 300) || null, t.id);
    audit(db, actor, 'void_transaction', `#${t.id} ${t.kind} by ${t.employee}: ${clean(reason, 200)}`);
    bump();
    return { txn: summary(db, db.prepare('SELECT * FROM transactions WHERE id = ?').get(t.id)) };
  });
  return res;
}

/* ---------- admin: inventory ---------- */
function nextIds(db, prefix, count) {
  const rows = db.prepare('SELECT id FROM equipment WHERE id LIKE ?').all(`${prefix}-%`);
  let max = 0;
  for (const r of rows) max = Math.max(max, parseInt(r.id.split('-')[1], 10) || 0);
  return Array.from({ length: count }, (_, k) => `${prefix}-${String(max + k + 1).padStart(3, '0')}`);
}

function createEquipment(db, b, actor) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(b.category_id));
  if (!cat) throw new HttpError(400, 'Choose a category.');
  const name = clean(b.name, 120);
  if (!name) throw new HttpError(400, 'Name / model is required.');
  const count = Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 100);
  return tx(db, () => {
    let ids;
    if (b.id) {
      const id = clean(b.id, 12).toUpperCase();
      if (!ID_RE.test(id) || !id.startsWith(`${cat.prefix}-`)) throw new HttpError(400, `ID must look like ${cat.prefix}-001.`);
      if (db.prepare('SELECT 1 FROM equipment WHERE id = ?').get(id)) throw new HttpError(409, `${id} already exists.`);
      ids = [id];
    } else ids = nextIds(db, cat.prefix, count);
    const t = nowIso();
    const ins = db.prepare('INSERT INTO equipment(id,category_id,name,serial,notes,status,location,updated_at) VALUES (?,?,?,?,?,?,?,?)');
    const loc = clean(b.location, 120) || null;
    for (const id of ids) ins.run(id, cat.id, name, clean(b.serial, 80), clean(b.notes, 300), 'available', loc, t);
    audit(db, actor, 'create_equipment', `${ids[0]}${ids.length > 1 ? `…${ids[ids.length - 1]}` : ''} (${ids.length}) ${name}`);
    bump();
    return { ids };
  });
}

function updateEquipment(db, id, b, actor) {
  const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
  if (!e) throw new HttpError(404, 'Equipment not found.');
  const name = clean(b.name ?? e.name, 120);
  if (!name) throw new HttpError(400, 'Name / model is required.');
  db.prepare('UPDATE equipment SET name=?, serial=?, notes=?, updated_at=? WHERE id=?').run(name, clean(b.serial ?? e.serial, 80), clean(b.notes ?? e.notes, 300), nowIso(), id);
  audit(db, actor, 'update_equipment', id); bump();
  return { ok: true };
}

/** Manual correction by an administrator (e.g. item found on the shelf but never returned). Fully reversible. */
function adjustStatus(db, id, b, actor) {
  const status = b.status;
  if (!['available', 'maintenance', 'retired'].includes(status)) throw new HttpError(400, 'Status must be available, maintenance or retired.');
  const reason = clean(b.reason, 300);
  if (reason.length < 3) throw new HttpError(400, 'Please give a short reason for the correction.', { field: 'reason' });
  return tx(db, () => {
    const e = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'Equipment not found.');
    if (e.status === status) throw new HttpError(409, `${id} is already ${status}.`);
    const t = nowIso();
    const location = clean(b.location, 120) || e.location || null;
    const txnId = Number(db.prepare(`INSERT INTO transactions(public_id,kind,employee,location,notes,created_at,device) VALUES (?,?,?,?,?,?,?)`)
      .run(crypto.randomUUID(), 'adjust', clean(actor, 80) || 'admin', location, `${e.status} → ${status}: ${reason}`, t, 'admin').lastInsertRowid);
    db.prepare('INSERT INTO txn_items(txn_id,equipment_id,condition,prev_json) VALUES (?,?,?,?)').run(txnId, id, 'ok', JSON.stringify(Object.fromEntries(STATE.map((k) => [k, e[k] ?? null]))));
    db.prepare(`UPDATE equipment SET status=?, txn_id=?, holder=NULL, project_code=NULL, project_name=NULL, site=NULL, location=?, due_date=NULL, out_at=NULL, issue=?, updated_at=? WHERE id=?`)
      .run(status, txnId, location, status === 'maintenance' ? reason : null, t, id);
    audit(db, actor, 'adjust_status', `${id}: ${e.status} → ${status} (${reason})`);
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
function lookupList(db, table) {
  const L = LOOKUPS[table]; if (!L) throw new HttpError(404, 'Unknown list.');
  return db.prepare(`SELECT * FROM ${table} ORDER BY ${L.order}`).all();
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
function lookupCreate(db, table, b, actor) {
  if (!LOOKUPS[table]) throw new HttpError(404, 'Unknown list.');
  const v = lookupValues(table, b, false);
  const cols = Object.keys(v);
  try { db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(v)); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That entry already exists.'); throw e; }
  audit(db, actor, `create_${table}`, JSON.stringify(v).slice(0, 200)); bump();
  return { ok: true };
}
function lookupUpdate(db, table, id, b, actor) {
  if (!LOOKUPS[table]) throw new HttpError(404, 'Unknown list.');
  const v = lookupValues(table, b, true);
  if (table === 'categories') delete v.prefix; // prefix is baked into printed QR labels — never change it
  const cols = Object.keys(v);
  if (!cols.length) return { ok: true };
  try { db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id=?`).run(...Object.values(v), Number(id)); }
  catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'That name/code is already used.'); throw e; }
  audit(db, actor, `update_${table}`, `#${id} ${JSON.stringify(v).slice(0, 200)}`); bump();
  return { ok: true };
}

/* ---------- admin: reporting ---------- */
function allEquipment(db) { return db.prepare(`${EQ_SELECT} ORDER BY c.sort, c.name, e.id`).all(); }

function listTransactions(db, { q, limit = 100, offset = 0 } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500); offset = Math.max(parseInt(offset, 10) || 0, 0);
  const where = []; const args = [];
  if (q) {
    const like = `%${clean(q, 60)}%`;
    where.push(`(t.employee LIKE ? OR t.project_name LIKE ? OR t.project_code LIKE ? OR t.location LIKE ? OR EXISTS (SELECT 1 FROM txn_items i WHERE i.txn_id=t.id AND i.equipment_id LIKE ?))`);
    args.push(like, like, like, like, like);
  }
  const sql = `SELECT t.id, t.public_id, t.kind, t.employee, t.project_code, t.project_name, t.requester, t.site, t.location, t.due_date, t.notes, t.created_at, t.client_time, t.voided_at, t.voided_by, t.void_reason,
      (SELECT group_concat(equipment_id, ', ') FROM txn_items WHERE txn_id=t.id) AS items,
      (SELECT count(*) FROM txn_items WHERE txn_id=t.id) AS n
    FROM transactions t ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, limit, offset);
}

function overview(db) {
  const today = localDate();
  const by = db.prepare(`SELECT c.name, count(e.id) AS total,
      sum(e.status='available') AS available, sum(e.status='out') AS out, sum(e.status='maintenance') AS maintenance
    FROM categories c LEFT JOIN equipment e ON e.category_id=c.id AND e.status!='retired' GROUP BY c.id ORDER BY c.sort, c.name`).all();
  const totals = db.prepare(`SELECT count(*) AS total, coalesce(sum(status='available'),0) AS available, coalesce(sum(status='out'),0) AS out, coalesce(sum(status='maintenance'),0) AS maintenance FROM equipment WHERE status!='retired'`).get();
  const outRows = db.prepare(`${EQ_SELECT} WHERE e.status='out' ORDER BY e.due_date IS NULL, e.due_date, e.id`).all();
  return {
    totals, byCategory: by, today,
    out: outRows,
    overdue: outRows.filter((r) => r.due_date && r.due_date < today),
    attention: db.prepare(`${EQ_SELECT} WHERE e.status='maintenance' ORDER BY e.updated_at DESC`).all(),
    recent: listTransactions(db, { limit: 8 }),
    selfAdded: db.prepare('SELECT count(*) AS n FROM employees WHERE self_added=1 AND active=1').get().n,
  };
}

/* ---------- CSV (with spreadsheet-formula-injection guard) ---------- */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (cols, rows) => `﻿${cols.join(',')}\r\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\r\n')}\r\n`;

function equipmentFeed(db) {
  const today = localDate();
  return allEquipment(db).map((e) => ({
    id: e.id, category: e.category, name: e.name, serial: e.serial, status: e.status, holder: e.holder, project_code: e.project_code,
    project_name: e.project_name, site: e.site, location: e.location, due_date: e.due_date, overdue: e.status === 'out' && e.due_date && e.due_date < today ? 'yes' : 'no',
    signed_out_at: e.out_at, issue: e.issue, updated_at: e.updated_at,
  }));
}
const EQUIPMENT_COLS = ['id', 'category', 'name', 'serial', 'status', 'holder', 'project_code', 'project_name', 'site', 'location', 'due_date', 'overdue', 'signed_out_at', 'issue', 'updated_at'];
const TXN_COLS = ['id', 'created_at', 'kind', 'employee', 'project_code', 'project_name', 'requester', 'site', 'location', 'due_date', 'items', 'n', 'notes', 'voided_at', 'voided_by', 'void_reason'];

module.exports = {
  HttpError, clean, sha, nowIso, audit, bump, getRev, bootstrap, createTransaction, voidTransaction,
  createEquipment, updateEquipment, adjustStatus, lookupList, lookupCreate, lookupUpdate,
  allEquipment, listTransactions, overview, toCsv, equipmentFeed, EQUIPMENT_COLS, TXN_COLS, ID_RE,
};
