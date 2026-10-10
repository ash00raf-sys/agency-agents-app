#!/usr/bin/env node
/**
 * WhatsApp Catalogue Bot — Level 1 (official Cloud API)
 * =====================================================
 * The product: the shop promotes its WhatsApp number; customers message
 * it ("hi" or anything); the bot replies with the catalogue as tappable
 * WhatsApp lists, builds a cart from taps, and places the order — all
 * inside the chat. No website, no app.
 *
 *   customer: "hi"
 *   bot:      catalogue list (categories)
 *   customer: taps "Indoor Plants" → list of plants → taps "Snake Plant"
 *   bot:      "✅ Snake Plant added — cart 1 item ₹120" [Add more] [Confirm]
 *   customer: [Confirm] → [Place order]
 *   bot:      confirmation to the customer + order to the OWNER
 *
 * Official & policy-friendly: this is Meta's own WhatsApp Business
 * Platform (Cloud API). Replies inside the customer's 24-hour window are
 * "service messages" — 1,000/month free per number, ₹0.115 each after
 * (India, Oct 2026). Unofficial libraries (whatsapp-web.js) risk bans —
 * never use them for a client's number.
 *
 * ── Setup (see README.md for the full guide) ──
 *   WA_TOKEN      permanent access token (Meta developer dashboard)
 *   WA_PHONE_ID   phone number id (not the number itself)
 *   VERIFY_TOKEN  any string; entered in the webhook config
 *   OWNER_NUMBER  orders are sent here (optional; also logged + /orders)
 *   ADMIN_TOKEN   token for GET /orders?token=…
 *   PORT          default 8080
 *   WA_FAKE=1     dry-run: print outgoing messages instead of calling Meta
 *
 * Zero dependencies — plain Node 18+ (global fetch). Not for hosting on a
 * phone: Meta must reach the webhook over public HTTPS (Render/Railway
 * free tier works; see README).
 */

import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";

// ─── Catalogue — same SHOP shape as the ordering kits ─────────────────────

const SHOP = {
  name: "Green Leaf Nursery",
  whatsapp: "919999999999", // informational only (the bot runs ON the number)
  hours: "8:30 – 19:00 daily",
  currency: "₹",
  menu: [
    { cat: "Indoor Plants", items: [
      { n: "Money Plant (Pothos)", p: 60, d: "low light, easy care" },
      { n: "Snake Plant", p: 120, d: "air-purifying, hardy" },
      { n: "Areca Palm", p: 150, d: "balcony favourite, 2ft" },
      { n: "Peace Lily", p: 180, d: "flowers in shade" },
      { n: "Jade Plant", p: 90, d: "lucky plant, gift-ready" },
    ]},
    { cat: "Flowering", items: [
      { n: "Jasmine (Jathi Mullu)", p: 80, d: "fragrant creeper" },
      { n: "Hibiscus (Chembarathi)", p: 50, d: "red/pink, free flowering" },
      { n: "Desi Rose", p: 60, d: "pot-grown, blooming size" },
    ]},
    { cat: "Kitchen Garden", items: [
      { n: "Curry Leaf Plant", p: 40, d: "kitchen essential" },
      { n: "Grafted Mango Sapling", p: 150, d: "fruits in 2-3 years" },
      { n: "Guava Sapling", p: 120, d: "grafted, potted" },
      { n: "Tomato Seedlings", p: 35, d: "pack of 5" },
      { n: "Chilli Seedlings", p: 30, d: "pack of 5, kanthari" },
    ]},
    { cat: "Pots & Care", items: [
      { n: "Terracotta Pot 8″", p: 70, d: "classic breathable pot" },
      { n: "Plastic Pot 10″", p: 60, d: "with drainage tray" },
      { n: "Potting Mix 5kg", p: 120, d: "ready to use" },
      { n: "Cocopeat Block", p: 90, d: "expands to ~5L" },
      { n: "Organic Fertilizer 1kg", p: 80, d: "cow dung + neem" },
    ]},
  ],
};

// ─── Config ────────────────────────────────────────────────────────────────

const {
  WA_TOKEN = "",
  WA_PHONE_ID = "",
  VERIFY_TOKEN = "change-me",
  OWNER_NUMBER = "",
  ADMIN_TOKEN = "",
  PORT = "8080",
  WA_FAKE = "",
  TEMPLATE_NEW_ORDER = "new_order", // pre-approved utility template name
} = process.env;

const API = `https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`;
const ORDERS_FILE = path.join(import.meta.dirname ?? ".", "orders.jsonl");

// WhatsApp limits: list rows ≤ 10 per message, 3 buttons, row title ≤ 24ch
// (all catalogue names above are ≤ 23 chars — validate at boot).
for (const g of SHOP.menu) {
  for (const it of g.items) {
    if (it.n.length > 24) throw new Error(`row title too long (>24): ${it.n}`);
  }
}

