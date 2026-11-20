// Tests for the Vercel/serverless path: cookie token storage, per-request
// base-URL derivation, DCR re-registration on redirect change, and a full
// login -> callback -> status flow against the real handler with a stubbed
// Swiggy auth endpoint. Nothing here touches mcp.swiggy.com.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const auth = require("../lib/auth");
const { handleRequest, deriveBaseUrl } = require("../server");

const CLIENT_FILE = path.join(__dirname, "..", ".swiggy-client.json");

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

function setCookieValues(res) {
  const raw = res.headers && res.headers["Set-Cookie"];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function cookieValue(setCookie, name) {
  const hit = setCookieValues({ headers: { "Set-Cookie": setCookie } }).find((s) => s.startsWith(`${name}=`));
  if (!hit) return null;
  return hit.split(";")[0].slice(name.length + 1);
}

// --- Cookie token storage ---

test("tokens cookie round-trips the token set, Secure only on https", () => {
  const tokens = {
    access_token: "acc_123",
    refresh_token: "ref_456",
    token_type: "Bearer",
    scope: "mcp:tools",
    expires_at: Date.now() + 432000 * 1000,
  };
  const httpsCookie = auth.serializeTokensCookie(tokens, true);
  assert.match(httpsCookie, /^sca_tokens=/);
  assert.match(httpsCookie, /HttpOnly/);
  assert.match(httpsCookie, /SameSite=Lax/);
  assert.match(httpsCookie, /Secure/);
  assert.match(httpsCookie, /Max-Age=2592000/);
  const parsed = auth.parseTokensCookie(httpsCookie);
  assert.equal(parsed.access_token, "acc_123");
  assert.equal(parsed.refresh_token, "ref_456");
  assert.equal(parsed.expires_at, tokens.expires_at);

  const httpCookie = auth.serializeTokensCookie(tokens, false);
  assert.doesNotMatch(httpCookie, /Secure/);
  assert.equal(auth.parseTokensCookie(httpCookie).access_token, "acc_123");
});

test("parseTokensCookie returns null on missing or malformed cookies", () => {
  assert.equal(auth.parseTokensCookie(undefined), null);
  assert.equal(auth.parseTokensCookie("other=1; foo=bar"), null);
  assert.equal(auth.parseTokensCookie("sca_tokens=!!!not-base64!!!"), null);
  assert.equal(auth.parseTokensCookie("sca_tokens=bm90LWpzb24="), null); // "not-json"
});

test("OAuth state cookie round-trips and clears", () => {
  const cookie = auth.serializeOAuthStateCookie("state1", "verifier1", true);
  assert.match(cookie, /^sca_oauth=/);
  assert.match(cookie, /Path=\/auth\/callback/);
  assert.match(cookie, /Max-Age=600/);
  const parsed = auth.parseOAuthStateCookie(cookie);
  assert.deepEqual(parsed, { state: "state1", verifier: "verifier1" });
  assert.equal(auth.parseOAuthStateCookie("sca_oauth=junk"), null);

  const cleared = auth.clearCookie(auth.OAUTH_COOKIE, true, "/auth/callback");
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\/auth\/callback/);
});

// --- Base URL derivation ---

test("deriveBaseUrl prefers BASE_URL, then forwarded headers, then Host", () => {
  const req = (headers) => ({ headers, socket: {} });
  assert.equal(deriveBaseUrl(req({ host: "demo.vercel.app", "x-forwarded-proto": "https" })), "https://demo.vercel.app");
  assert.equal(
    deriveBaseUrl(req({ host: "a.internal", "x-forwarded-host": "demo.vercel.app", "x-forwarded-proto": "https, http" })),
    "https://demo.vercel.app"
  );
  assert.equal(deriveBaseUrl(req({ host: "localhost:3000" })), "http://localhost:3000");

  process.env.BASE_URL = "https://example.com/";
  try {
    assert.equal(deriveBaseUrl(req({ host: "demo.vercel.app" })), "https://example.com");
  } finally {
    delete process.env.BASE_URL;
  }
});

// --- Dynamic client registration ---

test("registerClient re-registers when the redirect URI changes", async () => {
  const saved = fs.existsSync(CLIENT_FILE) ? fs.readFileSync(CLIENT_FILE, "utf8") : null;
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(url);
    return { ok: true, status: 201, text: async () => JSON.stringify({ client_id: "swiggy-mcp" }) };
  };
  try {
    const first = await auth.registerClient("https://one.example/auth/callback");
    assert.equal(first.client_id, "swiggy-mcp");
    assert.equal(calls.length, 1);
    // Same URI again: served from the in-memory cache, no second POST.
    await auth.registerClient("https://one.example/auth/callback");
    assert.equal(calls.length, 1);
    // Different URI: re-registers.
    await auth.registerClient("https://two.example/auth/callback");
    assert.equal(calls.length, 2);
  } finally {
    global.fetch = realFetch;
    if (saved === null) {
      try { fs.unlinkSync(CLIENT_FILE); } catch { /* already gone */ }
    } else {
      fs.writeFileSync(CLIENT_FILE, saved);
    }
  }
});

