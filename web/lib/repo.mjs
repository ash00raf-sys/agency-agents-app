/**
 * Repo-root resolution for the web backend.
 *
 * The server runs from `<repo>/web/`, and reads its data (bundled corpus
 * baseline, tools.json, agency-categories.json) straight from the checkout.
 * When the SPA is prebuilt (`npm run build`), the web/ directory ships
 * alongside it, so `web/../src-tauri/...` always resolves.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root (…/agency-agents-app). */
export function repoRoot() {
  // web/lib/repo.mjs → up twice.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** The bundled corpus baseline directory. */
export function baselineDir() {
  return path.join(repoRoot(), "src-tauri", "resources", "corpus-baseline");
}

/** The prebuilt SPA directory (SvelteKit adapter-static output). */
export function buildDir() {
  return path.join(repoRoot(), "build");
}

/** The web server's package version (from package.json). */
export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}
