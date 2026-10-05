/**
 * Agent chat — talk to any catalog agent through OpenRouter.
 *
 * The agent's rendered `.md` (frontmatter + body) becomes the system prompt.
 * The OpenRouter key is entered once in the app (web-only state file, never
 * settings.json, never returned to the browser — masked status only). Usage
 * (tokens + cost per response) is appended to `state/chat-usage.jsonl`.
 *
 * `OPENROUTER_BASE_URL` env overrides the API base — same hook stationd
 * uses, so proxies/tests can point it anywhere.
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "./util.mjs";

const OR_BASE = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const KEY_FILE = "openrouter.json";
const USAGE_FILE = "chat-usage.jsonl";
const MODELS_CACHE = "chat-models.json";
const MODELS_TTL_MS = 60 * 60 * 1000;

/** Fallback list when the live OpenRouter catalog can't be fetched
 *  (offline, or a network-filtered environment). Curated small models. */
const FALLBACK_MODELS = [
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini" },
  { id: "anthropic/claude-3.5-haiku", name: "Claude 3.5 Haiku" },
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  { id: "qwen/qwen-2.5-72b-instruct", name: "Qwen 2.5 72B" },
];

function keyFile(adir) {
  return path.join(stateDir(adir), KEY_FILE);
}

function mask(key) {
  if (!key) return null;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** `chat_key_get` — status only; the raw key never leaves the host. */
export async function chatKeyGet(adir) {
  try {
    const raw = await fsp.readFile(keyFile(adir), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.key === "string" && parsed.key.length > 8) {
      return { configured: true, masked: mask(parsed.key), model: parsed.model ?? null, base: OR_BASE };
    }
  } catch {
    /* absent */
  }
  return { configured: false, masked: null, model: null, base: OR_BASE };
}

/** `chat_key_set` — store (or clear with "") the OpenRouter key + default model. */
export async function chatKeySet(adir, key, model = null) {
  const sdir = stateDir(adir);
  await fsp.mkdir(sdir, { recursive: true });
  const clean = String(key ?? "").trim();
  const prev = await chatKeyGet(adir).catch(() => ({ model: null }));
  if (clean === "") {
    await fsp.writeFile(keyFile(adir), JSON.stringify({ key: "", model: model ?? null }, null, 2), { mode: 0o600 });
    return { configured: false, masked: null, model: model ?? null };
  }
  if (clean.length < 8) {
    throw Object.assign(new Error("key too short"), {
      payload: { code: "invalid_argument", message: "that doesn't look like an OpenRouter key" },
    });
  }
  const nextModel = model ?? prev.model ?? null;
  await fsp.writeFile(keyFile(adir), JSON.stringify({ key: clean, model: nextModel }, null, 2), { mode: 0o600 });
  return { configured: true, masked: mask(clean), model: nextModel };
}

/** `chat_key_model` — set only the default model (key untouched). */
export async function chatKeySetModel(adir, model) {
  const parsed = await fsp.readFile(keyFile(adir), "utf8").then(JSON.parse).catch(() => null);
  if (!parsed?.key) {
    throw Object.assign(new Error("no key"), {
      payload: { code: "invalid_argument", message: "save your OpenRouter key first" },
    });
  }
  const next = { key: parsed.key, model: model ?? null };
  await fsp.writeFile(keyFile(adir), JSON.stringify(next, null, 2), { mode: 0o600 });
  return { configured: true, masked: mask(parsed.key), model: next.model };
}

async function readKey(adir) {
  try {
    const parsed = await fsp.readFile(keyFile(adir), "utf8").then(JSON.parse);
    if (typeof parsed?.key === "string" && parsed.key.length > 8) {
      return { key: parsed.key, model: parsed.model ?? null };
    }
  } catch {
    /* absent */
  }
  return null;
}

/** `chat_models` — OpenRouter catalog (1h cache), fallback list offline. */
export async function chatModels(adir) {
  const cacheFile = path.join(stateDir(adir), MODELS_CACHE);
  try {
    const stat = await fsp.stat(cacheFile);
    if (Date.now() - stat.mtimeMs < MODELS_TTL_MS) {
      const cached = JSON.parse(await fsp.readFile(cacheFile, "utf8"));
      return { source: "cache", models: cached };
    }
  } catch {
    /* no cache */
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(`${OR_BASE}/models`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`models → HTTP ${res.status}`);
    const json = await res.json();
    const models = (json.data ?? [])
      .map((m) => ({ id: m.id, name: m.name ?? m.id }))
      .slice(0, 200);
    if (models.length > 0) {
      await fsp.mkdir(stateDir(adir), { recursive: true }).catch(() => {});
      await fsp.writeFile(cacheFile, JSON.stringify(models)).catch(() => {});
      return { source: "live", models };
    }
    throw new Error("empty catalog");
  } catch {
    return { source: "fallback", models: FALLBACK_MODELS };
  } finally {
    clearTimeout(timer);
  }
}

/** Append one usage record (one assistant response). Never throws. */
async function logUsage(adir, rec) {
  try {
    const sdir = stateDir(adir);
    await fsp.mkdir(sdir, { recursive: true });
    await fsp.appendFile(path.join(sdir, USAGE_FILE), `${JSON.stringify(rec)}\n`);
  } catch {
    /* usage logging is best-effort */
  }
}

/** `chat_usage` — totals from the usage journal. */
export async function chatUsage(adir) {
  const file = path.join(stateDir(adir), USAGE_FILE);
  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let lastAt = null;
  try {
    const raw = await fsp.readFile(file, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        requests += 1;
        promptTokens += r.promptTokens ?? 0;
        completionTokens += r.completionTokens ?? 0;
        costUsd += r.costUsd ?? 0;
        if (r.at && (!lastAt || r.at > lastAt)) lastAt = r.at;
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    /* no journal yet */
  }
  return { requests, promptTokens, completionTokens, costUsd: round2(costUsd), lastAt };
}

function round2(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * Chat completion (non-streaming) — used by the fallback path and tests.
 * Returns { content, usage }.
 */
export async function chatComplete(adir, { model, system, messages }) {
  const cred = await readKey(adir);
  if (!cred) {
    throw Object.assign(new Error("no key"), {
      payload: { code: "invalid_argument", message: "add your OpenRouter key first (Chat view → setup)" },
    });
  }
  const body = {
    model: model || cred.model || FALLBACK_MODELS[0].id,
    messages: [{ role: "system", content: system }, ...messages],
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cred.key}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`openrouter ${res.status}`), {
        payload: { code: "io", message: `OpenRouter error ${res.status}: ${text.slice(0, 200)}` },
      });
    }
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? "";
    const u = json.usage ?? {};
    const rec = {
      at: new Date().toISOString(),
      model: body.model,
      promptTokens: u.prompt_tokens ?? 0,
      completionTokens: u.completion_tokens ?? 0,
      costUsd: typeof u.cost === "number" ? u.cost : 0,
    };
    await logUsage(adir, rec);
    return { content, usage: rec, model: body.model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Streaming chat — yields text deltas over OpenRouter's SSE stream.
 * The caller (server.mjs) re-emits them to the browser as SSE. The final
 * usage record is logged when OpenRouter sends it (`stream_options`).
 */
export async function* chatStream(adir, { model, system, messages }) {
  const cred = await readKey(adir);
  if (!cred) {
    throw Object.assign(new Error("no key"), {
      payload: { code: "invalid_argument", message: "add your OpenRouter key first (Chat view → setup)" },
    });
  }
  const body = {
    model: model || cred.model || FALLBACK_MODELS[0].id,
    messages: [{ role: "system", content: system }, ...messages],
    stream: true,
    stream_options: { include_usage: true },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  let usage = null;
  try {
    const res = await fetch(`${OR_BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cred.key}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw Object.assign(new Error(`openrouter ${res.status}`), {
        payload: { code: "io", message: `OpenRouter error ${res.status}: ${text.slice(0, 200)}` },
      });
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) yield { type: "delta", text: delta };
          if (json.usage) usage = json.usage;
          if (json.error) {
            throw Object.assign(new Error(json.error?.message ?? "stream error"), {
              payload: { code: "io", message: String(json.error?.message ?? "stream error").slice(0, 200) },
            });
          }
        } catch (e) {
          if (e?.payload) throw e;
          /* partial JSON — skip */
        }
      }
    }
    const rec = {
      at: new Date().toISOString(),
      model: body.model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      costUsd: typeof usage?.cost === "number" ? usage.cost : 0,
    };
    await logUsage(adir, rec);
    yield { type: "done", usage: rec, model: body.model };
  } finally {
    clearTimeout(timer);
  }
}
