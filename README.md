# Setuware AI Commerce Assistant

Chat UI on the **live Swiggy MCP servers** (Food + Dineout) — built for the
Swiggy Builders Club application. The running app has no mock mode: every
restaurant, dish, price, slot and cart total comes from `mcp.swiggy.com`.

## For Swiggy Builders Club reviewers

This is the localhost path. A fresh clone talks to the real Swiggy MCP
servers. `npm test` is separate: it uses an in-process fake MCP server and
does not contact Swiggy.

### What it does

A single-page chat for food discovery and table booking.

- Search and menus call the live Food server (`search_restaurants`,
  `search_menu`, `get_restaurant_menu`).
- The panel on the right lists every MCP call with server, tool name,
  arguments, timing, and a short result summary.
- **Add to cart is confirmation-gated.** The app shows the dish, restaurant,
  and price, and names the tool it is about to call. **Yes, add to cart**
  calls `update_food_cart`, then re-reads the cart with `get_food_cart`.
  **Cancel** does not send that request. The server rejects the cart route
  unless the request includes `confirmed: true`, which the page sets only
  after Yes.
- **Table booking is confirmation-gated the same way** (`book_table`, and
  `create_cart` for a paid prebook). That creates a real reservation.
- **`place_food_order` is not called.** The food demo stops at the confirmed
  cart. No food order is placed and no payment is taken for food. The ₹1000
  Builders Club cap is checked on the live cart total and warned about.

### Who will use it first

TODO (Satyam): write who the first user is before this goes back to Swiggy
for review.

### Where we plan to ship

TODO (Satyam): write where this will ship before this goes back to Swiggy
for review.

### Prerequisites

- Node.js 18 or newer (`node -v`). No database and no npm packages.
- A browser on the same machine.
- Outbound HTTPS to `mcp.swiggy.com`.
- A Swiggy account that can receive the phone OTP. That login is the only
  credential. There is no Swiggy API key to put in `.env`.

### Setup

```bash
git clone https://github.com/stymrj/setuware-ai-commerce-assistant.git
cd setuware-ai-commerce-assistant
npm install
cp .env.example .env
```

`npm install` only checks the lockfile (zero dependencies). Copying
`.env.example` is optional: every variable in it is optional, and `npm start`
still works if you skip the copy. Do not put real tokens in `.env`.

### How to run

```bash
npm start
```

Open **http://localhost:3000**. Use `localhost`, not a LAN IP. The OAuth
redirect Swiggy expects for local dev is `http://localhost:3000/auth/callback`
(or whatever `PORT` you set). Leave `BASE_URL` unset for a local run.

Then:

1. Click **Sign in with Swiggy**.
2. Complete phone + OTP on Swiggy's page. This app never sees the phone
   number or the OTP.
3. You land back on the chat, signed in. The page loads your saved addresses
   with `get_addresses` and selects the default. The food cart needs that
   saved address. Table booking also needs **Use my location** (Dineout
   slots require coordinates).

Tokens are written to `.swiggy-tokens.json` (mode 0600, gitignored). Sign out
from the header when you are done.

Optional checks that do not place an order:

```bash
npm test             # local tests only; does not call Swiggy
npm run verify-live  # unauthenticated calls against the real servers (expects 401) plus dynamic client registration. Does not sign in and does not mutate a cart.
```

### Demo walkthrough

Do this while watching the **Live MCP tool calls** panel.

| Step | What you do | Live calls |
| --- | --- | --- |
| 1. Sign in | **Sign in with Swiggy**, then OTP on Swiggy's page | `POST https://mcp.swiggy.com/auth/register`, browser navigation to `GET /auth/authorize`, then `POST /auth/token` |
| 2. Address | Automatic after sign-in | Food `initialize`, then `get_addresses` |
| 3. Search | Send `biryani near me` | Food `search_restaurants`, then `search_menu` |
| 4. Menu | **See menu** on a restaurant | Food `get_restaurant_menu` |
| 5. Confirm the cart | **Add to cart** on a dish. Read the dialog. Click **Yes, add to cart**. Click **Cancel** once first if you want to see that nothing is sent. | After Yes only: `get_food_cart`, `update_food_cart`, `get_food_cart`. A dish opened from the compact menu may also call `search_menu` first so variant ids match what Swiggy expects. |
| 6. Cart total | The cart card shows the live total. Over ₹1000 is called out. **View my cart** reads it again. | Food `get_food_cart` |
| 7. Table (optional) | **Use my location**, then `book a table for 2 tonight`. Pick a place, **Check slots**, **Book this slot**, then confirm. | Dineout `search_restaurants_dineout`, `get_available_slots`, then `book_table`. A paid prebook calls `create_cart` first and asks again before UPI. |

Food ordering stops at step 6. There is no button that places the order.

### If something fails before a tool call

| What you see | What to do |
| --- | --- |
| "Sign in with Swiggy first" | Search and cart both require a signed-in session. Unauthenticated `initialize` returns HTTP 401. |
| Sign-in bounces or says the redirect URI is wrong | Open `http://localhost:<PORT>` and leave `BASE_URL` empty. |
| "Pick a saved Swiggy address" | The address dropdown is filled from `get_addresses`. The account needs at least one saved Swiggy address. GPS alone cannot build the food cart. |
| Table slots ask for coordinates | Click **Use my location** and allow the browser prompt. |
| Cart update errors on a dish with options | Add the dish from the search cards (those include variant ids). The menu page retries via `search_menu` when the compact row has no variant payload. |

## Run it

