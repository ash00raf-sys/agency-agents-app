# WhatsApp Catalogue Bot — orders inside the chat (official Cloud API)

The product your client dreams of: they promote their **WhatsApp number**
(status, board, visiting card). A customer messages it — "hi" or anything —
and the bot replies with the **full catalogue as tappable lists inside
WhatsApp**. Customer taps items, sees the total, confirms. Order done.
No website, no app, no QR needed.

```
customer: hi
bot:      🌿 Green Leaf Nursery — [View catalogue]
             Indoor Plants / Flowering / Kitchen Garden / Pots & Care
customer: taps Indoor Plants → taps Snake Plant ₹120
bot:      ✅ Snake Plant added. Total ₹120   [➕ Add more] [✅ Confirm] [🗑 Clear]
customer: [✅ Confirm] → [✅ Place order]
bot:      🎉 Order placed! We'll confirm availability here.  → owner notified
```

**100% policy-friendly** — this is Meta's own WhatsApp Business Platform.
Replies within the customer's 24-hour window are *service messages*:
1,000 free per number per month, ₹0.115 each after that (India, Oct 2026).
Never run unofficial bots (whatsapp-web.js) on a client's number — bans
are real.

## Files

    server.mjs      the whole bot — zero dependencies, plain Node 18+
    orders.jsonl    orders land here (created on first order)

The catalogue is the `SHOP` config at the top of `server.mjs` — same
shape as the ordering kits, so the Frontend Developer agent customizes
a client's bot in one chat prompt.

## The owner's side

- Every order is **logged** to `orders.jsonl`
- Live view: `GET /orders?token=ADMIN_TOKEN` (open in any browser)
- Optional instant notification: a pre-approved **utility template**
  message to the owner's personal number (`OWNER_NUMBER` env)

## Setup — free test drive first (~20 minutes, ₹0)

**You can demo this bot TODAY with Meta's free test number** before any
client pays anything. Dev mode allows sending to up to 5 verified numbers
(yours, a friend's, the shop owner's).

1. **Meta developer account** → [developers.facebook.com](https://developers.facebook.com) →
   Create app → type **Business** → add the **WhatsApp** product
2. On the **WhatsApp → API Setup** page you get a **free test number**,
   a temporary token, and the **Phone number ID** — that's `WA_TOKEN`
   and `WA_PHONE_ID`
3. Under *To* → **Manage phone number list** → add your own number +
   the verify code
4. **Host the webhook** (Meta needs public HTTPS — a phone won't do):
   - Quick demos: [render.com](https://render.com) free tier (or Railway) —
     `git push` deploy, env vars in the dashboard
   - Set `VERIFY_TOKEN` to any string
5. In the app dashboard → **WhatsApp → Configuration**:
   - Callback URL: `https://your-host/webhook`
   - Verify token: your `VERIFY_TOKEN` → *Verify* (the server answers
     the handshake)
6. Message the test number on WhatsApp: say "hi" → the catalogue appears 🌿

## Going live for a real client

- Register the client's business (Meta Business Manager) and their number
- ⚠ **Number exclusivity:** a number can be on the WhatsApp Business
  *app* **or** the Cloud API — not both. Migrating their existing number
  moves it off the app; some shops prefer a second SIM for the bot
- Create the `new_order` **utility template** in the dashboard
  (body like: `New order: {{1}} — total {{2}}`) → approved in minutes
- Permanent token via a System User (dashboard guides this)
- Host on a ₹300–500/mo VPS or keep free tier (first message after
  sleep takes ~30s to wake)

## Running locally (no Meta account needed)

```bash
WA_FAKE=1 node server.mjs
# webhook: http://localhost:8080/webhook — sends print to console instead of Meta
```

Test the flow with curl:

```bash
# 1. customer says hi → catalogue list prints
curl -s -X POST localhost:8080/webhook -H 'content-type: application/json' -d '{
  "entry":[{"changes":[{"value":{
    "contacts":[{"profile":{"name":"Ashraf"}}],
    "messages":[{"from":"919999000001","type":"text","text":{"body":"hi"}}]
  }}]}]}'
```

## Customizing per client (the agency magic)

Chat → **Frontend Developer** → attach this project →

> Change the SHOP config in server.mjs for "Krishna Nursery, Karamana":
> categories and items with prices [paste their stock]. Keep the flow.

## Pricing you can charge

- Setup: **₹25,000–50,000** (Meta business registration, number setup,
  catalogue, template, hosting, testing)
- Monthly: **₹3,000–5,000** (hosting + stock updates + Meta fees
  pass-through; actual Meta cost for a small shop is typically ₹0–200)
