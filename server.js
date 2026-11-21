// Setuware AI Commerce Assistant — chat UI + visible MCP tool-call log +
// confirmation-gated mutations, wired to the REAL Swiggy MCP servers
// (Food, Dineout).
//
// Run locally:  npm install   (no dependencies — Node 18+ built-ins only)
//               npm start     (http://localhost:3000)
// Deploy:       import the repo into Vercel (see README + vercel.json) —
//               no env vars required. The same handler serves both: on
//               localhost tokens live in a local file (.swiggy-tokens.json),
//               on a public URL they live in an HttpOnly cookie, so any
//               serverless instance can serve any request (no shared disk).
// Auth: click "Sign in with Swiggy" — OAuth 2.1 + PKCE, phone + OTP in
//       Swiggy's own browser UI. We never see or handle phone/OTP.
// LLM:  optional — set GEMINI_API_KEY or OPENAI_API_KEY for LLM routing;
//       without a key the deterministic keyword router runs instead.
//       Either way, ALL commerce data comes from the live MCP server.
//
// Safety rails (from the Swiggy docs):
// - place_food_order is NOT exposed at all in this build (demo stops at the
//   confirmed cart — no order is ever placed, no money moves).
// - update_food_cart / book_table / create_cart run ONLY after an explicit
//   Confirm tap. The mutation routes reject a body that is not confirmed:true,
//   and the UI sets that flag only after the dialog returns Yes.
// - Builders Club ₹1000 cart cap is checked on the live get_food_cart total
//   after an update. Over-cap carts are warned about. Nothing is ordered.
// - Mutations are never retried. A failed mutation is reported, not re-sent.
// - There is no mock mode on this server. Tests stub MCP on localhost only.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { loadEnvFile } = require("./lib/load-env");
const { McpClient, McpError } = require("./lib/mcp");
const auth = require("./lib/auth");
const { routeMessage, buildCartItem, normalizeDish, dishNeedsMenuDetails, llmRoute } = require("./lib/router");

// Optional. Does not override variables already set in the environment.
const envFile = loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const CART_CAP_INR = 1000; // Swiggy v1: hard ₹1000 cap on Builders Club orders

// ---------------------------------------------------------------------------
// Per-request context. The server is stateless across requests on purpose:
// on localhost the token set comes from the local file; on a public URL
// it comes from the HttpOnly cookie set at the OAuth callback. Location,
// last results and the tool log stay in-memory (single-user demo; the UI
// sends its location with every chat message and renders tool calls from
// each response inline, so a cold instance loses nothing the demo needs).
// ---------------------------------------------------------------------------

/** Base URL for this request. BASE_URL wins when set; otherwise derive it
 * from the proxy headers (Vercel) or the Host header, so the OAuth
 * redirect_uri is automatically https://<public-domain>/auth/callback. */
/** Map 127.0.0.1 and ::1 onto localhost so the OAuth redirect_uri stays on the
 * exact http://localhost origin Swiggy allowlists for local development. */
function normalizeLoopbackHost(host) {
  const value = String(host || "").split(",")[0].trim();
  const match = value.match(/^(?:\[::1\]|127\.0\.0\.1|localhost)(?::(\d+))?$/);
  if (!match) return value;
  return `localhost:${match[1] || PORT}`;
}

function deriveBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const proto =
    (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ||
    (req.socket && req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${normalizeLoopbackHost(host)}`;
}

function makeCtx(req) {
  const baseUrl = deriveBaseUrl(req);
  const secure = baseUrl.startsWith("https://");
  const cookieTokens = auth.parseTokensCookie(req.headers.cookie);
  // Localhost keeps the old file-based tokens; anywhere else tokens must
  // arrive in the cookie (serverless instances share no disk).
  const useFile = !cookieTokens && baseUrl.startsWith("http://localhost");
  const tokens = cookieTokens || (useFile ? auth.getStoredTokens() : null);
  return {
    baseUrl,
    redirectUri: `${baseUrl}/auth/callback`,
    secure,
    useFile,
    tokens,
    setCookie: null, // Set-Cookie value(s) to attach to this response
    clients: {}, // server -> McpClient, per request (stateless-safe)
  };
}

/** Persist a fresh token set for this request: file on localhost, a new
 * Set-Cookie value on a public URL (sent with the response). */
function saveTokens(ctx, tokens) {
  ctx.tokens = tokens;
  if (ctx.useFile) {
    auth.storeTokens(tokens);
  } else {
    ctx.setCookie = auth.serializeTokensCookie(tokens, ctx.secure);
  }
}

/** Refresh this request's access token. Returns true on success. */
async function refreshCtx(ctx) {
  if (!ctx.tokens || !ctx.tokens.refresh_token) return false;
  try {
    const fresh = await auth.refreshWithTokens(ctx.tokens);
    saveTokens(ctx, fresh);
    for (const c of Object.values(ctx.clients)) c.initialized = false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Single-user demo state (in-memory only; nothing sensitive is logged).
// ---------------------------------------------------------------------------
const state = {
  location: null, // { addressId?, latitude?, longitude?, label? }
  lastRestaurants: [],
  lastDishes: [],
  lastDineout: [],
  toolLog: [], // every MCP call, newest last — shown in the UI log panel
  oauthStates: new Map(), // state -> { verifier, createdAt } (localhost fallback)
};

function logTool(entry) {
  state.toolLog.push({ ...entry, at: new Date().toISOString() });
  if (state.toolLog.length > 200) state.toolLog.shift();
}

function getMcp(ctx, server) {
  if (!ctx.clients[server]) {
    ctx.clients[server] = new McpClient(
      server,
      () => Promise.resolve(ctx.tokens && ctx.tokens.access_token ? ctx.tokens.access_token : null),
      async () => refreshCtx(ctx)
    );
  }
  return ctx.clients[server];
}

/** Call a tool and record it in the visible log. Returns { data, ms }. */
async function callLogged(ctx, server, tool, args) {
  const started = Date.now();
  try {
    const { data, ms } = await getMcp(ctx, server).callTool(tool, args);
    logTool({ server, tool, args, status: "ok", ms, summary: summarize(tool, data) });
    return { data, ms };
  } catch (err) {
    logTool({ server, tool, args, status: "error", ms: Date.now() - started, summary: err.message });
    throw err;
  }
}

/** get_food_cart's documented payload is { data: { items, pricing, restaurant }, addressId }.
 * Some callers also see the inner object already unwrapped. Accept both. */
function cartView(data) {
  if (!data || typeof data !== "object") return {};
  const inner = data.data;
  if (inner && typeof inner === "object" && (inner.items || inner.pricing || inner.restaurant || inner.cart_id)) {
    return inner;
  }
  if (data.items || data.pricing || data.restaurant) return data;
  return {};
}

function listFrom(data, key) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data[key])) return data[key];
  if (data.data && Array.isArray(data.data[key])) return data.data[key];
  return [];
}

function summarize(tool, data) {
  if (!data || typeof data !== "object") return "";
  if (data.restaurants || data.data?.restaurants) return `${listFrom(data, "restaurants").length} restaurants`;
  if (tool === "get_food_cart" || tool === "update_food_cart") {
    const cart = cartView(data);
    if (cart.items) return `${cart.items.length} items in cart, to pay ₹${cart.pricing?.to_pay ?? "?"}`;
  }
  if (data.items || data.data?.items) return `${listFrom(data, "items").length} items`;
  if (data.addresses || data.data?.addresses) return `${listFrom(data, "addresses").length} addresses`;
  if (data.slots || data.data?.slots) return `${listFrom(data, "slots").length} slots`;
  if (data.orderId) return `order ${data.orderId}`;
  if (data.booking) return `booking ${data.booking.orderId || data.booking.id || ""}`;
  return data.message || "";
}

function authed(ctx) {
  return auth.hasValidToken(ctx.tokens);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj, ctx) {
  const body = JSON.stringify(obj);
  const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) };
  if (ctx && ctx.setCookie) headers["Set-Cookie"] = ctx.setCookie;
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, ctx) {
  const headers = { Location: location };
  if (ctx && ctx.setCookie) headers["Set-Cookie"] = ctx.setCookie;
  res.writeHead(302, headers);
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1e6) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.join(__dirname, "public", urlPath);
  if (!file.startsWith(path.join(__dirname, "public"))) return sendJson(res, 403, { error: "Forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function errToJson(err) {
  if (err instanceof McpError && err.isAuth) {
    return { status: 401, body: { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy to continue — your session is missing or expired." } };
  }
  return { status: 500, body: { ok: false, error: "ERROR", message: err.message || String(err) } };
}

// ---------------------------------------------------------------------------
// Chat: message -> router -> live MCP calls -> reply + cards + tool log.
// ---------------------------------------------------------------------------
async function handleChat(ctx, body) {
  const message = String(body.message || "").trim();
  const location = body.location || state.location;
  if (location) state.location = location;
  if (!message) return { ok: false, error: "EMPTY", message: "Say something first." };

  const ctx2 = {
    location,
    lastRestaurants: state.lastRestaurants,
    lastDishes: state.lastDishes,
  };

  // LLM routing when a key is configured; keyword router otherwise.
  let route = routeMessage(message, ctx2);
  let routedBy = "keyword";
  if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
    try {
      const tools = await getMcp(ctx, "food").listTools();
      const llm = await llmRoute(message, tools);
      if (llm && llm.tool) {
        const server = llm.tool.includes("dineout") ? "dineout" : "food";
        route = { intent: "llm", tool: llm.tool, server, args: { ...llm.arguments, ...(location?.addressId ? { addressId: location.addressId } : {}) }, reply: "", needsLocation: false };
        routedBy = "llm";
      }
    } catch {
      /* fall through to keyword route */
    }
  }

  if (!route.tool) {
    return { ok: true, reply: route.reply, cards: null, toolCalls: [], routedBy, needsLocation: route.needsLocation || false };
  }
  // Verified live 2026-11-20: initialize without a Bearer token returns
  // HTTP 401, so EVERY tool call — including search — needs a signed-in
  // session. Say so up front instead of failing mid-call.
  if (!authed(ctx)) {
    return { ok: true, reply: "Sign in with Swiggy first (top-right) — the MCP servers need an authenticated session even for search. It takes a minute: phone + OTP in Swiggy's own page, and your token stays in your browser only.", cards: null, toolCalls: [], routedBy, needsLocation: false };
  }
  if (route.needsLocation && !location) {
    return { ok: true, reply: "I need your location first — sign in (uses your saved Swiggy address) or tap 'Use my location'.", cards: null, toolCalls: [], routedBy, needsLocation: true };
  }

  const toolCalls = [];
  const run = async (server, tool, args) => {
    const { data, ms } = await callLogged(ctx, server, tool, args);
    const entry = state.toolLog[state.toolLog.length - 1];
    toolCalls.push({ server, tool, args, ms, status: "ok", summary: entry?.summary || summarize(tool, data) });
    return data;
  };

  let reply = "";
  let cards = null;

  if (route.intent === "discover") {
    const data = await run(route.server, route.tool, route.args);
    const restaurants = listFrom(data, "restaurants").filter((r) => r);
    state.lastRestaurants = restaurants.slice(0, 10);
    let dishes = [];
    try {
      const menuData = await run(route.followUp.server, route.followUp.tool, route.followUp.args);
      dishes = listFrom(menuData, "items");
      state.lastDishes = dishes.slice(0, 20);
    } catch (e) {
      // search_menu failing must not hide the restaurant results.
      toolCalls.push({ server: "food", tool: "search_menu", args: route.followUp.args, ms: 0, status: "error", error: e.message });
    }
    const open = restaurants.filter((r) => r.availabilityStatus === "OPEN");
    reply =
      open.length > 0
        ? `Found ${restaurants.length} restaurants for "${route.args.query}" — ${open.length} open now. Tap a restaurant to see its menu, or tap a dish to add it to your cart (I'll ask before adding anything).`
        : `Found ${restaurants.length} restaurants for "${route.args.query}", but none are marked OPEN right now. Try a different dish or time.`;
    cards = { type: "discover", restaurants: restaurants.slice(0, 8), dishes: dishes.slice(0, 8) };
  } else if (route.intent === "cart") {
    const data = await run("food", "get_food_cart", route.args);
    const cart = cartView(data);
    const items = cart.items || [];
    reply = items.length
      ? `Your cart at ${cart.restaurant?.name || "Swiggy"}: ${items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}. To pay: ₹${cart.pricing?.to_pay ?? "?"}.`
      : "Your food cart is empty right now.";
    cards = { type: "cart", cart };
  } else if (route.intent === "dineout_search") {
    const data = await run("dineout", "search_restaurants_dineout", route.args);
    const restaurants = listFrom(data, "restaurants");
    state.lastDineout = restaurants.slice(0, 10);
    reply = restaurants.length
      ? `Found ${restaurants.length} places to book a table. Pick one and I'll show its available slots.`
      : "No dineout restaurants found near that location.";
    cards = { type: "dineout", restaurants: restaurants.slice(0, 8) };
  } else {
    const data = await run(route.server, route.tool, route.args);
    if (route.tool === "get_restaurant_menu") {
      const cats = data.categories || data.data?.categories || [];
      const items = cats.flatMap((c) => [
        ...(Array.isArray(c.items) ? c.items : []),
        ...((c.subcategories || []).flatMap((s) => s.items || [])),
      ]);
      state.lastDishes = items.slice(0, 20);
      reply = `Menu: ${cats.length} categories, ${items.length} items shown. Tap a dish to add it — I'll confirm first.`;
      cards = { type: "menu", categories: cats.slice(0, 10), items: items.slice(0, 12) };
    } else {
      reply = data.message || "Done — see the tool log on the right for the live response.";
      cards = { type: "raw", data };
    }
  }

  return { ok: true, reply, cards, toolCalls, routedBy, needsLocation: false };
}

// ---------------------------------------------------------------------------
// Routes — one handler, used by the localhost server and by api/index.js
// on Vercel. Every response that may carry refreshed tokens gets ctx so
// the Set-Cookie header is attached.
// ---------------------------------------------------------------------------
async function handleRequest(req, res) {
  const ctx = makeCtx(req);
  try {
    const url = new URL(req.url, ctx.baseUrl);
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/status") {
      const t = ctx.tokens;
      return sendJson(res, 200, {
        ok: true,
        authenticated: authed(ctx),
        tokenExpiresAt: t ? t.expires_at : null,
        tokenStorage: ctx.useFile ? "file" : "cookie",
        location: state.location,
        routedBy: process.env.GEMINI_API_KEY ? "llm-gemini" : process.env.OPENAI_API_KEY ? "llm-openai" : "keyword",
        servers: ["food", "dineout"],
      }, ctx);
    }

    if (req.method === "GET" && p === "/api/tool-log") {
      return sendJson(res, 200, { ok: true, log: state.toolLog }, ctx);
    }

    if (req.method === "GET" && p === "/api/tools") {
      const s = url.searchParams.get("server") || "food";
      const tools = await getMcp(ctx, s).listTools();
      return sendJson(res, 200, { ok: true, server: s, count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) }, ctx);
    }

    if (req.method === "POST" && p === "/api/location") {
      const body = await readBody(req);
      if (body.addressId || (body.latitude != null && body.longitude != null)) {
        state.location = {
          addressId: body.addressId || null,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          label: body.label || null,
        };
        return sendJson(res, 200, { ok: true, location: state.location }, ctx);
      }
      return sendJson(res, 400, { ok: false, error: "Provide addressId or latitude+longitude" }, ctx);
    }

    if (req.method === "GET" && p === "/api/addresses") {
      if (!authed(ctx)) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in first." }, ctx);
      const { data } = await callLogged(ctx, "food", "get_addresses", {});
      const addresses = listFrom(data, "addresses");
      const resolution = data.resolution || data.data?.resolution || null;
      return sendJson(res, 200, { ok: true, addresses, resolution, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    if (req.method === "POST" && p === "/api/chat") {
      const body = await readBody(req);
      const out = await handleChat(ctx, body);
      return sendJson(res, 200, out, ctx);
    }

    if (req.method === "POST" && p === "/api/menu") {
      const body = await readBody(req);
      const args = { restaurantId: body.restaurantId, ...(state.location?.addressId ? { addressId: state.location.addressId } : {}) };
      if (state.location?.latitude != null) { args.latitude = state.location.latitude; args.longitude = state.location.longitude; }
      const { data } = await callLogged(ctx, "food", "get_restaurant_menu", args);
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    if (req.method === "POST" && p === "/api/cart") {
      if (!state.location?.addressId) return sendJson(res, 400, { ok: false, error: "NO_ADDRESS", message: "Pick a saved address first (sign in, then choose an address)." }, ctx);
      const { data } = await callLogged(ctx, "food", "get_food_cart", { addressId: state.location.addressId });
      return sendJson(res, 200, { ok: true, cart: cartView(data), toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    // Confirmation-gated add to cart. The UI calls this only after the user
    // taps Confirm. The router never calls a mutation. Cancel does not hit
    // this route. `confirmed: true` is required so a request that skipped the
    // dialog is rejected before any Swiggy call.
    if (req.method === "POST" && p === "/api/confirm-add") {
      const body = await readBody(req);
      if (body.confirmed !== true) {
        return sendJson(res, 400, {
          ok: false,
          error: "CONFIRMATION_REQUIRED",
          message: "Adding to the cart calls the live update_food_cart tool. Confirm in the dialog first — Cancel sends nothing to Swiggy.",
        }, ctx);
      }
      if (!authed(ctx)) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." }, ctx);
      let dish;
      try {
        dish = normalizeDish(body.dish);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: "BAD_REQUEST", message: body.restaurantId ? e.message : "restaurantId and a dish are required." }, ctx);
      }
      if (!body.restaurantId) {
        return sendJson(res, 400, { ok: false, error: "BAD_REQUEST", message: "restaurantId and a dish are required." }, ctx);
      }
      if (dish.inStock === 0 || dish.in_stock === false) {
        return sendJson(res, 400, { ok: false, error: "OUT_OF_STOCK", message: `${dish.name || "That item"} is out of stock on Swiggy right now.` }, ctx);
      }
      // get_food_cart requires addressId. GPS alone is not enough for the cart tools.
      const addressId = state.location?.addressId;
      if (!addressId) {
        return sendJson(res, 400, { ok: false, error: "NO_ADDRESS", message: "Pick a saved Swiggy address first (sign in, then choose one in the bar). Cart tools need that address id." }, ctx);
      }
      // Compact get_restaurant_menu rows omit variant ids. Swiggy's docs say to
      // order from search_menu, which returns the format update_food_cart expects.
      const logStart = state.toolLog.length;
      if (dishNeedsMenuDetails(dish)) {
        const { data: menuData } = await callLogged(ctx, "food", "search_menu", {
          query: dish.name,
          restaurantIdOfAddedItem: body.restaurantId,
          addressId,
        });
        const items = listFrom(menuData, "items");
        const match =
          items.find((item) => item.menu_item_id && item.menu_item_id === dish.menu_item_id) ||
          items.find((item) => dish.name && item.name === dish.name);
        if (!match) {
          return sendJson(res, 400, {
            ok: false,
            error: "DISH_NOT_FOUND",
            message: `Swiggy's menu search did not return variant details for "${dish.name || dish.menu_item_id}". Add it from the search results instead.`,
            toolCalls: state.toolLog.slice(logStart),
          }, ctx);
        }
        dish = normalizeDish({ ...match, name: match.name || dish.name });
      }
      const item = buildCartItem(dish, Number(body.quantity) || 1);
      // Read the live cart first (docs: read before every mutation). The update
      // itself sends only the new line, matching Swiggy's order-food recipe —
      // echoing the current cart back can resend variant ids in the wrong shape
      // and fail the call.
      try {
        await callLogged(ctx, "food", "get_food_cart", { addressId });
      } catch { /* an empty cart can error; the update still proceeds */ }
      const args = {
        restaurantId: body.restaurantId,
        restaurantName: body.restaurantName || undefined,
        cartItems: [item],
        addressId,
      };
      await callLogged(ctx, "food", "update_food_cart", args);
      let cart = {};
      try {
        const updated = await callLogged(ctx, "food", "get_food_cart", { addressId, restaurantName: body.restaurantName || undefined });
        cart = cartView(updated.data);
      } catch (e) {
        return sendJson(res, 200, {
          ok: true,
          message: `Swiggy accepted the cart update for ${item.quantity}× ${dish.name}, but re-reading the cart failed: ${e.message}`,
          cart,
          toolCalls: state.toolLog.slice(logStart),
        }, ctx);
      }
      const toPay = cart.pricing?.to_pay;
      const capNote = typeof toPay === "number" && toPay > CART_CAP_INR
        ? ` Heads up: ₹${toPay} is over the ₹${CART_CAP_INR} Builders Club cap. This demo does not place the order — remove items before you would check out.`
        : "";
      return sendJson(res, 200, {
        ok: true,
        message: `Added ${item.quantity}× ${dish.name} to your Swiggy cart.${capNote} No order was placed.`,
        cart,
        toolCalls: state.toolLog.slice(logStart),
      }, ctx);
    }

    // ---- Dineout ----
    if (req.method === "POST" && p === "/api/dineout/search") {
      const body = await readBody(req);
      const { data } = await callLogged(ctx, "dineout", "search_restaurants_dineout", {
        query: body.query || "restaurant",
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      const restaurants = data.restaurants || data.data?.restaurants || [];
      state.lastDineout = restaurants.slice(0, 10);
      return sendJson(res, 200, { ok: true, restaurants, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    if (req.method === "POST" && p === "/api/dineout/slots") {
      const body = await readBody(req);
      const { data } = await callLogged(ctx, "dineout", "get_available_slots", {
        restaurantId: body.restaurantId,
        date: body.date,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    // Free deals only in this endpoint: book_table creates + confirms in one step.
    // Paid deals go through /api/dineout/create-cart first (see below).
    if (req.method === "POST" && p === "/api/dineout/book") {
      const body = await readBody(req);
      if (body.confirmed !== true) {
        return sendJson(res, 400, {
          ok: false,
          error: "CONFIRMATION_REQUIRED",
          message: "Booking a table calls the live book_table tool and creates a real reservation. Confirm in the dialog first — Cancel sends nothing to Swiggy.",
        }, ctx);
      }
      if (!authed(ctx)) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." }, ctx);
      const args = {
        restaurantId: body.restaurantId,
        slotId: Number(body.slotId),
        itemId: body.itemId,
        reservationTime: Number(body.reservationTime),
        guestCount: Number(body.guestCount) || 2,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      };
      if (body.paymentMethod === "UPI") {
        args.paymentMethod = "UPI";
        if (body.cartKey) args.cartKey = body.cartKey;
        args.generateUPIQR = true; // desktop demo: scannable QR instead of app intent
      }
      const { data } = await callLogged(ctx, "dineout", "book_table", args);
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    if (req.method === "POST" && p === "/api/dineout/create-cart") {
      const body = await readBody(req);
      if (body.confirmed !== true) {
        return sendJson(res, 400, {
          ok: false,
          error: "CONFIRMATION_REQUIRED",
          message: "Creating a dineout cart calls the live create_cart tool. Confirm in the dialog first — Cancel sends nothing to Swiggy.",
        }, ctx);
      }
      if (!authed(ctx)) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." }, ctx);
      const { data } = await callLogged(ctx, "dineout", "create_cart", {
        cartType: "DEAL_TICKET_PURCHASE",
        restaurantId: body.restaurantId,
        slotId: Number(body.slotId),
        itemId: body.itemId,
        reservationTime: Number(body.reservationTime),
        guestCount: Number(body.guestCount) || 2,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) }, ctx);
    }

    // ---- OAuth ----
    if (req.method === "GET" && p === "/auth/login") {
      const client = await auth.registerClient(ctx.redirectUri);
      const { url, state: oauthState, verifier } = auth.buildAuthorizeUrl(client.client_id, ctx.redirectUri);
      // Keep the PKCE verifier in a short-lived HttpOnly cookie (stateless
      // across instances) with the in-memory map as the localhost fallback.
      state.oauthStates.set(oauthState, { verifier, createdAt: Date.now() });
      ctx.setCookie = auth.serializeOAuthStateCookie(oauthState, verifier, ctx.secure);
      return redirect(res, url, ctx);
    }

    if (req.method === "GET" && p === "/auth/callback") {
      const code = url.searchParams.get("code");
      const oauthState = url.searchParams.get("state");
      const fromCookie = auth.parseOAuthStateCookie(req.headers.cookie);
      const saved =
        fromCookie && fromCookie.state === oauthState
          ? { verifier: fromCookie.verifier }
          : state.oauthStates.get(oauthState || "");
      if (!code || !saved) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end("<h1>Sign-in failed</h1><p>Missing or expired OAuth state. Please try signing in again.</p><a href='/'>Back</a>");
      }
      state.oauthStates.delete(oauthState);
      try {
        const tokens = await auth.exchangeCode({
          code,
          verifier: saved.verifier,
          redirectUri: ctx.redirectUri,
          persist: ctx.useFile, // file on localhost; cookie below otherwise
        });
        saveTokens(ctx, tokens);
        // Clear the one-time OAuth cookie alongside the token cookie.
        const clearOauth = auth.clearCookie(auth.OAUTH_COOKIE, ctx.secure, "/auth/callback");
        ctx.setCookie = ctx.setCookie ? [ctx.setCookie, clearOauth] : clearOauth;
        for (const c of Object.values(ctx.clients)) c.initialized = false;
        return redirect(res, "/?auth=ok", ctx);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end(`<h1>Sign-in failed</h1><p>${e.message}</p><a href='/'>Back</a>`);
      }
    }

    if (req.method === "GET" && p === "/auth/logout") {
      if (ctx.useFile) {
        await auth.logout(); // revokes server-side + deletes the token file
      } else {
        await auth.logoutWithTokens(ctx.tokens);
      }
      ctx.tokens = null;
      ctx.setCookie = auth.clearCookie(auth.TOKENS_COOKIE, ctx.secure);
      return redirect(res, "/", ctx);
    }

    if (req.method === "GET") return serveStatic(req, res);
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" }, ctx);
  } catch (err) {
    const { status, body } = errToJson(err);
    // A failed live call is still a real MCP call. Show it in the tool log.
    if (err instanceof McpError && state.toolLog.length) {
      body.toolCalls = [state.toolLog[state.toolLog.length - 1]];
    }
    return sendJson(res, status, body, ctx);
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  const startUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  server.listen(PORT, () => {
    console.log(`Setuware AI Commerce Assistant running at ${startUrl}`);
    console.log("Open that URL, then click Sign in with Swiggy (phone + OTP on Swiggy's page).");
    console.log("There is no mock mode. Cart and table booking each wait for Confirm before calling Swiggy.");
    console.log(`Auth: ${auth.hasValidToken() ? "signed in (token stored locally)" : "not signed in yet"}`);
    console.log(`Routing: ${process.env.GEMINI_API_KEY ? "Gemini LLM" : process.env.OPENAI_API_KEY ? "OpenAI LLM" : "keyword router (no LLM key)"}`);
    if (envFile.loaded) {
      console.log(`Loaded .env (${envFile.keys.length ? envFile.keys.join(", ") : "no new keys; environment already had them"})`);
    }
  });
}

module.exports = { handleRequest, deriveBaseUrl };
