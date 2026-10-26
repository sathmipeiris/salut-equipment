'use strict';
// libSQL (SQLite-compatible) via @libsql/client.
//   • Cloud:  TURSO_DATABASE_URL=libsql://your-db.turso.io  + TURSO_AUTH_TOKEN  → data survives restarts on any host, free tier.
//   • Local:  a plain SQLite file (default data/equipment.db), no account needed.
// Same SQL either way. Writes run inside write transactions that are serialised in-process, which is what makes
// "two people grab the same scrubber" impossible; the database enforces it again on its side.
const { createClient } = require('@libsql/client');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS equipment(
  id TEXT PRIMARY KEY,                       -- printed on the QR label, e.g. S03
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL, serial TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','out','maintenance','retired')),
  -- current-state snapshot (denormalised on purpose: the dashboard reads ONE table)
  txn_id INTEGER, holder TEXT, project_code TEXT, project_name TEXT, site TEXT, unit TEXT,
  location TEXT, due_date TEXT, out_at TEXT, issue TEXT,
  updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_equipment_status ON equipment(status);

CREATE TABLE IF NOT EXISTS employees(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1, self_added INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '', site TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1);

CREATE TABLE IF NOT EXISTS locations(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'warehouse',
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);

-- Append-only ledger. Nothing is ever deleted; mistakes are reversed (voided) and the reversal is itself recorded.
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE,
  idem_key TEXT UNIQUE,                      -- client-generated; makes retries / double-taps safe
  kind TEXT NOT NULL CHECK(kind IN ('out','in','adjust')),
  employee TEXT NOT NULL, project_code TEXT, project_name TEXT, requester TEXT, site TEXT, unit TEXT,
  location TEXT, due_date TEXT, notes TEXT, other_devices TEXT,
  created_at TEXT NOT NULL, client_time TEXT, device TEXT,
  undo_hash TEXT, voided_at TEXT, voided_by TEXT, void_reason TEXT);
CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions(created_at);

CREATE TABLE IF NOT EXISTS txn_items(
  txn_id INTEGER NOT NULL REFERENCES transactions(id),
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  condition TEXT NOT NULL DEFAULT 'ok',
  prev_json TEXT NOT NULL,                   -- equipment state before this txn, so a void can restore it exactly
  PRIMARY KEY(txn_id, equipment_id));
CREATE INDEX IF NOT EXISTS idx_txn_items_eq ON txn_items(equipment_id);

CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT);
`;


/** Wrap a libsql client or transaction in a small async helper: get / all / run / batch. */
function wrap(runner) {
  const rows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
  const h = {
    all: async (sql, args = []) => rows(await runner.execute({ sql, args })),
    get: async (sql, args = []) => (await h.all(sql, args))[0],
    run: async (sql, args = []) => { const rs = await runner.execute({ sql, args }); return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) }; },
    /** Several writes in ONE round trip. stmts = [[sql, args], ...] */
    batch: async (stmts) => { if (stmts.length) await runner.batch(stmts.map(([sql, args = []]) => ({ sql, args }))); },
  };
  return h;
}

/** target: 'libsql://…' / 'file:…' URL, or a plain file path. */
async function open(target, authToken) {
  const url = /^(libsql|https?|wss?|file):/.test(target) ? target : `file:${path.resolve(target)}`;
  if (url.startsWith('file:')) fs.mkdirSync(path.dirname(url.slice(5)), { recursive: true });
  const client = createClient({ url, authToken: authToken || undefined });
  const db = wrap({ execute: (s) => client.execute(s), batch: (s) => client.batch(s, 'write') });
  db.client = client; db.isLocal = url.startsWith('file:'); db.chain = Promise.resolve();
  db.close = () => client.close();
  if (db.isLocal) await client.execute('PRAGMA journal_mode=WAL');
  await client.executeMultiple(SCHEMA);
  await migrate(db);
  return db;
}

/** Add columns introduced after the first release to databases created by older versions. */
async function migrate(db) {
  const add = async (table, col, def) => {
    if (!(await db.all(`PRAGMA table_info(${table})`)).some((r) => r.name === col)) await db.client.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  await add('equipment', 'unit', 'TEXT');
  await add('transactions', 'unit', 'TEXT');
  await add('transactions', 'other_devices', 'TEXT');
}

/** Run fn(d) inside a write transaction. Transactions queue up one after another within this server process. */
function tx(db, fn) {
  const run = db.chain.then(async () => {
    const t = await db.client.transaction('write');
    try { const r = await fn(wrap(t)); await t.commit(); return r; }
    catch (e) { try { await t.rollback(); } catch { /* already rolled back */ } throw e; }
    finally { t.close(); }
  });
  db.chain = run.catch(() => {});
  return run;
}

module.exports = { open, tx };
