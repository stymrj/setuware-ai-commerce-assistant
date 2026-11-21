// The mutation routes must refuse to call Swiggy unless the user confirmed.
// These tests hit the real handler with a stubbed fetch. They never reach
// mcp.swiggy.com. The UI gate is asserted from public/app.js source order:
// askConfirm resolves before any /api/confirm-add or /api/dineout/book fetch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const auth = require("../lib/auth");
const { handleRequest } = require("../server");

function fakeReq({ method = "GET", url = "/", headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = {};
  return req;
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = null;
  res.body = "";
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (chunk) => {
    if (chunk) res.body += chunk;
    res.emit("finish");
  };
  return res;
}

async function post(url, body, headers = {}) {
  const req = fakeReq({
    method: "POST",
    url,
    headers: { host: "localhost:3000", ...headers },
  });
  const res = fakeRes();
  const pending = handleRequest(req, res);
  req.emit("data", JSON.stringify(body));
  req.emit("end");
  await pending;
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test("confirm-add and book_table do not call Swiggy without confirmed:true", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("Swiggy must not be called");
  };
  try {
    const cart = await post("/api/confirm-add", {
      restaurantId: "rest_1",
      dish: { menu_item_id: "dish_1", name: "Biryani" },
    });
    assert.equal(cart.status, 400);
    assert.equal(cart.json.error, "CONFIRMATION_REQUIRED");

    const book = await post("/api/dineout/book", { restaurantId: "rest_1", slotId: 1 });
    assert.equal(book.status, 400);
    assert.equal(book.json.error, "CONFIRMATION_REQUIRED");

    const created = await post("/api/dineout/create-cart", { restaurantId: "rest_1" });
    assert.equal(created.status, 400);
    assert.equal(created.json.error, "CONFIRMATION_REQUIRED");

    assert.equal(calls, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test("a confirmed cart add still does not call Swiggy before sign-in and a saved address", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("Swiggy must not be called");
  };
  try {
    const expired = auth.serializeTokensCookie(
      { access_token: "expired", refresh_token: "expired", expires_at: Date.now() - 1000 },
      false
    );
    const anon = await post(
      "/api/confirm-add",
      { confirmed: true, restaurantId: "rest_1", dish: { id: "dish_from_menu", name: "Paneer" } },
      { cookie: expired }
    );
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error, "AUTH_REQUIRED");

    const cookie = auth.serializeTokensCookie(
      { access_token: "tok_test", refresh_token: "ref_test", expires_at: Date.now() + 10 * 60_000 },
      false
    );
    const noAddress = await post(
      "/api/confirm-add",
      { confirmed: true, restaurantId: "rest_1", dish: { menu_item_id: "dish_1", name: "Biryani" } },
      { cookie }
    );
    assert.equal(noAddress.status, 400);
    assert.equal(noAddress.json.error, "NO_ADDRESS");
    assert.equal(calls, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test("unsigned chat asks for sign-in and does not call Swiggy", async () => {
  const realFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    throw new Error("Swiggy must not be called");
  };
  try {
    const expired = auth.serializeTokensCookie(
      { access_token: "expired", refresh_token: "expired", expires_at: Date.now() - 1000 },
      false
    );
    const out = await post("/api/chat", { message: "biryani near me" }, { cookie: expired });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);
    assert.match(out.json.reply, /Sign in with Swiggy/);
    assert.deepEqual(out.json.toolCalls, []);
    assert.equal(calls, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test("the cart and booking buttons wait for the confirm dialog", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const add = src.slice(src.indexOf("async function confirmAddToCart"), src.indexOf("async function showSlots"));
  const book = src.slice(src.indexOf("async function confirmBookTable"), src.indexOf("// --- header"));
  const addConfirm = add.indexOf("await askConfirm");
  const addPost = add.indexOf("/api/confirm-add");
  assert.ok(addConfirm !== -1 && addPost !== -1 && addConfirm < addPost);
  assert.ok(add.indexOf("Cancelled. Nothing was sent to Swiggy.") < addPost);
  assert.match(add, /confirmed:\s*true/);
  const bookConfirm = book.indexOf("await askConfirm");
  assert.ok(bookConfirm !== -1 && bookConfirm < book.indexOf("/api/dineout/create-cart"));
  assert.ok(bookConfirm < book.indexOf("/api/dineout/book"));
  assert.ok(book.indexOf("Cancelled. Nothing was sent to Swiggy.") < book.indexOf("/api/dineout/book"));
  assert.match(book, /confirmed:\s*true/);
  assert.doesNotMatch(src, /place_food_order/);
  // A top-level `let location` is a browser SyntaxError (it clashes with
  // window.location) and stops the whole page from running.
  assert.doesNotMatch(src, /^(?:let|const|var)\s+location\b/m);
});
