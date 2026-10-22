'use strict';
// Consistent online backup (safe while the server is running). Usage: npm run backup [-- target-folder]
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'equipment.db');
const dir = process.argv[2] || path.join(__dirname, '..', 'data', 'backups');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `equipment-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = new DatabaseSync(file);
backup(db, out).then(() => {
  db.close();
  // keep the newest 30 backups
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('equipment-')).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(dir, old));
  console.log(`Backup written: ${out}`);
});
