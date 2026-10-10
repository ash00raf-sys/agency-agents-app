/**
 * Project preview + web builder — Agency Agents' own build/serve pipeline.
 *
 * Any registered project folder gets a live URL on the phone:
 *
 *     /p/<name>/   →  serves the project's web output
 *
 * Serving resolution (per request, so a fresh build shows up instantly):
 * the first of build/, dist/, public/, out/ that contains index.html,
 * else the project root if it has index.html (plain static sites), else
 * 404 with a "run a build first" hint. Missing paths fall back to the
 * chosen dir's index.html (SPA routing), mirroring the app server itself.
 *
 * `runBuild` executes `npm run build` for node/web projects (the only
 * command v1 will run) with a hard timeout and capped logs, and appends
 * every run to `state/builds.jsonl` — the seed of the Artifacts page.
 *
 * Security posture: paths are registry-keyed (never raw paths in URLs),
 * traversal-checked on every file, and the ONLY command executed is
 * `npm run build` in the project's own directory. The UI shows the exact
 * command and asks for confirmation before each run.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { err, stateDir, atomicWrite } from "./util.mjs";

const ROOTS_FILE = (adir) => path.join(stateDir(adir), "preview-roots.json");
const BUILDS_FILE = (adir) => path.join(stateDir(adir), "builds.jsonl");

const MAX_LOG_BYTES = 200_000; // captured build log cap
const MAX_SERVE_BYTES = 100 * 1024 * 1024; // per-file serve cap
const BUILD_TIMEOUT_MS = 10 * 60_000; // 10 min hard cap
const SERVE_CANDIDATES = ["build", "dist", "public", "out"];

// ---------- Registry (name → project path) ----------

async function loadRoots(adir) {
  try {
    const parsed = JSON.parse((await fsp.readFile(ROOTS_FILE(adir))).toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.filter(
      (r) => r && typeof r.name === "string" && typeof r.path === "string",
    );
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw err.io(`parse preview-roots.json: ${e.message}`);
  }
}

async function saveRoots(adir, roots) {
  await atomicWrite(ROOTS_FILE(adir), JSON.stringify(roots, null, 2));
}

function slugify(basename) {
  const s = basename
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || "project";
}

/**
 * Register a project folder for previewing. Idempotent per path; names are
 * unique slugs (a second folder with the same basename gets a suffix).
 */
async function registerRoot(adir, rawPath) {
  const p = path.resolve(String(rawPath ?? ""));
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) throw err.invalidArgument(`not a directory: ${p}`);

  const roots = await loadRoots(adir);
  const existing = roots.find((r) => r.path === p);
  if (existing) return { ...existing, previewUrl: `/p/${existing.name}/` };

  let name = slugify(path.basename(p));
  if (roots.some((r) => r.name === name)) {
    let i = 2;
    while (roots.some((r) => r.name === `${name}-${i}`)) i++;
    name = `${name}-${i}`;
  }
  const entry = { name, path: p, addedAt: new Date().toISOString() };
  roots.push(entry);
  await saveRoots(adir, roots);
  return { ...entry, previewUrl: `/p/${name}/` };
}

async function entryForName(adir, name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const roots = await loadRoots(adir);
  return roots.find((r) => r.name === name) ?? null;
}

// ---------- Detection ----------

/**
 * Sniff a project folder: what is it, is it web-previewable, and does it
 * have a build step we can run? Read-only; never throws on unknown types.
 */
async function detectProject(p) {
  const ents = await fsp.readdir(p, { withFileTypes: true }).catch(() => null);
  if (!ents) throw err.invalidArgument(`cannot read directory: ${p}`);
  const names = new Set(ents.map((e) => e.name));

  let pkg = null;
  if (names.has("package.json")) {
    try {
      pkg = JSON.parse((await fsp.readFile(path.join(p, "package.json"))).toString("utf8"));
    } catch {
      pkg = null;
    }
  }

  if (names.has("settings.gradle") || names.has("build.gradle") || names.has("gradlew")) {
    return {
      kind: "android",
      label: "Android (Gradle)",
      previewable: false,
      buildable: false,
      hint: "APK builds go through DevForge (gradle) — use Open in DevForge.",
    };
  }
  if (pkg) {
    const hasBuild = typeof pkg.scripts?.build === "string";
    return {
      kind: "web-node",
      label: hasBuild ? "Web app (Node)" : "Web/Node files",
      previewable: true,
      buildable: hasBuild,
      buildCmd: hasBuild ? "npm run build" : null,
      hint: hasBuild
        ? null
        : "No build script in package.json — serving files as-is.",
    };
  }
  if (names.has("index.html")) {
    return {
      kind: "web-static",
      label: "Static web",
      previewable: true,
      buildable: false,
      hint: "Static site — no build needed.",
    };
  }
  if (names.has("requirements.txt") || names.has("main.py") || names.has("pyproject.toml")) {
    return {
      kind: "python",
      label: "Python",
      previewable: false,
      buildable: false,
      hint: "Python projects run via the server (opt-in) — coming next.",
    };
  }
  const hasApk = [...names].some((n) => n.toLowerCase().endsWith(".apk"));
  if (hasApk) {
    return {
      kind: "apk",
      label: "Android package (compiled)",
      previewable: false,
      buildable: false,
      hint: "Compiled APK — agents can inspect it, but altering means rebuilding source.",
    };
  }
  return {
    kind: "generic",
    label: "Files",
    previewable: false,
    buildable: false,
    hint: "No known project layout — agents can still read/edit the files.",
  };
}

