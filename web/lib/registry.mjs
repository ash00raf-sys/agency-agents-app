/**
 * Tool registry — the single source of truth for supported tools.
 * Loads the SAME `src-tauri/data/tools.json` the Rust backend embeds, so
 * the web backend and the native app can never disagree on tool shapes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { repoRoot } from "./repo.mjs";

/** Render formats the web renderer implements (mirrors IMPLEMENTED_FORMATS). */
const IMPLEMENTED_FORMATS = new Set([
  "identity",
  "codex-toml",
  "gemini-md",
  "qwen-md",
  "zcode-md",
  "cursor-mdc",
  "opencode-md",
  "skill-md",
]);

let cached = null;

/** Parse + cache the registry (throw on malformed JSON — authoring error). */
function registryList() {
  if (cached) return cached;
  const file = path.join(repoRoot(), "src-tauri", "data", "tools.json");
  const cat = JSON.parse(fs.readFileSync(file, "utf8"));
  const v = Object.values(cat.tools);
  v.sort(
    (a, b) => (a.order ?? 999) - (b.order ?? 999) || a.label.localeCompare(b.label),
  );
  cached = v;
  return v;
}

/** Look up a tool by its camelCase id. */
export function getTool(id) {
  return registryList().find((t) => t.id === id) ?? null;
}

/** True when the app can install this tool (renderer + not a plugin kind). */
export function installable(meta) {
  if (meta.installKind === "plugin") return false;
  return !!meta.format && IMPLEMENTED_FORMATS.has(meta.format);
}

/** The installable registry ids, in registry order. */
export function supportedToolIds() {
  return registryList().filter(installable).map((t) => t.id);
}

/** All tools (installable + recognized-only), in registry order. */
export function allTools() {
  return registryList();
}

// Re-export repoRoot so consumers of this module don't need two imports.
export { repoRoot, fileURLToPath };
