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
// Tokens live in .swiggy-tokens.json (mode 0600, gitignored) when running on
// localhost, or in an HttpOnly Secure cookie (see serializeTokensCookie)
// when served from a stateless host such as Vercel. Never logged.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const AUTH_BASE = "https://mcp.swiggy.com/auth";
const TOKEN_FILE = path.join(__dirname, "..", ".swiggy-tokens.json");
const CLIENT_FILE = path.join(__dirname, "..", ".swiggy-client.json");
const TOKENS_COOKIE = "sca_tokens";
const OAUTH_COOKIE = "sca_oauth";
// 30 days — the refresh token's lifetime. The access token's own expiry
// (5 days) is tracked inside the cookie value (expires_at).
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// In-memory DCR cache, keyed by redirect URI. On a stateless host the
// client file is not writable, so this keeps repeat logins in one instance
// from re-registering; a cold start just re-registers (one extra POST,
// client_id is fixed server-side).
const clientCache = new Map();

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

/** Best-effort write: on a stateless host the app directory is read-only,
 * so a failed persist must not break the request — the in-memory cache
 * above still serves this instance. */
function saveJsonBestEffort(file, obj) {
  try {
    saveJson(file, obj);
  } catch {
    /* read-only fs (e.g. Vercel) — in-memory cache covers this instance */
  }
}

/** Dynamic client registration. Returns { client_id, ... } and persists it.
 * Re-registers when the redirect URI changes (the stored record is keyed
 * by it), so a new public URL gets a matching registration. */
async function registerClient(redirectUri, fetchFn = fetch) {
  const cached = clientCache.get(redirectUri);
  if (cached) return cached;
  const existing = loadJson(CLIENT_FILE);
  if (existing && existing.client_id && existing.redirect_uri === redirectUri) {
    clientCache.set(redirectUri, existing);
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
  clientCache.set(redirectUri, client);
  saveJsonBestEffort(CLIENT_FILE, client);
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

/** Exchange an authorization code for tokens. Returns them.
 * With persist (default, localhost) they are also written to the token
 * file; with persist=false (stateless host) the caller stores them in the
 * response cookie instead. */
async function exchangeCode({ code, verifier, redirectUri, fetchFn = fetch, persist = true }) {
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
  // Normalize: the raw token response has expires_in (seconds from now);
  // callers need the absolute expires_at regardless of where the tokens
  // are stored (file or cookie).
  const normalized = {
    ...tokens,
    expires_at: Date.now() + (tokens.expires_in || 432000) * 1000,
    obtained_at: Date.now(),
  };
  if (persist) storeTokens(normalized);
  return normalized;
}

/** Refresh an access token from a given token set. Pure: merges and
 * returns fresh tokens without persisting — the caller decides where
 * they live (file on localhost, cookie on a stateless host). */
async function refreshWithTokens(tokens, fetchFn = fetch) {
  if (!tokens || !tokens.refresh_token) throw new Error("No refresh token stored");
  const res = await fetchFn(`${AUTH_BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token refresh failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const fresh = JSON.parse(text);
  return {
    ...tokens,
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    token_type: fresh.token_type || "Bearer",
    scope: fresh.scope || tokens.scope,
    expires_at: Date.now() + (fresh.expires_in || 432000) * 1000,
    obtained_at: Date.now(),
  };
}

/** Refresh the access token. Returns fresh tokens, persists them (file). */
async function refreshTokens(fetchFn = fetch) {
  const stored = loadJson(TOKEN_FILE);
  if (!stored || !stored.refresh_token) throw new Error("No refresh token stored");
  const merged = await refreshWithTokens(stored, fetchFn);
  saveJson(TOKEN_FILE, merged);
  return merged;
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

/** True when the given token set (or the file store, when none is passed)
 * holds a token that has not yet expired (with a 60s safety margin). */
function hasValidToken(tokens) {
  const t = tokens === undefined ? loadJson(TOKEN_FILE) : tokens;
  return Boolean(t && t.access_token && t.expires_at && t.expires_at - Date.now() > 60_000);
}

async function logoutWithTokens(tokens, fetchFn = fetch) {
  if (tokens && tokens.access_token) {
    try {
      await fetchFn(`${AUTH_BASE}/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
    } catch {
      /* best effort */
    }
  }
}

async function logout(fetchFn = fetch) {
  const t = loadJson(TOKEN_FILE);
  await logoutWithTokens(t, fetchFn);
  clearTokens();
}

// ---------------------------------------------------------------------------
// Stateless token storage: HttpOnly cookies.
// The cookie holds ONLY the tokens (base64url JSON, minimal fields) — no
// other user data. SameSite=Lax keeps the OAuth callback (a top-level GET
// navigation back from Swiggy) working; Secure is set on https origins.
// ---------------------------------------------------------------------------

function tokensCookieValue(tokens) {
  const minimal = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type || "Bearer",
    scope: tokens.scope,
    expires_at: tokens.expires_at,
  };
  return Buffer.from(JSON.stringify(minimal), "utf8").toString("base64url");
}

/** Build the Set-Cookie value for a token set. */
function serializeTokensCookie(tokens, secure) {
  const attrs = [
    `${TOKENS_COOKIE}=${tokensCookieValue(tokens)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Parse the token set out of a Cookie header. Returns null when absent
 * or malformed — never throws. */
function parseTokensCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const pair = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${TOKENS_COOKIE}=`));
  if (!pair) return null;
  try {
    const t = JSON.parse(Buffer.from(pair.slice(TOKENS_COOKIE.length + 1), "base64url").toString("utf8"));
    if (t && typeof t.access_token === "string") return t;
    return null;
  } catch {
    return null;
  }
}

/** Build the Set-Cookie value for the one-time OAuth state (PKCE verifier).
 * Short-lived (10 min) and scoped to the callback path. */
function serializeOAuthStateCookie(oauthState, verifier, secure) {
  const value = Buffer.from(JSON.stringify({ state: oauthState, verifier }), "utf8").toString("base64url");
  const attrs = [
    `${OAUTH_COOKIE}=${value}`,
    "Path=/auth/callback",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Parse the OAuth state cookie. Returns { state, verifier } or null. */
function parseOAuthStateCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const pair = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${OAUTH_COOKIE}=`));
  if (!pair) return null;
  try {
    const v = JSON.parse(Buffer.from(pair.slice(OAUTH_COOKIE.length + 1), "base64url").toString("utf8"));
    if (v && typeof v.state === "string" && typeof v.verifier === "string") return v;
    return null;
  } catch {
    return null;
  }
}

/** Build a Set-Cookie value that deletes a cookie. */
function clearCookie(name, secure, cookiePath = "/") {
  const attrs = [`${name}=`, `Path=${cookiePath}`, "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

module.exports = {
  AUTH_BASE,
  TOKENS_COOKIE,
  OAUTH_COOKIE,
  registerClient,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  refreshWithTokens,
  storeTokens,
  getStoredTokens,
  clearTokens,
  hasValidToken,
  logout,
  logoutWithTokens,
  newPkcePair,
  serializeTokensCookie,
  parseTokensCookie,
  serializeOAuthStateCookie,
  parseOAuthStateCookie,
  clearCookie,
};
