// OAuth 2.1 + PKCE auth against https://mcp.swiggy.com/auth.
// Built from the live docs: https://mcp.swiggy.com/builders/docs/start/authenticate.md
// and the swiggy-cli reference (HKTITAN/swiggy-cli AGENTS.md).
//
// Flow:
//   1. Dynamic Client Registration (RFC 7591): POST /auth/register
//      -> { client_id }  (no pre-registered client needed)
//   2. GET /auth/authorize?response_type=code&client_id=...&redirect_uri=...
//      &code_challenge=<S256>&code_challenge_method=S256&state=...&scope=mcp:tools
//      User completes phone + OTP in the browser (Swiggy's own UI — we never
//      touch phone numbers or OTPs).
//   3. Redirect lands on /auth/callback?code=...&state=...
//      POST /auth/token { grant_type: "authorization_code", code, code_verifier, redirect_uri }
//      -> { access_token, refresh_token, expires_in: 432000 (5 days), scope }
//   4. Refresh: POST /auth/token { grant_type: "refresh_token", refresh_token }
//      -> new access token valid 30 days + rotated refresh token.
//
// Tokens live ONLY in .swiggy-tokens.json (mode 0600, gitignored). Never logged.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUTH_BASE = "https://mcp.swiggy.com/auth";
const TOKEN_FILE = path.join(__dirname, "..", ".swiggy-tokens.json");
const CLIENT_FILE = path.join(__dirname, "..", ".swiggy-client.json");

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function newPkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function saveJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

/** Dynamic client registration. Returns { client_id, ... } and persists it. */
async function registerClient(redirectUri, fetchFn = fetch) {
  const existing = loadJson(CLIENT_FILE);
  if (existing && existing.client_id && existing.redirect_uri === redirectUri) {
    return existing;
  }
  const res = await fetchFn(`${AUTH_BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      client_name: "Setuware AI Commerce Assistant",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools mcp:resources mcp:prompts",
    }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`Dynamic client registration failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const client = JSON.parse(body);
  if (!client.client_id) throw new Error(`DCR response had no client_id: ${body.slice(0, 300)}`);
  client.redirect_uri = redirectUri;
  saveJson(CLIENT_FILE, client);
  return client;
}

/** Build the /auth/authorize URL. Returns { url, state, verifier }. */
function buildAuthorizeUrl(clientId, redirectUri) {
  const { verifier, challenge } = newPkcePair();
  const state = b64url(crypto.randomBytes(16));
  const url =
    `${AUTH_BASE}/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      scope: "mcp:tools",
    }).toString();
  return { url, state, verifier };
}

/** Exchange an authorization code for tokens. Persists tokens, returns them. */
async function exchangeCode({ code, verifier, redirectUri, fetchFn = fetch }) {
  const client = loadJson(CLIENT_FILE);
  const body = {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
  };
  if (client && client.client_id) body.client_id = client.client_id;
  const res = await fetchFn(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const tokens = JSON.parse(text);
  storeTokens(tokens);
  return tokens;
}

/** Refresh the access token. Returns fresh tokens, persists them. */
async function refreshTokens(fetchFn = fetch) {
  const stored = loadJson(TOKEN_FILE);
  if (!stored || !stored.refresh_token) throw new Error("No refresh token stored");
  const res = await fetchFn(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: stored.refresh_token }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const tokens = JSON.parse(text);
  storeTokens(tokens);
  return tokens;
}

function storeTokens(tokens) {
  const stored = loadJson(TOKEN_FILE) || {};
  const merged = {
    ...stored,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || stored.refresh_token,
    token_type: tokens.token_type || "Bearer",
    scope: tokens.scope || stored.scope,
    // expires_in is seconds from now (432000 = 5 days for a fresh token,
    // 2592000 = 30 days after a refresh).
    expires_at: Date.now() + (tokens.expires_in || 432000) * 1000,
    obtained_at: Date.now(),
  };
  saveJson(TOKEN_FILE, merged);
  return merged;
}

function getStoredTokens() {
  return loadJson(TOKEN_FILE);
}

function clearTokens() {
  for (const f of [TOKEN_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

/** True when we hold a token that has not yet expired (with a 60s safety margin). */
function hasValidToken() {
  const t = loadJson(TOKEN_FILE);
  return Boolean(t && t.access_token && t.expires_at && t.expires_at - Date.now() > 60_000);
}

async function logout(fetchFn = fetch) {
  const t = loadJson(TOKEN_FILE);
  if (t && t.access_token) {
    try {
      await fetchFn(`${AUTH_BASE}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t.access_token}` },
      });
    } catch {
      /* best effort */
    }
  }
  clearTokens();
}

module.exports = {
  AUTH_BASE,
  registerClient,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  storeTokens,
  getStoredTokens,
  clearTokens,
  hasValidToken,
  logout,
  newPkcePair,
};
