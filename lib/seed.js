'use strict';
// Sample data only — fictional names/projects. Real inventory is added from the admin console (bulk add).
const crypto = require('node:crypto');
const svc = require('./service');

const CATEGORIES = [
  ['Air Scrubbers (HEPA)', 'AS', 14, ['HEPA Air Scrubber 500 CFM', 'HEPA Air Scrubber 2000 CFM']],
  ['Negative Air Machines', 'NA', 8, ['Negative Air Machine 2000 CFM']],
  ['Dehumidifiers', 'DH', 16, ['LGR Dehumidifier 70 pint', 'LGR Dehumidifier 120 pint']],
  ['Air Movers / Fans', 'FN', 24, ['Axial Air Mover', 'Centrifugal Air Mover']],
  ['HEPA Vacuums', 'HV', 6, ['HEPA Vacuum 12 gal']],
  ['Water Pumps', 'WP', 6, ['Submersible Pump 1/2 HP']],
  ['Generators', 'GN', 4, ['Portable Generator 5 kW']],
  ['Moisture Meters', 'MM', 8, ['Pin / Pinless Moisture Meter']],
  ['Air Quality Monitors', 'AQ', 8, ['Particulate / Dust Monitor']],
  ['Survey & Layout', 'SV', 6, ['Laser Level', 'Laser Distance Meter']],
];
const EMPLOYEES = ['Amelia Hart', 'Daniel Okafor', 'Priya Raman', 'Marcus Bell', 'Elena Petrova', 'Tomás Alvarez', 'Hannah Kim', 'Jamal Reed', 'Sofia Lindqvist', 'Victor Nguyen'];
const PROJECTS = [
  ['P-2401', 'Reston Parkway Bridge Deck', 'Fairfax Co. DPWES', '1800 Reston Pkwy, Reston, VA'],
  ['P-2407', 'Anacostia Riverwalk Remediation', 'DC DOEE', 'Anacostia Park, Washington, DC'],
  ['P-2412', 'BWI Terminal Concrete Moisture Survey', 'MAA', 'BWI Airport, Linthicum Heights, MD'],
  ['P-2415', 'Glen Burnie Library Mold Abatement', 'Anne Arundel Co.', '1010 Eastway, Glen Burnie, MD'],
  ['P-2418', 'Navy Yard Basement Water Loss', 'Private client', '1100 New Jersey Ave SE, Washington, DC'],
  ['P-2420', 'Route 50 Culvert Dewatering', 'MDOT SHA', 'US-50 near Cheverly, MD'],
];
const LOCATIONS = [
  ['Warehouse – Washington, DC', 'warehouse', 1], ['Warehouse – Glen Burnie, MD', 'warehouse', 2],
  ['Project site', 'site', 3], ['Company vehicle', 'vehicle', 4], ['Other', 'other', 9],
];

function seedBase(db) {
  const c = db.prepare('INSERT OR IGNORE INTO categories(name,prefix,sort) VALUES (?,?,?)');
  CATEGORIES.forEach(([n, p], i) => c.run(n, p, i));
  const l = db.prepare('INSERT OR IGNORE INTO locations(name,kind,sort) VALUES (?,?,?)');
  LOCATIONS.forEach(([n, k, s]) => l.run(n, k, s));
  svc.bump();
}

function seedDemo(db) {
  seedBase(db);
  const e = db.prepare('INSERT OR IGNORE INTO employees(name) VALUES (?)');
  EMPLOYEES.forEach((n) => e.run(n));
  const p = db.prepare('INSERT OR IGNORE INTO projects(code,name,client,site) VALUES (?,?,?,?)');
  PROJECTS.forEach((r) => p.run(...r));
  const cats = db.prepare('SELECT * FROM categories').all();
  let sn = 4100;
  for (const [name, prefix, count, models] of CATEGORIES) {
    const cat = cats.find((x) => x.prefix === prefix);
    models.forEach((m, mi) => {
      const n = Math.ceil(count / models.length) - (mi === models.length - 1 ? models.length * Math.ceil(count / models.length) - count : 0);
      const made = svc.createEquipment(db, { category_id: cat.id, name: m, count: n, location: LOCATIONS[prefix.charCodeAt(0) % 2][0] }, 'seed');
      made.ids.forEach((id) => db.prepare('UPDATE equipment SET serial=? WHERE id=?').run(`SN-${sn++}`, id));
    });
  }
  const day = (d) => new Date(Date.now() + d * 864e5).toLocaleDateString('en-CA');
  const out = (employee, proj, items, due, loc = 'Warehouse – Washington, DC') => svc.createTransaction(db, {
    kind: 'out', idem_key: crypto.randomUUID(), employee, project_code: proj, items: items.map((id) => ({ id })), location: loc, due_date: due,
  }, { device: 'seed' });
  out('Amelia Hart', 'P-2401', ['AS-001', 'AS-002', 'NA-001', 'NA-002', 'FN-001', 'FN-002', 'FN-003'], day(10));
  out('Daniel Okafor', 'P-2407', ['DH-001', 'DH-002', 'DH-003', 'FN-010', 'FN-011', 'FN-012', 'FN-013'], day(3));
  out('Priya Raman', 'P-2412', ['MM-001', 'MM-002', 'SV-001'], day(-2), 'Warehouse – Glen Burnie, MD');   // overdue
  out('Marcus Bell', 'P-2420', ['WP-001', 'WP-002', 'GN-001'], day(-5), 'Warehouse – Glen Burnie, MD');    // overdue
  const r = svc.createTransaction(db, { kind: 'in', idem_key: crypto.randomUUID(), employee: 'Elena Petrova', location: 'Warehouse – Washington, DC', items: [{ id: 'DH-001' }, { id: 'DH-002', condition: 'issue' }], notes: 'DH-002: drain pump noisy, not draining fully' }, { device: 'seed' });
  return r;
}

module.exports = { seedBase, seedDemo };

if (require.main === module) {
  const path = require('node:path');
  const fs = require('node:fs');
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'equipment.db');
  if (process.argv.includes('--reset')) for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true });
  const { open } = require('./db');
  const db = open(file);
  if (db.prepare('SELECT count(*) AS n FROM equipment').get().n > 0) { console.log('Database already has equipment — use --reset to wipe and re-seed.'); process.exit(0); }
  seedDemo(db);
  console.log(`Seeded demo data into ${file}`);
}
