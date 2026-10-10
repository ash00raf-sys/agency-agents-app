# DevForge ↔ Agency Agents — Integration Plan

Based on source inspection of `~/DevForge/devforge-claude-review` (README,
PLAN-assistant.md, `station/skill_registry.py`, `skill_sources.py`,
`stationd.py`).

## What DevForge actually is

A self-contained AI coding platform on Android/Termux:

- **`stationd.py`** — FastAPI daemon on `127.0.0.1:8090`: web UI (PWA),
  REST + WebSocket API, tmux/aider lane management, coach loop
  (context-pressure model switching, budget auto-pause)
- **Aider** as the coding agent, OpenRouter model cascade
  (Gemini → Qwen → Sonnet → capped Astra), cost/budget guards
- **Sessions = workspaces** at `~/DevForge/<name>`, each with its own git
  repo; `.aider.chat.history.jsonl` is the shared memory
- **Skills = pinned, curated, read-only** (see finding below)
- Connectors (Google Drive/Docs, Notion, Gmail, GitHub), artifact/APK
  builders (e2b), test runner, companion Android APK project
- **Assistant roadmap** (PLAN-assistant.md A0–A5): personal assistant with
  a typed tool registry — DevForge's own project, not ours to build

## Key finding — corrects the shipped integration

`skill_registry.py` loads skills from **one pinned upstream snapshot**
(`vendor/agent-scripts` @ `d15557c…`), gated by a hardcoded allowlist
(`CURATED_SKILLS = {"create-cli"}`), revision- and license-verified.
`~/.station/library-skills/*.md` files are **rendered read-only documents**
(the `model_context()` trust-header format) for station's Skills Library
page — an *output*, never an input.

Consequences:

1. ✅ **Read side is correct**: importing `~/.station/library-skills` into
   the app as a private overlay reads real, rendered skill documents.
2. ❌ **Write side is inert**: the "DevForge install target" I shipped
   writes into `library-skills/`, which station never loads — and the dir
   may be regenerated. **Phase 0 fixes this.**

## Principles

- DevForge repo and `~/.station` state are **never modified** — after
  Phase 0 the app writes *nothing* to `~/.station` at all
- All changes live in agency-agents-app only
- stationd is integrated through its own API, read-only by default

---

## Phase 0 — Correct the skill bridge *(fixes shipped state)*

| Change | Detail |
|---|---|
| Retarget "DevForge" tool | Project-scoped only: `scope {user:false, project:true}`, dest `<workspace>/agents/{slug}.md`, identity format. The app's project picker selects the DevForge session workspace (e.g. `~/DevForge/fulltrader-backend-v0.3.0`). Agents land as plain context `.md` files in the workspace the aider lane uses — add them in aider (`/add agents/*.md`) or open them from DevForge's Files screen |
| Remove `~/.station` writes | No more user-scope dest into `library-skills/` |
| Keep the overlay import | `~/.station/library-skills` stays a default overlay (read-only, proven working) — station's curated skills appear in the app and install to Claude Code etc. |
| UI copy | Tool label: "DevForge (workspace context)" so the semantics are honest |

## Phase 1 — Station dashboard *(read-only bridge)*

stationd's API is on the same device as our web backend — the Node server
can call `http://127.0.0.1:8090` directly (localhost origins are trusted by
its control boundary).

- New backend commands `station_*` proxying **GET only**, 2s timeout,
  fail-soft `{available:false}` when the daemon is down:
  - `/api/health` → liveness, version, uptime
  - `/api/status` → current model, tier, ctx%, balance, coach state
  - `/api/usage` → key balance
  - `/api/analytics` → per-day/per-model spend
  - `/api/events` → recent coach events
  - `/api/models` → OpenRouter catalog (1h cache upstream)
- Frontend: a **Station** card/section (web build only) — daemon health,
  current model + tier + context pressure, balance, today's spend, recent
  events. Port configurable (default 8090), auto-detected via `/api/health`.

## Phase 2 — DevForge workspaces as Projects

- Scan `~/DevForge/*` for session workspaces (git repo +
  `.aider.chat.history.jsonl`) and offer them as quick-add entries in the
  app's Projects view
- Project-scoped installs (Phase 0 target) then flow into any workspace
- The non-authoritative `fulltrader-*` copies stay selectable but are
  labeled exactly what they are: DevForge session workspaces

## Phase 3 — Control bridge *(optional, mutating, confirm-gated)*

- `POST /api/switch` (model/tier/cap/auto) from the app, behind an
  explicit confirmation — the only write-path we'd ever call on stationd
- `POST /api/models/refresh`

## Explicitly rejected

- **Catalog agents as station "skills"** — impossible without changing
  DevForge (pinned registry is a deliberate security design)
- **Any writes into `~/.station`** (config, sessions, active.env, keys,
  skills state) — including the current `library-skills/` writes, removed
  in Phase 0
- **OpenRouter chat runtime inside the app** — stays parked; DevForge's
  Assistant roadmap already owns that lane
- Touching the aider lane, tmux seats, or the transcript ("shared memory")

## Open items (one paste confirms)

1. `head -80 station/aider_entry.sh` — exactly how enabled skills +
   `active.env` flow into aider flags (validates the Phase 0 context-file
   story)
2. `grep -n "library-skills\|skills" station/stationd.py | head -30` —
   whether `library-skills/` is regenerated (wipe risk for any files left
   there; Phase 0 removes our writes regardless)

## Suggested order

Phase 0 (small, fixes a wrong assumption) → Phase 1 (high value, pure
read) → Phase 2 → Phase 3 only if wanted.
