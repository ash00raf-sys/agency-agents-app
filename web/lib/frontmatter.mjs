/**
 * Tolerant frontmatter parsing + canonical hashing for the corpus.
 * Faithful port of `src-tauri/src/corpus/parse.rs`.
 *
 * The frontmatter split is byte-exact (fences, BOM, trailing whitespace);
 * the five surfaced fields (name/description/emoji/color/vibe) are read
 * with a small YAML-subset that covers the corpus's actual shapes:
 * plain scalars, single/double-quoted scalars, and indented continuation
 * folding (joined by single spaces, as YAML folds).
 */

import { sha256Hex } from "./util.mjs";

/**
 * Split a raw agent `.md` into frontmatter + body.
 * Returns null when there is no well-formed `---`-fenced frontmatter block
 * at the head of the file (the file is not an agent).
 */
export function splitFrontmatter(source) {
  // Tolerate a leading BOM.
  const s = source.startsWith("\u{feff}") ? source.slice(1) : source;

  // The opening fence must be the very first line, exactly `---` ignoring
  // trailing whitespace.
  const firstNl = s.indexOf("\n");
  if (firstNl === -1) return null;
  if (s.slice(0, firstNl).trimEnd() !== "---") return null;

  // Walk lines until the closing fence, tracking exact offsets.
  let fmStart = firstNl + 1;
  let from = fmStart;
  for (;;) {
    const nl = s.indexOf("\n", from);
    const lineEnd = nl === -1 ? s.length : nl;
    const line = s.slice(from, lineEnd).trimEnd();
    if (line === "---") {
      const frontmatter = s.slice(fmStart, from);
      const body = nl === -1 ? "" : s.slice(lineEnd + 1);
      return { frontmatter, body };
    }
    if (nl === -1) return null; // EOF without a closing fence — not an agent
    from = nl + 1;
  }
}

/**
 * Parse the frontmatter region for the subset of keys we surface.
 * Returns `{ name, description, emoji, color, vibe }` (all strings, empty
 * when absent) — never throws for the corpus's real-world shapes.
 */
export function parseFrontmatterFields(frontmatter) {
  const out = { name: "", description: "", emoji: "", color: "", vibe: "" };
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!(key in out)) continue;
    let value = m[2] ?? "";
    // Indented continuation lines fold in, joined by single spaces.
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      const rest = next.replace(/^[ \t]+/, "");
      const indented = rest !== next && rest.trim() !== "";
      if (!indented) break;
      value += " " + rest.trim();
      i++;
    }
    out[key] = unquoteYamlScalar(value.trim());
  }
  return out;
}

/**
 * Strip one matching pair of outer quotes and unescape, matching both
 * serde_yaml and the shell helper's semantics (see render.mjs
 * `unquoteScalar` — same rules, applied to parsed display values).
 */
function unquoteYamlScalar(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return raw.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replaceAll("''", "'");
  }
  return raw;
}

/**
 * Parse one agent `.md`. Returns `{ agent, entry }` or null when the file is
 * not an agent (no frontmatter, or no `name`). `slug` is the filename stem;
 * `category` is the parent directory name.
 */
export function parseAgent(slug, category, source) {
  const split = splitFrontmatter(source);
  if (!split) return null;

  const fm = parseFrontmatterFields(split.frontmatter);
  if (fm.name.trim() === "") return null; // `name` is required

  const description = fm.description;
  const body = split.body;

  // Hash the canonical byte regions of the *source* so the values are
  // stable across runs/platforms (identical to the Rust byte ranges).
  const sourceHash = sha256Hex(Buffer.from(source, "utf8"));
  const frontmatterHash = sha256Hex(Buffer.from(split.frontmatter, "utf8"));
  const bodyHash = sha256Hex(Buffer.from(split.body, "utf8"));

  const agent = {
    slug,
    name: fm.name,
    description,
    category,
    emoji: fm.emoji || null,
    color: fm.color || null,
    vibe: fm.vibe || null,
    body,
  };

  const entry = {
    slug,
    name: fm.name,
    category,
    emoji: fm.emoji || null,
    color: fm.color || null,
    vibe: fm.vibe || null,
    description,
    sourceHash,
    frontmatterHash,
    bodyHash,
  };

  return { agent, entry };
}
