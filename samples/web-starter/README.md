# Agency Web Starter — sample web project

The web counterpart of the Android samples: a real, buildable web app
demonstrating the **Projects → preview → build** loop in Agency Agents.

- `index.html` — the whole app (dark Agency theme, zero dependencies)
- `build.js` — zero-dependency build: stamps `dist/index.html` with the
  build time (`npm run build`)
- `agents/engineering-frontend-developer.md` — the Frontend Developer
  agent, installed as workspace context

## Try it

1. Register this folder in Agency Agents (Projects → Add, or copy to
   `~/DevForge/` for the quick-add)
2. Open the project → tap **Open preview** — you get a live URL served
   by the app itself (`/p/<name>/`)
3. Tap **Build web app** → `npm run build` runs on your phone → the
   preview switches to the stamped `dist/` output
4. Chat with the **Frontend Developer** agent to change the app, then
   rebuild

No server, no deploy step — your phone is the host.
