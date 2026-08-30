"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createRendererEventSnapshot,
} = require("./renderer-event-snapshot.cjs");

const LISTENING = Object.freeze({
  activity: "listening",
  microphoneMuted: false,
  outputMuted: false,
  phase: "active",
});

const SPEAKING = Object.freeze({ ...LISTENING, activity: "speaking" });

test("compacts events to the renderer state instead of replaying an ignored cue", () => {
  const snapshot = createRendererEventSnapshot();
  snapshot.push({ type: "state", state: LISTENING });
  snapshot.push({ type: "presence-cue", cue: "greeting" });
  snapshot.push({ type: "presence-cue", cue: "thinking" });
  for (let index = 0; index < 65; index += 1) {
    snapshot.push({ type: "audio-level", level: index / 100 });
  }

  assert.deepEqual(snapshot.getEvents(), [
    { type: "state", state: LISTENING },
    { type: "presence-cue", cue: "greeting" },
    { type: "audio-level", level: 0.64 },
  ]);
});

test("canonical events preserve cue, preview, voice, and indicator precedence", () => {
  const snapshot = createRendererEventSnapshot();
  snapshot.push({ type: "state", state: LISTENING });
  snapshot.push({ type: "animation", animation: "DANCE" });
  snapshot.push({ type: "presence-cue", cue: "complete" });
  snapshot.push({ type: "indicator", indicator: "warning" });

  assert.deepEqual(snapshot.getEvents(), [
    { type: "state", state: LISTENING },
    { type: "presence-cue", cue: "complete" },
    { type: "indicator", indicator: "warning" },
  ]);

  snapshot.push({ type: "state", state: SPEAKING });
  snapshot.push({ type: "presence-cue", cue: "break" });
  snapshot.push({ type: "indicator", indicator: "clear" });

  assert.deepEqual(snapshot.getEvents(), [
    { type: "state", state: SPEAKING },
  ]);
});

test("keeps only the latest independent listener and bridge status", () => {
  const snapshot = createRendererEventSnapshot();
  snapshot.push({
    type: "listener-status",
    status: {
      available: true,
      capturing: false,
      monitoring: true,
      source: null,
    },
  });
  snapshot.push({ type: "bridge-status", connected: false });
  snapshot.push({ type: "bridge-status", connected: true });

  assert.deepEqual(snapshot.getEvents(), [
    {
      type: "listener-status",
      status: {
        available: true,
        capturing: false,
        monitoring: true,
        source: null,
      },
    },
    { type: "bridge-status", connected: true },
  ]);
});
