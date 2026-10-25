# Equipment Sign-Out

A no-login web app for signing field equipment (air scrubbers `S01`, dehumidifiers `D01`, fans `F01`, …) out and back in. Built for the SaLUT Technical Assessment 01 to replace a Google Form + Sheet workflow.

- **Staff page** (`/`): no account, works on phones, tablets, kiosks and desktops. Sign out or return many items from any category in one transaction.
- **Admin console** (`/admin`): PIN-protected. Inventory (add / import), corrections, reversals, QR label printing, people / projects / locations, dashboard feed.
- **Zero runtime dependencies, zero recurring cost.** Node.js + the SQLite built into Node. Nothing to `npm install`.

## Run it locally (2 minutes)

Requirements: **Node.js 22.13 or newer** (<https://nodejs.org>). Check with `node -v`.

```bash
git clone https://github.com/<your-username>/salut-equipment.git
cd salut-equipment
npm start
```

| What | Address |
|---|---|
| Staff page | <http://localhost:3000/> |
| Kiosk mode (auto-resets between users) | <http://localhost:3000/?kiosk=1> |
| Admin console | <http://localhost:3000/admin> |

On the **first start** the server prints a randomly generated **admin PIN** in the terminal. To choose your own:

```bash
ADMIN_PIN=my-secret-pin npm start          # macOS / Linux
$env:ADMIN_PIN="my-secret-pin"; npm start  # Windows PowerShell
```

The first start loads **fictional sample data** (91 items tagged `S01–S40`, `D01–D25`, `F01–F26`, two locations `1818` and `Cottontail`, a few sample people and projects, some overdue items) so you can try everything immediately.

> **Upgrading from an earlier download?** The tag format changed from `AS-001` to `S01`. Run `npm run seed` once to reset the sample database.

### Load the real inventory
1. Start with an empty database: `DEMO_DATA=0 npm start` (on a fresh `data/` folder).
2. Admin → **Inventory** → **Import CSV**. Choose a CSV, or paste cells copied from Excel / Google Sheets.
3. Accepted columns: `id, category, name, serial, notes, location` **or** the old inventory-tab layout (`Name, Old Name, Tag, Serial No., Description`). The category can be left blank; it is inferred from the tag's first letter.
4. The import is all-or-nothing (a typo never half-imports) and safe to repeat (existing tags are skipped).

### Try it on a phone
Phone and computer on the same Wi-Fi: find the computer's IP address (e.g. `192.168.1.20`) and open `http://192.168.1.20:3000/` on the phone. In-page camera scanning needs HTTPS (see the Technical Summary), but scanning a printed QR label with the phone's normal camera app works over plain HTTP.

### Install it like an app
The staff page installs on phones, tablets and desktops (home-screen icon, full-screen, opens offline). It needs an HTTPS address; steps for Android, iPhone and desktop, and notes on making an APK, are in [`docs/INSTALL_AS_APP.md`](docs/INSTALL_AS_APP.md).

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs 19 automated tests (race conditions, double-submit, auth, CSV import, CSV safety, …) |
| `npm run seed` | Wipes the database and reloads sample data |
| `npm run backup` | Safe backup while running (keeps newest 30) |

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `ADMIN_PIN` | random on first start | Admin PIN (stored hashed with scrypt) |
| `DB_FILE` | `data/equipment.db` | Database location |
| `DEMO_DATA=0` | sample data on | Start a fresh database empty (categories and locations only) |
| `TZ` | system | Time zone used for "overdue" (e.g. `America/New_York`) |
| `COOKIE_SECURE=1` | off | Set when served over HTTPS |
| `TRUST_PROXY=1` | off | Set behind a reverse proxy / tunnel so rate limits see the real client IP |

## Using it

**Sign out:** *Sign out* → name, where from, project, who requested it, project location, (unit) → tap equipment tiles from any category, or scan QR labels, or type `S01-S08, D03, F12` → *Review* → *Confirm*. Name, location and recent projects are remembered. A 15-minute *Undo* appears afterwards.

**Return:** *Return* → your signed-out items are listed grouped by project → tick them (or *Select all*) → mark any with a problem → confirm. Project, requester and location come from the original sign-out.

**Not in the list?** Both flows have a *Something not on the list?* box for other equipment (free text).

**Admin:** *Inventory* → Add / Import CSV → *QR labels* → print. *Activity* shows every transaction (searchable by person, project, requester, item, other equipment) and lets an administrator reverse mistakes. *Settings* has the dashboard links and PIN change.

## Branding
The SaLUT wordmark and circular mark supplied for this project are in `public/brand/`, and the app icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`, `favicon-*.png`) in `public/` are generated from them. Brand colors (navy `#27377c`, yellow `#f8d13e`) are the CSS variables at the top of `public/styles.css`. To re-brand, replace those image files and edit the variables.

## Docs

- [`docs/DESIGN_DECISIONS.md`](docs/DESIGN_DECISIONS.md): why it is built this way, how it maps to the old form, scalability
- [`docs/TECHNICAL_SUMMARY.md`](docs/TECHNICAL_SUMMARY.md): approach, storage, security, costs, dashboard connection
- [`docs/DEVELOPMENT_RECORD.md`](docs/DEVELOPMENT_RECORD.md): time, tools, completed features, limitations, next steps

## Project layout

```
server.js          HTTP server, routing, auth, rate limiting, static files
lib/db.js          SQLite schema, upgrades, write-transaction helper
lib/service.js     All business rules (transactions, conflicts, reversals, import, CSV)
lib/seed.js        Sample data (fictional)
lib/backup.js      Online backup
public/            Staff app (index.html, app.js), admin (admin.html, admin.js), shared code, vendored QR libs
test/              Automated tests
```
