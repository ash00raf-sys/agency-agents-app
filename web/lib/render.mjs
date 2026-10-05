/**
 * Deterministic per-tool agent renderers + destination-path resolution.
 * Faithful port of `src-tauri/src/render/mod.rs` (which itself ports the
 * upstream `scripts/convert.sh`). Every renderer is a pure function of
 * `(Agent, raw source)` — no timestamps, no randomness, stable key order —
 * so `renderedHash` is reproducible and reconciliation by byte-match works
 * exactly as in the native app.
 */

import path from "node:path";

import { sha256Hex } from "./util.mjs";
import { getTool } from "./registry.mjs";

/** Whether `tool` can deploy USER-GLOBALLY (`~/…`). */
export function supportsUser(tool) {
  const m = getTool(tool);
  return !!m && !!m.scope?.user;
}

/** Whether `tool` can deploy into a SPECIFIC PROJECT (`<project>/…`). */
export function supportsProject(tool) {
  const m = getTool(tool);
  return !!m && !!m.scope?.project;
}

/** The scope an install lands in — derived from the chosen project root. */
export function scopeFor(projectRoot) {
  return projectRoot ? "project" : "user";
}

/** Human label for the UI, from the registry. */
export function label(tool) {
  return getTool(tool)?.label ?? tool;
}

/**
 * Match `scripts/lib.sh#get_field`: the first `field: value` line inside the
 * frontmatter. A plain scalar's indented continuation lines are folded in,
 * joined by single spaces, and one matching pair of outer quotes is a
 * delimiter, not content (stripped + unescaped). Byte parity with
 * `convert.sh` depends on every step here.
 */
export function sourceField(source, field) {
  const prefix = `${field}: `;
  let fences = 0;
  let value = null;
  for (const line of source.split("\n")) {
    if (line === "---") {
      fences++;
      if (fences >= 2) break;
      continue;
    }
    if (fences !== 1) continue;
    if (value === null) {
      if (line.startsWith(prefix)) value = line.slice(prefix.length);
    } else {
      const rest = line.replace(/^[ \t]+/, "");
      if (rest.length < line.length && rest !== "") {
        value += " " + rest;
      } else {
        break;
      }
    }
  }
  return value === null ? "" : unquoteScalar(value);
}

/** `get_field`'s `emit`: trim plain-scalar padding, then strip/unescape one
 *  matching pair of outer quotes. */
function unquoteScalar(raw) {
  const v = raw.replace(/^[ \t]+|[ \t]+$/g, "");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replaceAll("''", "'");
  }
  return v;
}

/**
 * Match `body="$(get_body "$file")"` from the upstream converter: skip only
 * the two `---` lines that fence the frontmatter. Later `---` lines are
 * Markdown horizontal rules and belong to the body (agency-agents #891).
 */
export function sourceBody(source) {
  let fences = 0;
  let body = "";
  for (const line of source.split("\n")) {
    if (fences < 2 && line === "---") {
      fences++;
      continue;
    }
    if (fences >= 2) body += line + "\n";
  }
  while (body.endsWith("\n")) body = body.slice(0, -1);
  return body;
}

/** Match `convert.sh#yaml_quote`: a single-quoted YAML scalar with embedded
 *  apostrophes doubled. */
function yamlQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Match `convert.sh#qwen_tools`: rename a source agent's Claude Code tool
 * list to Qwen Code's canonical tool names, deduped, order-preserving.
 */
function qwenTools(tools) {
  const map = {
    Read: "read_file",
    Write: "write_file",
    Edit: "edit",
    MultiEdit: "edit",
    Bash: "run_shell_command",
    Grep: "grep_search",
    Glob: "glob",
    LS: "list_directory",
    WebFetch: "web_fetch",
    WebSearch: "web_search",
    TodoWrite: "todo_write",
    NotebookEdit: "notebook_edit",
    Task: "agent",
  };
  const out = [];
  for (const raw of tools.split(",")) {
    const t = raw.replace(/^[\s\u0009\u000a\u000d\u000b\u000c]+|[\s\u0009\u000a\u000d\u000b\u000c]+$/g, "");
    if (t === "") continue;
    const q = map[t] ?? t;
    if (!out.includes(q)) out.push(q);
  }
  return out.join(", ");
}

/** Match `scripts/lib.sh#slugify`. */
export function slugify(value) {
  let out = "";
  let previousDash = false;
  for (const ch of value.toLowerCase()) {
    const c = ch.codePointAt(0);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      out += ch;
      previousDash = false;
    } else if (out !== "" && !previousDash) {
      out += "-";
      previousDash = true;
    }
  }
  while (out.endsWith("-")) out = out.slice(0, -1);
  return out;
}

/** Filename stem emitted by `convert.sh`. Identity tools preserve the source
 *  filename; transform tools derive it from frontmatter `name`. */
export function outputSlug(agent, rawSource, tool) {
  const meta = getTool(tool);
  if (meta?.slugFrom === "source") return agent.slug;
  const prefix = meta?.slugPrefix ?? "";
  return `${prefix}${slugify(sourceField(rawSource, "name"))}`;
}