// ─── Carts (in-memory + best-effort persistence) ──────────────────────────

/** customerWaId → { [itemName]: qty } */
const carts = new Map();

function cartView(cart) {
  const entries = Object.entries(cart);
  const lines = entries.map(([n, q]) => `${q} × ${n} — ${SHOP.currency}${q * priceOf(n)}`);
  const total = entries.reduce((s, [n, q]) => s + q * priceOf(n), 0);
  const count = entries.reduce((s, [, q]) => s + q, 0);
  return { lines, total, count, empty: entries.length === 0 };
}

function priceOf(name) {
  for (const g of SHOP.menu) for (const it of g.items) if (it.n === name) return it.p;
  return 0;
}

async function logOrder(waId, name, cart) {
  const view = cartView(cart);
  const rec = {
    ts: new Date().toISOString(),
    from: waId,
    customerName: name ?? null,
    items: Object.entries(cart).map(([n, q]) => ({ n, q, p: priceOf(n) })),
    total: view.total,
  };
  try {
    await fsp.appendFile(ORDERS_FILE, JSON.stringify(rec) + "\n");
  } catch { /* logging is best-effort */ }
  return rec;
}

// ─── Sending (Cloud API) ───────────────────────────────────────────────────

async function send(payload) {
  if (WA_FAKE) {
    console.log("[dry-run] →", JSON.stringify(payload.interactive ?? { text: payload.text }));
    return;
  }
  if (!WA_TOKEN || !WA_PHONE_ID) throw new Error("WA_TOKEN / WA_PHONE_ID not set");
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${WA_TOKEN}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`graph api ${res.status}: ${body.slice(0, 300)}`);
  }
}

const toText = (to, text) => send({ messaging_product: "whatsapp", to, type: "text", text: { body: text } });

/** A tappable list. rows: [{id, title, description}] */
function toList(to, header, body, footer, button, rows) {
  return send({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: header },
      body: { text: body },
      footer: { text: footer },
      action: { button, sections: [{ title: " ", rows }] },
    },
  });
}

/** Up to 3 tappable reply buttons. buttons: [{id, title}] */
function toButtons(to, body, footer, buttons) {
  if (buttons.length > 3) throw new Error("max 3 buttons");
  return send({
    messaging_product: "whatsapp", to, type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      footer: { text: footer },
      action: { buttons: buttons.map((b) => ({ type: "reply", reply: b })) },
    },
  });
}

/** Owner notification via a pre-approved utility template. */
function toOwnerTemplate(order) {
  if (!OWNER_NUMBER) return Promise.resolve();
  return send({
    messaging_product: "whatsapp", to: OWNER_NUMBER, type: "template",
    template: {
      name: TEMPLATE_NEW_ORDER,
      language: { code: "en" },
      components: [{
        type: "body",
        parameters: [
          { type: "text", text: order.items.map((i) => `${i.q}×${i.n}`).join(", ").slice(0, 300) },
          { type: "text", text: `${SHOP.currency}${order.total}` },
        ],
      }],
    },
  });
}

// ─── The conversation ──────────────────────────────────────────────────────

function menuList(to) {
  const rows = SHOP.menu.map((g, i) => ({
    id: `cat:${i}`,
    title: g.cat,
    description: g.items.map((it) => it.n.split(" (")[0]).slice(0, 3).join(", ") + "…",
  }));
  return toList(
    to,
    SHOP.name,
    `Welcome to ${SHOP.name}! 🌿\nPick a category to see plants & prices. Orders arrive here in chat.\n\n${SHOP.hours}`,
    "Live stock — we confirm availability on chat",
    "View catalogue",
    rows,
  );
}

function itemsList(to, catIndex) {
  const g = SHOP.menu[catIndex];
  if (!g) return menuList(to);
  const rows = g.items.map((it) => ({
    id: `item:${it.n}`,
    title: it.n,
    description: `${SHOP.currency}${it.p} · ${it.d}`,
  }));
  return toList(to, g.cat, "Tap an item to add it to your order:", SHOP.name, `Add from ${g.cat}`, rows);
}

function cartButtons(to, lastAdded) {
  const cart = carts.get(to) ?? {};
  const v = cartView(cart);
  return toButtons(
    to,
    `✅ ${lastAdded} added.\n\nYour order: ${v.count} item${v.count === 1 ? "" : "s"} · ${v.lines.join("\n")}\n\n*Total: ${SHOP.currency}${v.total}*`,
    "Live stock — availability confirmed on chat",
    [
      { id: "act:more", title: "➕ Add more" },
      { id: "act:confirm", title: "✅ Confirm order" },
      { id: "act:clear", title: "🗑 Clear cart" },
    ],
  );
}

