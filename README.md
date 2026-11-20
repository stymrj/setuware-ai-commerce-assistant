# Setuware AI Commerce Assistant

Chat UI on the **live Swiggy MCP servers** (Food + Dineout) — built for the
Swiggy Builders Club application. No mock data anywhere: every restaurant,
dish, price, slot and cart total comes from `mcp.swiggy.com`.

## What it does

- **Chat surface** — ask for food (`biryani near me`) or a table
  (`book a table for 2 tonight`).
- **Visible tool-call log** — every real MCP call, with server, tool name,
  arguments, timing and result summary, in a panel next to the chat.
  This is what Swiggy asked to see in the demo.
- **Discovery** — `search_restaurants` + `search_menu` on the live Food
  server; restaurant menu via `get_restaurant_menu`.
- **Cart, confirmation-gated** — tapping "Add to cart" shows a summary and
  only calls `update_food_cart` after you tap Confirm; the cart is then
  re-read with `get_food_cart` and shown. The ₹1000 Builders Club cap is
  checked and warned about.
- **Table booking, confirmation-gated** — `search_restaurants_dineout` →
  `get_available_slots` → `book_table` (free deals book directly; paid
  prebook deals go `create_cart` → UPI QR → `book_table`, and confirm only
  after you pay in your UPI app).
- **Deliberately NOT included:** `place_food_order` is not wired up at all.
  The demo stops at the confirmed cart — no order is ever placed, no money
  moves from this app.

## Run it

```bash
npm install   # zero dependencies — Node 18+ built-ins only
npm start     # http://localhost:3000
```

Optional LLM routing (the LLM only picks the tool — commerce data always
comes from the live MCP server):

```bash
GEMINI_API_KEY=... npm start     # or OPENAI_API_KEY=...
```

Without a key, the deterministic keyword router runs instead, and the demo
still works end-to-end.

## Sign in (required — even for search)

Click **Sign in with Swiggy** (top-right). The flow is OAuth 2.1 + PKCE:

1. Dynamic Client Registration (`POST /auth/register`) — the server
   registers this app and gets `client_id: swiggy-mcp`.
2. Your browser goes to `https://mcp.swiggy.com/auth/authorize` where you
   complete **phone + OTP in Swiggy's own page**. This app never sees or
   handles your phone number or OTP.
3. The callback (`http://localhost:3000/auth/callback`) exchanges the code
   for tokens (`POST /auth/token`). Access token lasts 5 days; the app
   refreshes it automatically (`grant_type=refresh_token`, 30-day tokens).
4. Tokens live only in `.swiggy-tokens.json` (mode 0600, gitignored).

**Verified live 2026-11-20:** `initialize` without a Bearer token returns
`HTTP 401 {"error":"invalid_token","error_description":"Authentication required"}`
on both `/food` and `/dineout` — so every tool call needs a signed-in
session, including search. The app says so honestly instead of failing
mid-call. See `verification/live-check.json` for the recorded responses.

## Demo shot list (for the ≤5-min Swiggy recording)

| Shot | Time | What to show |
| --- | --- | --- |
| 1. Surface | 0:00–0:30 | The chat UI at localhost:3000; sign-in state visible |
| 2. Discovery | 0:30–2:00 | `biryani near me` → watch the tool-call log fill with `search_restaurants` + `search_menu` (real args visible), restaurant + dish cards from live data |
| 3. Cart | 2:00–3:30 | Tap a dish → **Add to cart** → confirmation card → Confirm → `update_food_cart` + `get_food_cart` appear in the log, cart shown with live total |
| 4. Action step | 3:30–4:30 | `book a table for 2 tonight` → `search_restaurants_dineout` → pick a place → `get_available_slots` → pick a slot → Confirm → `book_table` (free deal) |
| 5. First user / ship plan | 4:30–5:00 | Say who uses it first and where it ships (see below) |

One continuous take if possible; no mock data in frame — there is none in
the app.

**First user / ship plan — Satyam to decide (not yet answered):**
- First user: [himself / first users — his call]
- Ship it: [where — his call]

## Tool catalog used (from the live docs, 2026-11-20)

Servers: `POST https://mcp.swiggy.com/food` (20 tools),
`POST https://mcp.swiggy.com/dineout` (11 tools).
Transport: MCP Streamable HTTP, JSON-RPC 2.0, protocol `2025-06-18`,
headers `Content-Type: application/json`,
`Accept: application/json, text/event-stream`,
`Authorization: Bearer <token>`.

| Tool | Server | Arguments used |
| --- | --- | --- |
| `search_restaurants` | food | `{ query (req), addressId \| latitude+longitude }` |
| `search_menu` | food | `{ query (req), addressId \| latitude+longitude, restaurantIdOfAddedItem? }` |
| `get_restaurant_menu` | food | `{ restaurantId, addressId \| latitude+longitude }` |
| `get_addresses` | food | `{}` → `addresses[]`, `resolution.defaultAddressId` |
| `update_food_cart` | food | `{ restaurantId (req), cartItems: [{ menu_item_id, quantity, variants\|variantsV2? }] (req), addressId \| lat+lng, restaurantName? }` |
| `get_food_cart` | food | `{ addressId (req), restaurantName? }` |
| `fetch_food_coupons` | food | `{ restaurantId, addressId }` (COD-valid only) |
| `search_restaurants_dineout` | dineout | `{ query, latitude, longitude }` |
| `get_available_slots` | dineout | `{ restaurantId (req), date YYYY-MM-DD (req), latitude (req), longitude (req) }` |
| `create_cart` | dineout | `{ cartType: "DEAL_TICKET_PURCHASE", restaurantId, slotId, itemId, reservationTime, guestCount, latitude, longitude }` |
| `book_table` | dineout | `{ restaurantId, slotId, itemId, reservationTime, guestCount, latitude, longitude (all req), paymentMethod?, cartKey?, generateUPIQR? }` |

Rules honoured from the docs: only `OPEN` restaurants are recommended;
`update_food_cart` uses the SAME variant format (`variants` or
`variantsV2`) the item came with, never both; the cart is re-read with
`get_food_cart` after every update; `place_food_order` is not idempotent
and not de-duplicated, so it is not exposed here at all; mutations are
never retried; Builders Club orders pay by COD with a hard ₹1000 cart cap.

## Project layout

```
server.js            # HTTP server, API routes, OAuth callback, safety rails
lib/mcp.js           # Streamable-HTTP JSON-RPC client (JSON + SSE parsing)
lib/auth.js          # OAuth 2.1 + PKCE, DCR, token exchange/refresh, local store
lib/router.js        # keyword router + optional LLM router (read-only tools only)
public/              # index.html, app.js, style.css — chat UI + tool-call log
test/                # node:test suite (mock MCP server; no live calls)
scripts/verify-live.mjs  # live endpoint check (no auth, no mutations)
verification/live-check.json  # recorded live responses
```

## Tests & verification

```bash
npm test          # 14 tests, all passing (mock MCP server + router)
npm run verify-live  # real endpoints: 401s without auth, DCR 201, authorize URL generated
```

## Known limits

- Search needs sign-in too (verified live — see above), even though the
  docs describe coordinates as usable for "guest" calls; the transport
  still requires a Bearer token.
- Dineout needs GPS coordinates from the browser for slots/booking; after
  sign-in the food flows use the saved address instead.
- Paid dineout deals need the UPI QR step in your own UPI app; the booking
  confirms only after you pay there.
- This is a localhost demo (single user, in-memory session state). It is
  not production-hardened — see the Ship-to-production doc before going
  further.