/** Detect + auto-register in one step (what the UI calls when opening a project). */
async function detectAndRegister(adir, rawPath) {
  const p = path.resolve(String(rawPath ?? ""));
  const detected = await detectProject(p);
  const reg = await registerRoot(adir, p);
  return { ...detected, name: reg.name, previewUrl: reg.previewUrl, path: p };
}

// ---------- Serving ----------

/** Directory to serve for a project root: first built-output with an
 *  index.html, else the root itself when it's a plain static site. */
async function serveDirFor(root) {
  for (const cand of SERVE_CANDIDATES) {
    const d = path.join(root, cand);
    if (fs.existsSync(path.join(d, "index.html"))) return d;
  }
  if (fs.existsSync(path.join(root, "index.html"))) return root;
  return null;
}

/**
 * Map `/p/<name>/<rest>` to a real file (or null). Traversal-checked;
 * dirs resolve to their index.html; missing paths fall back to the SPA
 * index (same behavior as the app server itself).
 */
async function resolvePreviewFile(adir, urlPath) {
  const m = urlPath.match(/^\/p\/([a-z0-9][a-z0-9-]*)(\/.*)?$/);
  if (!m) return null;
  const entry = await entryForName(adir, m[1]);
  if (!entry) return { notFound: `unknown preview project: ${m[1]}` };

  const st = await fsp.stat(entry.path).catch(() => null);
  if (!st || !st.isDirectory()) return { notFound: `project folder is gone: ${entry.path}` };

  const dir = await serveDirFor(entry.path);
  if (!dir) {
    return {
      notFound:
        "No index.html and no build output (build/ dist/ public/ out/) — run a build first.",
    };
  }

  const rest = m[2] ?? "/";
  let decoded;
  try {
    decoded = decodeURIComponent(rest.split("?")[0]);
  } catch {
    return { notFound: "bad path encoding" };
  }
  // Reject backslashes outright: harmless on Termux/Linux (not a separator)
  // but a traversal vector on Windows hosts.
  if (decoded.includes("\\")) return { notFound: "invalid path" };
  const resolved = path.resolve(dir, `.${decoded}`);
  if (!resolved.startsWith(dir + path.sep) && resolved !== dir) return { notFound: "invalid path" };

  let file = resolved;
  let fst = await fsp.stat(file).catch(() => null);
  if (fst?.isDirectory()) {
    file = path.join(file, "index.html");
    fst = await fsp.stat(file).catch(() => null);
  }
  if (!fst?.isFile()) {
    // SPA fallback.
    file = path.join(dir, "index.html");
    fst = await fsp.stat(file).catch(() => null);
    if (!fst?.isFile()) return { notFound: "not found" };
  }
  if (fst.size > MAX_SERVE_BYTES) return { notFound: "file too large to preview" };
  return { file, size: fst.size };
}

// ---------- Build ----------

async function appendBuild(adir, record) {
  const line = JSON.stringify(record) + "\n";
  await fsp.appendFile(BUILDS_FILE(adir), line).catch(() => {
    // state dir may not exist yet on a fresh install
  });
}

/** Last `n` build records (oldest → newest). */
async function buildsHistory(adir, n = 100) {
  try {
    const raw = (await fsp.readFile(BUILDS_FILE(adir))).toString("utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { corrupt: true };
      }
    });
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw err.io(`read builds.jsonl: ${e.message}`);
  }
}

/**
 * Run the project's web build — `npm run build`, the only command v1
 * executes — with a hard timeout, capped capture, and a history record.
 */
async function runBuild(adir, rawPath) {
  const p = path.resolve(String(rawPath ?? ""));
  const detected = await detectProject(p);
  const reg = await registerRoot(adir, p);

  if (!detected.buildable) {
    return {
      ran: false,
      ok: false,
      kind: detected.kind,
      cmd: null,
      log: detected.hint ?? "Nothing to build for this project type.",
      previewUrl: reg.previewUrl,
    };
  }
  const cmd = "npm run build";
  const started = Date.now();

  const log = await new Promise((resolve) => {
    let out = "";
    let done = false;
    const child = spawn("npm", ["run", "build"], {
      cwd: p,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, BUILD_TIMEOUT_MS);
    const push = (buf) => {
      if (out.length < MAX_LOG_BYTES) out += buf.toString("utf8");
    };
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(`failed to start npm: ${e.message}\n(is Node/npm installed?)`);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(out + (out.endsWith("\n") || out === "" ? "" : "\n") + `\n[exit ${code ?? "killed"}]`);
    });
  });

  const ok = /\[exit 0\]\s*$/.test(log);
  const durationMs = Date.now() - started;
  const record = {
    ts: new Date().toISOString(),
    path: p,
    kind: detected.kind,
    cmd,
    ok,
    durationMs,
    log: log.slice(0, MAX_LOG_BYTES),
  };
  await appendBuild(adir, record);

  return {
    ran: true,
    ok,
    kind: detected.kind,
    cmd,
    log,
    durationMs,
    previewUrl: reg.previewUrl,
  };
}

export {
  registerRoot,
  detectProject,
  detectAndRegister,
  resolvePreviewFile,
  runBuild,
  buildsHistory,
};