function unsupported(tool) {
  const kebab = getTool(tool)?.kebab ?? tool;
  return new (class extends Error {
    constructor() {
      super(`tool '${kebab}' is not supported for install yet (multi-file format)`);
      this.payload = { code: "io", message: this.message };
    }
  })();
}

/**
 * Render the file content for `tool` from `agent` (+ the raw corpus `.md`
 * source, used verbatim by identity tools). Deterministic.
 */
export function render(agent, rawSource, tool) {
  const name = sourceField(rawSource, "name");
  const description = sourceField(rawSource, "description");
  const body = sourceBody(rawSource);
  const slug = slugify(name);
  const format = getTool(tool)?.format;

  switch (format) {
    // Identity — ship the corpus `.md` exactly as authored.
    case "identity":
      return rawSource;

    // Cursor `.mdc`: description + globs + alwaysApply frontmatter.
    case "cursor-mdc":
      return `---\ndescription: ${yamlQuote(description)}\nglobs: ""\nalwaysApply: false\n---\n${body}\n`;

    // Codex TOML: minimal required fields, control chars escaped.
    case "codex-toml":
      return `name = "${tomlEscape(name)}"\ndescription = "${tomlEscape(description)}"\ndeveloper_instructions = "${tomlEscape(body)}"\n`;

    // Gemini CLI subagent `.md`: name(=slug) + description frontmatter.
    case "gemini-md":
      return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;

    // Qwen Code SubAgent `.md`: the optional tool list is renamed to Qwen's
    // own tool names (see `qwenTools`).
    case "qwen-md": {
      const tools = qwenTools(sourceField(rawSource, "tools"));
      if (tools === "") {
        return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
      }
      return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\ntools: ${yamlQuote(tools)}\n---\n${body}\n`;
    }

    // ZCode subagent `.md`: optional `tools` list kept as written.
    case "zcode-md": {
      const tools = sourceField(rawSource, "tools");
      if (tools === "") {
        return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
      }
      return `---\nname: ${yamlQuote(slug)}\ndescription: ${yamlQuote(description)}\ntools: ${yamlQuote(tools)}\n---\n${body}\n`;
    }

    // Agent-Skills `SKILL.md`: name (namespaced) + description frontmatter.
    case "skill-md": {
      const prefix = getTool(tool)?.slugPrefix ?? "";
      return `---\nname: ${yamlQuote(prefix + slug)}\ndescription: ${yamlQuote(description)}\n---\n${body}\n`;
    }

    // OpenCode `.md`: name + description + mode + hex color frontmatter.
    case "opencode-md":
      return `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(description)}\nmode: subagent\ncolor: '${resolveOpencodeColor(sourceField(rawSource, "color"))}'\n---\n${body}\n`;

    // No format (recognized-only) or an unknown renderer ⇒ not installable.
    default:
      throw unsupported(tool);
  }
}

/** Render + hash in one shot. */
export function renderWithHash(agent, rawSource, tool) {
  const bytes = render(agent, rawSource, tool);
  return [bytes, sha256Hex(Buffer.from(bytes, "utf8"))];
}

/**
 * Absolute destination path(s) for an installed agent. Most tools write a
 * single file; Copilot dual-writes to `~/.github` and `~/.copilot`.
 */
export function dests(tool, slug, homeDir, projectRoot) {
  const dest = getTool(tool)?.dest;
  if (!dest) throw unsupported(tool);

  const [templates, root] = projectRoot
    ? [dest.project ?? [], projectRoot]
    : [dest.user ?? [], homeDir];

  if (templates.length === 0) {
    const kebab = getTool(tool)?.kebab ?? tool;
    throw new (class extends Error {
      constructor() {
        super(`tool '${kebab}' is project-scoped; a project path is required`);
        this.payload = { code: "io", message: this.message };
      }
    })();
  }

  return templates.map((t) => path.join(root, t.replaceAll("{slug}", slug)));
}

/**
 * Map an agency-agents `color` (named or hex) to an OpenCode-safe `#RRGGBB`
 * (uppercase). Unknown → neutral gray.
 */
function resolveOpencodeColor(color) {
  const c = color.trim().toLowerCase();
  const map = {
    cyan: "#00FFFF",
    blue: "#3498DB",
    green: "#2ECC71",
    red: "#E74C3C",
    purple: "#9B59B6",
    orange: "#F39C12",
    teal: "#008080",
    indigo: "#6366F1",
    pink: "#E84393",
    gold: "#EAB308",
    amber: "#F59E0B",
    "neon-green": "#10B981",
    "neon-cyan": "#06B6D4",
    "metallic-blue": "#3B82F6",
    yellow: "#EAB308",
    violet: "#8B5CF6",
    rose: "#F43F5E",
    lime: "#84CC16",
    gray: "#6B7280",
    fuchsia: "#D946EF",
    slate: "#64748B",
    navy: "#000080",
  };
  const mapped = map[c] ?? c;
  const hex = mapped.startsWith("#") ? mapped.slice(1) : mapped;
  const isHex6 = hex.length === 6 && /^[0-9a-fA-F]{6}$/.test(hex);
  return isHex6 ? `#${hex.toUpperCase()}` : "#6B7280";
}

/** Escape a value for a TOML basic string. */
function tomlEscape(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c < 0x20 || c === 0x7f) {
      out += "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    } else out += ch;
  }
  return out;
}
