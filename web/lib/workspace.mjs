/**
 * Workspace file access for agent chat — the "inspect & alter" layer.
 *
 * Chat conversations can attach a project folder. The agent then gets:
 *   • a compact file tree (junk dirs skipped, entry-capped)
 *   • attached file contents (size-capped) — auto for key files, or picked
 *   • an edit protocol: changed files come back as ```path:<rel> fences,
 *     each rendered with an "Apply" button in the UI
 *
 * Writes are the dangerous part, so they mirror the installer's discipline:
 * traversal-checked relative paths only, hard size caps, and the existing
 * bytes are backed up to the app's backups dir before any overwrite. The
 * user sees a unified diff and confirms before anything touches disk.
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

import { atomicWrite, backupsDir, err, fsStamp } from "./util.mjs";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svelte-kit", ".gradle", ".idea", ".vscode",
  "build", "dist", "out", "target", "coverage", "__pycache__", ".venv",
  ".next", ".nuxt", ".cache",
]);

const MAX_TREE_ENTRIES = 400;
const MAX_READ_BYTES = 200_000; // per attached file
const MAX_WRITE_BYTES = 1_000_000; // per applied file
const BINARY_SNIFF = 8_000;

// ---------- Path safety ----------

/** Resolve `rel` inside `root`, refusing escapes, absolute paths, and backslashes. */
function safeRel(root, rel) {
  const r = String(rel ?? "");
  if (r === "" || r.includes("\\") || r.includes("\0")) return null;
  if (path.isAbsolute(r)) return null;
  const resolved = path.resolve(root, r);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function assertDir(p) {
  const st = await fsp.stat(p).catch(() => null);
  if (!st || !st.isDirectory()) throw err.invalidArgument(`not a directory: ${p}`);
}

// ---------- Tree ----------

/**
 * Compact project tree: `[{ p: "<rel path>", d: 1|0 }]`, depth 3, junk dirs
 * skipped, capped at MAX_TREE_ENTRIES. Directories first, then files, per level.
 */
async function workspaceTree(rootRaw) {
  const root = path.resolve(String(rootRaw ?? ""));
  await assertDir(root);
  const out = [];
  let truncated = false;

  async function walk(dir, rel, depth) {
    if (out.length >= MAX_TREE_ENTRIES) {
      truncated = true;
      return;
    }
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    ents.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    const files = [];
    for (const ent of ents) {
      if (ent.name.startsWith(".") && ent.name !== ".github") continue;
      if (out.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        out.push({ p: childRel, d: 1 });
        if (depth < 3) await walk(path.join(dir, ent.name), childRel, depth + 1);
      } else {
        files.push(childRel);
      }
    }
    for (const f of files) {
      if (out.length >= MAX_TREE_ENTRIES) {
        truncated = true;
        break;
      }
      out.push({ p: f, d: 0 });
    }
  }

  await walk(root, "", 0);
  return { root, entries: out, truncated };
}

// ---------- Read ----------

/**
 * Read one file (size-capped). Binary sniff: a NUL byte in the first 8 KB
 * marks it binary — contents are not returned, just the flag + size.
 */
async function workspaceRead(rootRaw, rel) {
  const root = path.resolve(String(rootRaw ?? ""));
  await assertDir(root);
  const file = safeRel(root, rel);
  if (!file) throw err.invalidArgument(`invalid file path: ${rel}`);
  const st = await fsp.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw err.invalidArgument(`no such file: ${rel}`);

  const handle = await fsp.open(file, "r").catch(() => null);
  if (!handle) throw err.io(`cannot open: ${rel}`);
  try {
    const head = Buffer.alloc(Math.min(BINARY_SNIFF, st.size));
    await handle.read(head, 0, head.length, 0);
    const binary = head.includes(0);
    const truncated = st.size > MAX_READ_BYTES;
    const len = truncated ? MAX_READ_BYTES : st.size;
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, 0);
    return {
      path: rel,
      bytes: st.size,
      binary,
      truncated,
      text: binary ? null : buf.toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

// ---------- Write (with backup) ----------

/**
 * Apply a file: back up existing bytes, create parent dirs, atomic write.
 * Returns what happened; never silently overwrites.
 */
async function workspaceWrite(adir, rootRaw, rel, content) {
  const root = path.resolve(String(rootRaw ?? ""));
  await assertDir(root);
  const file = safeRel(root, rel);
  if (!file) throw err.invalidArgument(`invalid file path: ${rel}`);
  if (typeof content !== "string") throw err.invalidArgument("content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes === 0) throw err.invalidArgument("refusing to write an empty file");
  if (bytes > MAX_WRITE_BYTES) throw err.invalidArgument(`file too large to apply (${bytes} bytes)`);

  const stampIso = new Date().toISOString();
  let backup = null;
  const existing = await fsp.readFile(file).catch(() => null);
  if (existing) {
    const bdir = backupsDir(adir);
    await fsp.mkdir(bdir, { recursive: true });
    const flat = String(rel).replace(/\//g, "__");
    const bpath = path.join(bdir, `ws-${flat}.${fsStamp(stampIso)}.bak`);
    await atomicWrite(bpath, existing);
    backup = bpath;
  }

  await fsp.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, content);
  return { path: rel, bytes, created: !existing, backup };
}

// ---------- Diff ----------

/** LCS line diff (O(n·m), guarded) → unified-diff hunks with 3 context lines. */
function lineDiff(oldText, newText) {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  if (a.length * b.length > 250_000) return null; // too big → summary fallback

  const n = a.length;
  const m = b.length;
  // DP table as one Int32Array, 1-indexed.
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j]
        ? dp[(i + 1) * w + (j + 1)] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
    }
  }
  // Walk the edits.
  const edits = []; // {t:'='|'-'|'+', line}
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      edits.push({ t: "=", line: a[i] });
      i++; j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) {
      edits.push({ t: "-", line: a[i++] });
    } else {
      edits.push({ t: "+", line: b[j++] });
    }
  }
  while (i < n) edits.push({ t: "-", line: a[i++] });
  while (j < m) edits.push({ t: "+", line: b[j++] });

  // Group into hunks with 3 lines of context.
  const CTX = 3;
  const hunks = [];
  let k = 0;
  let aLine = 1;
  let bLine = 1;
  while (k < edits.length) {
    if (edits[k].t === "=") {
      k++; aLine++; bLine++;
      continue;
    }
    // Hunk start: back up CTX context lines.
    const start = Math.max(0, k - CTX);
    const aStart = aLine - (k - start);
    const bStart = bLine - (k - start);
    const body = [];
    let end = k;
    // Extend until CTX equal lines beyond the last edit in this cluster.
    let quiet = 0;
    let t = k;
    while (t < edits.length) {
      if (edits[t].t === "=") {
        quiet++;
        if (quiet > CTX * 2 && t - CTX > end) break;
      } else {
        quiet = 0;
        end = t;
      }
      t++;
    }
    const stop = Math.min(edits.length, end + CTX + 1);
    for (let s = start; s < stop; s++) {
      const e = edits[s];
      body.push(`${e.t === "=" ? " " : e.t}${e.line}`);
      if (e.t !== "+") aLine++;
      if (e.t !== "-") bLine++;
    }
    hunks.push({ aStart, bStart, body });
    k = stop;
  }
  return hunks;
}

