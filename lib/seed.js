'use strict';
// SAMPLE DATA ONLY — people, projects and addresses are fictional. No real response data is stored in this repo.
// IDs follow the tags already on the equipment (S01–S40 scrubbers, D01–D25 dehumidifiers, F01–F26 fans).
// To load the real fleet, use Admin → Inventory → Import (CSV).
const crypto = require('node:crypto');
const svc = require('./service');

const CATEGORIES = [
  ['Air Scrubbers', 'S', 40, ['HEPA Air Scrubber']],
  ['Dehumidifiers', 'D', 25, ['LGR Dehumidifier']],
  ['Fans', 'F', 26, ['Air Mover']],
];
const EMPLOYEES = ['Alex Morgan', 'Priya Nair', 'Sam Okoye', 'Jordan Lee', 'Maria Santos', 'Chris Dubois', 'Taylor Brooks', 'Dana Whitfield'];
const PROJECTS = [
  ['26-101', 'Maple Court Senior Apartments', 'Sample Client A', '410 Maple Ct (sample address)'],
  ['26-108', 'Harbor Street Library', 'Sample Client B', '22 Harbor St (sample address)'],
  ['26-112', 'Oak Ridge Elementary', 'Sample Client C', '900 Oak Ridge Rd (sample address)'],
  ['26-115', 'Westside Community Center', 'Sample Client D', '75 West Ave (sample address)'],
];
const LOCATIONS = [['1818', 'warehouse', 1], ['Cottontail', 'warehouse', 2]];

async function seedBase(db) {
  await db.batch([
    ...CATEGORIES.map(([n, p], i) => ['INSERT OR IGNORE INTO categories(name,prefix,sort) VALUES (?,?,?)', [n, p, i]]),
    ...LOCATIONS.map(([n, k, s]) => ['INSERT OR IGNORE INTO locations(name,kind,sort) VALUES (?,?,?)', [n, k, s]]),
  ]);
  svc.bump();
}

async function seedDemo(db) {
  await seedBase(db);
  await db.batch([
    ...EMPLOYEES.map((n) => ['INSERT OR IGNORE INTO employees(name) VALUES (?)', [n]]),
    ...PROJECTS.map((r) => ['INSERT OR IGNORE INTO projects(code,name,client,site) VALUES (?,?,?,?)', r]),
  ]);
  const cats = await db.all('SELECT * FROM categories');
  let sn = 1000;
  for (const [, prefix, count, models] of CATEGORIES) {
    const cat = cats.find((x) => x.prefix === prefix);
    const made = await svc.createEquipment(db, { category_id: cat.id, name: models[0], count, location: prefix === 'S' ? '1818' : 'Cottontail' }, 'seed');
    await db.batch(made.ids.map((id) => ['UPDATE equipment SET serial=? WHERE id=?', [`SAMPLE-${sn++}`, id]]));
  }
  const day = (d) => new Date(Date.now() + d * 864e5).toLocaleDateString('en-CA');
  const out = (employee, proj, requester, items, due, loc, extra = {}) => svc.createTransaction(db, {
    kind: 'out', idem_key: crypto.randomUUID(), employee, project_code: proj, requester, items: items.map((id) => ({ id })), location: loc, due_date: due, ...extra,
  }, { device: 'seed' });
  await out('Alex Morgan', '26-101', 'Pat Rivera', ['S01', 'S02', 'S03', 'D01', 'D02', 'F01', 'F02', 'F03'], day(10), '1818', { unit: '4B' });
  await out('Priya Nair', '26-108', 'Pat Rivera', ['S10', 'S11', 'F10', 'F11', 'F12'], day(3), 'Cottontail');
  await out('Sam Okoye', '26-112', 'Lee Chen', ['D10', 'D11', 'F20'], day(-2), 'Cottontail');                       // overdue
  await out('Jordan Lee', '26-115', 'Lee Chen', ['S20', 'S21', 'D20'], day(-5), '1818', { other_devices: 'Two 100 ft extension cords' }); // overdue
  await svc.createTransaction(db, { kind: 'in', idem_key: crypto.randomUUID(), employee: 'Maria Santos', location: '1818', items: [{ id: 'D01' }, { id: 'D02', condition: 'issue' }], notes: 'D02: drain pump noisy, not draining fully' }, { device: 'seed' });
}

module.exports = { seedBase, seedDemo };

if (require.main === module) {
  (async () => {
    const path = require('node:path');
    const { open } = require('./db');
    const target = process.env.TURSO_DATABASE_URL || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'equipment.db');
    const db = await open(target, process.env.TURSO_AUTH_TOKEN);
    if (process.argv.includes('--reset')) {
      for (const t of ['txn_items', 'transactions', 'sessions', 'audit', 'equipment', 'employees', 'projects', 'locations', 'categories']) await db.run(`DELETE FROM ${t}`);
      svc.bump();
    }
    if ((await db.get('SELECT count(*) AS n FROM equipment')).n > 0) { console.log('Database already has equipment — use --reset to wipe and re-seed.'); return db.close(); }
    await seedDemo(db);
    console.log(`Seeded sample data into ${target}`);
    db.close();
  })().catch((e) => { console.error(e); process.exit(1); });
}
