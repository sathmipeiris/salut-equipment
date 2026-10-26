'use strict';
// Consistent backup of a LOCAL database file (safe while the server is running). Usage: npm run backup [-- target-folder]
// Cloud (Turso) databases have their own point-in-time restore and snapshots in the Turso dashboard.
const path = require('node:path');
const fs = require('node:fs');
const { open } = require('./db');

(async () => {
  if (process.env.TURSO_DATABASE_URL) { console.log('This database lives in Turso: use the Turso dashboard / CLI for backups (turso db shell <name> .dump > backup.sql).'); return; }
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'equipment.db');
  const dir = process.argv[2] || path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `equipment-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const db = await open(file);
  await db.run(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  db.close();
  const all = fs.readdirSync(dir).filter((f) => f.startsWith('equipment-')).sort();      // keep the newest 30
  for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(dir, old));
  console.log(`Backup written: ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
