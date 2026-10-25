# Put it online for reviewers (free, ~5 minutes)

Uses Render's free tier. The demo database resets when the service restarts, which is fine for a demo: sample data reloads automatically.

1. Push this repo to GitHub (see README).
2. Sign in at https://render.com with GitHub → **New → Blueprint** → pick the repo. It reads `render.yaml`.
3. When asked, set **ADMIN_PIN** to something you can share with interviewers (e.g. `demo-2026`).
4. After the build, Render gives you `https://salut-equipment.onrender.com`. Staff page at `/`, admin at `/admin`.

Notes
- Free services sleep after ~15 min idle; the first visit then takes ~30 s. Open it yourself just before an interview.
- HTTPS is automatic, so camera QR scanning and "Install app" work.
- For permanent data use a paid plan with a disk mounted at `/app/data`, or Fly.io with a volume.
- Quick alternative from your own laptop: `npm start` then `cloudflared tunnel --url http://localhost:3000` gives a temporary public https link.
