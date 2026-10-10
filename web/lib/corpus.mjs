/**
 * Corpus subsystem — the in-memory agent catalog + its on-disk state.
 * Faithful port of `src-tauri/src/corpus/mod.rs` (the parts the app's
 * command surface exercises): source resolution, baseline seeding,
 * indexing + hashing, division metadata, meta persistence, tarball
 * refresh, and runbooks.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { baselineDir, repoRoot } from "./repo.mjs";
import { parseAgent, parseStationSkill } from "./frontmatter.mjs";
import {
  collectMdFiles,
  findMdUnder,
  isEmptyDir,
  atomicWrite,
  readCapped,
  err,
  home,
  nowIso,
  MAX_AGENT_BYTES,
  MAX_TARBALL_BYTES,
  corpusDir as corpusDirOf,
  stateDir,
} from "./util.mjs";
import { slugify } from "./render.mjs";

/** Version string recorded for the bundled baseline before any refresh. */
export const BASELINE_VERSION = "baseline";

/** GitHub codeload tarball for the live corpus (no git binary required). */
const CORPUS_TARBALL_URL =
  "https://codeload.github.com/msitarzewski/agency-agents/tar.gz/refs/heads/main";

/** Git remote used to clone/pull a managed catalog when git is available. */
export const CATALOG_GIT_URL = "https://github.com/msitarzewski/agency-agents.git";

/** Dev-root directory names scanned (under `$HOME`) by "Find Agency Agents". */
export const SCAN_ROOTS = ["Software", "Projects", "git", "Developer", "code", "dev", "src"];

/** Default managed catalog location. */
export const managedDir = (home) => path.join(home, ".agency-agents");

const INDEX_FILE = "corpus-index.json";
const META_FILE = "corpus-meta.json";
const CATALOG_SOURCE_FILE = "catalog.json";
const OVERLAYS_FILE = "overlays.json";
const DIVISIONS_FILE = "divisions.json";

// ---------- Private catalog overlays (web build) ----------
//
// A private overlay is a LOCAL folder (e.g. the user's own agent repo,
// kept untouched on disk) merged OVER the active catalog at corpus-build
// time. Overlay agents win slug collisions; overlay divisions that don't
// exist in the base catalog are appended as first-class tiles. The overlay
// repo is only ever READ.

/** slug → absolute file path — byte-exact source reads for private agents. */
const overlayFiles = new Map();

/**
 * First-run default overlay: the private DevForge clone (Termux layout).
 * Seeded ONLY while `state/overlays.json` doesn't exist AND the folder
 * holds ≥1 parseable agent — once the file is written (even by a Remove),
 * it is authoritative forever, so removing the overlay in Settings sticks.
 */
const DEFAULT_OVERLAYS = [
  path.join(home(), "DevForge", "devforge-claude-review"),
  // DevForge's live skill library — station skills import as private agents.
  path.join(home(), ".station", "library-skills"),
];

/**
 * Overlay-tolerant agent parse: standard YAML-frontmatter agents first,
 * then DevForge station skills (trust-header format). The public catalog
 * stays strict — only private overlays accept the station shape.
 */
function parseOverlayAgent(slug, category, raw) {
  return parseAgent(slug, category, raw) ?? parseStationSkill(slug, category, raw);
}

/** The persisted overlay path list (`state/overlays.json`). */
export async function loadOverlays(adir) {
  let raw = null;
  try {
    raw = await fsp.readFile(path.join(stateDir(adir), OVERLAYS_FILE), "utf8");
  } catch {
    /* absent (first run) or unreadable */
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.overlays)
        ? parsed.overlays.filter((p) => typeof p === "string")
        : [];
    } catch {
      return [];
    }
  }

  // No state file yet: adopt the default DevForge clone when it's there.
  const seeded = DEFAULT_OVERLAYS.filter((p) => {
    try {
      return looksLikeOverlay(p);
    } catch {
      return false;
    }
  });
  if (seeded.length > 0) {
    try {
      await saveOverlays(adir, seeded);
      return seeded;
    } catch {
      /* state dir not writable — behave as unseeded */
    }
  }
  return [];
}

