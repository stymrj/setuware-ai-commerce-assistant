// Live verification against the REAL Swiggy MCP endpoints.
// Read-only by design: it only sends initialize / tools/list WITHOUT a
// token (expecting a proper auth error — that proves real connectivity)
// and performs Dynamic Client Registration to build the authorize URL.
// It NEVER completes auth, never calls a tool, never mutates anything.
// Run: npm run verify-live
// Output is written to verification/live-check.json for the record.

import fs from "node:fs";

const BASE = "https://mcp.swiggy.com";
const REDIRECT_URI = "http://localhost:3000/auth/callback";
const results = {};

async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), body: text.slice(0, 500) };
}

async function step(name, fn) {
  try {
    results[name] = await fn();
    console.log(`[ok] ${name}:`, JSON.stringify(results[name]).slice(0, 300));
  } catch (err) {
    results[name] = { error: err.message };
    console.log(`[fail] ${name}: ${err.message}`);
  }
}

await step("food_initialize_no_auth", async () => {
  const r = await postJson(`${BASE}/food`, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setuware-commerce-assistant", version: "0.1.0" } },
  });
  return r; // expect HTTP 401 (or JSON-RPC -32001) — proves the endpoint is live
});

await step("food_tools_list_no_auth", async () => {
  const r = await postJson(`${BASE}/food`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return r;
});

await step("dineout_initialize_no_auth", async () => {
  const r = await postJson(`${BASE}/dineout`, {
    jsonrpc: "2.0",
    id: 3,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "setuware-commerce-assistant", version: "0.1.0" } },
  });
  return r;
});

await step("oauth_metadata", async () => {
  const res = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 500) };
});

await step("dynamic_client_registration", async () => {
  const r = await postJson(`${BASE}/auth/register`, {
    redirect_uris: [REDIRECT_URI],
    client_name: "Setuware AI Commerce Assistant",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "mcp:tools mcp:resources mcp:prompts",
  });
  // Never print a client_secret if one is ever returned — only the client_id.
  let clientId = null;
  try {
    clientId = JSON.parse(r.body).client_id || null;
  } catch { /* keep null */ }
  return { status: r.status, client_id: clientId, rawHead: r.body.slice(0, 200) };
});

if (results.dynamic_client_registration?.client_id) {
  const { randomBytes, createHash } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorizeUrl =
    `${BASE}/auth/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: results.dynamic_client_registration.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "mcp:tools",
    }).toString();
  results.authorize_url_generated = { ok: true, url: authorizeUrl, note: "Generated only — NOT visited. Satyam completes phone + OTP in the browser." };
  console.log("[ok] authorize_url_generated:", authorizeUrl);
}

fs.mkdirSync("verification", { recursive: true });
fs.writeFileSync("verification/live-check.json", JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
console.log("\nWrote verification/live-check.json");
