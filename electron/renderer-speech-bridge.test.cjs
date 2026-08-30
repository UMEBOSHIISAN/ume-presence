"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererSpeechBridge } = require("./renderer-speech-bridge.cjs");

function createHarness() {
  const sent = [];
  const timers = new Map();
  let timerId = 0;
  let started = 0;
  let finished = 0;
  const window = {
    isDestroyed: () => false,
    webContents: {
      id: 7,
      isLoading: () => false,
      send(channel, payload) {
        sent.push({ channel, payload });
      },
    },
  };
  const bridge = createRendererSpeechBridge({
    getWindow: () => window,
    onStarted: () => {
      started += 1;
    },
    onFinished: () => {
      finished += 1;
    },
    setTimer(callback, timeoutMs) {
      const id = ++timerId;
      timers.set(id, { callback, timeoutMs });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  });
  return {
    bridge,
    sent,
    timers,
    window,
    get started() {
      return started;
    },
    get finished() {
      return finished;
    },
  };
}

test("sends WAV bytes and resolves after matching renderer completion", async () => {
  const harness = createHarness();
  const pending = harness.bridge.play(Buffer.from("RIFF"));
  const message = harness.sent[0];

  assert.equal(message.channel, "persona:speech");
  assert.deepEqual([...message.payload.wavBytes], [...Buffer.from("RIFF")]);
  assert.equal(harness.bridge.isBusy(), true);
  assert.equal(
    harness.bridge.handleRendererResult(7, {
      id: message.payload.id,
      status: "started",
    }),
    true,
  );
  assert.equal(harness.started, 1);
  assert.equal(
    harness.bridge.handleRendererResult(7, {
      id: message.payload.id,
      status: "completed",
    }),
    true,
  );

  await pending;
  assert.equal(harness.finished, 1);
  assert.equal(harness.bridge.isBusy(), false);
  assert.equal(harness.timers.size, 0);
});

test("rejects a second play without queueing it", async () => {
  const harness = createHarness();
  const first = harness.bridge.play(Buffer.from("RIFF"));
  await assert.rejects(
    harness.bridge.play(Buffer.from("WAVE")),
    (error) => error.code === "SPEECH_BUSY",
  );
  assert.equal(harness.sent.length, 1);
  harness.bridge.stop("test cleanup");
  await assert.rejects(first, /test cleanup/);
});

test("ignores results from another renderer or operation", async () => {
  const harness = createHarness();
  const pending = harness.bridge.play(Buffer.from("RIFF"));
  const id = harness.sent[0].payload.id;

  assert.equal(harness.bridge.handleRendererResult(8, { id, status: "started" }), false);
  assert.equal(
    harness.bridge.handleRendererResult(7, { id: "speech-other", status: "started" }),
    false,
  );
  assert.equal(harness.started, 0);

  harness.bridge.handleRendererResult(7, { id, status: "completed" });
  await pending;
  assert.equal(harness.finished, 0);
});

test("renderer failure rejects with a bounded message and clears state", async () => {
  const harness = createHarness();
  const pending = harness.bridge.play(Buffer.from("RIFF"));
  const id = harness.sent[0].payload.id;
  harness.bridge.handleRendererResult(7, { id, status: "started" });
  harness.bridge.handleRendererResult(7, {
    id,
    status: "failed",
    message: "x".repeat(500),
  });

  await assert.rejects(pending, (error) => error.message.length <= 200);
  assert.equal(harness.finished, 1);
  assert.equal(harness.bridge.isBusy(), false);
});

test("timeout rejects once and releases an active start", async () => {
  const harness = createHarness();
  const pending = harness.bridge.play(Buffer.from("RIFF"));
  const id = harness.sent[0].payload.id;
  harness.bridge.handleRendererResult(7, { id, status: "started" });
  const timer = [...harness.timers.values()][0];
  assert.equal(timer.timeoutMs, 60_000);
  timer.callback();

  await assert.rejects(pending, /timed out/i);
  assert.equal(harness.sent[1].channel, "persona:speech-cancel");
  assert.deepEqual(harness.sent[1].payload, { id });
  assert.equal(harness.finished, 1);
  assert.equal(harness.bridge.isBusy(), false);
  assert.equal(harness.timers.size, 0);
});

test("stop rejects and clears without starting a queued operation", async () => {
  const harness = createHarness();
  const pending = harness.bridge.play(Buffer.from("RIFF"));
  harness.bridge.stop("Persona is quitting.");

  await assert.rejects(pending, /quitting/i);
  assert.equal(harness.started, 0);
  assert.equal(harness.finished, 0);
  assert.equal(harness.bridge.isBusy(), false);
  assert.equal(harness.sent.length, 2);
  assert.equal(harness.sent[1].channel, "persona:speech-cancel");
});

test("rejects when the renderer is unavailable or still loading", async () => {
  for (const getWindow of [
    () => null,
    () => ({ isDestroyed: () => true }),
    () => ({
      isDestroyed: () => false,
      webContents: { id: 7, isLoading: () => true },
    }),
  ]) {
    const bridge = createRendererSpeechBridge({ getWindow });
    await assert.rejects(bridge.play(Buffer.from("RIFF")), /renderer/i);
  }
});