function confirmStep(to) {
  const cart = carts.get(to) ?? {};
  const v = cartView(cart);
  if (v.empty) return toText(to, "Your cart is empty — send anything for the catalogue 🌿");
  return toButtons(
    to,
    `Place this order?\n\n${v.lines.join("\n")}\n\n*Total: ${SHOP.currency}${v.total}*\n\nWe'll confirm availability and delivery here in chat.`,
    SHOP.name,
    [
      { id: "act:place", title: "✅ Place order" },
      { id: "act:more", title: "➕ Add more" },
      { id: "act:clear", title: "🗑 Clear cart" },
    ],
  );
}

async function handleMessage(waId, name, msg) {
  // Interactive replies (list/button taps) carry the action.
  const listId = msg?.interactive?.list_reply?.id;
  const buttonId = msg?.interactive?.button_reply?.id;
  const text = typeof msg?.text?.body === "string" ? msg.text.body.trim() : "";

  if (listId?.startsWith("cat:")) {
    return itemsList(waId, Number(listId.slice(4)));
  }
  if (listId?.startsWith("item:")) {
    const item = decodeURIComponent(listId.slice(5));
    if (priceOf(item) === 0) return menuList(waId); // stale/unknown item
    const cart = carts.get(waId) ?? {};
    cart[item] = Math.min(99, (cart[item] ?? 0) + 1);
    carts.set(waId, cart);
    return cartButtons(waId, item);
  }
  if (buttonId === "act:more") return menuList(waId);
  if (buttonId === "act:confirm") return confirmStep(waId);
  if (buttonId === "act:clear") {
    carts.delete(waId);
    return menuList(waId);
  }
  if (buttonId === "act:place") {
    const cart = carts.get(waId) ?? {};
    if (cartView(cart).empty) return menuList(waId);
    const order = await logOrder(waId, name, cart);
    carts.delete(waId);
    await toOwnerTemplate(order).catch((e) => console.error("[owner] template send failed:", e.message));
    const v = cartView(cart);
    return toText(
      waId,
      `🎉 Order placed!\n\n${v.lines.join("\n")}\n\n*Total: ${SHOP.currency}${v.total}*\n\nWe'll message you here to confirm availability and delivery. Thank you! 🌿`,
    );
  }

  // Any plain text → catalogue (the "customer just says hi" moment).
  if (text) return menuList(waId);
}

// ─── Webhook server ────────────────────────────────────────────────────────

async function readBody(req, cap = 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > cap) throw new Error("body too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Meta webhook verification handshake.
  if (req.method === "GET" && url.pathname === "/webhook") {
    if (url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(url.searchParams.get("hub.challenge") ?? "");
    } else {
      res.writeHead(403).end("forbidden");
    }
    return;
  }

  // Incoming messages/events from Meta.
  if (req.method === "POST" && url.pathname === "/webhook") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    } catch {
      res.writeHead(400).end("bad request");
      return;
    }
    res.writeHead(200).end("ok"); // ack fast; process after
    const entries = payload?.entry ?? [];
    for (const entry of entries) {
      for (const change of entry?.changes ?? []) {
        const msgs = change?.value?.messages ?? [];
        for (const m of msgs) {
          const waId = m.from;
          const name = change?.value?.contacts?.[0]?.profile?.name ?? null;
          try {
            await handleMessage(waId, name, m);
          } catch (e) {
            console.error("[bot] handle failed:", e.message);
            await toText(waId, "Sorry, something went wrong — please send 'hi' again 🙏").catch(() => {});
          }
        }
      }
    }
    return;
  }

  // Orders list for the owner (token-protected).
  if (req.method === "GET" && url.pathname === "/orders") {
    if (!ADMIN_TOKEN || url.searchParams.get("token") !== ADMIN_TOKEN) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const raw = (await fsp.readFile(ORDERS_FILE)).toString("utf8");
      const orders = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(orders.slice(-100), null, 2));
    } catch {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(`${SHOP.name} — WhatsApp catalogue bot is running.\nWebhook: POST /webhook · Orders: GET /orders?token=…\n`);
    return;
  }

  res.writeHead(404).end("not found");
});

server.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`  ${SHOP.name} — WhatsApp catalogue bot`);
  console.log(`  webhook : http://localhost:${PORT}/webhook`);
  console.log(`  mode    : ${WA_FAKE ? "DRY-RUN (no real sends)" : "live (Cloud API)"}`);
  if (!WA_TOKEN && !WA_FAKE) console.log("  ⚠ set WA_TOKEN + WA_PHONE_ID (or WA_FAKE=1 to test locally)");
});