// --- Full serverless flow, offline ---

test("login -> callback -> status works with cookies on a Vercel-style host", async () => {
  const saved = fs.existsSync(CLIENT_FILE) ? fs.readFileSync(CLIENT_FILE, "utf8") : null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).endsWith("/auth/register")) {
      return { ok: true, status: 201, text: async () => JSON.stringify({ client_id: "swiggy-mcp" }) };
    }
    if (String(url).endsWith("/auth/token")) {
      const body = JSON.parse(opts.body);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.redirect_uri, "https://demo.vercel.app/auth/callback");
      assert.equal(typeof body.code_verifier, "string");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: "tok_test", refresh_token: "ref_test", expires_in: 432000, token_type: "Bearer", scope: "mcp:tools" }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    // 1. Login from behind the Vercel proxy.
    const loginReq = fakeReq({
      url: "/auth/login",
      headers: { host: "demo.vercel.app", "x-forwarded-proto": "https", "x-forwarded-host": "demo.vercel.app" },
    });
    const loginRes = fakeRes();
    await handleRequest(loginReq, loginRes);
    assert.equal(loginRes.statusCode, 302);
    assert.match(loginRes.headers.Location, /^https:\/\/mcp\.swiggy\.com\/auth\/authorize\?/);
    assert.match(loginRes.headers.Location, /redirect_uri=https%3A%2F%2Fdemo\.vercel\.app%2Fauth%2Fcallback/);
    assert.match(loginRes.headers.Location, /code_challenge_method=S256/);
    const oauthCookie = cookieValue(loginRes.headers["Set-Cookie"], auth.OAUTH_COOKIE);
    assert.ok(oauthCookie, "login sets the sca_oauth cookie");
    assert.match(setCookieValues(loginRes).join(";"), /Secure/);
    const oauth = auth.parseOAuthStateCookie(`${auth.OAUTH_COOKIE}=${oauthCookie}`);
    assert.ok(oauth && oauth.state && oauth.verifier);

    // 2. Callback with the code + the cookie (no in-memory state needed).
    const cbReq = fakeReq({
      url: `/auth/callback?code=authcode123&state=${oauth.state}`,
      headers: {
        host: "demo.vercel.app",
        "x-forwarded-proto": "https",
        cookie: `${auth.OAUTH_COOKIE}=${oauthCookie}`,
      },
    });
    const cbRes = fakeRes();
    await handleRequest(cbReq, cbRes);
    assert.equal(cbRes.statusCode, 302);
    assert.equal(cbRes.headers.Location, "/?auth=ok");
    const tokensCookie = cookieValue(cbRes.headers["Set-Cookie"], auth.TOKENS_COOKIE);
    assert.ok(tokensCookie, "callback sets the sca_tokens cookie");
    const tokens = auth.parseTokensCookie(`${auth.TOKENS_COOKIE}=${tokensCookie}`);
    assert.equal(tokens.access_token, "tok_test");
    assert.equal(tokens.refresh_token, "ref_test");
    assert.ok(tokens.expires_at > Date.now());
    assert.ok(cbRes.headers["Set-Cookie"] && setCookieValues(cbRes).join(";").includes(`${auth.OAUTH_COOKIE}=`), "oauth cookie is cleared");

    // 3. A follow-up API call reads the token from the cookie.
    const statusReq = fakeReq({
      url: "/api/status",
      headers: {
        host: "demo.vercel.app",
        "x-forwarded-proto": "https",
        cookie: `${auth.TOKENS_COOKIE}=${tokensCookie}`,
      },
    });
    const statusRes = fakeRes();
    await handleRequest(statusReq, statusRes);
    assert.equal(statusRes.statusCode, 200);
    const status = JSON.parse(statusRes.body);
    assert.equal(status.authenticated, true);
    assert.equal(status.tokenStorage, "cookie");
    assert.ok(status.tokenExpiresAt > Date.now());

    // 4. No cookie, no file -> not authenticated.
    const anonReq = fakeReq({
      url: "/api/status",
      headers: { host: "demo.vercel.app", "x-forwarded-proto": "https" },
    });
    const anonRes = fakeRes();
    await handleRequest(anonReq, anonRes);
    const anon = JSON.parse(anonRes.body);
    assert.equal(anon.authenticated, false);
    assert.equal(anon.tokenStorage, "cookie");
  } finally {
    global.fetch = realFetch;
    if (saved === null) {
      try { fs.unlinkSync(CLIENT_FILE); } catch { /* already gone */ }
    } else {
      fs.writeFileSync(CLIENT_FILE, saved);
    }
  }
});

test("localhost keeps the file token path (tokenStorage=file)", async () => {
  const req = fakeReq({ url: "/api/status", headers: { host: "localhost:3000" } });
  const res = fakeRes();
  await handleRequest(req, res);
  assert.equal(res.statusCode, 200);
  const status = JSON.parse(res.body);
  assert.equal(status.tokenStorage, "file");
});
