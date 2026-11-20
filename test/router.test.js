// Tests for lib/router.js — the deterministic keyword router.
// No network, no LLM key needed.
const test = require("node:test");
const assert = require("node:assert/strict");
const { routeMessage, extractQuery, buildCartItem } = require("../lib/router");

const LOC = { addressId: "addr_1", latitude: 28.61, longitude: 77.2 };

test("'biryani near me' routes to search_restaurants with a clean query", () => {
  const r = routeMessage("biryani near me", { location: LOC });
  assert.equal(r.intent, "discover");
  assert.equal(r.tool, "search_restaurants");
  assert.equal(r.server, "food");
  assert.equal(r.args.query, "biryani");
  assert.equal(r.args.addressId, "addr_1");
  assert.equal(r.followUp.tool, "search_menu");
});

test("discovery without a location flags needsLocation", () => {
  const r = routeMessage("pizza", { location: null });
  assert.equal(r.needsLocation, true);
});

test("'book a table for 2 tonight' routes to dineout search", () => {
  const r = routeMessage("book a table for 2 tonight", { location: LOC });
  assert.equal(r.intent, "dineout_search");
  assert.equal(r.tool, "search_restaurants_dineout");
  assert.equal(r.server, "dineout");
  assert.equal(r.args.latitude, 28.61);
  assert.equal(r.args.longitude, 77.2);
});

test("'my cart' needs a saved address", () => {
  const withAddr = routeMessage("show my cart", { location: LOC });
  assert.equal(withAddr.tool, "get_food_cart");
  const withoutAddr = routeMessage("show my cart", { location: { latitude: 28.6, longitude: 77.2 } });
  assert.equal(withoutAddr.tool, null);
  assert.equal(withoutAddr.needsLocation, true);
});

test("greeting does not call any tool", () => {
  const r = routeMessage("hello", { location: LOC });
  assert.equal(r.tool, null);
  assert.match(r.reply, /Hi!/);
});

test("extractQuery drops stopwords", () => {
  assert.equal(extractQuery("I want some veg biryani please"), "veg biryani");
  assert.equal(extractQuery("find me a good pizza near me"), "good pizza");
});

test("buildCartItem keeps the item's own variant format — never both", () => {
  const simple = buildCartItem({ menu_item_id: "m1", name: "Biryani" }, 2);
  assert.deepEqual(simple, { menu_item_id: "m1", quantity: 2 });

  const v2 = buildCartItem({
    menu_item_id: "m2",
    variantsV2: [
      { groupId: "g-size", variations: [{ id: "v-reg", name: "Regular", default: 1 }, { id: "v-lg", name: "Large" }] },
      { groupId: "g-spice", variations: [{ id: "v-mild", name: "Mild" }] },
    ],
  });
  assert.equal(v2.variantsV2.length, 2);
  assert.equal(v2.variantsV2[0].variation_id, "v-reg");
  assert.equal(v2.variantsV2[1].variation_id, "v-mild");
  assert.equal(v2.variants, undefined);

  const legacy = buildCartItem({
    menu_item_id: "m3",
    variations: [{ id: "v1", groupId: "g1", default: 0 }, { id: "v2", groupId: "g1", default: 1 }],
  });
  assert.equal(legacy.variants[0].variation_id, "v2");
  assert.equal(legacy.variantsV2, undefined);
});

test("buildCartItem throws without a menu_item_id", () => {
  assert.throws(() => buildCartItem({ name: "No id dish" }), /menu_item_id/);
});
