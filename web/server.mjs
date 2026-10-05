#!/usr/bin/env node
/**
 * Agency Agents — web server for browser + Termux use.
 *
 * Serves the prebuilt SvelteKit SPA (`build/`, produced by `npm run build`)
 * plus `POST /api/invoke`, a faithful HTTP bridge to the app's backend
 * command surface (see `web/lib/commands.mjs`). Zero npm dependencies —
 * plain Node 18+ — so it runs anywhere Termux can run Node.
 *
 * Usage:
 *   npm run build         # one-time (or after pulling changes)
 *   node web/server.mjs   # → http://localhost:8787
 *
 * Options (env or flags):
 *   PORT=8787   / --port 8787    listen port
 *   HOST=0.0.0.0 / --host 0.0.0.0 listen host (0.0.0.0 = reachable on LAN)
 *   AGENCY_DATA_DIR=/path       override the app data dir
 *
 * On your phone (Termux):
 *   pkg install nodejs git
 *   git clone https://github.com/msitarzewski/agency-agents-app && cd agency-agents-app
 *   npm install && npm run build
 *   node web/server.mjs
 *   → open http://localhost:8787 in your phone's browser
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDir } from "./lib/repo.mjs";
import { dispatch } from "./lib/commands.mjs";
import { appDataDir, err } from "./lib/util.mjs";
import { chatStream } from "./lib/chat.mjs";

// ---------- CLI ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port" && argv[i + 1]) out.port = argv[++i];
    else if (arg === "--host" && argv[i + 1]) out.host = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg.startsWith("--")) {
      const [k, v] = arg.replace(/^--/, "").split("=");
      out[k] = v ?? true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log("usage: node web/server.mjs [--port 8787] [--host 0.0.0.0]");
  process.exit(0);
}

const PORT = parseInt(String(args.port ?? process.env.PORT ?? "8787"), 10);
const HOST = String(args.host ?? process.env.HOST ?? "0.0.0.0");
const ADIR = process.env.AGENCY_DATA_DIR
  ? path.resolve(process.env.AGENCY_DATA_DIR)
  : appDataDir();

// ---------- Static file serving (SPA) ----------

const BUILD = buildDir();
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const resolved = path.resolve(root, `.${decoded}`);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

function serveStatic(req, res) {
  if (!fs.existsSync(BUILD)) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "Agency Agents: no build/ directory found. Run `npm run build` first, then start the server.",
    );
    return true;
  }
  let file = safeJoin(BUILD, req.url);
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    file = path.join(file, "index.html");
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback (adapter-static single-page-app mode).
    file = path.join(BUILD, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Agency Agents: build/index.html missing — run `npm run build`.");
      return true;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const cacheable = req.url.startsWith("/_app/") || req.url.startsWith("/favicon");
  res.writeHead(200, {
    "content-type": type,
    "cache-control": cacheable ? "public, max-age=3600" : "no-cache",
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------- Invoke bridge ----------

async function readBody(req, cap = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > cap) throw err.invalidArgument("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleInvoke(req, res) {
  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body.toString("utf8") || "{}");
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "invalid_argument", message: `bad request: ${e.message}` }));
    return;
  }
  const cmd = String(payload?.cmd ?? "");
  const cmdArgs = payload?.args ?? {};
  const started = Date.now();
  try {
    const result = await dispatch(ADIR, cmd, cmdArgs);
    if (!res.writableEnded) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result ?? null));
    }
    console.log(`[invoke] ${cmd} ok (${Date.now() - started}ms)`);
  } catch (e) {
    const errorPayload = e?.payload ?? { code: "internal", message: String(e?.message ?? e) };
    if (!res.writableEnded) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify(errorPayload));
    }
    console.warn(`[invoke] ${cmd} error: ${JSON.stringify(errorPayload)}`);
  }
}

// ---------- Server ----------

/**
 * POST /api/chat — streaming agent chat over OpenRouter.
 * Body: { model?, system, messages: [{role, content}] }.
 * Response: SSE — `data: {"type":"delta","text":"…"}` chunks, then
 * `data: {"type":"done","usage":{…}}`, or `data: {"type":"error",…}`.
 * The key never crosses this boundary; only the server holds it.
 */
async function handleChatStream(req, res) {
  let payload;
  try {
    const body = await readBody(req, 2 * 1024 * 1024);
    payload = JSON.parse(body.toString("utf8") || "{}");
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "invalid_argument", message: `bad request: ${e.message}` }));
    return;
  }
  const system = String(payload?.system ?? "");
  const model = payload?.model ? String(payload.model) : null;
  const messages = Array.isArray(payload?.messages)
    ? payload.messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-40)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 100_000) }))
    : [];
  if (!system || messages.length === 0) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "invalid_argument", message: "system and messages are required" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    for await (const part of chatStream(ADIR, { model, system, messages })) {
      send(part);
    }
  } catch (e) {
    send({ type: "error", message: String(e?.payload?.message ?? e?.message ?? e).slice(0, 300) });
    console.log("[chat] stream error:", e?.payload?.message ?? e?.message ?? e);
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  try {
    if (req.method === "POST" && (url === "/api/invoke" || url === "/api/invoke/")) {
      handleInvoke(req, res);
      return;
    }
    if (req.method === "POST" && (url === "/api/chat" || url === "/api/chat/")) {
      handleChatStream(req, res);
      return;
    }
    if (req.method === "GET" && (url === "/api/health" || url === "/api/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.3.2", dataDir: ADIR }));
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "invalid_argument", message: "method not allowed" }));
  } catch (e) {
    console.error("[server] unhandled:", e);
    if (!res.writableEnded) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "internal", message: "unhandled server error" }));
    }
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log("");
  console.log("  Agency Agents (web)");
  console.log(`  →  http://${shownHost}:${PORT}`);
  console.log(`  data dir: ${ADIR}`);
  if (HOST === "0.0.0.0") {
    console.log("  (listening on all interfaces — reachable from other devices on your LAN/Wi-Fi)");
  }
  console.log("");
});
