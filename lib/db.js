'use strict';
// SQLite via Node's built-in node:sqlite (no npm dependency).
// WAL mode = readers never block the writer; BEGIN IMMEDIATE = writers are serialised,
// which is what makes "two people grab the same scrubber" impossible.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS equipment(
  id TEXT PRIMARY KEY,                       -- printed on the QR label, e.g. AS-003
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

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Add columns introduced after the first release to databases created by older versions. */
function migrate(db) {
  const add = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  add('equipment', 'unit', 'TEXT');
  add('transactions', 'unit', 'TEXT');
  add('transactions', 'other_devices', 'TEXT');
}

/** Run fn inside a write transaction that takes the write lock up-front. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

module.exports = { open, tx };
