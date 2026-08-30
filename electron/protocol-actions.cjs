"use strict";

const RITUAL_PATHS = Object.freeze({
  "/greeting": "greeting",
  "/work-complete": "work_complete",
  "/break": "break",
});

function hasClosedActionEnvelope(rawUrl, url, protocolScheme) {
  return rawUrl === `${protocolScheme}://${url.hostname}${url.pathname}` &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "";
}

function voiceState(activity, phase = "active") {
  return {
    type: "state",
    state: {
      activity,
      microphoneMuted: false,
      outputMuted: false,
      phase,
    },
  };
}

function parseProtocolUrl(rawUrl, protocolScheme = "persona") {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${protocolScheme}:`) return null;
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "show" || action === "hide" || action === "toggle") {
      return [{ type: action }];
    }
    if (action === "listening") {
      return [{ type: "event", event: voiceState("listening") }];
    }
    if (action === "speaking") {
      const commands = [{ type: "event", event: voiceState("speaking") }];
      const level = Number(url.searchParams.get("level"));
      if (Number.isFinite(level)) {
        commands.push({
          type: "event",
          event: { type: "audio-level", level: Math.max(0, Math.min(1, level)) },
        });
      }
      return commands;
    }
    if (action === "thinking") {
      if (!hasClosedActionEnvelope(rawUrl, url, protocolScheme) || url.pathname !== "") return null;
      return [{ type: "event", event: { type: "presence-cue", cue: "thinking" } }];
    }
    if (action === "ritual") {
      if (!hasClosedActionEnvelope(rawUrl, url, protocolScheme)) return null;
      const ritual = RITUAL_PATHS[url.pathname];
      return ritual == null ? null : [{ type: "ritual", ritual }];
    }
    if (action === "inactive" || action === "stop") {
      return [{ type: "event", event: voiceState("idle", "inactive") }];
    }
    if (["idle", "greeting", "celebrate", "dance"].includes(action)) {
      return [
        {
          type: "event",
          event: { type: "animation", animation: action.toUpperCase() },
        },
      ];
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { parseProtocolUrl, voiceState };
