// Setuware AI Commerce Assistant — frontend.
// Talks only to this server's /api/* routes. The server talks to Swiggy MCP.
// No data is ever invented here: every card comes from a live tool response,
// and every mutation waits for the user's Confirm tap.
"use strict";

const $ = (id) => document.getElementById(id);
const chatEl = $("chat"), toolLogEl = $("toolLog"), inputEl = $("chatInput");

let authed = false;
let location = null; // { addressId?, latitude?, longitude?, label? }
let lastDishes = []; // dishes from the latest search, keyed for Add buttons
let pendingConfirm = null; // { kind, payload } resolved by the modal

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function inr(n) { return n == null ? "" : `₹${Number(n).toLocaleString("en-IN")}`; }

function addMsg(text, cls = "bot") {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function renderToolLog(calls) {
  if (!calls || !calls.length) return;
  const empty = toolLogEl.querySelector(".empty");
  if (empty) empty.remove();
  for (const c of calls) {
    const div = document.createElement("div");
    div.className = "call";
    const status = c.status === "ok"
      ? `<span class="ok">✓ ok · ${c.ms ?? "?"} ms</span>`
      : `<span class="error">✗ ${esc(c.error || "error")}</span>`;
    div.innerHTML = `<div class="head"><span><span class="server">${esc(c.server)}</span> · <span class="tool">${esc(c.tool)}</span></span>${status}</div>` +
      `<pre>${esc(JSON.stringify(c.args || {}, null, 2))}</pre>` +
      (c.summary ? `<div class="summary">${esc(c.summary)}</div>` : "");
    toolLogEl.appendChild(div);
  }
  toolLogEl.scrollTop = toolLogEl.scrollHeight;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && json.error === "AUTH_REQUIRED") {
    addMsg("⚠️ " + (json.message || "Sign in with Swiggy to continue."), "sys");
  }
  return { res, json };
}

async function refreshStatus() {
  const { json } = await api("/api/status");
  authed = !!json.authenticated;
  const pill = $("authState");
  if (authed) {
    pill.textContent = "✓ Signed in with Swiggy" + (json.tokenExpiresAt ? ` · token valid till ${new Date(json.tokenExpiresAt).toLocaleString()}` : "");
    pill.classList.add("ok");
    $("authBtn").hidden = true;
    $("logoutBtn").hidden = false;
    await loadAddresses();
  } else {
    pill.textContent = "Not signed in — sign in to search, build a cart & book a table";
    pill.classList.remove("ok");
    $("authBtn").hidden = false;
    $("logoutBtn").hidden = true;
  }
  if (json.location) { location = json.location; updateLocationLabel(); }
}

async function loadAddresses() {
  const { res, json } = await api("/api/addresses");
  if (!res.ok) return;
  const sel = $("addressSelect");
  const addresses = json.addresses || [];
  if (!addresses.length) return;
  sel.innerHTML = `<option value="">Choose a saved address…</option>` +
    addresses.map((a) => `<option value="${esc(a.id)}">${esc(a.addressLine || a.id)} (${esc(a.addressCategory || "")})</option>`).join("");
  sel.hidden = false;
  const def = json.resolution?.defaultAddressId || addresses[0].id;
  sel.value = def;
  setLocation({ addressId: def, label: sel.options[sel.selectedIndex]?.text || def });
}

function setLocation(loc) {
  location = loc;
  updateLocationLabel();
  if (loc) api("/api/location", loc);
}

function updateLocationLabel() {
  $("locationLabel").textContent = location
    ? `📍 ${location.label || (location.addressId ? "Saved address " + location.addressId : `${location.latitude}, ${location.longitude}`)}`
    : "📍 No location set — search needs one.";
}

// --- confirmation modal (the gate before every mutation) ---
function askConfirm(title, bodyHtml) {
  return new Promise((resolve) => {
    $("confirmTitle").textContent = title;
    $("confirmBody").innerHTML = bodyHtml;
    $("confirmModal").hidden = false;
    pendingConfirm = resolve;
  });
}
$("confirmYes").onclick = () => { $("confirmModal").hidden = true; pendingConfirm?.(true); pendingConfirm = null; };
$("confirmNo").onclick = () => { $("confirmModal").hidden = true; pendingConfirm?.(false); pendingConfirm = null; };
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("confirmModal").hidden) $("confirmNo").onclick();
});
$("confirmModal").addEventListener("click", (e) => {
  if (e.target === $("confirmModal")) $("confirmNo").onclick();
});

