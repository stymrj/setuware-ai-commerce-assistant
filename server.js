// Setuware AI Commerce Assistant — localhost demo server.
// Chat UI + visible MCP tool-call log + confirmation-gated mutations,
// wired to the REAL Swiggy MCP servers (Food, Dineout).
//
// Run:  npm install   (no dependencies — Node 18+ built-ins only)
//       npm start     (http://localhost:3000)
// Auth: click "Sign in with Swiggy" — OAuth 2.1 + PKCE, phone + OTP in
//       Swiggy's own browser UI. We never see or handle phone/OTP.
// LLM:  optional — set GEMINI_API_KEY or OPENAI_API_KEY for LLM routing;
//       without a key the deterministic keyword router runs instead.
//       Either way, ALL commerce data comes from the live MCP server.
//
// Safety rails (from the Swiggy docs):
// - place_food_order is NOT exposed at all in this build (demo stops at the
//   confirmed cart — no order is ever placed, no money moves).
// - update_food_cart / book_table run ONLY after an explicit Confirm tap.
// - Builders Club ₹1000 cart cap is enforced before any cart confirmation.
// - Mutations are never retried. A failed mutation is reported, not re-sent.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { McpClient, McpError } = require("./lib/mcp");
const auth = require("./lib/auth");
const { routeMessage, buildCartItem, llmRoute } = require("./lib/router");

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const REDIRECT_URI = `${BASE_URL}/auth/callback`;
const CART_CAP_INR = 1000; // Swiggy v1: hard ₹1000 cap on Builders Club orders

// ---------------------------------------------------------------------------
// Single-user localhost state (in-memory only; nothing sensitive is logged).
// ---------------------------------------------------------------------------
const state = {
  location: null, // { addressId?, latitude?, longitude?, label? }
  lastRestaurants: [],
  lastDishes: [],
  lastDineout: [],
  toolLog: [], // every MCP call, newest last — shown in the UI log panel
  oauthStates: new Map(), // state -> { verifier, createdAt }
};

const clients = {}; // server -> McpClient

function logTool(entry) {
  state.toolLog.push({ ...entry, at: new Date().toISOString() });
  if (state.toolLog.length > 200) state.toolLog.shift();
}

function getToken() {
  const t = auth.getStoredTokens();
  return Promise.resolve(t && t.access_token ? t.access_token : null);
}

async function onAuthFailure() {
  try {
    await auth.refreshTokens();
    for (const c of Object.values(clients)) c.initialized = false;
    return true;
  } catch {
    return false;
  }
}

function mcp(server) {
  if (!clients[server]) clients[server] = new McpClient(server, getToken, onAuthFailure);
  return clients[server];
}

/** Call a tool and record it in the visible log. Returns { data, ms }. */
async function callLogged(server, tool, args) {
  const started = Date.now();
  try {
    const { data, ms } = await mcp(server).callTool(tool, args);
    logTool({ server, tool, args, status: "ok", ms, summary: summarize(tool, data) });
    return { data, ms };
  } catch (err) {
    logTool({ server, tool, args, status: "error", ms: Date.now() - started, summary: err.message });
    throw err;
  }
}

function summarize(tool, data) {
  if (!data || typeof data !== "object") return "";
  if (data.restaurants) return `${data.restaurants.length} restaurants`;
  if (data.items) return `${data.items.length} items`;
  if (data.addresses) return `${data.addresses.length} addresses`;
  if (data.slots) return `${data.slots.length} slots`;
  if (data.data && data.data.items) return `${data.data.items.length} items in cart, to pay ₹${data.data.pricing?.to_pay ?? "?"}`;
  if (data.orderId) return `order ${data.orderId}`;
  if (data.booking) return `booking ${data.booking.orderId || data.booking.id || ""}`;
  return data.message || "";
}