/**
 * Unified diff of current vs proposed content for one file.
 * Falls back to a summary when the LCS would be too big.
 */
async function workspaceDiff(rootRaw, rel, content) {
  const root = path.resolve(String(rootRaw ?? ""));
  await assertDir(root);
  const file = safeRel(root, rel);
  if (!file) throw err.invalidArgument(`invalid file path: ${rel}`);
  if (typeof content !== "string") throw err.invalidArgument("content must be a string");

  const exists = fs.existsSync(file);
  const oldText = exists ? (await fsp.readFile(file)).toString("utf8") : "";
  if (oldText === content) {
    return { path: rel, exists, identical: true, summary: "No changes — content is identical.", diff: "" };
  }

  const hunks = lineDiff(oldText, content);
  let diff;
  let summary;
  if (hunks === null) {
    summary = `Large file: ${oldText.split("\n").length} → ${content.split("\n").length} lines (full replacement)`;
    diff = `--- a/${rel} (current)\n+++ b/${rel} (proposed)\n${summary}`;
  } else {
    summary = `${hunks.length} hunk${hunks.length === 1 ? "" : "s"}, ${
      content.split("\n").length
    } lines proposed`;
    diff =
      `--- a/${rel} (current)\n+++ b/${rel} (proposed)\n` +
      hunks
        .map((h) => `@@ -${h.aStart},${"…"} +${h.bStart},${"…"} @@\n${h.body.join("\n")}`)
        .join("\n");
  }
  return { path: rel, exists, identical: false, summary, diff };
}

export { workspaceTree, workspaceRead, workspaceWrite, workspaceDiff };
