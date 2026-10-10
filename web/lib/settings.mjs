/**
 * Settings persistence — port of `src-tauri/src/commands/settings.rs`.
 *
 * `settings.json` lives in the app data dir, is clamped on every load and
 * save, and fails CLOSED when present-but-corrupt (the UI offers a reset).
 */

import fsp from "node:fs/promises";
import path from "node:path";

import {
  atomicWrite,
  err,
  MAX_SETTINGS_BYTES,
  stateDir,
} from "./util.mjs";

/** Defaults matching the Rust `Settings::default()`. */
export const SETTINGS_DEFAULTS = {
  paranoidMode: false,
  catalogStaleBannerDays: 14,
  caskIconMode: "all",
  trendingTtlMinutes: 60,
  githubEnabled: false,
  aiFeaturesEnabled: true,
  updateAutoCheck: false,
  skippedUpdateVersions: [],
  enhancedTrendingEnabled: false,
  vulnerabilityScanningEnabled: false,
  liveEnrichmentEnabled: false,
  toolPaths: {},
};

const CATALOG_STALE_DAYS_MIN = 1;
const CATALOG_STALE_DAYS_MAX = 365;
const TRENDING_TTL_MIN = 5;
const TRENDING_TTL_MAX = 1440;
const SKIPPED_UPDATE_VERSIONS_CAP = 10;

const CASK_ICON_MODES = new Set(["off", "installed-only", "all"]);

function clampInt(v, lo, hi, fallback) {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(Math.max(n, lo), hi);
}

/** Apply the numeric clamps + shape validation. Idempotent. */
function clampAndShape(s) {
  const d = SETTINGS_DEFAULTS;
  const out = {
    paranoidMode: s.paranoidMode === true,
    catalogStaleBannerDays: clampInt(
      s.catalogStaleBannerDays,
      CATALOG_STALE_DAYS_MIN,
      CATALOG_STALE_DAYS_MAX,
      d.catalogStaleBannerDays,
    ),
    caskIconMode: CASK_ICON_MODES.has(s.caskIconMode) ? s.caskIconMode : d.caskIconMode,
    trendingTtlMinutes: clampInt(
      s.trendingTtlMinutes,
      TRENDING_TTL_MIN,
      TRENDING_TTL_MAX,
      d.trendingTtlMinutes,
    ),
    githubEnabled: s.githubEnabled === true,
    aiFeaturesEnabled: s.aiFeaturesEnabled !== false, // default true
    updateAutoCheck: s.updateAutoCheck === true,
    skippedUpdateVersions: Array.isArray(s.skippedUpdateVersions)
      ? s.skippedUpdateVersions
          .filter((v) => typeof v === "string")
          .slice(0, SKIPPED_UPDATE_VERSIONS_CAP)
      : [],
    enhancedTrendingEnabled: s.enhancedTrendingEnabled === true,
    vulnerabilityScanningEnabled: s.vulnerabilityScanningEnabled === true,
    liveEnrichmentEnabled: s.liveEnrichmentEnabled === true,
    toolPaths:
      s.toolPaths && typeof s.toolPaths === "object" && !Array.isArray(s.toolPaths)
        ? Object.fromEntries(
            Object.entries(s.toolPaths).filter(([, v]) => typeof v === "string"),
          )
        : {},
  };
  return out;
}

const settingsPath = (adir) => path.join(adir, "settings.json");

/** `settings_get` — throws AppError(internal) when the file is corrupt
 *  (fail closed, matching the Rust posture). */
export async function settingsGet(adir) {
  let bytes;
  try {
    const st = await fsp.stat(settingsPath(adir));
    if (st.size > MAX_SETTINGS_BYTES) {
      throw err.internal(`settings.json is ${st.size} bytes (cap ${MAX_SETTINGS_BYTES})`);
    }
    bytes = await fsp.readFile(settingsPath(adir));
  } catch (e) {
    if (e?.payload) throw e;
    return { ...SETTINGS_DEFAULTS }; // first launch — defaults
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw err.internal(`settings file unreadable: ${e.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw err.internal("settings file unreadable: not a JSON object");
  }
  return clampAndShape(parsed);
}

/** `settings_set` — clamp, persist atomically, return the canonicalized value. */
export async function settingsSet(adir, settings) {
  if (!settings || typeof settings !== "object") {
    throw err.invalidArgument("settings: expected an object");
  }
  const shaped = clampAndShape(settings);
  const bytes = Buffer.from(JSON.stringify(shaped, null, 2), "utf8");
  if (bytes.length > MAX_SETTINGS_BYTES) {
    throw err.internal(`settings.json would be ${bytes.length} bytes (cap ${MAX_SETTINGS_BYTES})`);
  }
  await fsp.mkdir(path.dirname(settingsPath(adir)), { recursive: true });
  await atomicWrite(settingsPath(adir), bytes);
  return shaped;
}

/** `settings_reset` — overwrite with defaults. */
export async function settingsReset(adir) {
  return settingsSet(adir, SETTINGS_DEFAULTS);
}