function authed() {
  return auth.hasValidToken();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
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
  let urlPath = decodeURIComponent(new URL(req.url, BASE_URL).pathname);
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
async function handleChat(body) {
  const message = String(body.message || "").trim();
  const location = body.location || state.location;
  if (location) state.location = location;
  if (!message) return { ok: false, error: "EMPTY", message: "Say something first." };

  const ctx = {
    location,
    lastRestaurants: state.lastRestaurants,
    lastDishes: state.lastDishes,
  };

  // LLM routing when a key is configured; keyword router otherwise.
  let route = routeMessage(message, ctx);
  let routedBy = "keyword";
  if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
    try {
      const tools = await mcp("food").listTools();
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
  if (!authed()) {
    return { ok: true, reply: "Sign in with Swiggy first (top-right) — the MCP servers need an authenticated session even for search. It takes a minute: phone + OTP in Swiggy's own page, and your token stays on this machine only.", cards: null, toolCalls: [], routedBy, needsLocation: false };
  }
  if (route.needsLocation && !location) {
    return { ok: true, reply: "I need your location first — sign in (uses your saved Swiggy address) or tap 'Use my location'.", cards: null, toolCalls: [], routedBy, needsLocation: true };
  }

  const toolCalls = [];
  const run = async (server, tool, args) => {
    const { data, ms } = await callLogged(server, tool, args);
    toolCalls.push({ server, tool, args, ms, status: "ok" });
    return data;
  };

  let reply = "";
  let cards = null;

  if (route.intent === "discover") {
    const data = await run(route.server, route.tool, route.args);
    const restaurants = (data.restaurants || []).filter((r) => r);
    state.lastRestaurants = restaurants.slice(0, 10);
    let dishes = [];
    try {
      const menuData = await run(route.followUp.server, route.followUp.tool, route.followUp.args);
      dishes = menuData.items || [];
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
    const cart = data.data || {};
    const items = cart.items || [];
    reply = items.length
      ? `Your cart at ${cart.restaurant?.name || "Swiggy"}: ${items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}. To pay: ₹${cart.pricing?.to_pay ?? "?"}.`
      : "Your food cart is empty right now.";
    cards = { type: "cart", cart };
  } else if (route.intent === "dineout_search") {
    const data = await run("dineout", "search_restaurants_dineout", route.args);
    const restaurants = data.restaurants || data.data?.restaurants || [];
    state.lastDineout = restaurants.slice(0, 10);
    reply = restaurants.length
      ? `Found ${restaurants.length} places to book a table. Pick one and I'll show its available slots.`
      : "No dineout restaurants found near that location.";
    cards = { type: "dineout", restaurants: restaurants.slice(0, 8) };
  } else {
    const data = await run(route.server, route.tool, route.args);
    if (route.tool === "get_restaurant_menu") {
      const cats = data.categories || [];
      const items = cats.flatMap((c) => c.items || c.subcategories?.flatMap((s) => s.items || []) || []);
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
// Routes
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/status") {
      const t = auth.getStoredTokens();
      return sendJson(res, 200, {
        ok: true,
        authenticated: authed(),
        tokenExpiresAt: t ? t.expires_at : null,
        location: state.location,
        routedBy: process.env.GEMINI_API_KEY ? "llm-gemini" : process.env.OPENAI_API_KEY ? "llm-openai" : "keyword",
        servers: ["food", "dineout"],
      });
    }

    if (req.method === "GET" && p === "/api/tool-log") {
      return sendJson(res, 200, { ok: true, log: state.toolLog });
    }

    if (req.method === "GET" && p === "/api/tools") {
      const s = url.searchParams.get("server") || "food";
      const tools = await mcp(s).listTools();
      return sendJson(res, 200, { ok: true, server: s, count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description })) });
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
        return sendJson(res, 200, { ok: true, location: state.location });
      }
      return sendJson(res, 400, { ok: false, error: "Provide addressId or latitude+longitude" });
    }

    if (req.method === "GET" && p === "/api/addresses") {
      if (!authed()) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in first." });
      const { data } = await callLogged("food", "get_addresses", {});
      return sendJson(res, 200, { ok: true, ...data });
    }

    if (req.method === "POST" && p === "/api/chat") {
      const body = await readBody(req);
      const out = await handleChat(body);
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && p === "/api/menu") {
      const body = await readBody(req);
      const args = { restaurantId: body.restaurantId, ...(state.location?.addressId ? { addressId: state.location.addressId } : {}) };
      if (state.location?.latitude != null) { args.latitude = state.location.latitude; args.longitude = state.location.longitude; }
      const { data } = await callLogged("food", "get_restaurant_menu", args);
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) });
    }

    if (req.method === "POST" && p === "/api/cart") {
      if (!state.location?.addressId) return sendJson(res, 400, { ok: false, error: "NO_ADDRESS", message: "Pick a saved address first (sign in, then choose an address)." });
      const { data } = await callLogged("food", "get_food_cart", { addressId: state.location.addressId });
      return sendJson(res, 200, { ok: true, cart: data.data || {}, toolCalls: state.toolLog.slice(-1) });
    }

    // Confirmation-gated add to cart. The UI only calls this after the user
    // taps Confirm on a summary card. Never called by the router.
    if (req.method === "POST" && p === "/api/confirm-add") {
      const body = await readBody(req);
      if (!authed()) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." });
      if (!body.restaurantId || !body.dish || !body.dish.menu_item_id) {
        return sendJson(res, 400, { ok: false, error: "BAD_REQUEST", message: "restaurantId and a dish with menu_item_id are required." });
      }
      const addressId = state.location?.addressId;
      if (!addressId && (state.location?.latitude == null)) {
        return sendJson(res, 400, { ok: false, error: "NO_LOCATION", message: "Pick a saved address first." });
      }
      // Read the live cart first (docs: read the cart before every mutation).
      let current = null;
      try {
        const c = await callLogged("food", "get_food_cart", addressId ? { addressId } : { latitude: state.location.latitude, longitude: state.location.longitude });
        current = c.data?.data || null;
      } catch { /* empty cart is fine */ }
      const existing = (current?.items || []).map((i) => ({
        menu_item_id: i.menu_item_id,
        quantity: i.quantity,
        ...(i.variants?.length ? { variants: i.variants } : {}),
        ...(i.addons?.length ? { addons: i.addons } : {}),
      }));
      const item = buildCartItem(body.dish, Number(body.quantity) || 1);
      const args = {
        restaurantId: body.restaurantId,
        restaurantName: body.restaurantName || undefined,
        cartItems: [...existing, item],
        ...(addressId ? { addressId } : { latitude: state.location.latitude, longitude: state.location.longitude }),
      };
      const { data } = await callLogged("food", "update_food_cart", args);
      const updated = await callLogged("food", "get_food_cart", addressId ? { addressId } : { latitude: state.location.latitude, longitude: state.location.longitude });
      const cart = updated.data?.data || {};
      const toPay = cart.pricing?.to_pay;
      const capNote = typeof toPay === "number" && toPay > CART_CAP_INR
        ? ` Heads up: ₹${toPay} is over the ₹${CART_CAP_INR} Builders Club cap — remove items before ordering.`
        : "";
      return sendJson(res, 200, { ok: true, message: `Added ${item.quantity}× ${body.dish.name} to your cart.${capNote}`, cart, toolCalls: state.toolLog.slice(-2) });
    }

    // ---- Dineout ----
    if (req.method === "POST" && p === "/api/dineout/search") {
      const body = await readBody(req);
      const { data } = await callLogged("dineout", "search_restaurants_dineout", {
        query: body.query || "restaurant",
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      const restaurants = data.restaurants || data.data?.restaurants || [];
      state.lastDineout = restaurants.slice(0, 10);
      return sendJson(res, 200, { ok: true, restaurants, toolCalls: state.toolLog.slice(-1) });
    }

    if (req.method === "POST" && p === "/api/dineout/slots") {
      const body = await readBody(req);
      const { data } = await callLogged("dineout", "get_available_slots", {
        restaurantId: body.restaurantId,
        date: body.date,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) });
    }

    // Free deals only in this endpoint: book_table creates + confirms in one step.
    // Paid deals go through /api/dineout/create-cart first (see below).
    if (req.method === "POST" && p === "/api/dineout/book") {
      const body = await readBody(req);
      if (!authed()) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." });
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
      const { data } = await callLogged("dineout", "book_table", args);
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) });
    }

    if (req.method === "POST" && p === "/api/dineout/create-cart") {
      const body = await readBody(req);
      if (!authed()) return sendJson(res, 401, { ok: false, error: "AUTH_REQUIRED", message: "Sign in with Swiggy first." });
      const { data } = await callLogged("dineout", "create_cart", {
        cartType: "DEAL_TICKET_PURCHASE",
        restaurantId: body.restaurantId,
        slotId: Number(body.slotId),
        itemId: body.itemId,
        reservationTime: Number(body.reservationTime),
        guestCount: Number(body.guestCount) || 2,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
      });
      return sendJson(res, 200, { ok: true, data, toolCalls: state.toolLog.slice(-1) });
    }

    // ---- OAuth ----
    if (req.method === "GET" && p === "/auth/login") {
      const client = await auth.registerClient(REDIRECT_URI);
      const { url, state: oauthState, verifier } = auth.buildAuthorizeUrl(client.client_id, REDIRECT_URI);
      state.oauthStates.set(oauthState, { verifier, createdAt: Date.now() });
      res.writeHead(302, { Location: url });
      return res.end();
    }

    if (req.method === "GET" && p === "/auth/callback") {
      const code = url.searchParams.get("code");
      const oauthState = url.searchParams.get("state");
      const saved = state.oauthStates.get(oauthState || "");
      if (!code || !saved) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end("<h1>Sign-in failed</h1><p>Missing or expired OAuth state. Please try signing in again.</p><a href='/'>Back</a>");
      }
      state.oauthStates.delete(oauthState);
      try {
        await auth.exchangeCode({ code, verifier: saved.verifier, redirectUri: REDIRECT_URI });
        for (const c of Object.values(clients)) c.initialized = false;
        res.writeHead(302, { Location: "/?auth=ok" });
        return res.end();
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html" });
        return res.end(`<h1>Sign-in failed</h1><p>${e.message}</p><a href='/'>Back</a>`);
      }
    }

    if (req.method === "GET" && p === "/auth/logout") {
      await auth.logout();
      for (const c of Object.values(clients)) c.initialized = false;
      res.writeHead(302, { Location: "/" });
      return res.end();
    }

    if (req.method === "GET") return serveStatic(req, res);
    return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
  } catch (err) {
    const { status, body } = errToJson(err);
    return sendJson(res, status, body);
  }
});

server.listen(PORT, () => {
  console.log(`Setuware AI Commerce Assistant running at ${BASE_URL}`);
  console.log(`Auth: ${authed() ? "signed in (token stored locally)" : "not signed in — use /auth/login"}`);
  console.log(`Routing: ${process.env.GEMINI_API_KEY ? "Gemini LLM" : process.env.OPENAI_API_KEY ? "OpenAI LLM" : "keyword router (no LLM key)"}`);
});
