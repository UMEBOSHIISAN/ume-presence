"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAppShutdownCoordinator } = require("./app-shutdown.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function quitEvent() {
  let preventCalls = 0;
  return {
    event: { preventDefault: () => { preventCalls += 1; } },
    get preventCalls() { return preventCalls; },
  };
}

test("first quit cleans up synchronously, awaits one bounded stop, then exits once", async () => {
  const sequence = [];
  const stopped = deferred();
  let timer = null;
  const coordinator = createAppShutdownCoordinator({
    cleanupNow: () => sequence.push("cleanup"),
    stopRuntime: () => {
      sequence.push("stop");
      return stopped.promise;
    },
    exit: (code) => sequence.push(`exit:${code}`),
    setTimer(callback, timeoutMs) {
      timer = { callback, timeoutMs };
      return timer;
    },
    clearTimer(handle) {
      assert.equal(handle, timer);
      sequence.push("clear-timer");
    },
  });
  const first = quitEvent();

  const completion = coordinator.handleBeforeQuit(first.event);
  assert.equal(first.preventCalls, 1);
  assert.deepEqual(sequence, ["cleanup", "stop"]);
  assert.equal(timer.timeoutMs, 6_000);
  stopped.resolve();
  await completion;

  assert.deepEqual(sequence, ["cleanup", "stop", "clear-timer", "exit:0"]);
  assert.equal(Object.isFrozen(coordinator), true);
  assert.deepEqual(Object.keys(coordinator), ["handleBeforeQuit"]);
});

test("re-entry prevents default without duplicating cleanup, stop, timer, or exit", async () => {
  const stopped = deferred();
  const calls = [];
  const coordinator = createAppShutdownCoordinator({
    cleanupNow: () => calls.push("cleanup"),
    stopRuntime: () => {
      calls.push("stop");
      return stopped.promise;
    },
    exit: () => calls.push("exit"),
    setTimer: (callback) => ({ callback }),
    clearTimer: () => calls.push("clear"),
  });
  const first = quitEvent();
  const second = quitEvent();

  const firstCompletion = coordinator.handleBeforeQuit(first.event);
  const secondCompletion = coordinator.handleBeforeQuit(second.event);
  assert.equal(firstCompletion, secondCompletion);
  assert.equal(first.preventCalls, 1);
  assert.equal(second.preventCalls, 1);
  assert.deepEqual(calls, ["cleanup", "stop"]);

  stopped.resolve();
  await firstCompletion;
  coordinator.handleBeforeQuit(second.event);
  assert.equal(second.preventCalls, 2);
  assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit"]);
});

test("stop throw, rejection, and the outer deadline all terminate without retry", async () => {
  for (const mode of ["throw", "reject", "stall"]) {
    const calls = [];
    let timer = null;
    const coordinator = createAppShutdownCoordinator({
      cleanupNow: () => calls.push("cleanup"),
      stopRuntime() {
        calls.push("stop");
        if (mode === "throw") throw new Error("private stop throw");
        if (mode === "reject") return Promise.reject(new Error("private stop reject"));
        return new Promise(() => {});
      },
      exit: (code) => calls.push(`exit:${code}`),
      setTimer(callback, timeoutMs) {
        timer = { callback, timeoutMs };
        return timer;
      },
      clearTimer: () => calls.push("clear"),
    });
    const event = quitEvent();
    const completion = coordinator.handleBeforeQuit(event.event);
    if (mode === "stall") {
      assert.equal(timer.timeoutMs, 6_000);
      timer.callback();
    }
    await completion;

    assert.equal(event.preventCalls, 1);
    assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit:0"]);
  }
});

test("cleanup throw is contained and cannot skip the one runtime stop", async () => {
  const calls = [];
  const coordinator = createAppShutdownCoordinator({
    cleanupNow() {
      calls.push("cleanup");
      throw new Error("cleanup failure");
    },
    stopRuntime: () => calls.push("stop"),
    exit: () => calls.push("exit"),
    setTimer: () => 1,
    clearTimer: () => calls.push("clear"),
  });

  await coordinator.handleBeforeQuit(quitEvent().event);
  assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit"]);
});

test("timer winner ignores a later stop settlement or rejection without repeating effects", async () => {
  for (const lateOutcome of ["resolve", "reject"]) {
    const stopped = deferred();
    const calls = [];
    let timerCallback = null;
    const coordinator = createAppShutdownCoordinator({
      cleanupNow: () => calls.push("cleanup"),
      stopRuntime: () => {
        calls.push("stop");
        return stopped.promise;
      },
      exit: () => calls.push("exit"),
      setTimer(callback) {
        timerCallback = callback;
        return 1;
      },
      clearTimer: () => calls.push("clear"),
    });
    const first = quitEvent();
    const second = quitEvent();
    const completion = coordinator.handleBeforeQuit(first.event);
    timerCallback();
    await completion;
    coordinator.handleBeforeQuit(second.event);

    if (lateOutcome === "resolve") stopped.resolve();
    else stopped.reject(new Error("late private rejection"));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(first.preventCalls, 1);
    assert.equal(second.preventCalls, 1);
    assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit"]);
  }
});

test("cleanup callback re-entry observes the exact cached shutdown promise", async () => {
  const calls = [];
  const firstEvent = quitEvent();
  const secondEvent = quitEvent();
  let coordinator = null;
  let reentered = null;
  let didReenter = false;
  coordinator = createAppShutdownCoordinator({
    cleanupNow() {
      calls.push("cleanup");
      if (!didReenter) {
        didReenter = true;
        reentered = coordinator.handleBeforeQuit(secondEvent.event);
      }
    },
    stopRuntime: () => calls.push("stop"),
    exit: () => calls.push("exit"),
    setTimer: () => 1,
    clearTimer: () => calls.push("clear"),
  });

  const first = coordinator.handleBeforeQuit(firstEvent.event);
  assert.equal(first, reentered);
  await first;
  assert.equal(firstEvent.preventCalls, 1);
  assert.equal(secondEvent.preventCalls, 1);
  assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit"]);
});

test("stop callback re-entry observes the exact cached shutdown promise", async () => {
  const calls = [];
  const firstEvent = quitEvent();
  const secondEvent = quitEvent();
  let coordinator = null;
  let reentered = null;
  let didReenter = false;
  coordinator = createAppShutdownCoordinator({
    cleanupNow: () => calls.push("cleanup"),
    stopRuntime() {
      calls.push("stop");
      if (!didReenter) {
        didReenter = true;
        reentered = coordinator.handleBeforeQuit(secondEvent.event);
      }
    },
    exit: () => calls.push("exit"),
    setTimer: () => 1,
    clearTimer: () => calls.push("clear"),
  });

  const first = coordinator.handleBeforeQuit(firstEvent.event);
  assert.equal(first, reentered);
  await first;
  assert.equal(firstEvent.preventCalls, 1);
  assert.equal(secondEvent.preventCalls, 1);
  assert.deepEqual(calls, ["cleanup", "stop", "clear", "exit"]);
});
