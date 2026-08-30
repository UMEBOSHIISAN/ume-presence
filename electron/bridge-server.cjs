"use strict";

const http = require("node:http");

const DEFAULT_PORT = 47831;
const MAX_BODY_BYTES = 64 * 1024;
const TRUSTED_ORIGIN =
  /^(?:https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?|codex-app:\/\/[A-Za-z0-9._~-]*)$/i;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ANIMATIONS = new Set(["IDLE", "GREETING", "TALK", "CELEBRATE", "DANCE"]);
const STATE_EVENT_KEYS = new Set(["type", "state"]);
const AUDIO_LEVEL_EVENT_KEYS = new Set(["type", "level"]);
const ANIMATION_EVENT_KEYS = new Set(["type", "animation"]);
const INDICATOR_EVENT_KEYS = new Set(["type", "indicator"]);
const PRESENCE_CUES = new Set(["thinking", "greeting", "complete", "break", "clear"]);
const PRESENCE_CUE_EVENT_KEYS = new Set(["type", "cue"]);
const VOICE_STATE_KEYS = new Set([
  "activity",
  "microphoneMuted",
  "outputMuted",
  "phase",
]);

function hasOnlyKeys(value, allowedKeys) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === allowedKeys.size &&
    Object.keys(value).every((key) => allowedKeys.has(key))
  );
}

function isVoiceState(value) {
  return (
    hasOnlyKeys(value, VOICE_STATE_KEYS) &&
    ["inactive", "starting", "active", "stopping"].includes(value.phase) &&
    ["idle", "listening", "speaking"].includes(value.activity) &&
    typeof value.microphoneMuted === "boolean" &&
    typeof value.outputMuted === "boolean"
  );
}

function normalizeEvent(value) {
  if (
    value?.type === "state" &&
    hasOnlyKeys(value, STATE_EVENT_KEYS) &&
    isVoiceState(value.state)
  ) {
    return {
      type: "state",
      state: {
        activity: value.state.activity,
        microphoneMuted: value.state.microphoneMuted,
        outputMuted: value.state.outputMuted,
        phase: value.state.phase,
      },
    };
  }
  if (
    value?.type === "audio-level" &&
    hasOnlyKeys(value, AUDIO_LEVEL_EVENT_KEYS) &&
    Number.isFinite(value.level)
  ) {
    return {
      type: "audio-level",
      level: Math.max(0, Math.min(1, Number(value.level))),
    };
  }
  if (
    value?.type === "animation" &&
    hasOnlyKeys(value, ANIMATION_EVENT_KEYS) &&
    ANIMATIONS.has(value.animation)
  ) {
    return { type: "animation", animation: value.animation };
  }
  if (
    value?.type === "indicator" &&
    ["warning", "error", "clear"].includes(value.indicator) &&
    hasOnlyKeys(value, INDICATOR_EVENT_KEYS)
  ) {
    return { type: "indicator", indicator: value.indicator };
  }
  if (
    value?.type === "presence-cue" &&
    hasOnlyKeys(value, PRESENCE_CUE_EVENT_KEYS) &&
    PRESENCE_CUES.has(value.cue)
  ) {
    return { type: "presence-cue", cue: value.cue };
  }
  return null;
}

function originAllowed(origin) {
  return origin == null || TRUSTED_ORIGIN.test(origin);
}

function hostAllowed(hostHeader) {
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return (
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

function jsonRpcError(response, status, code, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
  );
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error("Request body is too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (bytes > MAX_BODY_BYTES) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        const error = new Error("Request body is not valid JSON");
        error.code = "INVALID_JSON";
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function createBridgeServer({
  host = "127.0.0.1",
  port = DEFAULT_PORT,
  onEvent,
  mcpHandler = null,
}) {
  let lastStateEvent = null;
  const server = http.createServer((request, response) => {
    const origin = request.headers.origin;
    if (!hostAllowed(request.headers.host)) {
      response.writeHead(403);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, lastState: lastStateEvent?.state ?? null }));
      return;
    }

    if (request.url === "/mcp") {
      if (!originAllowed(origin)) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { allow: "POST" });
        response.end();
        return;
      }
      if (mcpHandler == null) {
        response.writeHead(404);
        response.end();
        return;
      }
      void readJsonBody(request)
        .then((body) => mcpHandler(request, response, body))
        .catch((error) => {
          if (response.headersSent) return;
          if (error?.code === "BODY_TOO_LARGE") {
            jsonRpcError(response, 413, -32000, "Request body is too large");
          } else if (error?.code === "INVALID_JSON") {
            jsonRpcError(response, 400, -32700, "Parse error");
          } else {
            jsonRpcError(response, 500, -32603, "Internal server error");
          }
        });
      return;
    }

    if (
      request.method === "OPTIONS"
      && request.url === "/events"
      && origin !== undefined
      && originAllowed(origin)
    ) {
      response.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        vary: "Origin",
      });
      response.end();
      return;
    }

    if (request.method !== "POST" || request.url !== "/events" || !originAllowed(origin)) {
      response.writeHead(404);
      response.end();
      return;
    }

    void readJsonBody(request)
      .then((body) => {
        const event = normalizeEvent(body);
        if (event == null) {
          response.writeHead(422);
          response.end();
          return;
        }
        if (event.type === "state") lastStateEvent = event;
        onEvent(event);
        response.writeHead(202, {
          ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
          "content-type": "application/json",
        });
        response.end('{"accepted":true}');
      })
      .catch((error) => {
        if (response.headersSent) return;
        response.writeHead(error?.code === "BODY_TOO_LARGE" ? 413 : 400);
        response.end();
      });
  });

  return {
    getLastStateEvent: () => lastStateEvent,
    listen: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve(server.address());
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

module.exports = {
  ANIMATIONS,
  DEFAULT_PORT,
  PRESENCE_CUES,
  createBridgeServer,
  hostAllowed,
  isVoiceState,
  normalizeEvent,
  originAllowed,
};