export async function saveOverlays(adir, paths) {
  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  await atomicWrite(path.join(sdir, OVERLAYS_FILE), JSON.stringify({ overlays: paths }, null, 2));
}

/** Count parseable agent `.md` files anywhere under `root` (validation). */
export function countAgentsAnywhere(root) {
  let n = 0;
  for (const file of collectMdFiles(root)) {
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (parseOverlayAgent(path.basename(file, ".md"), "", raw)) n++;
    } catch {
      /* skip unreadable */
    }
  }
  return n;
}

/** Does `root` qualify as a private overlay (≥1 parseable agent)? */
export function looksLikeOverlay(root) {
  try {
    if (!fs.statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  return countAgentsAnywhere(root) > 0;
}

/** Stable, pleasant fallback colors for custom (non-standard) divisions. */
const DIVISION_PALETTE = [
  "#0EA5E9", "#8B5CF6", "#F97316", "#10B981", "#EC4899",
  "#6366F1", "#EAB308", "#14B8A6", "#F43F5E", "#84CC16",
];

function stableHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function titleCase(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Build an overlay corpus piece from a local folder. Categories are the
 * REAL top-level dirs that hold ≥1 agent `.md`; root-level agent files map
 * to a synthesized "private" division. `divisions.json` at the root (same
 * shape as the catalog's) supplies custom labels/icons/colors when present.
 */
function buildOverlayPiece(root) {
  const agents = [];
  const index = new Map();
  const categories = new Set();
  const divisionMeta = {};

  // Add one parsed agent, keeping `agents` and `index` in sync when the same
  // slug shows up twice (later file wins, e.g. root + subfolder collision).
  const addAgent = (parsed, category, file) => {
    if (!parsed) return;
    const slug = parsed.entry.slug;
    const prevIndex = index.get(slug);
    if (prevIndex) {
      const i = agents.findIndex((a) => a.slug === slug);
      if (i !== -1) agents[i] = parsed.agent;
    } else {
      agents.push(parsed.agent);
    }
    index.set(slug, parsed.entry);
    categories.add(category);
    overlayFiles.set(slug, file);
  };

  // Custom division metadata, when the overlay ships it.
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, DIVISIONS_FILE), "utf8"));
    if (parsed?.divisions && typeof parsed.divisions === "object") {
      Object.assign(divisionMeta, parsed.divisions);
    }
  } catch {
    /* none — synthesize */
  }

  // Root-level agent files → the "private" division.
  const ROOT_DIVISION = "private";
  try {
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const raw = fs.readFileSync(path.join(root, ent.name), "utf8");
      addAgent(parseOverlayAgent(ent.name.replace(/\.md$/, ""), ROOT_DIVISION, raw), ROOT_DIVISION, path.join(root, ent.name));
    }
  } catch {
    /* unreadable root */
  }

  // Division folders (any name) — the overlay's own structure wins.
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
  } catch {
    /* unreadable */
  }
  for (const dir of dirs) {
    for (const file of collectMdFiles(path.join(root, dir))) {
      const raw = fs.readFileSync(file, "utf8");
      const slug = path.basename(file, ".md");
      addAgent(parseOverlayAgent(slug, dir, raw), dir, file);
    }
  }

  if (agents.length === 0) return null;

  // Synthesize metadata for divisions without a divisions.json entry.
  for (const slug of categories) {
    if (!divisionMeta[slug]) {
      divisionMeta[slug] = {
        label: titleCase(slug),
        icon: "Sparkles",
        color: DIVISION_PALETTE[stableHash(slug) % DIVISION_PALETTE.length],
      };
    }
  }

  return { root, agents, index, categories, divisionMeta };
}

/**
 * Merge every configured overlay over the base corpus (in place + return).
 * Overlay agents replace base agents on slug collision (yours win) and are
 * flagged `source: "private"` so the UI can badge them.
 */
