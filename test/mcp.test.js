// Tests for lib/mcp.js against a LOCAL mock MCP server.
// Nothing here touches mcp.swiggy.com — live connectivity is covered by
// scripts/verify-live.mjs instead.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { McpClient, McpError, readToolData, parseResponseBody } = require("../lib/mcp");

function startMock(handler) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body ? JSON.parse(body) : {}));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

test("initialize + tools/list over plain JSON", async () => {
  const server = await startMock((req, res, msg) => {
    if (msg.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(jsonRpcResponse(msg.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "mock", version: "1" } }));
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(jsonRpcResponse(msg.id, { tools: [{ name: "search_restaurants", description: "find food" }] }));
    }
    res.writeHead(400).end("{}");
  });
  const port = server.address().port;
  try {
    const client = new McpClient("food", async () => null);
    client.url = `http://127.0.0.1:${port}`;
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "search_restaurants");
  } finally {
    server.close();
  }
});

test("tools/call parses an SSE response", async () => {
  const server = await startMock((req, res, msg) => {
    if (msg.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(jsonRpcResponse(msg.id, { protocolVersion: "2025-06-18" }));
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end("{}");
      return;
    }
    // SSE: a notification line, then the real result.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
        `event: message\ndata: ${jsonRpcResponse(msg.id, { content: [{ type: "text", text: "ok" }], structuredContent: { restaurants: [{ name: "Biryani House" }] } })}\n\n`
    );
  });
  const port = server.address().port;
  try {
    const client = new McpClient("food", async () => null);
    client.url = `http://127.0.0.1:${port}`;
    const { data } = await client.callTool("search_restaurants", { query: "biryani" });
    assert.equal(data.restaurants[0].name, "Biryani House");
  } finally {
    server.close();
  }
});

test("HTTP 401 surfaces as an auth error", async () => {
  const server = await startMock((req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  const port = server.address().port;
  try {
    const client = new McpClient("food", async () => null);
    client.url = `http://127.0.0.1:${port}`;
    await assert.rejects(() => client.listTools(), (err) => err instanceof McpError && err.isAuth && err.httpStatus === 401);
  } finally {
    server.close();
  }
});

test("JSON-RPC -32001 surfaces as an auth error", async () => {
  const server = await startMock((req, res, msg) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "Unauthorized" } }));
  });
  const port = server.address().port;
  try {
    const client = new McpClient("food", async () => null);
    client.url = `http://127.0.0.1:${port}`;
    await assert.rejects(() => client.listTools(), (err) => err instanceof McpError && err.isAuth && err.rpcCode === -32001);
  } finally {
    server.close();
  }
});

test("readToolData prefers structuredContent, falls back to the JSON envelope", () => {
  const fromStructured = readToolData({
    content: [{ type: "text", text: "human summary" }],
    structuredContent: { restaurants: [{ name: "A" }] },
  });
  assert.deepEqual(fromStructured, { restaurants: [{ name: "A" }] });

  const fromEnvelope = readToolData({
    content: [{ type: "text", text: JSON.stringify({ success: true, data: { slots: [1, 2] }, message: "ok" }) }],
  });
  assert.equal(fromEnvelope.slots.length, 2);

  assert.throws(
    () => readToolData({ isError: true, content: [{ type: "text", text: "bad address" }] }),
    /bad address/
  );
});

test("parseResponseBody handles plain JSON and SSE", () => {
  const plain = parseResponseBody(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), "application/json");
  assert.equal(plain.result.ok, true);
  const sse = parseResponseBody(
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n',
    "text/event-stream"
  );
  assert.deepEqual(sse.result, { tools: [] });
});
