# Agency Agents on Android — Termux Quickstart

Run the full Agency Agents app as a **web app on your phone**. The UI runs in
your mobile browser; a tiny zero-dependency Node server (this repo's `web/`)
implements the same backend command surface as the native app — so you can
browse the 251+ agent catalog, read personas, and **install agents into your
Termux home** (`~/.claude/agents`, `~/.codex/agents`, …) for the AI coding
tools you run inside Termux.

## 1. Install prerequisites (one time)

```bash
pkg update
pkg install nodejs git   # nodejs-lts works too
```

## 2. Get the app + build

```bash
git clone https://github.com/msitarzewski/agency-agents-app
cd agency-agents-app
npm install
npm run build
```

The build writes the SPA to `build/` (takes a minute on phones; you only
rebuild after `git pull`).

## 3. Run

```bash
node web/server.mjs
```

Then open **http://localhost:8787** in your phone's browser. Add it to your
home screen ("Add to Home screen" in the browser menu) and it runs
full-screen like an app.

Useful flags:

```bash
node web/server.mjs --port 9000        # different port
PORT=9000 node web/server.mjs          # same, via env
```

## Where things live

| What | Path |
|------|------|
| App data (ledger, settings, corpus copy) | `~/.local/share/agency-agents-app/` |
| Agent installs | `~/.claude/agents/`, `~/.codex/agents/`, `~/.gemini/agents/`, … (same layout as desktop) |
| Pre-overwrite backups | `~/.local/share/agency-agents-app/backups/` |
| The web server | `web/server.mjs` (zero npm dependencies) |

## Keeping the catalog fresh

The bundled snapshot ships with the app. For the live upstream catalog:

```bash
pkg install git          # if you skipped it above
```

Then in the app: **Settings → Catalog → Set up a managed catalog** (clones
`~/.agency-agents`), or **Refresh** to pull the latest. Without git, the
refresh falls back to downloading the GitHub snapshot — either way you get
the newest agents + NEXUS runbooks.

## Tips

- **Installing to a project**: project-scoped tools (Cursor, opencode) ask
  for a project folder — the in-app folder picker browses your Termux
  filesystem directly.
- **Agentfile export/import** (Teams view) downloads/uploads in the browser
  instead of using native file dialogs.
- **GitHub sign-in and in-app updates** are native-app features; the web
  build updates via `git pull && npm install && npm run build`.
- The server listens on `0.0.0.0`, so from another device on the same
  Wi-Fi you can open `http://<phone-ip>:8787` too.
- Data dir override for testing: `AGENCY_DATA_DIR=/path node web/server.mjs`.

## Development

```bash
# terminal 1 — the backend
node web/server.mjs

# terminal 2 — vite dev server with /api proxied to :8787
npm run dev
```

The dev server (port 1430) hot-reloads the UI while talking to the same
backend as production.

## What's different from the native app?

The web backend is a faithful port of the Rust one (same renderers —
byte-identical agent files, same ledger/reconcile model, same settings), with
these intentional exceptions:

- GitHub OAuth (Device Flow) and the signed in-app updater are not
  available — the UI degrades quietly.
- Native file/folder dialogs are replaced by the in-app folder browser and
  browser downloads.
- Everything else — corpus, installs, reconciliation, Teams, Projects,
  Runbooks, Activity, Settings — works the same.
