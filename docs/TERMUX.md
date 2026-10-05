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

## Private catalogs (overlays)

Have your own agent repo — e.g. a private DevForge clone — and want its
agents to show up alongside the main catalog? Add it as a **private
catalog**: it's merged in read-only at runtime, the folder itself is never
modified.

**In the app:** Settings → Catalog → **Add private catalog…** → pick the
folder (e.g. `~/DevForge/devforge-claude-review`). The list shows each
overlay with its agent count; **Remove** un-merges it.

**Default:** on a fresh install, `~/DevForge/devforge-claude-review` is
adopted automatically as a private catalog if it exists and holds agents —
no clicks needed. (Removing it in Settings writes the state file, so it
never comes back on its own.)

**DevForge station skills:** `~/.station/library-skills` is also adopted by
default. Station skill files (trust-header format: banner, `name:` /
`source:` lines, `---`, then the skill body) import as private agents with
their provenance shown. They install everywhere: to Claude Code / Gemini /
etc. as clean agent files with synthesized frontmatter. In the other
direction, installing any catalog agent to the **DevForge** target writes a
native station skill (`~/.station/library-skills/{slug}.md`, same
trust-header shape station itself uses).

How the merge works:

- Any folder with at least one parseable agent `.md` file qualifies
  (recursively found — any layout works).
- Top-level folders containing agents become categories/divisions;
  `.md` files at the overlay root land in a **private** division.
- A `divisions.json` at the overlay root overrides the synthesized
  division labels/colors/icons.
- If a private agent has the same slug as a catalog agent, the **private
  one wins**.
- Private agents get a small **private** badge in the agents list and on
  their profile.
- Your list of overlays is saved in `~/.agency-agents/state/overlays.json`
  (or `$AGENCY_DATA_DIR/state/overlays.json`); the base catalog files on
  disk stay untouched.

The managed catalog (section above) and private overlays can be combined:
managed provides the base, overlays layer on top.

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
- Private catalogs (overlays) are web-only; the native app doesn't show
  that section.
- Everything else — corpus, installs, reconciliation, Teams, Projects,
  Runbooks, Activity, Settings — works the same.
