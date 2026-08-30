"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  RITUAL_DURATIONS_MS,
  createRitualController,
} = require("./ritual-controller.cjs");

function harness() {
  const events = [];
  const timers = [];
  const controller = createRitualController({
    emit: (event) => events.push(event),
    setTimer: (callback, milliseconds) => {
      const timer = { callback, milliseconds, cleared: false, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  return { controller, events, timers };
}

test("starts one fixed ritual and clears it on completion", () => {
  const { controller, events, timers } = harness();
  assert.deepEqual(controller.start("work_complete"), {
    status: "started", ritual: "work_complete",
  });
  assert.deepEqual(events, [{ type: "presence-cue", cue: "complete" }]);
  assert.equal(timers[0].milliseconds, RITUAL_DURATIONS_MS.work_complete);
  timers[0].callback();
  assert.deepEqual(events.at(-1), { type: "presence-cue", cue: "clear" });
  assert.equal(controller.getActive(), null);
});

test("returns busy without queueing, replacing, or retrying", () => {
  const { controller, events, timers } = harness();
  controller.start("greeting");
  assert.deepEqual(controller.start("break"), {
    status: "busy", ritual: "greeting",
  });
  assert.equal(events.length, 1);
  assert.equal(timers.length, 1);
});

test("cancels once and rejects unknown ritual names", () => {
  const { controller, events, timers } = harness();
  controller.start("break");
  assert.equal(controller.cancel(), true);
  assert.equal(controller.cancel(), false);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(events.at(-1), { type: "presence-cue", cue: "clear" });
  assert.throws(() => controller.start("run-command"), /Unknown ritual/);
});
