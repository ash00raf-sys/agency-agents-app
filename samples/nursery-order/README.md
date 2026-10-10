# Nursery Ordering Kit — WhatsApp orders for a plant nursery

The WhatsApp ordering system, themed for plant nurseries (green edition
of `samples/whatsapp-order`). Customers browse plants → cart → the order
lands in the nursery's WhatsApp with the total — and the owner confirms
live-stock availability on chat, which is exactly how plant sales work.

Demo shop: **Green Leaf Nursery** — indoor plants, jasmine & hibiscus,
kitchen-garden saplings, pots and potting mix, with realistic Kerala
prices.

## Why nurseries are a great first client

- **Stock changes weekly** (what's blooming, what's potted) — a printed
  catalogue is dead on arrival, but "we update your menu in minutes"
  is a real, chargeable service (the maintenance retainer writes itself)
- **Seasonal spikes** — Vishu kani plants, Onam flowers, monsoon
  planting season, Christmas stars/poinsettias: each season is a
  natural "update + promote" touchpoint you get paid for
- **Buyers browse before visiting** — "do you have snake plant?" is the
  most common nursery WhatsApp message; this turns it into an order
- **Gift market** — jade "lucky plant", flowering pots: the catalogue
  doubles as a gift menu customers forward to friends

## The demo that closes (at the nursery, from your phone)

1. Register this folder in Agency Agents → **Open preview**
2. Put THEIR number in the config (see below), add a few plants
3. Place a real order — let the owner's WhatsApp ring with a tidy,
   totaled order
4. Show the QR idea: scan at the counter → browse → order while walking
   the rows

## Customize for the real client (one chat prompt)

Chat → **Frontend Developer** → 📁 attach this project →

> Change the SHOP config in index.html for "Krishna Nursery,
> Karamana", WhatsApp +91 94xxxxxx00, hours "8:00–18:30, Monday off".
> Categories: Indoor Plants (their stock + prices), Flowering, Fruit
> Saplings, Pots & Fertilizer. Keep the design.

Apply → preview → done. Then add real touches:

> Add a "Care tips" section at the bottom with one-line watering
> advice for the top 5 plants.

> Add a "Gift wrap +₹20" option in checkout that appears in the
> WhatsApp message.

## Pricing for a nursery client

- ₹8,000–12,000 setup (catalogue with their stock, photos if they send
  them, deploy, counter QR)
- ₹1,500–2,500/month maintenance — seasonal stock updates are the
  recurring hook
- Upsell later: the in-WhatsApp bot (WhatsApp Cloud API) for auto-menu
  replies when they're tired of answering "what plants do you have?"

## Live-stock honesty (tell them upfront)

Plants aren't a fixed catalogue like a restaurant menu — availability
changes daily. The flow handles this naturally: the order arrives on
WhatsApp, the owner replies "snake plant yes, areca palm next week,
ok?" — the conversation IS the stock confirmation. That's a feature,
not a bug, and it's why this beats any "shopify for plants".

Deploy free (static site): Netlify Drop / Vercel / GitHub Pages —
see `samples/whatsapp-order/README.md` for the full playbook.
