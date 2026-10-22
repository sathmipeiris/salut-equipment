# Equipment Sign-Out

A no-login web app for signing field equipment (air scrubbers, dehumidifiers, fans, …) out and back in, built for the SaLUT Technical Assessment 01. It replaces a Google Form + Sheet workflow.

- **Staff page** (`/`): no account, works on phones, tablets, kiosks and desktops. Sign out or return many items in one transaction.
- **Admin console** (`/admin`): PIN-protected. Inventory, corrections, reversals, QR label printing, people/projects/locations, dashboard feed.
- **Zero runtime dependencies, zero recurring cost.** Node.js + the SQLite built into Node. Nothing to `npm install`.

## Run it locally (2 minutes)

Requirements: **Node.js 22.13 or newer** (<https://nodejs.org>). Check with `node -v`.

```bash
git clone https://github.com/<your-username>/salut-equipment.git
cd salut-equipment
npm start
```

Open:

| What | Address |
|---|---|
| Staff page | <http://localhost:3000/> |
| Kiosk mode (auto-resets between users) | <http://localhost:3000/?kiosk=1> |
| Admin console | <http://localhost:3000/admin> |

On the **first start** the server prints a randomly generated **admin PIN** in the terminal. Copy it. To choose your own instead:

```bash
ADMIN_PIN=my-secret-pin npm start          # macOS / Linux
$env:ADMIN_PIN="my-secret-pin"; npm start  # Windows PowerShell
```

The first start loads **fictional sample data** (about 100 items, a few people and projects, some overdue items) so you can try everything immediately.

### Try it on a phone
Phone and computer on the same Wi-Fi: find the computer's IP address (e.g. `192.168.1.20`) and open `http://192.168.1.20:3000/` on the phone. Camera scanning inside the page needs HTTPS (see *Deploying*), but scanning a printed QR label with the phone's normal camera app works over plain HTTP.

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs 15 automated tests (race conditions, double-submit, auth, CSV safety, …) |
| `npm run seed` | Wipes the database and reloads sample data |
| `npm run backup` | Safe backup of the database while running (keeps newest 30) |
| `DEMO_DATA=0 npm start` | On a **fresh** database, start empty with just categories/locations, ready for real inventory |

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_PIN` | random on first start | Admin PIN (stored hashed with scrypt) |
| `DB_FILE` | `data/equipment.db` | Database location |
| `TZ` | system | Time zone used for "overdue" (e.g. `America/New_York`) |
| `COOKIE_SECURE=1` | off | Set when served over HTTPS |
| `TRUST_PROXY=1` | off | Set behind a reverse proxy / tunnel so rate limits see the real client IP |

## Using it

**Staff, sign out:** tap *Sign out* → name, project, location (remembered next time) → tap equipment tiles from any category, or scan QR labels, or type `FN-1..8, DH-2` → *Review* → *Confirm*. A 15-minute *Undo* appears on the confirmation screen.

**Staff, return:** tap *Return* → your signed-out items are listed grouped by project → tick them (or *Select all*) → mark any with a problem → confirm.

**Admin:** *Inventory* → *Add equipment* (bulk add numbers IDs automatically) → *QR labels* → print. *Activity* shows every transaction and lets an administrator reverse mistakes. *Settings* has the dashboard links and PIN change.

## Docs

- [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md): why it is built this way, incl. scalability
- [`docs/TECHNICAL_SUMMARY.md`](docs/TECHNICAL_SUMMARY.md): approach, storage, security, costs, dashboard connection
- [`docs/DEVELOPMENT_RECORD.md`](docs/DEVELOPMENT_RECORD.md): time, tools, completed features, limitations, next steps

## Project layout

```
server.js          HTTP server, routing, auth, rate limiting, static files
lib/db.js          SQLite schema and write-transaction helper
lib/service.js     All business rules (transactions, conflicts, reversals, CSV)
lib/seed.js        Sample data (fictional)
lib/backup.js      Online backup
public/            Staff app (index.html, app.js), admin (admin.html, admin.js), shared code, vendored QR libs
test/              Automated tests
```
