// Turns a chat message into real Swiggy MCP tool calls.
//
// Two modes:
//  1. LLM mode — if GEMINI_API_KEY or OPENAI_API_KEY is set, the model picks
//     the tool + arguments from the live tool list. Commerce data still
//     always comes from the live MCP server; the LLM only routes.
//  2. Keyword mode (default, no key needed) — deterministic rules below.
//     The demo works end-to-end in this mode.
//
// The router NEVER invents data. Every restaurant/dish/cart value it uses
// comes from a prior live tool response stored in the session context.
// Mutating tools (update_food_cart, book_table, place_food_order) are NEVER
// called by the router itself — the UI shows a confirmation card first and
// only calls the mutation endpoint after the user taps Confirm.

const FOOD_STOPWORDS = new Set([
  "i", "want", "need", "please", "pls", "get", "me", "some", "a", "an", "the",
  "for", "to", "near", "around", "here", "my", "order", "food", "eat", "hungry",
  "show", "find", "search", "give", "can", "you", "is", "there", "any", "with",
  "and", "or", "of", "in", "at", "on", "from", "deliver", "delivery",
]);

/** Extract a search query from free text: drop stopwords, keep the food words. */
function extractQuery(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !FOOD_STOPWORDS.has(w));
  return words.join(" ").trim();
}

const DINEOUT_WORDS = /\b(table|dineout|dine out|dine-in|dine in|book a table|reservation|reserve)\b/i;
const CART_WORDS = /\b(my cart|show cart|view cart|cart|checkout)\b/i;
const MENU_WORDS = /\b(menu)\b/i;
const GREETING = /^(hi|hello|hey|namaste|namaskar)\b/i;

/**
 * Route a message.
 * @param {string} message
 * @param {object} ctx - { location: {addressId?, latitude?, longitude?} | null,
 *   lastRestaurants: [{id,name}], lastDishes: [{menu_item_id, restaurant_id, restaurant_name}] }
 * @returns {{ intent: string, tool: string|null, server: string|null, args: object,
 *   reply: string, needsLocation: boolean }}
 */
function routeMessage(message, ctx = {}) {
  const text = (message || "").trim();
  const loc = ctx.location || null;
  const locationArgs = {};
  if (loc) {
    if (loc.addressId) locationArgs.addressId = loc.addressId;
    else if (loc.latitude != null && loc.longitude != null) {
      locationArgs.latitude = loc.latitude;
      locationArgs.longitude = loc.longitude;
    }
  }

  if (!text) {
    return { intent: "empty", tool: null, server: null, args: {}, reply: "Type what you'd like — e.g. 'biryani near me' or 'book a table'.", needsLocation: false };
  }
  if (GREETING.test(text)) {
    return {
      intent: "greet", tool: null, server: null, args: {},
      reply: "Hi! I can search restaurants and dishes on live Swiggy, build your cart (with your confirmation), and book a table. Try 'biryani near me' or 'book a table for 2 tonight'.",
      needsLocation: false,
    };
  }
  if (CART_WORDS.test(text)) {
    if (!loc || !loc.addressId) {
      return { intent: "cart", tool: null, server: "food", args: {}, reply: "To show your cart I need your saved Swiggy address — please sign in first (top-right).", needsLocation: true };
    }
    return { intent: "cart", tool: "get_food_cart", server: "food", args: { addressId: loc.addressId }, reply: "", needsLocation: false };
  }
  if (DINEOUT_WORDS.test(text)) {
    if (!loc || loc.latitude == null || loc.longitude == null) {
      return { intent: "dineout", tool: null, server: "dineout", args: {}, reply: "For table booking I need your location — sign in (uses your saved address) or share your location from the bar above.", needsLocation: true };
    }
    const query = extractQuery(text.replace(DINEOUT_WORDS, " ")) || "restaurant";
    return { intent: "dineout_search", tool: "search_restaurants_dineout", server: "dineout", args: { query, latitude: loc.latitude, longitude: loc.longitude }, reply: "", needsLocation: false };
  }
  if (MENU_WORDS.test(text)) {
    const restaurants = ctx.lastRestaurants || [];
    if (!restaurants.length) {
      return { intent: "menu", tool: null, server: "food", args: {}, reply: "Search for a restaurant first (e.g. 'biryani near me'), then ask for its menu.", needsLocation: false };
    }
    const r = restaurants[0];
    return {
      intent: "menu", tool: "get_restaurant_menu", server: "food",
      args: { restaurantId: r.id, ...locationArgs },
      reply: "", needsLocation: false,
    };
  }

  // Default: food discovery. Dish-style query -> search_menu AND search_restaurants;
  // the caller runs search_restaurants first (restaurants), search_menu second (dishes).
  const query = extractQuery(text) || text;
  return {
    intent: "discover", tool: "search_restaurants", server: "food",
    args: { query, ...locationArgs },
    reply: "", needsLocation: !loc,
    followUp: { tool: "search_menu", server: "food", args: { query, ...locationArgs } },
  };
}

