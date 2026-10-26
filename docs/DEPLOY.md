# Put it online for reviewers: free, and the data survives restarts

Two free services: **Turso** (the database, 5 GB free, no card) and **Render** (the web server). The server can sleep and restart as often as it likes; everything lives in Turso.

## 1. Create the free database (Turso)
1. Sign up at https://turso.tech (GitHub login works). Create a database, e.g. `salut-equipment`.
2. On the database page copy the **URL** (`libsql://salut-equipment-<you>.turso.io`).
3. Create a **token** (Database → Generate token, read & write). Copy it.

## 2. Deploy the server (Render)
1. Push this repo to GitHub.
2. https://render.com → **New → Blueprint** → pick the repo (it reads `render.yaml`).
3. Fill in the three environment variables: `ADMIN_PIN` (any PIN you will share with interviewers), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`.
4. First start creates the tables and loads the sample data **once**. After that, restarts keep everything.

For this submission, the deployed prototype is available at:

- Staff: <https://salut-equipment.onrender.com/>
- Admin: <https://salut-equipment.onrender.com/admin>
- Health check: <https://salut-equipment.onrender.com/api/health>

The admin PIN is intentionally not documented in the repository. Share it through a separate secure channel.

Notes
- Free Render services sleep after ~15 min idle (first visit then takes ~30 s). The data is not affected.
- If the logs show a WebSocket/connection error, change the URL scheme from `libsql://` to `https://` (same host).
- To start with an empty inventory instead of sample data, add the variable `DEMO_DATA=0` **before** the first start.
- To wipe the cloud demo back to sample data: run `TURSO_DATABASE_URL=… TURSO_AUTH_TOKEN=… npm run seed -- --reset` on your computer.
- Backups: Turso keeps point-in-time restore in its dashboard, or `turso db shell <name> .dump > backup.sql`.
- Running more than one server instance needs a shared cache for the bootstrap ETag; one instance is right for this app (see Technical Summary).

## Run locally against the cloud database
```
TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… ADMIN_PIN=demo-2026 npm start
```
(PowerShell: set `$env:TURSO_DATABASE_URL=...` etc. first.) Without those variables it uses a local file, `data/equipment.db`.