export async function withOverlays(adir, corpus) {
  overlayFiles.clear();
  const paths = await loadOverlays(adir);
  if (paths.length === 0) {
    corpus.privateCount = 0;
    return corpus;
  }

  let privateCount = 0;
  for (const overlayPath of paths) {
    const piece = buildOverlayPiece(overlayPath);
    if (!piece) continue; // vanished or empty — skip quietly

    const agentBySlug = new Map(piece.agents.map((a) => [a.slug, a]));
    for (const [slug, entry] of piece.index) {
      const agent = agentBySlug.get(slug);
      if (!agent) continue;
      const tagged = { ...agent, source: "private" };
      // Replace-or-append into the base corpus (overlay wins collisions).
      if (corpus.index.has(slug)) {
        const i = corpus.agents.findIndex((a) => a.slug === slug);
        if (i !== -1) corpus.agents[i] = tagged;
      } else {
        corpus.agents.push(tagged);
        privateCount++;
      }
      corpus.index.set(slug, { ...entry });
    }

    // Division tiles: base set first, then overlay-only divisions. Overlay
    // meta fills gaps — it never overrides curated base division meta.
    for (const cat of piece.categories) {
      if (!corpus.categoryOrder.includes(cat)) corpus.categoryOrder.push(cat);
    }
    for (const [slug, meta] of Object.entries(piece.divisionMeta)) {
      if (!corpus.divisionMeta[slug]) corpus.divisionMeta[slug] = meta;
    }
  }

  // Restore the stable (category, slug) ordering after the merge.
  corpus.agents.sort((a, b) =>
    a.category === b.category
      ? a.slug < b.slug
        ? -1
        : a.slug > b.slug
          ? 1
          : 0
      : a.category < b.category
        ? -1
        : 1,
  );
  corpus.meta.count = corpus.index.size;
  corpus.privateCount = privateCount;
  return corpus;
}

/** Overlay descriptors for the UI: path + live agent count. */
export async function listOverlays(adir) {
  const paths = await loadOverlays(adir);
  return paths.map((p) => ({ path: p, agentCount: looksLikeOverlay(p) ? countAgentsAnywhere(p) : 0 }));
}


// ---------- Division metadata (bundled floor) ----------

let bundledMetaCache = null;