// --- chat ---
$("chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  addMsg(text, "user");
  const { json } = await api("/api/chat", { message: text, location });
  if (json.toolCalls) renderToolLog(json.toolCalls);
  if (json.ok === false) { addMsg("⚠️ " + (json.message || "Something went wrong."), "sys"); return; }
  if (json.reply) addMsg(json.reply, "bot");
  if (json.cards) renderCards(json.cards);
  if (json.needsLocation) addMsg("Tip: tap 'Use my location' above, or sign in and pick a saved address.", "sys");
});

function renderCards(cards) {
  const wrap = document.createElement("div");
  wrap.className = "cards";
  if (cards.type === "discover") {
    lastDishes = cards.dishes || [];
    for (const r of cards.restaurants || []) {
      const d = document.createElement("div");
      d.className = "card";
      const status = r.availabilityStatus === "OPEN" ? `<span class="open">● OPEN</span>` : `<span class="closed">${esc(r.availabilityStatus || "—")}</span>`;
      d.innerHTML = `<div class="row"><h4>${esc(r.name)}</h4><span>${status}</span></div>
        <div class="meta">${esc((r.cuisines || []).join(", "))} · ⭐ ${r.avgRating ?? "—"} · ${esc(r.areaName || "")} · ${r.distanceKm != null ? r.distanceKm + " km · " : ""}~${r.deliveryTimeMinutes ?? "?"} min · ${esc(r.costForTwo || "")}</div>
        <div class="row" style="margin-top:6px"><span class="meta">${esc(r.offer || "")}</span>
        <button class="btn small" data-menu="${esc(r.id)}">See menu</button></div>`;
      d.querySelector("[data-menu]").onclick = () => showMenu(r.id, r.name);
      wrap.appendChild(d);
    }
    for (const dish of cards.dishes || []) {
      wrap.appendChild(dishCard(dish));
    }
  } else if (cards.type === "menu") {
    lastDishes = cards.items || [];
    for (const item of cards.items || []) wrap.appendChild(dishCard(item));
  } else if (cards.type === "cart") {
    wrap.appendChild(cartCard(cards.cart));
  } else if (cards.type === "dineout") {
    for (const r of cards.restaurants || []) {
      const d = document.createElement("div");
      d.className = "card";
      d.innerHTML = `<h4>${esc(r.name)}</h4><div class="meta">${esc((r.cuisines || []).join(", "))} · ⭐ ${r.avgRating ?? "—"} · ${esc(r.costForTwo || "")} · ${esc(r.areaName || "")}</div>
        <div class="row" style="margin-top:6px"><span class="meta">${esc(r.offer || r.deals?.[0]?.title || "")}</span>
        <button class="btn small">Check slots</button></div>`;
      d.querySelector("button").onclick = () => showSlots(r.id, r.name);
      wrap.appendChild(d);
    }
  } else if (cards.type === "raw") {
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<pre style="white-space:pre-wrap">${esc(JSON.stringify(cards.data, null, 2).slice(0, 2000))}</pre>`;
    wrap.appendChild(d);
  }
  if (wrap.children.length) { chatEl.appendChild(wrap); chatEl.scrollTop = chatEl.scrollHeight; }
}

function dishCard(dish) {
  const d = document.createElement("div");
  d.className = "card";
  const veg = dish.isVeg ? "🟢 veg" : dish.isVeg === false ? "🔴 non-veg" : "";
  d.innerHTML = `<div class="row"><h4>${esc(dish.name)}</h4><span class="price">${inr(dish.price)}</span></div>
    <div class="meta">${veg} ${dish.isBestseller ? "· ★ Bestseller" : ""} · ${esc(dish.restaurant_name || "")}</div>
    <div class="row" style="margin-top:6px"><span class="meta">${esc(dish.description || "")}</span>
    <button class="btn small primary">Add to cart</button></div>`;
  d.querySelector("button").onclick = () => confirmAddToCart(dish);
  return d;
}

function cartCard(cart) {
  const d = document.createElement("div");
  d.className = "card";
  const items = cart.items || [];
  if (!items.length) { d.innerHTML = `<h4>Your cart</h4><div class="meta">Empty.</div>`; return d; }
  d.innerHTML = `<h4>Your cart — ${esc(cart.restaurant?.name || "")}</h4>` +
    items.map((i) => `<div class="row"><span>${i.quantity}× ${esc(i.name)}</span><span class="price">${inr(i.total ?? i.final_price)}</span></div>`).join("") +
    `<div class="row" style="margin-top:6px"><strong>To pay</strong><strong>${inr(cart.pricing?.to_pay)}</strong></div>
     <div class="meta">Demo stops here — no order is placed from this app.</div>`;
  return d;
}

async function showMenu(restaurantId, restaurantName) {
  addMsg(`Menu for ${restaurantName}…`, "bot");
  const { json } = await api("/api/menu", { restaurantId });
  if (json.toolCalls) renderToolLog(json.toolCalls);
  if (!json.ok) { addMsg("⚠️ " + (json.message || "Could not load the menu."), "sys"); return; }
  const cats = json.data?.categories || [];
  const items = cats.flatMap((c) => c.items || c.subcategories?.flatMap((s) => s.items || []) || []);
  lastDishes = items.map((i) => ({ ...i, restaurant_id: restaurantId, restaurant_name: restaurantName }));
  const wrap = document.createElement("div");
  wrap.className = "cards";
  items.slice(0, 12).forEach((item) => wrap.appendChild(dishCard({ ...item, restaurant_id: restaurantId, restaurant_name: restaurantName })));
  if (wrap.children.length) { chatEl.appendChild(wrap); chatEl.scrollTop = chatEl.scrollHeight; }
  else addMsg("No menu items came back for this restaurant.", "bot");
}

async function confirmAddToCart(dish) {
  if (!authed) { addMsg("⚠️ Sign in with Swiggy first — adding to cart needs your account.", "sys"); return; }
  if (!location) { addMsg("⚠️ Pick a location/address first.", "sys"); return; }
  const restaurantId = dish.restaurant_id || dish.restaurantId;
  const restaurantName = dish.restaurant_name || dish.restaurantName || "";
  const ok = await askConfirm("Add to cart?",
    `<p>Add <strong>${esc(dish.name)}</strong> (${inr(dish.price)}) from <strong>${esc(restaurantName)}</strong> to your Swiggy cart?</p>
     <p class="meta">This calls the live <code>update_food_cart</code> tool. Nothing is ordered — the demo stops at the cart.</p>`);
  if (!ok) return;
  const { json } = await api("/api/confirm-add", {
    restaurantId, restaurantName,
    dish: { menu_item_id: dish.menu_item_id, name: dish.name, variantsV2: dish.variantsV2, variations: dish.variations },
    quantity: 1,
  });
  if (json.toolCalls) renderToolLog(json.toolCalls);
  if (!json.ok) { addMsg("⚠️ " + (json.message || "Could not add to cart."), "sys"); return; }
  addMsg(json.message || "Added to cart.", "bot");
  if (json.cart) { const wrap = document.createElement("div"); wrap.className = "cards"; wrap.appendChild(cartCard(json.cart)); chatEl.appendChild(wrap); }
  chatEl.scrollTop = chatEl.scrollHeight;
}

// --- dineout slots + booking (confirmation-gated) ---
async function showSlots(restaurantId, restaurantName) {
  if (!location || location.latitude == null) { addMsg("⚠️ Table booking needs your coordinates — tap 'Use my location' first.", "sys"); return; }
  const date = new Date().toISOString().slice(0, 10);
  addMsg(`Checking slots at ${restaurantName} for ${date}…`, "bot");
  const { json } = await api("/api/dineout/slots", { restaurantId, date, latitude: location.latitude, longitude: location.longitude });
  if (json.toolCalls) renderToolLog(json.toolCalls);
  if (!json.ok) { addMsg("⚠️ " + (json.message || "Could not load slots."), "sys"); return; }
  const slots = (json.data?.slots || []).slice(0, 12);
  if (!slots.length) { addMsg("No slots came back for this restaurant/date.", "bot"); return; }
  const wrap = document.createElement("div");
  wrap.className = "cards";
  for (const s of slots) {
    const deal = (s.deals || [])[0];
    if (!deal) continue;
    const d = document.createElement("div");
    d.className = "card";
    d.innerHTML = `<div class="row"><h4>${esc(s.displayTime)} · ${esc(s.slotGroupName || "")}</h4><span class="price">${deal.isFree ? "FREE" : inr(deal.bookingPrice)}</span></div>
      <div class="meta">${esc(deal.title || "")} · ${esc(s.dateStr || date)} · ${s.availableInventory ?? "?"} left</div>
      <div class="row" style="margin-top:6px"><span></span><button class="btn small primary">Book this slot</button></div>`;
    d.querySelector("button").onclick = () => confirmBookTable({ restaurantId, restaurantName, slot: s, deal });
    wrap.appendChild(d);
  }
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
}

async function confirmBookTable({ restaurantId, restaurantName, slot, deal }) {
  if (!authed) { addMsg("⚠️ Sign in with Swiggy first — booking needs your account.", "sys"); return; }
  const isFree = deal.isFree !== false && !deal.bookingPrice;
  const ok = await askConfirm("Book this table?",
    `<p><strong>${esc(restaurantName)}</strong> — ${esc(slot.displayTime)}, ${esc(slot.dateStr || "")}, 2 guests.<br>
     Deal: ${esc(deal.title || "")} — ${isFree ? "FREE reservation" : "PAID prebook " + inr(deal.bookingPrice)}.</p>
     <p class="meta">This calls the live <code>book_table</code> tool${isFree ? "" : " (paid: via UPI QR after a cart step)"}. A real reservation is created — only confirm if you mean it.</p>`);
  if (!ok) return;
  const base = { restaurantId, slotId: slot.slotId, itemId: deal.itemId, reservationTime: slot.reservationTime, guestCount: 2, latitude: location.latitude, longitude: location.longitude };
  if (isFree) {
    const { json } = await api("/api/dineout/book", base);
    if (json.toolCalls) renderToolLog(json.toolCalls);
    addMsg(json.ok ? `✅ Table booked! Order ${json.data?.orderId || json.data?.booking?.orderId || ""} — ${restaurantName}, ${slot.displayTime}.` : "⚠️ " + (json.message || "Booking failed."), json.ok ? "bot" : "sys");
  } else {
    const { json: cartJson } = await api("/api/dineout/create-cart", base);
    if (cartJson.toolCalls) renderToolLog(cartJson.toolCalls);
    if (!cartJson.ok) { addMsg("⚠️ " + (cartJson.message || "Could not create the booking cart."), "sys"); return; }
    const cartKey = cartJson.data?.cartKey || cartJson.data?.data?.cartKey;
    addMsg(`Booking summary created (cart ${cartKey || ""}). This is a paid prebook — the next step takes UPI payment via QR.`, "bot");
    const pay = await askConfirm("Proceed to UPI payment?",
      `<p>Pay ${inr(deal.bookingPrice)} via UPI QR to confirm the booking at <strong>${esc(restaurantName)}</strong>?</p>`);
    if (!pay) return;
    const { json } = await api("/api/dineout/book", { ...base, paymentMethod: "UPI", cartKey });
    if (json.toolCalls) renderToolLog(json.toolCalls);
    if (json.ok && json.data?.status === "PENDING_PAYMENT") {
      addMsg(`Payment pending — scan the QR / open the UPI link to complete: ${json.data.bridgeUrl || json.data.upiIntentUrl || "(link in tool log)"}. The booking confirms only after you pay in your UPI app.`, "bot");
    } else if (json.ok) {
      addMsg(`✅ Table booked! Order ${json.data?.orderId || ""}.`, "bot");
    } else {
      addMsg("⚠️ " + (json.message || "Booking failed."), "sys");
    }
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

// --- header / location controls ---
$("authBtn").onclick = () => { window.location.href = "/auth/login"; };
$("logoutBtn").onclick = () => { window.location.href = "/auth/logout"; };
$("geoBtn").onclick = () => {
  if (!navigator.geolocation) { addMsg("Geolocation is not available in this browser.", "sys"); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: `GPS ${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}` }),
    () => addMsg("Location permission denied — sign in and pick a saved address instead.", "sys")
  );
};
$("addressSelect").addEventListener("change", (e) => {
  const sel = e.target;
  if (sel.value) setLocation({ addressId: sel.value, label: sel.options[sel.selectedIndex]?.text || sel.value });
});
$("cartBtn").onclick = async () => {
  const { json } = await api("/api/cart", {});
  if (json.toolCalls) renderToolLog(json.toolCalls);
  if (!json.ok) { addMsg("⚠️ " + (json.message || "Could not load the cart."), "sys"); return; }
  const wrap = document.createElement("div");
  wrap.className = "cards";
  wrap.appendChild(cartCard(json.cart || {}));
  chatEl.appendChild(wrap);
  chatEl.scrollTop = chatEl.scrollHeight;
};
$("clearLogBtn").onclick = () => { toolLogEl.innerHTML = '<p class="empty">Log cleared.</p>'; };

refreshStatus();
if (new URLSearchParams(location.search).get("auth") === "ok") {
  addMsg("✅ Signed in with Swiggy — your token stays in this browser only. Try 'biryani near me'.", "sys");
}
addMsg("Hi! I'm the Setuware AI Commerce Assistant, running on live Swiggy MCP. Sign in with Swiggy (top-right), then ask me for food ('biryani near me') or a table ('book a table for 2 tonight'). Everything I show comes from Swiggy's real servers — nothing here is mocked.", "bot");
