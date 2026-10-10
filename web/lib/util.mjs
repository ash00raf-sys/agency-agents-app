/**
 * Shared utilities for the Agency Agents web backend (Node, zero deps).
 *
 * Mirrors `src-tauri/src/util/fs.rs` (atomic_write, read_capped) and the
 * small helpers the Rust backend leans on (sha256 hex, RFC3339 now).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Cap on a single agent `.md` (matches MAX_AGENT_BYTES). */
export const MAX_AGENT_BYTES = 1024 * 1024;
/** Cap on an installed agent file read back during reconciliation. */
export const MAX_INSTALLED_BYTES = 4 * 1024 * 1024;
/** Cap on settings.json (matches MAX_SETTINGS_BYTES). */
export const MAX_SETTINGS_BYTES = 1024 * 1024;
/** Cap on the corpus refresh tarball (matches MAX_TARBALL_BYTES). */
export const MAX_TARBALL_BYTES = 32 * 1024 * 1024;

/** SHA-256, lowercase hex — the canonical hash for the ledger + reconcile. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** RFC3339 UTC timestamp (Rust `Utc::now().to_rfc3339()`-shaped). */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * AppError — mirrors the Rust `AppError` wire payload: a plain object with a
 * `code` discriminator the frontend's `isAppError` / `appErrorMessage` know
 * how to render. Thrown by command handlers; serialized verbatim by the
 * HTTP bridge so the browser shim can reject invoke() with it.
 */
export class AppError extends Error {
  /** @param {Record<string, unknown>} payload — must carry a string `code`. */
  constructor(payload) {
    super(String(payload.message ?? payload.code ?? "app error"));
    this.name = "AppError";
    this.payload = payload;
  }
}

/** Convenience factories matching the variants the backend uses. */
export const err = {
  io: (message) => new AppError({ code: "io", message }),
  internal: (message) => new AppError({ code: "internal", message }),
  invalidArgument: (message) => new AppError({ code: "invalid_argument", message }),
  network: (url, message) => new AppError({ code: "network", url, message }),
  httpStatus: (url, status) => new AppError({ code: "http_status", url, status }),
};

/** Home directory (Termux: /data/data/com.termux/files/home). */
export function home() {
  const h = os.homedir();
  if (!h) throw err.io("cannot resolve home directory");
  return h;
}

/**
 * App data dir — mirrors Tauri's `app_data_dir()` for the bundle id
 * `com.zerologic.agency-agents-app` on Linux/Android:
 * `$XDG_DATA_HOME/agency-agents-app` or `~/.local/share/agency-agents-app`.
 */
export function appDataDir() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home(), ".local", "share");
  return path.join(base, "agency-agents-app");
}

/** State dir: `<appData>/state` (ledger, index, meta, catalog source). */
export const stateDir = (adir) => path.join(adir, "state");
/** Working corpus copy: `<appData>/corpus` (the Bundled source root). */
export const corpusDir = (adir) => path.join(adir, "corpus");
/** Backups of pre-overwrite bytes: `<appData>/backups`. */
export const backupsDir = (adir) => path.join(adir, "backups");

/** Atomic write: temp file in the same dir + rename (no torn writes). */
export async function atomicWrite(file, data) {
  const parent = path.dirname(file);
  await fsp.mkdir(parent, { recursive: true });
  const tmp = path.join(parent, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** Read a file with a size cap; throws AppError(io) when missing/oversized. */
export async function readCapped(file, cap) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch (e) {
    throw err.io(`read ${file}: ${e.code ?? e.message}`);
  }
  if (st.size > cap) {
    throw err.io(`file ${file} is ${st.size} bytes (cap ${cap})`);
  }
  return fsp.readFile(file);
}

/** True when the dir holds no entries — INCLUDING when it doesn't exist
 *  (matches the Rust `is_empty_dir`, which reads Err as empty so a fresh
 *  data dir seeds from the baseline). */
export async function isEmptyDir(dir) {
  try {
    const it = await fsp.opendir(dir);
    const first = await it.read();
    await it.close();
    return first === null;
  } catch {
    return true;
  }
}

/** Filesystem-safe variant of an RFC3339 timestamp (no colons). */
export function fsStamp(iso) {
  return iso.replaceAll(":", "-").replaceAll("/", "-");
}

/** Recursively collect every `*.md` under `root`, sorted by full path. */
export function collectMdFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.isFile() && ent.name.endsWith(".md")) out.push(p);
    }
  }
  out.sort();
  return out;
}

/** Find `<fileName>` anywhere under `dir` (depth-first). */
export function findMdUnder(dir, fileName) {
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === fileName) return p;
    }
  }
  return null;
}
