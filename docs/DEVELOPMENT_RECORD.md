# Development record

## Time spent
**Approximate hours: ____ (fill in your own actual time before submitting).**

> The brief asks for the real time spent. I (the AI assistant) cannot measure your time, so this is left for you to complete honestly, including time you spent reviewing, testing and understanding the code.

## Tools used
- Claude (AI assistant) generated the design, code, tests and documentation; ____ (list anything else you used).
- Node.js 22, SQLite, Playwright/Chromium (testing only).
- Vendored libraries: `qrcode-generator` (MIT), `jsQR` (Apache-2.0).

## Completed
Everything under "Key features" in `TECHNICAL_SUMMARY.md`. Verified by 15 automated tests and a scripted browser run (phone and desktop viewports).

## Known limitations
1. **Original Google Form fields were not inspected.** The form link was not reachable from the build environment; fields follow the brief's list. Compare against the real form and adjust.
2. **No staff identity checking.** The link is the only gate (as requested). Anyone with it can create transactions.
3. **One shared admin PIN.** Actions are attributed to the name typed at sign-in, which is not verified.
4. **Hosting not deployed.** Runs locally; no live link. HTTPS is needed for in-app camera scanning and offline mode; scanning with the phone's own camera works without it.
5. **Offline mode is limited.** The device shows its own queued items as applied, but other devices don't see them until it reconnects; an item taken by someone else meanwhile is reported as a failure for an admin to resolve.
6. **Live updates are polling (20 s), not push.**
7. **Dashboard feeds are tested as CSV/JSON endpoints only.** Not tested inside Power BI, SharePoint or Salesforce.
8. **QR scanning** uses the browser's native detector where present, else jsQR; tested for code paths loading, **not** with a physical camera on real labels.
9. **Single server, single time zone.** Overdue is computed in the server's `TZ`.
10. Accessibility was designed for (large targets, labels, contrast, focus rings) but not audited with a screen reader.

## Recommended next steps
1. Reconcile fields with the original form; add any missing ones (e.g. a request/work-order number, vehicle).
2. Deploy on the chosen host with HTTPS; set `COOKIE_SECURE=1`, `TRUST_PROXY=1`, a strong `ADMIN_PIN`, and schedule `npm run backup`.
3. Restrict the staff page to the company network/VPN, or add a shared site passcode.
4. Print and apply QR labels; pilot with 5–10 items on one team; collect feedback.
5. Connect the CSV feed to the existing Excel/Power BI dashboard.
6. Email/Teams reminders for overdue items (Power Automate reading the feed).
7. Per-admin accounts (or Microsoft sign-in) if more than a few admins.
8. Photo on return for damage reports; maintenance history per item; reservations.
9. If SaLUT outgrows one site: PostgreSQL, push updates, per-branch scoping (see `DESIGN_DECISIONS.md` §4).