/** The bundled `agency-categories.json` parsed into a slug → row map. */
function bundledDivisionMeta() {
  if (bundledMetaCache) return bundledMetaCache;
  const file = path.join(repoRoot(), "src-tauri", "data", "agency-categories.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  bundledMetaCache = raw.categories ?? {};
  return bundledMetaCache;
}

/** The catalog root's `divisions.json` overlaid on the bundled floor. */
function loadDivisionMeta(catalogRoot) {
  const floor = bundledDivisionMeta();
  try {
    const raw = fs.readFileSync(path.join(catalogRoot, DIVISIONS_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.divisions) {
      return { ...floor, ...parsed.divisions };
    }
  } catch {
    /* missing/malformed → bundled floor */
  }
  return floor;
}

/** Category slugs for a catalog root: divisions.json keys when present,
 *  else the bundled floor's keys — sorted either way. */
export function discoverCategories(root) {
  let meta;
  try {
    const raw = fs.readFileSync(path.join(root, DIVISIONS_FILE), "utf8");
    const parsed = JSON.parse(raw);
    meta = parsed?.divisions && typeof parsed.divisions === "object" ? parsed.divisions : null;
  } catch {
    meta = null;
  }
  const keys = Object.keys(meta ?? bundledDivisionMeta()).sort();
  return keys;
}

// ---------- Catalog source ----------

/** Load the persisted CatalogSource, or `{kind:"bundled"}` when absent. */
export async function loadCatalogSource(adir) {
  const file = path.join(stateDir(adir), CATALOG_SOURCE_FILE);
  try {
    const bytes = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(bytes);
    if (parsed?.kind === "bundled") return { kind: "bundled" };
    if (parsed?.kind === "managed" && typeof parsed.path === "string") {
      return { kind: "managed", path: parsed.path };
    }
    if (parsed?.kind === "userClone" && typeof parsed.path === "string") {
      return { kind: "userClone", path: parsed.path, manage: !!parsed.manage };
    }
    return { kind: "bundled" };
  } catch {
    return { kind: "bundled" };
  }
}

/** Persist the chosen CatalogSource to `state/catalog.json`. */
export async function saveCatalogSource(adir, source) {
  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  await atomicWrite(path.join(sdir, CATALOG_SOURCE_FILE), JSON.stringify(source, null, 2));
}

/** Resolve the active catalog ROOT directory for a source. */
export function catalogRoot(adir, source) {
  if (source.kind === "bundled") return corpusDirOf(adir);
  return source.path;
}

// ---------- Build / load ----------

/** Seed the working copy from the bundled baseline (first run, bundled). */
async function seedFromBaseline(baseline, dest, categories) {
  if (!fs.existsSync(baseline)) {
    throw err.io(`baseline corpus not found at ${baseline}`);
  }
  let seeded = 0;
  for (const category of categories) {
    const srcCat = path.join(baseline, category);
    let ents;
    try {
      ents = await fsp.readdir(srcCat);
    } catch {
      continue;
    }
    const dstCat = path.join(dest, category);
    await fsp.mkdir(dstCat, { recursive: true });
    for (const fname of ents) {
      if (!fname.endsWith(".md")) continue;
      const bytes = await readCapped(path.join(srcCat, fname), MAX_AGENT_BYTES);
      await atomicWrite(path.join(dstCat, fname), bytes);
      seeded++;
    }
  }
  // Carry the tooling forward so the seeded copy is self-describing.
  const srcScript = path.join(baseline, "scripts", "convert.sh");
  try {
    const bytes = await readCapped(srcScript, MAX_AGENT_BYTES);
    const dstScript = path.join(dest, "scripts", "convert.sh");
    await fsp.mkdir(path.dirname(dstScript), { recursive: true });
    await atomicWrite(dstScript, bytes);
  } catch {
    /* baseline has no scripts/ — fine */
  }
  return seeded;
}

/** Build the in-memory corpus by walking `<dir>/<category>/… agent .md files`. */
function buildFromDir(dir, version, categories) {
  const catSet = new Set(categories);
  const rows = [];
  for (const file of collectMdFiles(dir)) {
    const rel = path.relative(dir, file);
    const parts = rel.split(path.sep);
    const category = parts[0];
    if (!catSet.has(category)) continue;
    const slug = parts[parts.length - 1].replace(/\.md$/, "");
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseAgent(slug, category, raw);
    if (parsed) rows.push(parsed);
  }
  // Stable (category, slug) order.
  rows.sort((a, b) =>
    a.agent.category === b.agent.category
      ? a.agent.slug < b.agent.slug
        ? -1
        : a.agent.slug > b.agent.slug
          ? 1
          : 0
      : a.agent.category < b.agent.category
        ? -1
        : 1,
  );

  const agents = rows.map((r) => r.agent);
  const index = new Map(rows.map((r) => [r.entry.slug, r.entry]));
  const divisionMeta = loadDivisionMeta(dir);
  return {
    agents,
    index,
    categoryOrder: categories,
    divisionMeta,
    meta: { version, commit: null, fetchedAt: "", count: index.size },
  };
}

/** An empty-but-valid corpus (degraded, never fatal). */
function emptyCorpus(version, categories) {
  return {
    agents: [],
    index: new Map(),
    categoryOrder: categories,
    divisionMeta: bundledDivisionMeta(),
    meta: { version, commit: null, fetchedAt: "", count: 0 },
  };
}

/** Corpus public helpers over the plain object built above. */
export function corpusList(corpus, category) {
  return corpus.agents
    .filter((a) => category == null || a.category === category)
    .map((a) => ({ ...a, body: "" }));
}

export function corpusGet(corpus, slug) {
  return corpus.agents.find((a) => a.slug === slug) ?? null;
}

export function corpusGetByConversionSlug(corpus, slug) {
  return corpus.agents.find((a) => slugify(a.name) === slug) ?? null;
}

export function corpusEntry(corpus, slug) {
  return corpus.index.get(slug) ?? null;
}

export function corpusVersion(corpus) {
  return corpus.meta.version;
}

export function corpusCategories(corpus) {
  const counts = new Map();
  for (const entry of corpus.index.values()) {
    counts.set(entry.category, (counts.get(entry.category) ?? 0) + 1);
  }
  return corpus.categoryOrder.map((slug) => {
    const meta = corpus.divisionMeta[slug] ?? {};
    return {
      slug,
      label: meta.label ?? slug,
      icon: meta.icon ?? "Sparkles",
      color: meta.color ?? "#6366F1",
      count: counts.get(slug) ?? 0,
    };
  });
}

/** Deterministic serialized index (BTreeMap key order ⇒ sorted slugs). */
function indexJson(corpus) {
  const obj = {};
  for (const key of [...corpus.index.keys()].sort()) {
    obj[key] = corpus.index.get(key);
  }
  return JSON.stringify(obj, null, 2);
}

/** Load `corpus-meta.json` if present + parseable. */
async function loadStoredMeta(adir) {
  try {
    const raw = await fsp.readFile(path.join(stateDir(adir), META_FILE), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.version === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Write `corpus-index.json` + `corpus-meta.json` (meta preserves prior
 *  fetched_at; stamped once on fresh seed). */
async function persistCorpus(adir, corpus) {
  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  const prior = await loadStoredMeta(adir);
  const fetchedAt =
    prior?.fetchedAt && prior.fetchedAt !== "" ? prior.fetchedAt : nowIso();
  const commit = prior?.commit ?? null;
  await atomicWrite(path.join(sdir, INDEX_FILE), indexJson(corpus));
  const stored = {
    version: corpus.meta.version,
    commit,
    fetchedAt,
    count: corpus.meta.count,
  };
  await atomicWrite(path.join(sdir, META_FILE), JSON.stringify(stored, null, 2));
  corpus.meta.fetchedAt = fetchedAt;
  corpus.meta.commit = commit;
}

/**
 * Resolve the active corpus for the current process:
 * seed from baseline when needed, parse + index, persist state.
 */
export async function resolveActive(adir) {
  const source = await loadCatalogSource(adir);
  const dir = catalogRoot(adir, source);

  if (source.kind === "bundled" && (await isEmptyDir(dir))) {
    const seedCats = discoverCategories(baselineDir());
    try {
      await seedFromBaseline(baselineDir(), dir, seedCats);
    } catch (e) {
      console.warn("[corpus] seed from baseline failed:", e?.payload?.message ?? e);
    }
  }

  const categories = discoverCategories(dir);
  const stored = await loadStoredMeta(adir);
  const version = stored?.version ?? BASELINE_VERSION;

  let corpus;
  try {
    corpus = buildFromDir(dir, version, categories);
  } catch (e) {
    console.error("[corpus] index build failed; serving empty corpus:", e);
    corpus = emptyCorpus(version, categories);
  }

  try {
    await persistCorpus(adir, corpus);
  } catch (e) {
    console.warn("[corpus] persist index/meta failed:", e?.payload?.message ?? e);
  }

  // Private overlays merge AFTER the base persist, so the on-disk index
  // stays a faithful picture of the active catalog and the in-memory
  // corpus carries the merged (public + private) view.
  try {
    await withOverlays(adir, corpus);
  } catch (e) {
    console.warn("[corpus] overlay merge failed:", e?.payload?.message ?? e);
  }
  return corpus;
}

/** Read the raw, byte-exact `.md` source of an agent (nested-aware). */
export async function readSource(adir, category, slug) {
  // Private overlay agents (and overlay winners of slug collisions) are
  // served from the overlay file — never from the base catalog.
  const overlayFile = overlayFiles.get(slug);
  if (overlayFile) {
    const bytes = await readCapped(overlayFile, MAX_AGENT_BYTES);
    return bytes.toString("utf8");
  }
  const source = await loadCatalogSource(adir);
  const catDir = path.join(catalogRoot(adir, source), category);
  const fname = `${slug}.md`;
  const flat = path.join(catDir, fname);
  const file = fs.existsSync(flat) ? flat : (findMdUnder(catDir, fname) ?? flat);
  const bytes = await readCapped(file, MAX_AGENT_BYTES);
  return bytes.toString("utf8");
}

// ---------- Memoized corpus (per-process) ----------

let corpusCache = null;
let corpusPromise = null;

/** Ensure the corpus is built once, then serve from cache. */
export async function ensureCorpus(adir) {
  if (corpusCache) return corpusCache;
  if (corpusPromise) return corpusPromise;
  corpusPromise = (async () => {
    corpusCache = await resolveActive(adir);
    return corpusCache;
  })();
  try {
    return await corpusPromise;
  } finally {
    corpusPromise = null;
  }
}

/** Rebuild + swap the memoized corpus (source switch / pull / refresh). */
export async function rebuildCorpus(adir) {
  corpusCache = await resolveActive(adir);
  return corpusCache.meta;
}

// ---------- Refresh (live tarball) ----------

/**
 * Fetch the GitHub tarball, extract its category dirs over the working
 * copy, re-index, and persist. Mirrors the Rust `refresh()`.
 */
export async function refreshCorpus(adir) {
  const source = await loadCatalogSource(adir);
  if (source.kind === "userClone" && !source.manage) {
    throw err.invalidArgument(
      "catalog source is a read-only user clone; enable manage-with-permission or switch source to refresh",
    );
  }

  const bytes = await downloadCorpusTarball();
  const categories = categoriesFromTarball(bytes) ?? Object.keys(bundledDivisionMeta()).sort();
  const dir = catalogRoot(adir, source);
  const extracted = extractCategories(bytes, dir, categories);
  if (extracted === 0) {
    throw err.internal("corpus tarball contained no agent files under known categories");
  }

  const version = `github:main@${new Date().toISOString().slice(0, 10)}`;
  const corpus = buildFromDir(dir, version, categories);
  const fetchedAt = nowIso();

  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  await atomicWrite(path.join(sdir, INDEX_FILE), indexJson(corpus));
  await atomicWrite(
    path.join(sdir, META_FILE),
    JSON.stringify(
      { version, commit: null, fetchedAt, count: corpus.meta.count },
      null,
      2,
    ),
  );
  corpus.meta.fetchedAt = fetchedAt;
  await withOverlays(adir, corpus);
  corpusCache = corpus;
  return corpus.meta;
}

/** Fetch the codeload tarball (capped, 60s abort). */
async function downloadCorpusTarball() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(CORPUS_TARBALL_URL, {
      signal: controller.signal,
      headers: { "user-agent": "agency-agents-web/0.3 (+https://github.com/msitarzewski/agency-agents)" },
    });
    if (!res.ok) throw err.httpStatus(CORPUS_TARBALL_URL, res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_TARBALL_BYTES) {
      throw err.io(`corpus tarball ${buf.length} bytes exceeds ${MAX_TARBALL_BYTES} cap`);
    }
    return buf;
  } catch (e) {
    if (e?.payload) throw e;
    throw err.network(CORPUS_TARBALL_URL, String(e?.cause?.message ?? e?.message ?? e));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal tar reader: regular files only, returns a list of
 * `{ name, data }`. Handles ustar + GNU long-name entries, which is all
 * GitHub tarballs use.
 */
function readTarEntries(tarBytes) {
  const entries = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive
    const name = longName ?? parseTarString(header.subarray(0, 100));
    longName = null;
    const sizeField = parseTarString(header.subarray(124, 136));
    const size = parseInt(sizeField.trim(), 8) || 0;
    const type = header[156];
    const dataStart = off + 512;
    const data = tarBytes.subarray(dataStart, dataStart + size);
    if (type === 76) {
      // 'L' — GNU long name for the NEXT entry.
      longName = parseTarString(data).replace(/\0+$/, "");
    } else if (type === 48 || type === 0) {
      // '0' or NUL — regular file.
      entries.push({ name, data });
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function parseTarString(buf) {
  const nul = buf.indexOf(0);
  return buf.subarray(0, nul === -1 ? buf.length : nul).toString("utf8");
}

/** Category slugs from the tarball's own `scripts/convert.sh` (AGENT_DIRS). */
function categoriesFromTarball(gzBytes) {
  try {
    const tar = gunzipSync(gzBytes, { maxOutputLength: MAX_TARBALL_BYTES * 8 });
    const script = readTarEntries(tar).find((e) =>
      /\/scripts\/convert\.sh$/.test(e.name),
    );
    if (!script) return null;
    const text = script.data.toString("utf8");
    const m = /AGENT_DIRS=\(([^)]*)\)/.exec(text);
    if (!m) return null;
    return m[1].split(/\s+/).filter(Boolean).sort();
  } catch {
    return null;
  }
}

/** Extract the known category dirs (+ scripts/) into `dir`; returns count. */
function extractCategories(gzBytes, dir, categories) {
  const tar = gunzipSync(gzBytes, { maxOutputLength: MAX_TARBALL_BYTES * 8 });
  const wanted = new Set(categories);
  let extracted = 0;
  for (const entry of readTarEntries(tar)) {
    // Strip the single top-level `agency-agents-main/` prefix.
    const slash = entry.name.indexOf("/");
    if (slash === -1) continue;
    const rel = entry.name.slice(slash + 1);
    const top = rel.split("/")[0];
    const isTooling = rel === "scripts/convert.sh" || rel === DIVISIONS_FILE;
    if (!isTooling && !(wanted.has(top) && rel.endsWith(".md"))) continue;
    atomicWriteSync(path.join(dir, rel), entry.data);
    if (rel.endsWith(".md") && wanted.has(top)) extracted++;
  }
  return extracted;
}

function atomicWriteSync(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// ---------- Runbooks (NEXUS scenario rosters) ----------

/** `runbooks_list` — the manifest from the catalog's strategy/runbooks.json.
 *  Empty when absent (bundled snapshot / unsynced clone). */
export async function runbooksList(adir) {
  const source = await loadCatalogSource(adir);
  const root = catalogRoot(adir, source);
  try {
    const raw = await fsp.readFile(path.join(root, "strategy", "runbooks.json"), "utf8");
    const file = JSON.parse(raw);
    return Array.isArray(file?.runbooks) ? file.runbooks : [];
  } catch {
    return [];
  }
}

// ---------- Heuristics ----------

/** Does `root` hold an agency-agents catalog? (tooling or a known category dir) */
export function looksLikeCatalog(root) {
  try {
    if (fs.existsSync(path.join(root, "scripts", "convert.sh"))) return true;
  } catch {
    /* ignore */
  }
  return Object.keys(bundledDivisionMeta()).some((c) => {
    try {
      return fs.statSync(path.join(root, c)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Count agents under a candidate root (for the detect list). */
function countAgentsIn(root) {
  let n = 0;
  for (const cat of Object.keys(bundledDivisionMeta())) {
    try {
      const ents = fs.readdirSync(path.join(root, cat), { withFileTypes: true });
      n += ents.filter((e) => e.isFile() && e.name.endsWith(".md")).length;
    } catch {
      /* not present */
    }
  }
  return n;
}

/** Catalog candidates: always `~/.agency-agents`; `scan` also walks common
 *  dev roots (one level under $HOME + SCAN_ROOTS children). */
export function detectCatalogs(scan, home) {
  const candidates = [];
  const push = (p, kind) => {
    try {
      if (!fs.statSync(p).isDirectory()) return;
      if (!looksLikeCatalog(p)) return;
      candidates.push({
        path: p,
        kind,
        hasGit: fs.existsSync(path.join(p, ".git")),
        agentCount: countAgentsIn(p),
      });
    } catch {
      /* skip */
    }
  };
  push(managedDir(home), "managed");
  if (scan) {
    for (const rootName of SCAN_ROOTS) {
      const root = path.join(home, rootName);
      let ents = [];
      try {
        ents = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of ents) {
        if (ent.isDirectory()) push(path.join(root, ent.name), "userClone");
      }
    }
  }
  return { gitAvailable: gitAvailable(), scanned: !!scan, candidates };
}

/** True when the `git` binary is usable. */
export function gitAvailable() {
  try {
    const { status } = spawnSync("git", ["--version"], { timeout: 3000 });
    return status === 0;
  } catch {
    return false;
  }
}
