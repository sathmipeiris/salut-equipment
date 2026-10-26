# Development record

## Time spent
**Approximate active effort: 6.5 hours** (development, testing, debugging, and documentation).

This includes implementation, debugging, automated testing, browser smoke testing, deployment verification, and documentation updates.

## Tools used
- Claude (AI assistant), ChatGPT/Copilot SDK in VS Code, and PowerShell were used for design, implementation, debugging, documentation, and review.
- Node.js 22, npm, SQLite/libSQL, the Node built-in test runner, and Playwright/Chromium where available.
- Vendored libraries: `qrcode-generator` (MIT), `jsQR` (Apache-2.0).

## Completed
Everything under "Key features" in `TECHNICAL_SUMMARY.md`. Reconciled with the old form's questions and the inventory/response workbook (see `DESIGN_DECISIONS.md` §6). Verified by 20 automated API tests, including database-backed holder lookup, concurrency, idempotency, admin authorization, CSV import, and reversal behavior.

## Demo evidence

- Live prototype:
  - Staff: <https://salut-equipment.onrender.com/>
  - Admin: <https://salut-equipment.onrender.com/admin>
  - Health check: <https://salut-equipment.onrender.com/api/health>
- The deployed health endpoint returned HTTP 200, and both deployed staff/admin pages returned HTTP 200 during submission preparation.
- Local server smoke-tested at `http://127.0.0.1:3000/`.
- Captured the staff home screen and the sign-out form showing the active employee dropdown, location selector, project fields, and multi-item review tray.
- The dedicated pinned Playwright video-recording toolchain was unavailable in the evaluation environment, so no video file is claimed as part of this submission. The screenshots captured during the smoke test are the available visual demo evidence.

## Known limitations
1. **The live Google Form was never opened.** The fields come from the form text and response workbook supplied afterwards. If the live form differs from that text, adjust.
2. **No staff identity checking.** The link is the only gate (as requested). Anyone with it can create transactions.
3. **One shared admin PIN.** Actions are attributed to the name typed at sign-in, which is not verified.
4. **Render free-plan behavior.** The live service may sleep after inactivity, so the first request after a pause can be slower. HTTPS is enabled for in-app camera scanning and the offline PWA shell; scanning with the phone's own camera also works.
5. **Offline mode is limited.** The device shows its own queued items as applied, but other devices don't see them until it reconnects; an item taken by someone else meanwhile is reported as a failure for an admin to resolve.
6. **Live updates are polling (20 s), not push.**
7. **Dashboard feeds are tested as CSV/JSON endpoints only.** Not tested inside Power BI, SharePoint or Salesforce.
8. **QR scanning** uses the browser's native detector where present, else jsQR; tested for code paths loading, **not** with a physical camera on real labels.
9. **Single server, single time zone.** Overdue is computed in the server's `TZ`.
10. Accessibility was designed for (large targets, labels, contrast, focus rings) but not audited with a screen reader.

11. **Microsoft 365, Salesforce, and ChatGPT integrations are documented designs, not completed tenant integrations.** The deployed prototype exposes controlled feeds that could be consumed by Power BI, Power Automate, Salesforce middleware, or approved ChatGPT Business workflows. Tenant permissions, connector availability, data-governance rules, and any separate API licensing must be confirmed before enabling automation.

## Recommended next steps
1. Import the real inventory (Admin → Inventory → Import CSV) and resolve the 11 tags the form offered that are missing from the inventory list.
2. Keep the Render deployment configured with HTTPS, `COOKIE_SECURE=1`, `TRUST_PROXY=1`, a strong `ADMIN_PIN`, and a Turso database token; schedule database backups.
3. Restrict the staff page to the company network/VPN, or add a shared site passcode.
4. Print and apply QR labels; pilot with 5–10 items on one team; collect feedback.
5. Connect the CSV feed to the existing Excel/Power BI dashboard.
6. Email/Teams reminders for overdue items (Power Automate reading the feed).
7. Per-admin accounts (or Microsoft sign-in) if more than a few admins.
8. Photo on return for damage reports; maintenance history per item; reservations.
9. If SaLUT outgrows one site: PostgreSQL, push updates, per-branch scoping (see `DESIGN_DECISIONS.md` §4).