The reviewer steps above are the supported local run. Short form:

```bash
npm install          # zero dependencies — Node 18+ built-ins only
cp .env.example .env # optional; no secrets
npm start            # http://localhost:3000
```

## Deploy it (Vercel, public URL)

No env vars are required — the app derives its public URL per request
from the proxy headers, so the OAuth redirect URI is automatic.

1. In Vercel: **Add New → Project → Import** this repo
   (`stymrj/setuware-ai-commerce-assistant`).
2. Framework Preset: **Other**. Build Command: leave empty (or `npm install`).
   Output Directory: leave empty.
3. Deploy. The URL will be `https://setuware-ai-commerce-assistant.vercel.app`
   (or the domain Vercel assigns).
4. Open the URL, click **Sign in with Swiggy** — phone + OTP in Swiggy's
   own page — and record the demo from there. No local clone or `npm`
   needed.

Optional env vars in the Vercel dashboard (all optional):
`GEMINI_API_KEY` or `OPENAI_API_KEY` (LLM routing instead of the keyword
router), `BASE_URL` (only if the derived URL is ever wrong — it overrides
the per-request derivation).

How tokens work on Vercel: the OAuth callback sets an HttpOnly, Secure,
SameSite=Lax cookie (`sca_tokens`, 30-day Max-Age) holding only the token
set — no shared disk, no database, any serverless instance can serve any
request. The PKCE verifier rides a second short-lived cookie (`sca_oauth`,
10 min, callback path only). On localhost the old behaviour is unchanged:
tokens stay in `.swiggy-tokens.json` (mode 0600, gitignored).

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
3. The callback (`/auth/callback`) exchanges the code for tokens
   (`POST /auth/token`). Access token lasts 5 days; the app refreshes it
   automatically (`grant_type=refresh_token`, 30-day tokens).
4. Tokens live in an HttpOnly Secure cookie on a public URL, or in
   `.swiggy-tokens.json` (mode 0600, gitignored) on localhost — see
   "Deploy it (Vercel, public URL)" above.

**Verified live 2026-11-20:** `initialize` without a Bearer token returns
`HTTP 401 {"error":"invalid_token","error_description":"Authentication required"}`
on both `/food` and `/dineout` — so every tool call needs a signed-in
session, including search. The app says so honestly instead of failing
mid-call. See `verification/live-check.json` for the recorded responses.

## Demo shot list (for the ≤5-min Swiggy recording)

| Shot | Time | What to show |
| --- | --- | --- |
| 1. Surface | 0:00–0:30 | The chat UI at the public URL (or localhost:3000); sign-in state visible |
| 2. Discovery | 0:30–2:00 | `biryani near me` → watch the tool-call log fill with `search_restaurants` + `search_menu` (real args visible), restaurant + dish cards from live data |
| 3. Cart | 2:00–3:30 | Tap a dish → **Add to cart** → confirmation card → Confirm → `update_food_cart` + `get_food_cart` appear in the log, cart shown with live total |
| 4. Action step | 3:30–4:30 | `book a table for 2 tonight` → `search_restaurants_dineout` → pick a place → `get_available_slots` → pick a slot → Confirm → `book_table` (free deal) |
| 5. First user / ship plan | 4:30–5:00 | Read the two TODO sections above only after Satyam has filled them in. Do not invent this on camera. |

One continuous take if possible. The running app has no mock data. `npm test`
is the only place a fake MCP server exists, and it never starts with `npm start`.

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
api/index.js         # Vercel serverless entry — same handler as server.js
vercel.json          # rewrites every route to api/index.js, 60s maxDuration
lib/mcp.js           # Streamable-HTTP JSON-RPC client (JSON + SSE parsing)
lib/auth.js          # OAuth 2.1 + PKCE, DCR, token exchange/refresh, cookie + file stores
lib/router.js        # keyword router + optional LLM router (read-only tools only)
public/              # index.html, app.js, style.css — chat UI + tool-call log
test/                # node:test only. A local fake MCP server lives here and is never used by npm start.
scripts/verify-live.mjs  # live endpoint check (no auth, no mutations)
verification/live-check.json  # recorded live responses
```

## Tests & verification

```bash
npm test          # 28 tests, all local (fake MCP + router + confirmation gate + Vercel/cookie path). No live Swiggy calls.
npm run verify-live  # real endpoints: 401s without auth, DCR 201, authorize URL generated
```

## Known limits

- `place_food_order` is intentionally not wired. Reviewers can confirm a cart
  update (and, optionally, a table booking). They cannot place a food order
  from this app.
- The food cart needs a saved Swiggy address (`get_addresses`). An account
  with no saved address cannot complete the cart step. Browser GPS is only
  the location input for Dineout.
- Search needs sign-in too (verified live — see above), even though the
  docs describe coordinates as usable for "guest" calls; the transport
  still requires a Bearer token.
- Dineout needs GPS coordinates from the browser for slots/booking; after
  sign-in the food flows use the saved address instead.
- Paid dineout deals need the UPI QR step in your own UPI app; the booking
  confirms only after you pay there.
- This is a single-user demo (in-memory location / last-results / tool
  log per instance). The UI sends its location with every chat message
  and renders tool calls from each response inline, so a cold Vercel
  instance loses nothing the demo needs — except the `/api/tool-log`
  history endpoint, which is per-instance. Tokens are stateless (cookie);
  location and log are not shared across instances.
- On Vercel the function timeout is 60s (`vercel.json`); a slow MCP call
  past that returns a 500 to the browser — retry the message.
