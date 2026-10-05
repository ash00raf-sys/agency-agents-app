/**
 * Install + reconcile — the cross-tool agent state layer.
 * Faithful port of `src-tauri/src/install/mod.rs`: the ledger
 * (`installs.json`), the 5-state reconciliation (ledger ↔ disk ↔ corpus),
 * the Foreign sweep with byte-perfect adoption, tool detection, and the
 * Agentfile (loadout) export/import.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

import {
  getTool,
  supportedToolIds,
} from "./registry.mjs";
import {
  dests,
  label,
  outputSlug,
  renderWithHash,
  scopeFor,
  supportsProject,
  supportsUser,
} from "./render.mjs";
import {
  corpusEntry,
  corpusGet,
  corpusGetByConversionSlug,
  corpusVersion,
  ensureCorpus,
  readSource,
} from "./corpus.mjs";
import { settingsGet } from "./settings.mjs";
import {
  atomicWrite,
  backupsDir,
  err,
  fsStamp,
  home,
  nowIso,
  readCapped,
  sha256Hex,
  MAX_INSTALLED_BYTES,
  stateDir,
} from "./util.mjs";

// ---------- Ledger persistence ----------

const ledgerPath = (adir) => path.join(stateDir(adir), "installs.json");

async function loadLedger(adir) {
  try {
    const bytes = await fsp.readFile(ledgerPath(adir));
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch (e) {
    if (e?.code === "ENOENT") return []; // no ledger yet — nothing installed
    throw err.io(`parse installs.json: ${e.message}`);
  }
}

async function saveLedger(adir, records) {
  await atomicWrite(ledgerPath(adir), JSON.stringify(records, null, 2));
}

/**
 * User-scope base directory for a tool's installs + detection: the per-tool
 * custom path from settings if any, else the OS home.
 */
async function toolHome(adir, tool) {
  const osHome = home();
  try {
    const s = await settingsGet(adir);
    const custom = s.toolPaths?.[tool];
    if (typeof custom === "string" && custom !== "") return custom;
  } catch {
    /* corrupt settings — fall back to OS home */
  }
  return osHome;
}

// ---------- Backups ----------

/** Copy `dest`'s current bytes into the backups dir before an overwrite —
 *  only when it exists AND differs from the incoming bytes. A failed backup
 *  aborts the write (we never overwrite what we couldn't preserve). */
async function backupIfDiffers(dest, newBytes, backupDir, stamp) {
  let existing;
  try {
    existing = await fsp.readFile(dest);
  } catch (e) {
    if (e?.code === "ENOENT") return;
    throw err.io(`read existing file ${dest} before backup: ${e.code ?? e.message}`);
  }
  if (existing.equals(newBytes)) return; // identical → not destructive
  await fsp.mkdir(backupDir, { recursive: true });
  const fname = path.basename(dest) || "agent";
  const backup = path.join(backupDir, `${fname}.${fsStamp(stamp)}.bak`);
  await atomicWrite(backup, existing);
}

// ---------- Records ----------

function recordFor(agent, primaryDest, tool, projectRoot, renderedHash, sourceHash, bodyHash, corpusVersion, installedAt) {
  return {
    slug: agent.slug,
    tool,
    scope: scopeFor(projectRoot),
    projectPath: projectRoot ?? null,
    dest: primaryDest,
    sourceHash,
    bodyHash,
    renderedHash,
    installedAt,
    corpusVersion,
  };
}

/** Possible physical destinations for one logical install: the catalog
 *  filename slug AND the converter's `slugify(name)` variant. */
