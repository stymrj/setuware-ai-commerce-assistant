// Minimal MCP Streamable HTTP client for Swiggy MCP servers.
// Raw JSON-RPC 2.0 over fetch — no SDK. Built from the live docs:
// https://mcp.swiggy.com/builders/docs/build/connect-with-mcp-sdk.md
// https://mcp.swiggy.com/builders/docs/reference/protocol.md
//
// Transport facts (verified from the docs, 2026-11-20):
// - POST https://mcp.swiggy.com/{food,im,dineout,scenes}
// - Headers: Content-Type: application/json,
//   Accept: application/json, text/event-stream,
//   Authorization: Bearer <access_token>
// - Protocol version: 2025-06-18
// - Responses may be plain JSON or SSE (text/event-stream) — both are parsed.
// - Auth failures surface as HTTP 401 or JSON-RPC error -32001.

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "setuware-commerce-assistant", version: "0.1.0" };

const SERVERS = {
  food: "https://mcp.swiggy.com/food",
  im: "https://mcp.swiggy.com/im",
  dineout: "https://mcp.swiggy.com/dineout",
  scenes: "https://mcp.swiggy.com/scenes",
};

class McpError extends Error {
  constructor(message, { httpStatus = null, rpcCode = null, isAuth = false } = {}) {
    super(message);
    this.name = "McpError";
    this.httpStatus = httpStatus;
    this.rpcCode = rpcCode;
    this.isAuth = isAuth;
  }
}

/** Parse an MCP response body: plain JSON, or SSE `data:` lines. */
function parseResponseBody(text, contentType = "") {
  if (contentType.includes("text/event-stream") || text.includes("event:") || text.startsWith("data:")) {
    const messages = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          messages.push(JSON.parse(payload));
        } catch {
          // Ignore non-JSON SSE data lines (e.g. pings).
        }
      }
    }
    // The last JSON-RPC response message wins; notifications have no `id`.
    const responses = messages.filter((m) => m && typeof m.id !== "undefined");
    return responses.length ? responses[responses.length - 1] : messages[messages.length - 1];
  }
  return JSON.parse(text);
}

/** Extract the tool payload from a tools/call result, per the docs. */
function readToolData(result) {
  if (!result) throw new McpError("Empty tool result");
  if (result.isError) {
    const text = (result.content || []).map((c) => c.text || "").join(" ").trim();
    throw new McpError(text || "Tool returned isError", { rpcCode: -1 });
  }
  if (result.structuredContent && Object.keys(result.structuredContent).length) {
    return result.structuredContent;
  }
  // Fallback: JSON envelope in the first content block: {success, data, message}
  const firstText = (result.content || []).find((c) => c.type === "text" && c.text)?.text;
  if (firstText) {
    try {
      const envelope = JSON.parse(firstText);
      if (envelope && typeof envelope === "object") {
        if (envelope.success === false) {
          throw new McpError(envelope.error?.message || envelope.message || "Tool call failed");
        }
        // Merge fields next to `data` (e.g. Dineout `booking`) into the payload.
        const { data, ...rest } = envelope;
        return { ...(data && typeof data === "object" ? data : { value: data }), ...rest };
      }
    } catch (e) {
      if (e instanceof McpError) throw e;
      // Not JSON — return the raw text so the caller can show it honestly.
      return { message: firstText };
    }
  }
  return {};
}

class McpClient {
  /**
   * @param {string} server - one of food | im | dineout | scenes
   * @param {() => Promise<string|null>} getToken - returns a fresh access token or null
   * @param {(err: McpError) => Promise<boolean>} [onAuthFailure] - called on 401/-32001;
   *   return true if a refresh happened and the call should be retried once.
   */
  constructor(server, getToken, onAuthFailure = null) {
    if (!SERVERS[server]) throw new Error(`Unknown MCP server: ${server}`);
    this.server = server;
    this.url = SERVERS[server];
    this.getToken = getToken;
    this.onAuthFailure = onAuthFailure;
    this.sessionId = null;
    this.initialized = false;
    this._id = 0;
    this._fetch = fetch; // replaceable in tests
  }

  async _request(method, params = {}, { allowUnauthenticated = false } = {}) {
    const token = await this.getToken();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "setuware-commerce-assistant/0.1.0",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;

    const id = ++this._id;
    const res = await this._fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    const newSession = res.headers.get("mcp-session-id");
    if (newSession) this.sessionId = newSession;

    const text = await res.text();
    if (res.status === 401 || res.status === 403 || res.status === 419) {
      const err = new McpError(`HTTP ${res.status} from ${this.server} — authentication required`, {
        httpStatus: res.status,
        isAuth: true,
      });
      if (this.onAuthFailure && (await this.onAuthFailure(err))) {
        return this._request(method, params, { allowUnauthenticated });
      }
      throw err;
    }
    if (!res.ok) {
      throw new McpError(`HTTP ${res.status} from ${this.server}: ${text.slice(0, 300)}`, {
        httpStatus: res.status,
      });
    }
    let msg;
    try {
      msg = parseResponseBody(text, res.headers.get("content-type") || "");
    } catch {
      throw new McpError(`Unparseable MCP response from ${this.server}: ${text.slice(0, 300)}`);
    }
    if (msg && msg.error) {
      const code = msg.error.code;
      const err = new McpError(msg.error.message || `JSON-RPC error ${code}`, {
        rpcCode: code,
        isAuth: code === -32001,
      });
      if (err.isAuth && this.onAuthFailure && (await this.onAuthFailure(err))) {
        return this._request(method, params, { allowUnauthenticated });
      }
      throw err;
    }
    return msg ? msg.result : undefined;
  }

  async initialize() {
    if (this.initialized) return;
    await this._request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    // Best-effort initialized notification; some servers don't need it.
    try {
      await this._request("notifications/initialized", {});
    } catch {
      /* ignore */
    }
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const result = await this._request("tools/list", {});
    return result.tools || [];
  }

  /** Call a tool. Returns { data, raw } where data is readToolData(result). */
  async callTool(name, args = {}) {
    await this.initialize();
    const started = Date.now();
    const result = await this._request("tools/call", { name, arguments: args });
    const data = readToolData(result);
    return { data, raw: result, ms: Date.now() - started };
  }
}

module.exports = { McpClient, McpError, readToolData, parseResponseBody, SERVERS, PROTOCOL_VERSION };
