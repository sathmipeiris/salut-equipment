# Design decisions

The order below follows the priorities in the brief: usability first, then reliability, then cost.

## 1. User experience (the main concern)

Field staff are often on a phone, wearing gloves, in poor light, with a truck waiting. Every decision below serves that.

| Decision | Why |
|---|---|
| **Two giant buttons on the home screen: Sign out / Return** | The only question a person must answer first. No menus, no jargon. |
| **No login; the name is remembered on that device** | Brief requires link-only access. Typing a name once and never again is faster than any password. Kiosk mode does *not* remember names (shared device). |
| **Tap-to-select tiles with large IDs (AS-003)** | The ID is what is printed on the equipment, so staff can match by eye. 54 px+ touch targets, 18 px base text, high contrast for sunlight. |
| **Category chips + live search + "type IDs" box (`FN-1..8, DH-2`)** | Three ways to build a long list quickly, so a 30-item job takes under a minute. This is what removes "excessive scrolling". |
| **QR labels: scan in-app, or with the phone's own camera** | Each label encodes `https://site/e/AS-003`. Scanning with any camera opens the app with that item already added. The in-app *Scan* button adds many in a row. |
| **Return list shows *my* items, grouped by project, with "Select all N"** | Returning is the most common mistake-prone step. People return a whole job at once, so one tap per project. |
| **Remembers location and recent projects; project auto-fills the site** | Fewer fields to type each time. |
| **Details collapse to a one-line summary after step 1** | Keeps the equipment picker on screen, so there is little scrolling. |
| **Review sheet before confirming, then a big green tick with 15-min Undo** | Confirmation catches errors before they are saved; Undo catches the ones noticed afterwards, without calling the office. |
| **Plain-language errors** | "AS-005 is already signed out to Daniel Okafor (Anacostia Riverwalk)" instead of "409 Conflict". |
| **Works offline** | Basements and culverts have no signal. Transactions are saved on the device and upload automatically; the screen says "Saved on this device". |
| **Kiosk mode (`/?kiosk=1`)** | Resets to the start screen after 12 s on the confirmation or 3 min idle, and forgets the previous person, so a warehouse tablet is always ready. |

## 2. Reliability and data accuracy

| Decision | Why |
|---|---|
| **Append-only ledger + current-state snapshot** | Every movement is a row in `transactions`; nothing is deleted. The `equipment` row holds the *current* state so dashboards read one small table. |
| **All-or-nothing transactions inside `BEGIN IMMEDIATE`** | If any item in a sign-out is already taken, nothing is saved and the person is told exactly which items conflicted. Tested with 25 simultaneous requests for one item: exactly one wins. |
| **Idempotency key per submission** | A double-tap or a retry after a dropped connection can never create two records. This is also what makes offline replay safe. |
| **Reversal instead of delete** | Admins can reverse a transaction; the original stays visible, struck through, with who/why. Reversal restores the exact prior state of each item and is refused if newer activity has touched an item. |
| **Manual correction as a recorded transaction** | "Found on the shelf, never returned" is fixed with a required reason, and it appears in the ledger and audit log. |
| **No 14-device limit** | One transaction accepts up to 100 items (tested with 40). |
| **Problem reports on return send the item to Maintenance** | Broken equipment can't be signed out again until an admin marks it repaired. |

## 3. Cost and feasibility

The brief asks for no additional recurring cost and mentions existing M365, ChatGPT Business and Salesforce subscriptions. I chose a **small self-contained app** (Node + SQLite file) because:

- no licences, no per-user fees, no database service to rent;
- one file to back up, nothing to administer;
- zero npm dependencies, so nothing to patch or break on update;
- it can still **feed** M365/Power BI (see the Technical Summary), so the existing subscriptions are used where they are strong (dashboards) rather than forced into an unsuitable role.

The honest trade-off is **hosting**: it needs a computer that stays on. See "Hosting and cost" in the Technical Summary for the no-cost options and the ones that cost money.

I considered and rejected: a SharePoint List + Power Apps app (per-user licensing for external/field users and weak offline/QR flow; I could not verify in this assessment whether the existing licences cover it), and Salesforce (heavier than the problem needs).

## 4. Scalability and distributed-systems needs

**Short answer: for ~100 items, a few dozen staff and a handful of transactions per hour, a single node is the correct design, and distributing it would reduce reliability.** I kept the seams that make growth cheap:

| Concern | Today | If SaLUT grows (e.g. 5,000 items, many warehouses) |
|---|---|---|
| Throughput | SQLite in WAL mode handles thousands of writes/sec; this app needs a few per minute. | Swap to PostgreSQL; business logic is isolated in `lib/service.js`, writes are already single transactions. |
| Concurrency correctness | Serialised write transactions; tested race. | Same logic via `SELECT … FOR UPDATE` or a conditional `UPDATE … WHERE status='available'`. |
| Duplicate / retried requests | Idempotency keys. | Unchanged. This is the key property that makes multi-instance and unreliable networks safe. |
| Stateless app tier | Sessions in the DB, no in-memory state except a read cache and rate limiter. | Move those two to Redis (or drop them) and run N instances behind a load balancer. |
| Read load | `/api/bootstrap` is cached by ledger revision and served with ETags (`304` when nothing changed). | Put a CDN or reverse-proxy cache in front. |
| Live updates | Staff pages poll every 20 s and when the tab regains focus. | Server-Sent Events or WebSockets. |
| Offline / flaky sites | Client queue + replay with the original idempotency keys. | Unchanged. |
| Multi-site | `locations` is already a table. | Add a `site_id` to scope inventory and admins per branch. |
| Failure of the one server | Staff can still open the app and queue transactions offline; nightly `npm run backup`; restoring = copy one file. | Replicated Postgres with managed failover. |

Not built, deliberately: message queues, microservices, event sourcing frameworks, consensus. They would add cost and failure modes without solving a problem this size has.

## 5. Security

- Staff page needs no account by design, so it can only create sign-out/return records and cannot read or change anything else; every request is validated server-side.
- Admin API requires a signed-in session (HttpOnly, SameSite=Strict cookie); PIN stored as salted scrypt; login rate-limited; PIN change signs out other sessions.
- Undo for staff needs a secret token only the original device received.
- Strict Content-Security-Policy, no inline scripts, no `innerHTML` with user data (prevents stored XSS), path-traversal guarded static server, request size limits, per-IP write rate limit.
- CSV/dashboard exports neutralise spreadsheet formulas (`=`, `+`, `-`, `@`).
- Dashboard feed uses a separate read-only token that can be rotated.
- Audit log of admin actions.

**Known gap:** because staff need no login, anyone who has the link can submit transactions. For an internal tool this is the requested trade-off. Mitigations are in the next-steps list (restrict to company network/VPN, or add a shared site passcode).

## 6. Assumptions

The brief says to use the old Google Form to identify the fields. **I could not open the form from my build environment**, so the fields come from the brief's own list: employee, equipment, project / requester details, and sign-out or return location, plus due date, site address, notes and a condition flag that I added because they are standard for this workflow. If the original form has other fields they are quick to add (see *Next steps*). Sample data (names, projects, addresses, locations) is entirely fictional.
