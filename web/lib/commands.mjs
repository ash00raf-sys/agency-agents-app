/**
 * Command dispatch — the Tauri command surface, served over HTTP.
 *
 * The browser shim (see `src/app.html`) routes every `invoke(cmd, args)` to
 * `POST /api/invoke` with `{cmd, args}`; this table maps command names to
 * handlers whose results/errors match the native app's wire contract.
 *
 * Commands the web build intentionally degrades (GitHub OAuth, in-app
 * updater) return quiet, benign values so the UI renders sensibly.
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { appVersion } from "./repo.mjs";
import {
  corpusCategories as corpusCategoriesOf,
  corpusGet,
  corpusList,
  corpusVersion,
  ensureCorpus,
  listOverlays,
  loadOverlays,
  looksLikeOverlay,
  rebuildCorpus,
  refreshCorpus,
  runbooksList,
  saveOverlays,
} from "./corpus.mjs";
import {
  catalogCheckUpdates,
  catalogDetect,
  catalogProvisionManaged,
  catalogPull,
  catalogSourceGet,
  catalogSourceSet,
  catalogStatus,
  catalogConfigured,
} from "./catalog.mjs";
import {
  agentDiff,
  installAgent,
  installsForAgent,
  installsReconcile,
  loadoutExport,
  loadoutImport,
  projectForget,
  projectsList,
  toolsList,
  toolVersions,
  trackAgent,
  uninstallAgent,
  webLoadoutExport,
  webLoadoutImport,
} from "./install.mjs";
import { settingsGet, settingsReset, settingsSet } from "./settings.mjs";
import { err, home } from "./util.mjs";
import {
  saveStationUrl,
  stationAnalytics,
  stationEvents,
  stationStatus,
  stationUrl,
} from "./station.mjs";
import {
  chatKeyGet,
  chatKeySet,
  chatKeySetModel,
  chatModels,
  chatUsage,
} from "./chat.mjs";

/** Web-only: directory listing for the in-app folder picker. */
async function webListDir(args) {
  const root = typeof args?.path === "string" && args.path !== "" ? args.path : home();
  const st = await fsp.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw err.invalidArgument(`not a directory: ${root}`);
  }
  const ents = await fsp.readdir(root, { withFileTypes: true });
  const dirs = [];
  for (const ent of ents) {
    // Hide dot-dirs except nothing — Termux homes are full of dotdirs; show
    // them but sort after regular dirs. Files are listed too (informational).
    const isDir = ent.isDirectory();
    const isSymlink = ent.isSymbolicLink();
    dirs.push({ name: ent.name, dir: isDir, symlink: isSymlink });
  }
  dirs.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    const aDot = a.name.startsWith(".") ? 1 : 0;
    const bDot = b.name.startsWith(".") ? 1 : 0;
    if (aDot !== bDot) return aDot - bDot;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(root);
  return { path: root, parent: parent === root ? null : parent, entries: dirs.slice(0, 500) };
}

/**
 * Web-only: DevForge session workspaces — the `~/DevForge/<name>` dirs the
 * station daemon creates (git repo + aider transcript). Read-only scan;
 * offered as quick-adds in the Projects view and install flow.
 */
async function devforgeWorkspaces() {
  const root = path.join(home(), "DevForge");
  let ents = [];
  try {
    ents = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { root, workspaces: [] };
  }
  const workspaces = [];
  for (const ent of ents.slice(0, 100)) {
    if (!ent.isDirectory() || ent.name.startsWith(".")) continue;
    const dir = path.join(root, ent.name);
    const hasGit = await fsp.stat(path.join(dir, ".git")).then(() => true).catch(() => false);
    const hasAider = await fsp
      .stat(path.join(dir, ".aider.chat.history.jsonl"))
      .then(() => true)
      .catch(() => false);
    if (!hasGit && !hasAider) continue; // not a session workspace
    workspaces.push({ name: ent.name, path: dir, git: hasGit, aider: hasAider });
  }
  workspaces.sort((a, b) => a.name.localeCompare(b.name));
  return { root, workspaces };
}

/** Best-effort `reveal_path`: open a path with the platform opener. */
async function revealPath(args) {
  const p = String(args?.path ?? "");
  if (!p) throw err.invalidArgument("path required");
  const { execFile } = await import("node:child_process");
  const candidates =
    process.platform === "darwin" ? ["open"] : ["termux-open", "xdg-open", "open"];
  for (const bin of candidates) {
    const ok = await new Promise((resolve) => {
      execFile(bin, [p], { timeout: 5000 }, (e) => resolve(!e));
    });
    if (ok) return;
  }
  throw err.io(`could not open ${p}: no file opener available (install termux-tools or xdg-open)`);
}

/**
 * The dispatch table. Each handler takes `(adir, args)` (some take only
 * `args`) and returns the command's result — or throws an AppError whose
 * `.payload` is the wire error object.
 */
