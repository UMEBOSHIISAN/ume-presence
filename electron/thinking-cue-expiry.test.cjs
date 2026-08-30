"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  THINKING_TIMEOUT_MS,
  createThinkingCueExpiry,
} = require("./thinking-cue-expiry.cjs");

function harness() {
  const events = [];
  const timers = [];
  const expiry = createThinkingCueExpiry({
    emit: (event) => events.push(event),
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return { events, expiry, timers };
}

test("clears the persisted thinking cue at its original fixed deadline", () => {
  const { events, expiry, timers } = harness();

  expiry.start();
  assert.equal(timers[0].milliseconds, THINKING_TIMEOUT_MS);
  timers[0].callback();

  assert.deepEqual(events, [{ type: "presence-cue", cue: "clear" }]);
  assert.equal(expiry.isActive(), false);
});

test("cancels a stale deadline when another presentation takes ownership", () => {
  const { events, expiry, timers } = harness();

  expiry.start();
  assert.equal(expiry.cancel(), true);
  assert.equal(expiry.cancel(), false);
  assert.equal(timers[0].cleared, true);
  timers[0].callback();

  assert.deepEqual(events, []);
});