/**
 * search_menu items carry `menu_item_id`. get_restaurant_menu items carry `id`
 * for the same value (Swiggy's order-food recipe passes dish.id as menu_item_id).
 * Accept either so "See menu → Add to cart" does not 400 on a live menu.
 */
function normalizeDish(dish) {
  if (!dish || typeof dish !== "object") throw new Error("Dish is missing");
  const menu_item_id = dish.menu_item_id || dish.id;
  if (!menu_item_id) throw new Error("Dish has no menu_item_id — cannot add to cart");
  return { ...dish, menu_item_id };
}

/** True when the compact menu payload is missing the variant/add-on ids update_food_cart needs. */
function dishNeedsMenuDetails(dish) {
  const hasVariantPayload =
    (Array.isArray(dish.variantsV2) && dish.variantsV2.length > 0) ||
    (Array.isArray(dish.variations) && dish.variations.length > 0);
  if (hasVariantPayload) return false;
  return Boolean(dish.hasVariants || dish.hasAddons);
}

/** Build the cartItems entry for update_food_cart from a dish returned by search_menu. */
function buildCartItem(dish, quantity = 1) {
  const normalized = normalizeDish(dish);
  if (!normalized.menu_item_id) throw new Error("Dish has no menu_item_id — cannot add to cart");
  dish = normalized;
  const item = { menu_item_id: dish.menu_item_id, quantity };
  // Use the SAME variant format the item came with — never both (docs rule).
  if (dish.variantsV2 && dish.variantsV2.length) {
    item.variantsV2 = dish.variantsV2
      .map((g) => {
        const def = (g.variations || []).find((v) => v.default) || g.variations?.[0];
        return def ? { groupId: g.groupId, variation_id: def.id } : null;
      })
      .filter(Boolean);
  } else if (dish.variations && dish.variations.length) {
    const def = dish.variations.find((v) => v.default) || dish.variations[0];
    item.variants = [{ groupId: def.groupId, variation_id: def.id }];
  }
  return item;
}

const LLM_TOOL_PROMPT = (tools, message) => `You route a food-ordering chat to Swiggy MCP tools.
Available tools (name: description):
${tools.map((t) => `- ${t.name}: ${t.description || ""}`).join("\n")}
User message: "${message}"
Reply with ONLY a JSON object: {"tool": "<tool name>", "arguments": { ... }, "reason": "<one line>"}.
Rules: read-only tools only (search_restaurants, search_menu, get_restaurant_menu, get_food_cart, get_addresses, search_restaurants_dineout, get_available_slots). Never choose a mutating tool (update_food_cart, book_table, place_food_order, apply_food_coupon, flush_food_cart). If the message is a greeting or unclear, use {"tool": null, "arguments": {}, "reason": "..."}.`;

async function llmRoute(message, tools) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !openaiKey) return null;
  const prompt = LLM_TOOL_PROMPT(tools, message);
  try {
    let text;
    if (geminiKey) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      const json = await res.json();
      text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
    } else {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${openaiKey}` },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
        }),
      });
      const json = await res.json();
      text = json.choices?.[0]?.message?.content || "";
    }
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (parsed.tool && MUTATING_TOOLS.has(parsed.tool)) return null; // never let the LLM mutate
    return parsed;
  } catch {
    return null; // fall back to the keyword router
  }
}

const MUTATING_TOOLS = new Set([
  "update_food_cart",
  "book_table",
  "place_food_order",
  "apply_food_coupon",
  "flush_food_cart",
  "create_cart",
  "confirm_order",
]);

module.exports = {
  routeMessage,
  extractQuery,
  buildCartItem,
  normalizeDish,
  dishNeedsMenuDetails,
  llmRoute,
  MUTATING_TOOLS,
};
