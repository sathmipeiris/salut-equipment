# Technical summary

## Approach
A single small web server serves two browser apps (staff, admin) and a JSON/CSV API. Everything runs from one Node.js process and one SQLite file. No build step, no npm dependencies (two small MIT/Apache-2.0 QR libraries are vendored in `public/vendor/`).

## Technology choices
| Layer | Choice | Reason |
|---|---|---|
| Runtime | Node.js ≥ 22.13 | Built-in SQLite (`node:sqlite`), built-in test runner, built-in HTTP. Free. |
| Database | SQLite (WAL mode) | One file, transactional, trivial backup, plenty for this load. |
| Front end | Vanilla JS + CSS, installable web app (PWA manifest + service worker) | No framework to maintain; works on every device; offline shell. |
| QR | `qrcode-generator` (print), `jsQR` or native `BarcodeDetector` (scan) | Free, runs in the browser, no cloud service. |
| Auth (admin) | PIN → session cookie | Simple for a small team; no accounts for staff. |

## Key features
Staff: no-login link · sign out / return up to 100 items per transaction · search, category chips, ID-range entry, QR scan · remembers name/location/recent projects · due date · conflict detection · 15-minute undo · offline queue · kiosk mode · problem reporting on return.
Admin: overview (available / out / maintenance, overdue, needs-attention, by-category) · inventory with bulk add and edit · manual status correction with reason · ledger search and reversal · printable QR labels · manage people, projects, locations, categories · audit log · dashboard feed links · CSV export.

## Data storage
Tables: `equipment` (current state), `transactions` + `txn_items` (append-only ledger; stores previous state so reversal is exact), `employees`, `projects`, `locations`, `categories`, `sessions`, `audit`, `settings`. One file: `data/equipment.db`. Backup: `npm run backup` (consistent while running; keeps 30).

Fields recorded per transaction: employee, project code/name, requester, site, from/to location, expected-return date, notes, per-item condition, server timestamp, client timestamp, device (user-agent), and for each item its state before the change.

## Security
See `DESIGN_DECISIONS.md` §5. In short: hashed PIN, HttpOnly SameSite cookie, rate limiting, CSP, output escaping by construction, server-side validation of everything, formula-safe CSV, rotating read-only feed token, audit log.

## Hosting and expected ongoing cost
The software is free. It needs one always-on machine:

| Option | Recurring cost | Notes |
|---|---|---|
| **Existing office/warehouse PC or mini PC / Raspberry Pi, on the company network** | $0 beyond electricity | Works for kiosks and Wi-Fi devices. |
| …plus a free tunnel (e.g. Cloudflare Tunnel) for HTTPS and access from job sites | $0 at time of writing (verify current terms) | HTTPS is also what enables in-app camera scanning and the offline service worker. |
| Small cloud VM / container host | Typically a few dollars per month | Only if no on-site machine is suitable. Prices change; verify before committing. |

Not included and not required: a database service, user licences, SMS/email services.

## Connecting to an equipment-status dashboard
Admin → Settings shows token-protected, read-only links:
- `/api/feed/equipment.csv?token=…` and `.json`: one row per item with status, holder, project, site, location, due date, **overdue flag**, issue.
- `/api/feed/transactions.csv?token=…`: latest 500 movements.

In **Excel / Power BI**: *Get Data → From Web*, paste the link, set a refresh schedule. Because the existing M365 subscription already includes Excel (and Power BI Desktop is free), this gives a dashboard without extra licences. (Scheduled refresh in the Power BI *service* may need a paid licence and a reachable URL; I have not tested this.) SharePoint/Power Automate or Salesforce could ingest the same feed; I have not built or tested those.

## Testing
`npm test` runs 15 automated API tests, including a 25-way simultaneous-request race, idempotent retries, all-or-nothing conflicts, undo tokens, admin authorisation, reversal rules, bulk ID generation, CSV formula safety, and rate limiting. A headless-browser run exercised the staff flow (sign out, return with problem, undo, QR deep link, offline queue and replay), the desktop layout, and every admin tab with no page errors.
