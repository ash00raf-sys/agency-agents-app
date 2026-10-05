/**
 * Catalog source commands — the git-aware subset of `src-tauri/src/corpus/mod.rs`:
 * source get/set/configured, status (provenance + freshness), update check,
 * pull, and managed provisioning. `git` is best-effort (Termux usually has
 * it via `pkg install git`; without it, non-git sources still work).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import {
  CATALOG_GIT_URL,
  catalogRoot,
  detectCatalogs,
  discoverCategories,
  gitAvailable,
  loadCatalogSource,
  looksLikeCatalog,
  managedDir,
  rebuildCorpus,
  refreshCorpus,
  saveCatalogSource,
  ensureCorpus,
} from "./corpus.mjs";
import { err, home } from "./util.mjs";

/** Run `git <args>` in `cwd`; rejects with AppError(io) on failure. */
function git(args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (e, stdout, stderr) => {
      if (e) {
        reject(err.io(`git ${args[0]}: ${(stderr || e.message || "").trim().slice(0, 400)}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** `catalog_source_get` — the persisted source (default bundled). */
export async function catalogSourceGet(adir) {
  return loadCatalogSource(adir);
}

/** `catalog_configured` — has the user made an explicit source choice? */
export async function catalogConfigured(adir) {
  return fs.existsSync(path.join(adir, "state", "catalog.json"));
}

/** `catalog_source_set` — validate + persist + rebuild. */
export async function catalogSourceSet(adir, source) {
  if (source?.kind === "managed" || source?.kind === "userClone") {
    if (typeof source.path !== "string") {
      throw err.invalidArgument("catalog source path missing");
    }
    let st;
    try {
      st = await fsp.stat(source.path);
    } catch {
      throw err.invalidArgument(`catalog path is not a directory: ${source.path}`);
    }
    if (!st.isDirectory()) {
      throw err.invalidArgument(`catalog path is not a directory: ${source.path}`);
    }
    if (!looksLikeCatalog(source.path)) {
      throw err.invalidArgument(
        `${source.path} doesn't look like an agency-agents catalog (no scripts/convert.sh or category dirs)`,
      );
    }
  } else if (source?.kind !== "bundled") {
    throw err.invalidArgument("unknown catalog source kind");
  }
  await saveCatalogSource(adir, source);
  return rebuildCorpus(adir);
}

/** `catalog_status` — provenance + freshness of the active catalog. */
export async function catalogStatus(adir) {
  const source = await loadCatalogSource(adir);
  const corpus = await ensureCorpus(adir);
  const meta = corpus.meta;
  const root = catalogRoot(adir, source);

  const isGit = fs.existsSync(path.join(root, ".git")) && gitAvailable();
  let branch = null;
  let commit = null;
  let lastCommitSubject = null;
  let lastCommitDate = null;
  let dirtyCount = 0;
  let remoteUrl = null;
  let repoSlug = null;

  if (isGit) {
    branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root, 10_000).catch(() => "") || "").trim() || null;
    commit = (await git(["rev-parse", "--short", "HEAD"], root, 10_000).catch(() => "") || "").trim() || null;
    const log = await git(["log", "-1", "--format=%s%x1f%cI"], root, 10_000).catch(() => "");
    const [subject, date] = log.trim().split("\x1f");
    if (subject) lastCommitSubject = subject;
    if (date?.trim()) lastCommitDate = date.trim();
    const porcelain = await git(["status", "--porcelain"], root, 30_000).catch(() => "");
    dirtyCount = porcelain.split("\n").filter((l) => l.trim() !== "").length;
    remoteUrl =
      (await git(["remote", "get-url", "origin"], root, 10_000).catch(() => "") || "").trim() || null;
    if (remoteUrl) {
      const m = /github\.com[/:]([^/]+)\/([^/.#\s]+?)(?:\.git)?$/i.exec(remoteUrl);
      if (m) repoSlug = `${m[1]}/${m[2]}`;
    }
  }

  return {
    source,
    root: source.kind === "bundled" ? null : root,
    isGit,
    branch,
    commit,
    lastCommitSubject,
    lastCommitDate,
    dirtyCount,
    remoteUrl,
    repoSlug,
    version: meta.version,
    fetchedAt: meta.fetchedAt,
    agentCount: meta.count,
  };
}

/** `catalog_detect` — discover candidate catalogs. */
export function catalogDetect(scan) {
  return detectCatalogs(!!scan, home());
}

/** `catalog_check_updates` — git fetch + behind/ahead stats. Non-git
 *  sources report `isGit:false` (the UI offers a snapshot refresh). */
export async function catalogCheckUpdates(adir) {
  const source = await loadCatalogSource(adir);
  const root = catalogRoot(adir, source);
  if (!(fs.existsSync(path.join(root, ".git")) && gitAvailable())) {
    return { isGit: false, behind: 0, ahead: 0, changedFiles: 0, diffstat: "", upToDate: false };
  }
  await git(["fetch", "--quiet"], root, 120_000);
  let ahead = 0;
  let behind = 0;
  const counts = await git(
    ["rev-list", "--left-right", "--count", "HEAD...@{u}"],
    root,
    30_000,
  ).catch(() => "");
  const parts = counts.trim().split(/\s+/);
  if (parts.length === 2) {
    ahead = parseInt(parts[0], 10) || 0;
    behind = parseInt(parts[1], 10) || 0;
  }
  let diffstat = "";
  let changedFiles = 0;
  if (behind > 0) {
    diffstat = await git(["diff", "--stat", "HEAD..@{u}"], root, 30_000).catch(() => "");
    const names = await git(["diff", "--name-only", "HEAD..@{u}"], root, 30_000).catch(() => "");
    changedFiles = names.split("\n").filter((l) => l.trim() !== "").length;
  }
  return { isGit: true, behind, ahead, changedFiles, diffstat, upToDate: behind === 0 };
}

/**
 * `catalog_pull` — update the active catalog root then rebuild.
 * Git root → `git pull --ff-only`; bundled/snapshot → tarball refresh.
 */
export async function catalogPull(adir) {
  const source = await loadCatalogSource(adir);
  const root = catalogRoot(adir, source);
  if (source.kind === "userClone" && !source.manage) {
    throw err.invalidArgument(
      "catalog source is a read-only user clone; enable manage-with-permission or switch source to refresh",
    );
  }
  if (fs.existsSync(path.join(root, ".git")) && gitAvailable()) {
    await git(["pull", "--ff-only"], root, 300_000);
    return rebuildCorpus(adir);
  }
  return refreshCorpus(adir);
}

/**
 * `catalog_provision_managed` — set up `~/.agency-agents` (git clone when
 * available, else tarball snapshot), set it as the managed source, rebuild.
 */
export async function catalogProvisionManaged(adir) {
  const dest = managedDir(home());
  if (fs.existsSync(path.join(dest, ".git")) && gitAvailable()) {
    await git(["pull", "--ff-only"], dest, 300_000);
  } else if (!fs.existsSync(dest) || (await fsp.readdir(dest)).length === 0) {
    if (gitAvailable()) {
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await git(["clone", "--depth", "1", CATALOG_GIT_URL, dest], path.dirname(dest), 600_000);
    } else {
      // Tarball provisioning: extract into the managed dir via a refresh
      // into a temp bundled-style root.
      const tmpRoot = path.join(adir, "corpus-provision-tmp");
      await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      const wasBundled = (await loadCatalogSource(adir)).kind === "bundled";
      // Temporarily point the source at the tmp root, refresh, then commit.
      await saveCatalogSource(adir, { kind: "managed", path: tmpRoot });
      try {
        await refreshCorpus(adir);
        // Move the fresh content into ~/.agency-agents.
        await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(tmpRoot, dest);
      } catch (e) {
        await saveCatalogSource(adir, wasBundled ? { kind: "bundled" } : await loadCatalogSource(adir));
        throw e;
      }
    }
  } else if (looksLikeCatalog(dest)) {
    // Existing non-git managed dir with content — refresh in place.
    const prev = await loadCatalogSource(adir);
    await saveCatalogSource(adir, { kind: "managed", path: dest });
    try {
      await refreshCorpus(adir);
    } catch (e) {
      await saveCatalogSource(adir, prev);
      throw e;
    }
  } else {
    throw err.invalidArgument(`${dest} exists and is not an agency-agents catalog`);
  }
  await saveCatalogSource(adir, { kind: "managed", path: dest });
  return rebuildCorpus(adir);
}
