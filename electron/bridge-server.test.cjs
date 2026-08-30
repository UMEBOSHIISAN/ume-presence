"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const {
  createBridgeServer,
  hostAllowed,
  normalizeEvent,
  originAllowed,
} = require("./bridge-server.cjs");

function requestServer(address, { path, method = "GET", headers = {}, body = "" }) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
            status: response.statusCode,
          }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

test("normalizes state and clamps audio level events", () => {
  const state = {
    activity: "speaking",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  assert.deepEqual(normalizeEvent({ type: "state", state }), { type: "state", state });
  assert.deepEqual(normalizeEvent({ type: "audio-level", level: 4 }), {
    type: "audio-level",
    level: 1,
  });
  assert.deepEqual(normalizeEvent({ type: "animation", animation: "DANCE" }), {
    type: "animation",
    animation: "DANCE",
  });
  assert.equal(normalizeEvent({ type: "animation", animation: "UNKNOWN" }), null);
  assert.equal(normalizeEvent({ type: "state", state: { phase: "wat" } }), null);
});

test("normalizes only closed visual indicator events", () => {
  assert.deepEqual(normalizeEvent({ type: "indicator", indicator: "warning" }), {
    type: "indicator",
    indicator: "warning",
  });
  assert.deepEqual(normalizeEvent({ type: "indicator", indicator: "error" }), {
    type: "indicator",
    indicator: "error",
  });
  assert.deepEqual(normalizeEvent({ type: "indicator", indicator: "clear" }), {
    type: "indicator",
    indicator: "clear",
  });
  assert.equal(
    normalizeEvent({
      type: "indicator",
      indicator: "error",
      text: "must not cross",
    }),
    null,
  );
  assert.equal(
    normalizeEvent({ type: "indicator", indicator: "notice" }),
    null,
  );
});

test("normalizes only closed presentation cues", () => {
  for (const cue of ["thinking", "greeting", "complete", "break", "clear"]) {
    assert.deepEqual(normalizeEvent({ type: "presence-cue", cue }), {
      type: "presence-cue",
      cue,
    });
  }
  assert.equal(normalizeEvent({ type: "presence-cue", cue: "remember" }), null);
  assert.equal(
    normalizeEvent({ type: "presence-cue", cue: "thinking", text: "secret" }),
    null,
  );
});

test("bridge forwards a warning without changing last voice state", async (context) => {
  const events = [];
  const bridge = createBridgeServer({ port: 0, onEvent: (event) => events.push(event) });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const stateBody = JSON.stringify({
    type: "state",
    state: {
      activity: "speaking",
      microphoneMuted: false,
      outputMuted: false,
      phase: "active",
    },
  });
  await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: stateBody,
  });

  const indicatorBody = JSON.stringify({
    type: "indicator",
    indicator: "warning",
  });
  const response = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: indicatorBody,
  });

  assert.equal(response.status, 202);
  assert.deepEqual(events.at(-1), {
    type: "indicator",
    indicator: "warning",
  });
  assert.equal(bridge.getLastStateEvent().state.activity, "speaking");
});

test("rejects unknown and nested state content instead of forwarding it", () => {
  const state = {
    activity: "speaking",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };

  assert.equal(
    normalizeEvent({ type: "state", state, transcript: "must not cross" }),
    null,
  );
  assert.equal(
    normalizeEvent({
      type: "state",
      state: { ...state, transcript: "must not cross" },
    }),
    null,
  );
  assert.equal(
    normalizeEvent({
      type: "state",
      state: { ...state, metadata: { transcript: "must not cross" } },
    }),
    null,
  );
});

test("rejects unknown and bands content from audio-level events", () => {
  assert.equal(
    normalizeEvent({
      type: "audio-level",
      level: 0.3,
      transcript: "must not cross",
    }),
    null,
  );
  assert.equal(
    normalizeEvent({
      type: "audio-level",
      level: 0.3,
      bands: { low: 0.2 },
    }),
    null,
  );
  assert.equal(
    normalizeEvent({
      type: "audio-level",
      level: 0.3,
      metadata: { transcript: "must not cross" },
    }),
    null,
  );
});

test("rejects unknown animation fields instead of silently dropping them", () => {
  assert.equal(
    normalizeEvent({
      type: "animation",
      animation: "DANCE",
      transcript: "must not cross",
    }),
    null,
  );
});

test("only accepts supported app and local webview origins", () => {
  assert.equal(originAllowed("http://127.0.0.1:5175"), true);
  assert.equal(originAllowed("http://localhost:5175"), true);
  assert.equal(originAllowed("codex-app://codex"), true);
  assert.equal(originAllowed("null"), false);
  assert.equal(originAllowed("https://example.com"), false);
  assert.equal(originAllowed("codex://settings"), false);
  assert.equal(originAllowed(undefined), true);
});

test("only accepts loopback Host headers", () => {
  assert.equal(hostAllowed("127.0.0.1:47831"), true);
  assert.equal(hostAllowed("localhost:47831"), true);
  assert.equal(hostAllowed("[::1]:47831"), true);
  assert.equal(hostAllowed("persona.example"), false);
  assert.equal(hostAllowed("127.0.0.1.example"), false);
  assert.equal(hostAllowed(undefined), false);
});

test("bridge rejects a non-loopback Host header", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/health",
    headers: { host: "persona.example" },
  });

  assert.equal(response.status, 403);
});

test("bridge rejects an originless events preflight without crashing", async (context) => {
  const bridge = createBridgeServer({ port: 0, onEvent: () => {} });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const response = await requestServer(address, {
    path: "/events",
    method: "OPTIONS",
    headers: { host: `127.0.0.1:${address.port}` },
  });

  assert.equal(response.status, 404);
});

test("bridge accepts a valid native adapter state event", async (context) => {
  const events = [];
  const bridge = createBridgeServer({ port: 0, onEvent: (event) => events.push(event) });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const body = JSON.stringify({
    type: "state",
    state: {
      activity: "listening",
      microphoneMuted: false,
      outputMuted: false,
      phase: "active",
    },
  });
  const response = await requestServer(address, {
    path: "/events",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
    body,
  });

  assert.equal(response.status, 202);
  assert.equal(events.length, 1);
  assert.equal(events[0].state.phase, "active");
});

test("bridge routes only valid local JSON requests to MCP", async (context) => {
  const bodies = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: (_request, response, body) => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    },
  });
  const address = await bridge.listen();
  context.after(() => bridge.close());

  const accepted = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0"}',
  });
  const blockedOrigin = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://example.com",
    },
    body: "{}",
  });
  const unsupportedMethod = await requestServer(address, {
    path: "/mcp",
  });
  const invalidJson = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  const oversized = await requestServer(address, {
    path: "/mcp",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(64 * 1024) }),
  });

  assert.equal(accepted.status, 200);
  assert.equal(blockedOrigin.status, 403);
  assert.equal(unsupportedMethod.status, 405);
  assert.equal(unsupportedMethod.headers.allow, "POST");
  assert.equal(invalidJson.status, 400);
  assert.equal(JSON.parse(invalidJson.body).error.code, -32700);
  assert.equal(oversized.status, 413);
  assert.deepEqual(bodies, [{ jsonrpc: "2.0" }]);
});
