/**
 * DevForge Station bridge — read-only proxy to the stationd API.
 *
 * stationd (FastAPI) runs on the same device as this web backend, bound to
 * 127.0.0.1 by default (port 8090). Its control boundary trusts localhost
 * origins, so our server-side fetches pass. Everything here is GET-only and
 * fail-soft: when the daemon is down the UI shows "not detected".
 *
 * Station URL resolution: `state/station.json` `{ url }` override (web-only
 * state file, same pattern as overlays.json — never settings.json), else
 * `http://127.0.0.1:8090`.
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { stateDir } from "./util.mjs";

const DEFAULT_URL = "http://127.0.0.1:8090";
const STATION_FILE = "station.json";
const TIMEOUT_MS = 2500;

/** Read the optional station URL override (missing/invalid → default). */
export async function stationUrl(adir) {
  try {
    const raw = await fsp.readFile(path.join(stateDir(adir), STATION_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url === "string" && /^https?:\/\//.test(parsed.url)) {
      return parsed.url.replace(/\/+$/, "");
    }
  } catch {
    /* absent */
  }
  return DEFAULT_URL;
}

/** Save the station URL override. */
export async function saveStationUrl(adir, url) {
  const clean = String(url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(clean)) {
    throw Object.assign(new Error("station URL must start with http:// or https://"), {
      payload: { code: "invalid_argument", message: "station URL must start with http:// or https://" },
    });
  }
  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  await fsp.writeFile(path.join(sdir, STATION_FILE), JSON.stringify({ url: clean }, null, 2));
  return clean;
}

/** One GET with a hard timeout; throws on non-2xx. Never follows redirects. */
async function get(base, pathname) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${pathname}`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`station ${pathname} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** True when the daemon answers /api/health. */
export async function stationAlive(adir) {
  const base = await stationUrl(adir);
  try {
    const health = await get(base, "/api/health");
    return { available: true, url: base, health };
  } catch {
    return { available: false, url: base, health: null };
  }
}

/**
 * `station_status` — the dashboard snapshot: health + status + usage,
 * merged, fail-soft per part. `status` (model/tier/ctx/coach) and `usage`
 * (key balance) may individually fail while the daemon is up.
 */
export async function stationStatus(adir) {
  const base = await stationUrl(adir);
  let health = null;
  try {
    health = await get(base, "/api/health");
  } catch {
    return { available: false, url: base, health: null, status: null, usage: null };
  }
  const [status, usage] = await Promise.all([
    get(base, "/api/status").catch(() => null),
    get(base, "/api/usage").catch(() => null),
  ]);
  return { available: true, url: base, health, status, usage };
}

/** `station_events` — recent coach events (newest first, capped). */
export async function stationEvents(adir, limit = 12) {
  const base = await stationUrl(adir);
  const n = Math.max(1, Math.min(Number(limit) || 12, 50));
  try {
    return { available: true, events: await get(base, `/api/events?limit=${n}`) };
  } catch {
    return { available: false, events: [] };
  }
}

/** `station_analytics` — per-day/per-model spend (30s cache upstream). */
export async function stationAnalytics(adir) {
  const base = await stationUrl(adir);
  try {
    return { available: true, analytics: await get(base, "/api/analytics") };
  } catch {
    return { available: false, analytics: null };
  }
}