export async function dispatch(adir, cmd, args) {
  const a = args ?? {};
  switch (cmd) {
    // ---- App ----
    case "app_version":
      return appVersion();

    // ---- Settings ----
    case "settings_get":
      return settingsGet(adir);
    case "settings_set":
      return settingsSet(adir, a.settings);
    case "settings_reset":
      return settingsReset(adir);

    // ---- Corpus ----
    case "corpus_list": {
      const corpus = await ensureCorpus(adir);
      return corpusList(corpus, a.category ?? null);
    }
    case "corpus_get": {
      const corpus = await ensureCorpus(adir);
      const agent = corpusGet(corpus, String(a.slug ?? ""));
      if (!agent) throw err.invalidArgument(`unknown agent slug: ${a.slug}`);
      return agent;
    }
    case "corpus_categories": {
      const corpus = await ensureCorpus(adir);
      return corpusCategoriesOf(corpus);
    }
    case "corpus_status": {
      const corpus = await ensureCorpus(adir);
      return corpus.meta;
    }
    case "corpus_refresh":
      return refreshCorpus(adir);

    // ---- Catalog source ----
    case "catalog_source_get":
      return catalogSourceGet(adir);
    case "catalog_configured":
      return catalogConfigured(adir);
    case "catalog_source_set":
      return catalogSourceSet(adir, a.source);
    case "catalog_status":
      return catalogStatus(adir);
    case "catalog_detect":
      return catalogDetect(a.scan);
    case "catalog_check_updates":
      return catalogCheckUpdates(adir);
    case "catalog_pull":
      return catalogPull(adir);
    case "catalog_provision_managed":
      return catalogProvisionManaged(adir);

    // ---- Runbooks ----
    case "runbooks_list":
      return runbooksList(adir);

    // ---- Install / reconcile ----
    case "install_agent":
      return installAgent(adir, a.slug, a.tool, a.projectPath);
    case "update_agent":
      return installAgent(adir, a.slug, a.tool, a.projectPath);
    case "track_agent":
      return trackAgent(adir, a.slug, a.tool, a.projectPath);
    case "uninstall_agent":
      return uninstallAgent(adir, a.slug, a.tool, a.projectPath);
    case "agent_diff":
      return agentDiff(adir, a.slug, a.tool, a.projectPath);
    case "installs_reconcile":
      return installsReconcile(adir, a.projectRoots ?? []);
    case "installs_for_agent":
      return installsForAgent(adir, a.slug);
    case "project_forget":
      return projectForget(adir, a.projectPath);
    case "projects_list":
      return projectsList(adir);

    // ---- Tools ----
    case "tools_list":
      return toolsList(adir);
    case "tool_versions":
      return toolVersions();
    case "reveal_path":
      return revealPath(a);

    // ---- Loadouts (Agentfile) ----
    case "loadout_export":
      return loadoutExport(adir, a.path);
    case "loadout_import":
      return loadoutImport(adir, a.path);
    // Web variants (browser download / upload instead of native dialogs).
    case "web_loadout_export":
      return webLoadoutExport(adir);
    case "web_loadout_import":
      return webLoadoutImport(adir, a.json);

    // ---- Web-only helpers ----
    case "web_list_dir":
      return webListDir(a);

    // ---- Private catalog overlays (web build) ----
    case "web_overlays_list":
      return listOverlays(adir);
    case "web_overlays_add": {
      const p = String(a.path ?? "");
      if (!p) throw err.invalidArgument("overlay path required");
      if (!looksLikeOverlay(p)) {
        throw err.invalidArgument(
          `${p} doesn't look like an agent catalog (no .md files with name frontmatter found)`,
        );
      }
      const paths = await loadOverlays(adir);
      const abs = path.resolve(p);
      if (!paths.includes(abs)) paths.push(abs);
      await saveOverlays(adir, paths);
      await rebuildCorpus(adir);
      return { path: abs, agentCount: (await listOverlays(adir)).find((o) => o.path === abs)?.agentCount ?? 0 };
    }
    case "web_overlays_remove": {
      const p = String(a.path ?? "");
      const paths = (await loadOverlays(adir)).filter(
        (x) => x !== p && path.resolve(x) !== path.resolve(p),
      );
      await saveOverlays(adir, paths);
      await rebuildCorpus(adir);
      return { path: p, agentCount: 0 };
    }

    // ---- DevForge Station bridge (web build, read-only) ----
    case "station_status":
      return stationStatus(adir);
    case "station_events":
      return stationEvents(adir, a.limit);
    case "station_analytics":
      return stationAnalytics(adir);
    case "station_url_get":
      return { url: await stationUrl(adir) };
    case "station_url_set":
      return { url: await saveStationUrl(adir, a.url) };

    // ---- Agent chat over OpenRouter (web build) ----
    case "chat_key_get":
      return chatKeyGet(adir);
    case "chat_key_set":
      return chatKeySet(adir, a.key, a.model);
    case "chat_model_set":
      return chatKeySetModel(adir, a.model);
    case "chat_models":
      return chatModels(adir);
    case "chat_usage":
      return chatUsage(adir);

    // ---- DevForge session workspaces (web build) ----
    case "web_devforge_workspaces":
      return devforgeWorkspaces();

    // ---- GitHub (quiet degradation in the web build) ----
    case "github_repo_stats":
      return null; // "not enabled" — no probes without consent
    case "github_status":
      return { signedIn: false, username: null, scopes: [] };
    case "github_signin_start":
      throw err.internal("GitHub sign-in is not available in the web build.");
    case "github_signin_poll":
      return { kind: "denied" };
    case "github_signout":
      return;
    case "github_star":
    case "github_unstar":
    case "github_watch":
    case "github_unwatch":
      throw new (class extends Error {
        constructor() {
          super("Not signed in");
          this.payload = { code: "auth_required" };
        }
      })();
    case "github_is_starred":
      return false;
    case "github_create_issue":
      throw err.internal("GitHub issue creation is not available in the web build.");

    // ---- Updater (quiet degradation — served from git/npm, not in-app) ----
    case "update_check_now":
      return { kind: "upToDate" };
    case "update_install":
    case "update_relaunch":
      throw err.internal("In-app updates are not available in the web build; update via git pull + rebuild.");
    case "update_skip":
      return;

    default:
      throw err.invalidArgument(`unknown command: ${cmd}`);
  }
}