function candidateDests(agent, raw, tool, homeDir, projectRoot) {
  const paths = dests(tool, agent.slug, homeDir, projectRoot);
  const conversionSlug = outputSlug(agent, raw, tool);
  if (conversionSlug !== agent.slug) {
    for (const p of dests(tool, conversionSlug, homeDir, projectRoot)) {
      if (!paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

/** True when the per-agent unit is a directory (`{slug}/LEAF`). */
function toolIsDirUnit(tool) {
  const dest = getTool(tool)?.dest;
  if (!dest) return false;
  return [...(dest.user ?? []), ...(dest.project ?? [])].some((t) => {
    const i = t.indexOf("{slug}");
    return i !== -1 && t.slice(i + 6).startsWith("/");
  });
}

/** Build a ledger record for Track: canonical render's hash + dest, but
 *  write NOTHING. */
function trackAgentRecord(agent, raw, tool, homeDir, projectRoot, sourceHash, bodyHash, corpusVersion, installedAt) {
  const [, renderedHash] = renderWithHash(agent, raw, tool);
  const paths = candidateDests(agent, raw, tool, homeDir, projectRoot);
  const primary = paths.find((p) => fs.existsSync(p)) ?? paths[0];
  return recordFor(agent, primary, tool, projectRoot, renderedHash, sourceHash, bodyHash, corpusVersion, installedAt);
}

// ---------- Install / update / track (shared core) ----------

async function doInstall(adir, slug, tool, projectPath) {
  const corpus = await ensureCorpus(adir);
  const agent = corpusGet(corpus, slug);
  if (!agent) throw err.io(`unknown agent: ${slug}`);
  const entry = corpusEntry(corpus, slug);
  if (!entry) throw err.io(`no corpus-index entry for ${slug}`);
  const raw = await readSource(adir, agent.category, slug);

  const homeDir = await toolHome(adir, tool);
  const proot = projectPath ?? null;
  const backups = backupsDir(adir);
  let ledger = await loadLedger(adir);
  const existingDest = ledger.find(
    (r) => r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot,
  )?.dest;

  const record = await writeAgentFilesTo(
    agent,
    raw,
    tool,
    homeDir,
    proot,
    backups,
    entry.sourceHash,
    entry.bodyHash,
    corpusVersion(corpus),
    nowIso(),
    existingDest,
  );

  ledger = ledger.filter(
    (r) => !(r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot),
  );
  ledger.push(record);
  await saveLedger(adir, ledger);
  return record;
}

async function doTrack(adir, slug, tool, projectPath) {
  const corpus = await ensureCorpus(adir);
  const agent = corpusGet(corpus, slug);
  if (!agent) throw err.io(`unknown agent: ${slug}`);
  const entry = corpusEntry(corpus, slug);
  if (!entry) throw err.io(`no corpus-index entry for ${slug}`);
  const raw = await readSource(adir, agent.category, slug);

  const homeDir = await toolHome(adir, tool);
  const proot = projectPath ?? null;
  const record = trackAgentRecord(
    agent,
    raw,
    tool,
    homeDir,
    proot,
    entry.sourceHash,
    entry.bodyHash,
    corpusVersion(corpus),
    nowIso(),
  );

  let ledger = await loadLedger(adir);
  ledger = ledger.filter(
    (r) => !(r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot),
  );
  ledger.push(record);
  await saveLedger(adir, ledger);
  return record;
}

/** Render + write the agent file(s) and build the ledger record. Backs up
 *  any existing dest whose bytes differ before overwriting. Keeps an
 *  existing install's filename variant while it's still a valid dest. */
async function writeAgentFilesTo(agent, raw, tool, homeDir, projectRoot, backupDir, sourceHash, bodyHash, corpusVersion, installedAt, preferredDest) {
  const [bytes, renderedHash] = renderWithHash(agent, raw, tool);
  let paths = dests(tool, agent.slug, homeDir, projectRoot);
  const valid = candidateDests(agent, raw, tool, homeDir, projectRoot);
  const preferred = preferredDest && valid.includes(preferredDest) ? preferredDest : null;
  if (preferred) {
    if (paths.length === 1) {
      paths[0] = preferred;
    } else {
      const i = paths.indexOf(preferred);
      if (i > 0) {
        const tmp = paths[0];
        paths[0] = paths[i];
        paths[i] = tmp;
      }
    }
  }
  for (const dest of paths) {
    if (backupDir) await backupIfDiffers(dest, Buffer.from(bytes, "utf8"), backupDir, installedAt);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await atomicWrite(dest, Buffer.from(bytes, "utf8"));
  }
  return recordFor(agent, paths[0], tool, projectRoot, renderedHash, sourceHash, bodyHash, corpusVersion, installedAt);
}

/** Back up divergent files, then remove every existing physical destination.
 *  Dir-unit tools also get their (now-empty) agent dir pruned. */
async function removeAgentFiles(agent, raw, tool, homeDir, projectRoot, ledgerDest, backupDir, stamp) {
  const [canonical] = renderWithHash(agent, raw, tool);
  const paths = candidateDests(agent, raw, tool, homeDir, projectRoot);
  if (ledgerDest && !paths.includes(ledgerDest)) paths.push(ledgerDest);

  const existing = paths.filter((p) => fs.existsSync(p));
  for (let i = 0; i < existing.length; i++) {
    await backupIfDiffers(existing[i], Buffer.from(canonical, "utf8"), backupDir, `${stamp}-${i}`);
  }
  const dirUnit = toolIsDirUnit(tool);
  for (const p of existing) {
    await fsp.rm(p, { force: true }).catch((e) => {
      if (e?.code !== "ENOENT") throw err.io(`remove agent file ${p}: ${e.code ?? e.message}`);
    });
    if (dirUnit) {
      await fsp.rmdir(path.dirname(p)).catch(() => {
        /* not empty (user files) — leave it */
      });
    }
  }
}

// ---------- Reconciliation core (pure) ----------

/** Classify one ledger row given the on-disk hash + corpus source hash. */
function classify(disk, renderedHash, recordSource, corpusSource) {
  if (disk == null) return "removed";
  if (disk !== renderedHash) return "modified";
  if (corpusSource == null) return "current"; // agent gone upstream — not stale
  return corpusSource === recordSource ? "current" : "outdated";
}

/** A Current install is stale when a fresh render of the same source differs
 *  from the recorded render (a renderer fix shipped since it was written). */
function rendererOutdated(state, recordedRender, freshRender) {
  return state === "current" && freshRender != null && freshRender !== recordedRender;
}

/** True when `fileBytes` are byte-identical to the canonical render. */
function bytesMatchRender(agent, raw, tool, fileBytes) {
  try {
    const [, expected] = renderWithHash(agent, raw, tool);
    return sha256Hex(fileBytes) === expected;
  } catch {
    return false;
  }
}

// ---------- Tool detection ----------

function detect(tool, homeDir) {
  const det = getTool(tool)?.detect;
  if (!det) return { detected: false, agentsDir: null };
  const detected = (det.dirs ?? []).some((d) => fs.existsSync(path.join(homeDir, d)));
  const agentsDir = det.agentsDir ? path.join(homeDir, det.agentsDir) : null;
  return { detected, agentsDir };
}

/** For the Foreign sweep: each scannable agents-root for a tool, paired with
 *  the path suffix that follows `{slug}` in the dest template. */
function agentUnits(tool, homeDir, projectRoot) {
  const dest = getTool(tool)?.dest;
  if (!dest) return [];
  const [templates, root] = projectRoot
    ? [dest.project ?? [], projectRoot]
    : [dest.user ?? [], homeDir];
  const seen = new Map();
  for (const t of templates) {
    const i = t.indexOf("{slug}");
    if (i === -1) continue;
    seen.set(`${path.join(root, t.slice(0, i))}\u0000${t.slice(i + 6)}`, [
      path.join(root, t.slice(0, i)),
      t.slice(i + 6),
    ]);
  }
  return [...seen.values()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------- Commands ----------

/** `install_agent` / `update_agent`. */
export async function installAgent(adir, slug, tool, projectPath) {
  return doInstall(adir, slug, tool, projectPath ?? null);
}

/** `uninstall_agent` — remove the written file(s) and the ledger row. */
export async function uninstallAgent(adir, slug, tool, projectPath) {
  const corpus = await ensureCorpus(adir);
  const agent = corpusGet(corpus, slug);
  if (!agent) throw err.io(`unknown agent: ${slug}`);
  const raw = await readSource(adir, agent.category, slug);
  const homeDir = await toolHome(adir, tool);
  const proot = projectPath ?? null;
  let ledger = await loadLedger(adir);
  const ledgerDest = ledger.find(
    (r) => r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot,
  )?.dest;
  await removeAgentFiles(agent, raw, tool, homeDir, proot, ledgerDest, backupsDir(adir), nowIso());
  ledger = ledger.filter(
    (r) => !(r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot),
  );
  await saveLedger(adir, ledger);
}

/** `track_agent` — record provenance without writing anything. */
export async function trackAgent(adir, slug, tool, projectPath) {
  return doTrack(adir, slug, tool, projectPath ?? null);
}

/** `agent_diff` — on-disk contents vs the canonical render (zero writes). */
export async function agentDiff(adir, slug, tool, projectPath) {
  const corpus = await ensureCorpus(adir);
  const agent = corpusGet(corpus, slug);
  if (!agent) throw err.io(`unknown agent: ${slug}`);
  const raw = await readSource(adir, agent.category, slug);
  const [proposed] = renderWithHash(agent, raw, tool);

  const homeDir = await toolHome(adir, tool);
  const proot = projectPath ?? null;
  const ledger = await loadLedger(adir);
  const ledgerDest = ledger.find(
    (r) => r.slug === slug && r.tool === tool && (r.projectPath ?? null) === proot,
  )?.dest;
  const candidates = candidateDests(agent, raw, tool, homeDir, proot);
  const dest =
    ledgerDest ?? candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
  let onDisk = null;
  try {
    const bytes = await readCapped(dest, MAX_INSTALLED_BYTES);
    onDisk = bytes.toString("utf8");
  } catch {
    onDisk = null;
  }
  return {
    slug,
    tool,
    projectPath: proot,
    dest,
    onDisk,
    proposed,
    differs: onDisk !== proposed,
  };
}

/** `project_forget` — drop every ledger row for a project, keep the files. */
export async function projectForget(adir, projectPath) {
  let ledger = await loadLedger(adir);
  ledger = ledger.filter((r) => (r.projectPath ?? null) !== projectPath);
  await saveLedger(adir, ledger);
}

/** `projects_list` — project dirs we've installed into (from the ledger). */
export async function projectsList(adir) {
  const ledger = await loadLedger(adir);
  const counts = new Map();
  for (const r of ledger) {
    if (r.projectPath) counts.set(r.projectPath, (counts.get(r.projectPath) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([p, installedCount]) => ({
      path: p,
      label: path.basename(p) || p,
      installedCount,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** `installs_for_agent` — all records matching one agent. */
export async function installsForAgent(adir, slug) {
  const ledger = await loadLedger(adir);
  return ledger.filter((r) => r.slug === slug);
}

/** The reconciled Library view — every ledger row resolved against disk +
 *  corpus, plus the Foreign sweep with byte-perfect adoption. */
export async function installsReconcile(adir, projectRoots) {
  const corpus = await ensureCorpus(adir);
  let ledger = await loadLedger(adir);
  const out = [];

  for (const r of ledger) {
    let diskHash = null;
    if (fs.existsSync(r.dest)) {
      try {
        const b = await readCapped(r.dest, MAX_INSTALLED_BYTES);
        diskHash = sha256Hex(b);
      } catch {
        diskHash = null;
      }
    }
    const centry = corpusEntry(corpus, r.slug);
    const corpusSource = centry?.sourceHash ?? null;
    let st = classify(diskHash, r.renderedHash, r.sourceHash, corpusSource);

    // Re-render an unchanged agent to catch renderer fixes.
    let rendererChanged = false;
    if (st === "current") {
      const agent = corpusGet(corpus, r.slug);
      if (agent) {
        let fresh = null;
        try {
          const raw = await readSource(adir, agent.category, r.slug);
          fresh = renderWithHash(agent, raw, r.tool)[1];
        } catch {
          fresh = null;
        }
        if (rendererOutdated(st, r.renderedHash, fresh)) {
          st = "outdated";
          rendererChanged = true;
        }
      }
    }

    let updateKind = null;
    if (st === "outdated") {
      const curBody = centry?.bodyHash ?? null;
      updateKind =
        !rendererChanged && curBody === r.bodyHash ? "cosmetic" : "substantive";
    }

    out.push({
      slug: r.slug,
      name: corpusGet(corpus, r.slug)?.name ?? r.slug,
      tool: r.tool,
      scope: r.scope,
      projectPath: r.projectPath ?? null,
      dest: r.dest,
      state: st,
      updateKind,
      tracked: true,
    });
  }

  // ----- Foreign sweep -----
  const ledgerKeys = new Set(ledger.map((r) => `${r.slug}\u0000${r.tool}\u0000${r.projectPath ?? ""}`));
  const projectDirs = [
    ...new Set([
      ...ledger.map((r) => r.projectPath).filter(Boolean),
      ...(projectRoots ?? []),
    ]),
  ];
  const adopted = [];
  const adoptedSeen = new Set();

  for (const tool of supportedToolIds()) {
    const homeDir = await toolHome(adir, tool);
    const prefix = getTool(tool)?.slugPrefix ?? "";
    const scanRoots = [];
    if (supportsUser(tool)) {
      for (const [d, s] of agentUnits(tool, homeDir, null)) scanRoots.push([null, d, s]);
    }
    if (supportsProject(tool)) {
      for (const p of projectDirs) {
        for (const [d, s] of agentUnits(tool, homeDir, p)) scanRoots.push([p, d, s]);
      }
    }

    for (const [proj, agentsRoot, suffix] of scanRoots) {
      let ents;
      try {
        ents = await fsp.readdir(agentsRoot, { withFileTypes: true });
      } catch {
        continue;
      }
      const dirUnit = suffix.startsWith("/");
      for (const ent of ents) {
        const name = ent.name;
        let token, bytePath;
        if (dirUnit) {
          if (!ent.isDirectory()) continue;
          token = name;
          bytePath = path.join(agentsRoot, name, suffix.replace(/^\//, ""));
        } else if (name.endsWith(suffix) && name.length > suffix.length) {
          token = name.slice(0, name.length - suffix.length);
          bytePath = path.join(agentsRoot, name);
        } else {
          continue;
        }
        const cand = token.startsWith(prefix) ? token.slice(prefix.length) : token;
        const agent =
          corpusGet(corpus, cand) ?? corpusGetByConversionSlug(corpus, cand);
        if (!agent) continue; // unrecognized → not ours to claim
        const slug = agent.slug;
        if (ledgerKeys.has(`${slug}\u0000${tool}\u0000${proj ?? ""}`)) continue;

        let raw = null;
        let disk = null;
        try {
          raw = await readSource(adir, agent.category, slug);
        } catch {
          raw = null;
        }
        try {
          disk = await readCapped(bytePath, MAX_INSTALLED_BYTES);
        } catch {
          disk = null;
        }
        const canonical = raw != null && disk != null && bytesMatchRender(agent, raw, tool, disk);
        let tracked = false;
        let state;
        if (canonical) {
          const entry = corpusEntry(corpus, slug);
          if (raw != null && entry) {
            const key = `${slug}\u0000${tool}\u0000${proj ?? ""}`;
            if (!adoptedSeen.has(key)) {
              try {
                const rec = trackAgentRecord(
                  agent,
                  raw,
                  tool,
                  homeDir,
                  proj,
                  entry.sourceHash,
                  entry.bodyHash,
                  corpusVersion(corpus),
                  nowIso(),
                );
                adopted.push(rec);
                adoptedSeen.add(key);
              } catch {
                /* adoption is best-effort */
              }
            }
            tracked = true;
          }
          state = "current";
        } else {
          state = "foreign";
        }
        out.push({
          slug,
          name: agent.name,
          tool,
          scope: scopeFor(proj),
          projectPath: proj,
          dest: bytePath,
          state,
          updateKind: null,
          tracked,
        });
      }
    }
  }

  // Persist byte-perfect adoptions in one write (idempotent).
  if (adopted.length > 0) {
    ledger = [...ledger, ...adopted];
    await saveLedger(adir, ledger);
  }

  // Collapse to one row per LOGICAL install (slug, tool, project).
  const seen = new Set();
  return out.filter((a) => {
    const key = `${a.slug}\u0000${a.tool}\u0000${a.projectPath ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `tools_list` — detected AI tools + deployment surface + counts. */
export async function toolsList(adir) {
  const ledger = await loadLedger(adir);
  const osHome = home();
  const out = [];
  for (const tool of supportedToolIds()) {
    const installedCount = ledger.filter((r) => r.tool === tool).length;
    const homeDir = await toolHome(adir, tool);
    const customPath = homeDir !== osHome ? homeDir : null;
    const { detected, agentsDir } = detect(tool, homeDir);
    out.push({
      tool,
      label: label(tool),
      detected,
      scope: supportsUser(tool) ? "user" : "project",
      userDest: agentsDir,
      installedCount,
      customPath,
    });
  }
  return out;
}

/** `tool_versions` — best-effort `<bin> --version` probes (3s timeout each). */
export async function toolVersions() {
  const ids = supportedToolIds();
  return Promise.all(
    ids.map(
      (tool) =>
        new Promise((resolve) => {
          const v = getTool(tool)?.version;
          if (!v?.bin) {
            resolve({ tool, version: null });
            return;
          }
          execFile(
            v.bin,
            v.args ?? [],
            { timeout: 3000, windowsHide: true },
            (e, stdout, stderr) => {
              let version = null;
              if (!e) {
                const first = (stdout || stderr)
                  .split("\n")
                  .map((l) => l.trim())
                  .find((l) => l !== "");
                if (first) version = [...first].slice(0, 48).join("");
              }
              resolve({ tool, version });
            },
          );
        }),
    ),
  );
}

// ---------- Loadouts (Agentfile) ----------

/** `loadout_export` — the ledger as a portable Agentfile written to `path`. */
export async function loadoutExport(adir, filePath) {
  const ledger = await loadLedger(adir);
  const installs = ledger.map((r) => ({
    slug: r.slug,
    tool: r.tool,
    projectPath: r.projectPath ?? null,
  }));
  const af = { agentfile: 1, installs };
  await atomicWrite(path.resolve(filePath), Buffer.from(JSON.stringify(af, null, 2), "utf8"));
  return installs.length;
}

/** `loadout_import` — install every Agentfile entry; failures are skipped. */
export async function loadoutImport(adir, filePath) {
  const bytes = await readCapped(path.resolve(filePath), MAX_INSTALLED_BYTES);
  let af;
  try {
    af = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw err.io(`parse Agentfile: ${e.message}`);
  }
  const out = [];
  for (const e of af?.installs ?? []) {
    if (typeof e?.slug !== "string" || typeof e?.tool !== "string") continue;
    try {
      const rec = await doInstall(adir, e.slug, e.tool, e.projectPath ?? null);
      out.push(rec);
    } catch {
      /* skipped, not fatal */
    }
  }
  return out;
}

/** `web_loadout_export` — same manifest as a JSON string (browser download). */
export async function webLoadoutExport(adir) {
  const ledger = await loadLedger(adir);
  const installs = ledger.map((r) => ({
    slug: r.slug,
    tool: r.tool,
    projectPath: r.projectPath ?? null,
  }));
  return JSON.stringify({ agentfile: 1, installs }, null, 2);
}

/** `web_loadout_import` — import from an uploaded Agentfile's contents. */
export async function webLoadoutImport(adir, json) {
  let af;
  try {
    af = JSON.parse(json);
  } catch (e) {
    throw err.io(`parse Agentfile: ${e.message}`);
  }
  const out = [];
  for (const e of af?.installs ?? []) {
    if (typeof e?.slug !== "string" || typeof e?.tool !== "string") continue;
    try {
      const rec = await doInstall(adir, e.slug, e.tool, e.projectPath ?? null);
      out.push(rec);
    } catch {
      /* skipped, not fatal */
    }
  }
  return out;
}
