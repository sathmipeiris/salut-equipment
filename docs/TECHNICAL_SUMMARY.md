# Technical summary

## Approach
A single small web server serves two browser apps (staff, admin) and a JSON/CSV API. Everything runs from one Node.js process. Data is in a SQLite-compatible database: a local file by default, or a free Turso (libSQL) cloud database so it survives restarts on free hosting. No build step; one npm dependency (`@libsql/client`, MIT); two small QR libraries are vendored in `public/vendor/`.

## Technology choices
| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js ≥ 20 | Built-in test runner and HTTP server. Free. |
| Database | libSQL (SQLite dialect) via `@libsql/client`: local file or Turso cloud | Same SQL both ways. Free tier is 5 GB. Writes are serialised in-process and run in write transactions. |
| Front end | Vanilla JS + CSS, installable web app (PWA manifest + service worker) | No framework to maintain; works on every device; offline shell. |
| QR | `qrcode-generator` (print), `jsQR` or native `BarcodeDetector` (scan) | Free, runs in the browser, no cloud service. |
| Auth (admin) | PIN → session cookie | Simple for a small team; no accounts for staff. |

## Key features
Staff: no-login link · sign out / return up to 200 items per transaction · search, category chips, ID-range entry, QR scan · choose a person for each visit · remembers location/recent projects · due date · conflict detection · 15-minute undo · offline queue · kiosk mode · problem reporting on return.
Admin: CSV import of the existing inventory sheet · overview (available / out / maintenance, overdue, needs-attention, by-category) · inventory with bulk add and edit · manual status correction with reason · ledger search and reversal · printable QR labels · manage people, projects, locations, categories · audit log · dashboard feed links · CSV export.

## Data storage
Tables: `equipment` (current state), `transactions` + `txn_items` (append-only ledger; stores previous state so reversal is exact), `employees`, `projects`, `locations`, `categories`, `sessions`, `audit`, `settings`. One file: `data/equipment.db`. Backup: `npm run backup` (consistent while running; keeps 30).

Fields recorded per transaction (matching the old form): employee, project no./name, requested by, project location, unit/apartment, from/to location (1818 / Cottontail), other equipment (free text), expected-return date, notes, per-item condition, server timestamp, client timestamp, device (user-agent), and for each item its state before the change.

## Security
See `DESIGN_DECISIONS.md` §5. In short: hashed PIN, HttpOnly SameSite cookie, rate limiting, CSP, output escaping by construction, server-side validation of everything, formula-safe CSV, rotating read-only feed token, audit log.

## Hosting and expected ongoing cost

### Submitted deployment

The working prototype is deployed at:

- Staff application: <https://salut-equipment.onrender.com/>
- Admin console: <https://salut-equipment.onrender.com/admin>
- Health endpoint: <https://salut-equipment.onrender.com/api/health>

The deployment uses a Render web service defined in [`render.yaml`](../render.yaml), built from [`Dockerfile`](../Dockerfile). Render provides HTTPS for the public application. Turso/libSQL is used as the persistent database so Render restarts do not discard transactions.

The software itself is free. Render's free web service may sleep after inactivity, so the first request after a pause can be slower. The health endpoint is suitable for deployment monitoring.

### Other hosting options

The software can also run on one always-on machine:

| Option | Recurring cost | Notes |
|---|---|---|
| **Existing office/warehouse PC or mini PC / Raspberry Pi, on the company network** | $0 beyond electricity | Works for kiosks and Wi-Fi devices. |
| …plus a free tunnel (e.g. Cloudflare Tunnel) for HTTPS and access from job sites | $0 at time of writing (verify current terms) | HTTPS is also what enables in-app camera scanning and the offline service worker. |
| Small cloud VM / container host | Typically a few dollars per month | Only if no on-site machine is suitable. Prices change; verify before committing. |

Not included and not required: user licences, SMS/email services, or a paid database service. The submitted deployment uses Turso's free database option.

## Connecting to an equipment-status dashboard
Admin → Settings shows token-protected, read-only links:
- `/api/feed/equipment.csv?token=…` and `.json`: one row per item with status, holder, project, site, location, due date, **overdue flag**, issue.
- `/api/feed/transactions.csv?token=…`: latest 500 movements.

In **Excel / Power BI**: *Get Data → From Web*, paste the link, set a refresh schedule. Because the existing M365 subscription already includes Excel (and Power BI Desktop is free), this gives a dashboard without extra licences. (Scheduled refresh in the Power BI *service* may need a paid licence and a reachable URL; I have not tested this.) SharePoint/Power Automate or Salesforce could ingest the same feed; I have not built or tested those.

## Testing
`npm test` runs 20 automated API tests, including a 25-way simultaneous-request race, idempotent retries, all-or-nothing conflicts, holder lookup from the database, undo tokens, admin authorisation, reversal rules, bulk ID generation, CSV formula safety, required-field rules from the old form, a 90-item transaction, the CSV importer (including all-or-nothing validation) and an in-place upgrade of databases from the first release, and rate limiting. A browser smoke run should exercise the staff flow, the desktop layout, and every admin tab before deployment.
