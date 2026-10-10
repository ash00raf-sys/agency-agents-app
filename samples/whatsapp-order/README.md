# WhatsApp Ordering Kit — the sellable "WhatsApp bot" for local shops

A complete, zero-dependency ordering system that lands every order in the
shop's **WhatsApp as a tidy, formatted message** — no API costs, no Meta
business verification, no ban risk. This is the v1 that small shops
actually need and can afford; the paid Cloud-API upgrade is the natural
next sale when they outgrow it.

**Demo:** register this folder in Agency Agents → **Open preview** →
add items to the cart → *Order on WhatsApp*. Orders arrive pre-formatted:

```
New order — Malabar Kitchen

• 2 × Chicken Biryani — ₹280
• 1 × Lime Soda — ₹40

Total: ₹320

Name: Ashraf
Note: less spicy
```

## What's in it

    index.html    the whole system — menu, cart, checkout, WhatsApp handoff
    agents/       the Frontend Developer agent (re-skins per client)

Everything the client's version needs lives in the `SHOP` config at the
top of `index.html`: name, WhatsApp number, hours, menu, prices. One
chat prompt changes it all (below).

## The sales play

**The pitch (say it in Malayalam, sell the outcome):**
"Customers see your menu, tap twice, and the order arrives in your
WhatsApp — written properly, with the total calculated. No app to
install, no commission like Swiggy. Your shop, your orders."

**The demo that closes:** open the preview **from your phone, at their
shop**. Put their actual dishes in front of them (takes one chat prompt,
see below), place a live order to *your* number, and let the owner's
WhatsApp ring. That moment sells itself.

**Pricing (realistic Kerala market):**
- ₹8,000–15,000 setup (menu, branding, deploy, QR code sticker for the counter)
- ₹1,000–2,000/month maintenance (menu/price updates — which the agents
  do in minutes, so it's nearly pure margin)
- The QR code: print `wa.me/<number>` or the site URL as a table/counter
  QR — customers scan, order, done.

## The one-prompt customization (this is the agency magic)

Chat → **Frontend Developer** → 📁 attach this project → paste:

> Change the SHOP config in index.html for a new client:
> name "Ayisha Restaurant", WhatsApp +91 98xxxxxx00, hours
> "8:00–21:00", currency ₹. Menu: breakfast (puttu ₹25, kadala curry
> ₹35, appam+egg roast ₹55), lunch (meals ₹80, fish curry meals ₹110),
> drinks (chaya ₹10, lime soda ₹35). Keep the same design.

Apply → Build → the client's site is done. A full delivery in one
conversation.

## Deploying for a client (free)

The output is a **static site** — host it anywhere free:
- **Netlify Drop** (drag the folder at app.netlify.com/drop) — instant URL
- **Vercel / GitHub Pages** — same idea
- Buy a domain only if the client pays for it (₹800/yr)

Free hosting + WhatsApp handoff = **zero monthly cost** to you.

## Honest limits (tell the client before they find out)

- The shop **receives** orders in WhatsApp — it doesn't auto-reply or
  confirm. The owner replies like any WhatsApp message.
- No online payment (that's the Cloud-API/upi-upgrade conversation).
- When a shop wants auto-replies, confirmations, or payments — that's
  the **WhatsApp Cloud API** upgrade: a small always-on server, Meta
  business setup, per-conversation fees. Charge for it as a project.

## Why not a "real bot" from day one?

Unofficial bot libraries (whatsapp-web.js etc.) get numbers **banned** —
never risk a client's business number. The official Cloud API needs
verification and a public server before the first rupee. This kit wins
the deal today with zero risk, and upgrades cleanly later.
