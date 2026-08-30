"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { createManagedLocalService } = require("./managed-local-service.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function drainMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createFakeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();

  const setTimer = (callback, delayMs) => {
    const handle = Object.freeze({ id: nextId });
    nextId += 1;
    timers.set(handle.id, { at: currentTime + delayMs, callback, handle });
    return handle;
  };

  const clearTimer = (handle) => {
    if (handle && typeof handle.id === "number") timers.delete(handle.id);
  };

  const nextEntry = () => {
    let selected = null;
    for (const entry of timers.values()) {
      if (
        selected === null
        || entry.at < selected.at
        || (entry.at === selected.at && entry.handle.id < selected.handle.id)
      ) {
        selected = entry;
      }
    }
    return selected;
  };

  const advanceBy = async (milliseconds) => {
    const target = currentTime + milliseconds;
    while (true) {
      const entry = nextEntry();
      if (entry === null || entry.at > target) break;
      currentTime = entry.at;
      timers.delete(entry.handle.id);
      entry.callback();
      await drainMicrotasks();
    }
    currentTime = Math.max(currentTime, target);
    await drainMicrotasks();
  };

  const runNext = async () => {
    const entry = nextEntry();
    if (entry === null) return false;
    await advanceBy(entry.at - currentTime);
    return true;
  };

  const runAll = async (limit = 1_000) => {
    let count = 0;
    while (timers.size > 0) {
      count += 1;
      if (count > limit) throw new Error("Fake clock timer limit exceeded.");
      await runNext();
    }
  };

  const elapseWithoutTimers = (milliseconds) => {
    currentTime += milliseconds;
  };

  return Object.freeze({
    advanceBy,
    clearTimer,
    elapseWithoutTimers,
    now: () => currentTime,
    pendingCount: () => timers.size,
    runAll,
    runNext,
    setTimer,
  });
}

class FakeChild extends EventEmitter {
  constructor({ exitCode = null, signalCode = null, killImpl } = {}) {
    super();
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.killCalls = [];
    this.killImpl = killImpl ?? (() => true);
  }

  kill(signal) {
    this.killCalls.push(signal);
    return this.killImpl(signal, this);
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }

  fail(error = new Error("child failed")) {
    this.emit("error", error);
  }

  signalExit(signal = "SIGTERM") {
    this.exitCode = null;
    this.signalCode = signal;
    this.emit("exit", null, signal);
  }
}

function createService({
  child = new FakeChild(),
  clock = createFakeClock(),
  cooldownMs = 10,
  maxAttempts = 60,
  onStatus,
  probe,
  readinessDeadlineMs = 1_000,
  shutdownTimeoutMs = 50,
  spawnOnce = () => child,
} = {}) {
  const service = createManagedLocalService({
    clearTimer: clock.clearTimer,
    cooldownMs,
    maxAttempts,
    now: clock.now,
    onStatus,
    probe,
    readinessDeadlineMs,
    setTimer: clock.setTimer,
    shutdownTimeoutMs,
    spawnOnce,
  });
  return { child, clock, service };
}

async function makeReadyOwned({ child = new FakeChild(), onStatus } = {}) {
  let probeCalls = 0;
  const harness = createService({
    child,
    cooldownMs: 1,
    onStatus,
    probe: async () => {
      probeCalls += 1;
      return probeCalls > 1;
    },
  });
  const started = harness.service.start();
  await drainMicrotasks();
  await harness.clock.advanceBy(1);
  assert.deepEqual(await started, {
    attempts: 1,
    errorCode: null,
    ownership: "owned",
    state: "ready-owned",
  });
  return { ...harness, getProbeCalls: () => probeCalls };
}

test("reuses an existing ready endpoint without spawning or owning it", async () => {
  let probeCalls = 0;
  let spawnCalls = 0;
  const { clock, service } = createService({
    probe: async () => {
      probeCalls += 1;
      return true;
    },
    spawnOnce: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
  });

  const first = service.start();
  const second = service.start();
  assert.strictEqual(first, second);
  assert.deepEqual(await first, {
    attempts: 0,
    errorCode: null,
    ownership: "none",
    state: "ready-existing",
  });
  assert.equal(probeCalls, 1);
  assert.equal(spawnCalls, 0);
  assert.equal(clock.pendingCount(), 0);
});

test("spawns once and becomes ready-owned after one cooled probe", async () => {
  let probeCalls = 0;
  let spawnCalls = 0;
  const child = new FakeChild();
  const { clock, service } = createService({
    child,
    probe: async () => {
      probeCalls += 1;
      return probeCalls === 2;
    },
    spawnOnce: () => {
      spawnCalls += 1;
      return child;
    },
  });

  const started = service.start();
  await drainMicrotasks();
  assert.equal(probeCalls, 1);
  await clock.advanceBy(9);
  assert.equal(probeCalls, 1);
  await clock.advanceBy(1);
  assert.deepEqual(await started, {
    attempts: 1,
    errorCode: null,
    ownership: "owned",
    state: "ready-owned",
  });
  assert.equal(spawnCalls, 1);
  assert.equal(clock.pendingCount(), 0);
});

test("counts only 60 post-spawn probes and never schedules a 61st", async () => {
  let probeCalls = 0;
  let spawnCalls = 0;
  const { clock, service } = createService({
    cooldownMs: 1,
    probe: async () => {
      probeCalls += 1;
      return false;
    },
    readinessDeadlineMs: 10_000,
    spawnOnce: () => {
      spawnCalls += 1;
      return new FakeChild();
    },
  });

  const started = service.start();
  await drainMicrotasks();
  await clock.runAll();
  assert.deepEqual(await started, {
    attempts: 60,
    errorCode: "READINESS_TIMEOUT",
    ownership: "owned",
    state: "requires-setup",
  });
  assert.equal(probeCalls, 61);
  assert.equal(spawnCalls, 1);
  assert.equal(clock.pendingCount(), 0);
});

test("absolute deadline settles a hung initial probe and ignores its late result", async () => {
  const pendingProbe = deferred();
  const { clock, service } = createService({
    probe: () => pendingProbe.promise,
    readinessDeadlineMs: 100,
  });

  const started = service.start();
  await clock.advanceBy(100);
  assert.deepEqual(await started, {
    attempts: 0,
    errorCode: "READINESS_TIMEOUT",
    ownership: "none",
    state: "requires-setup",
  });
  pendingProbe.resolve(true);
  await drainMicrotasks();
  assert.equal(service.getSnapshot().state, "requires-setup");
  assert.equal(clock.pendingCount(), 0);
});

test("deadline wins during cooldown without starting another probe", async () => {
  let probeCalls = 0;
  const { clock, service } = createService({
    cooldownMs: 100,
    probe: async () => {
      probeCalls += 1;
      return false;
    },
    readinessDeadlineMs: 50,
  });

  const started = service.start();
  await drainMicrotasks();
  await clock.advanceBy(50);
  assert.deepEqual(await started, {
    attempts: 0,
    errorCode: "READINESS_TIMEOUT",
    ownership: "owned",
    state: "requires-setup",
  });
  assert.equal(probeCalls, 1);
  assert.equal(clock.pendingCount(), 0);
});

test("deadline wins when it is exactly equal to the first cooldown", async () => {
  let probeCalls = 0;
  const { clock, service } = createService({
    cooldownMs: 50,
    probe: async () => {
      probeCalls += 1;
      return false;
    },
    readinessDeadlineMs: 50,
  });
  const started = service.start();
  await drainMicrotasks();
  await clock.advanceBy(50);
  assert.equal((await started).errorCode, "READINESS_TIMEOUT");
  assert.equal(probeCalls, 1);
  assert.equal(service.getSnapshot().attempts, 0);
});

test("deadline settles a hung post-spawn probe and ignores a late true", async () => {
  const pendingProbe = deferred();
  let probeCalls = 0;
  const { clock, service } = createService({
    cooldownMs: 10,
    probe: () => {
      probeCalls += 1;
      return probeCalls === 1 ? Promise.resolve(false) : pendingProbe.promise;
    },
    readinessDeadlineMs: 20,
  });

  const started = service.start();
  await drainMicrotasks();
  await clock.advanceBy(10);
  assert.equal(probeCalls, 2);
  await clock.advanceBy(10);
  assert.deepEqual(await started, {
    attempts: 1,
    errorCode: "READINESS_TIMEOUT",
    ownership: "owned",
    state: "requires-setup",
  });
  pendingProbe.resolve(true);
  await drainMicrotasks();
  assert.equal(service.getSnapshot().state, "requires-setup");
});

test("maps setup, spawn, probe, and invalid child failures to closed outcomes", async (t) => {
  await t.test("missing executable", async () => {
    const error = new Error("private path");
    error.code = "ENGINE_EXECUTABLE_MISSING";
    const { service } = createService({
      probe: async () => false,
      spawnOnce: () => { throw error; },
    });
    assert.deepEqual(await service.start(), {
      attempts: 0,
      errorCode: "ENGINE_EXECUTABLE_MISSING",
      ownership: "none",
      state: "requires-setup",
    });
  });

  await t.test("other spawn failure", async () => {
    const { service } = createService({
      probe: async () => false,
      spawnOnce: () => { throw new Error("raw spawn detail"); },
    });
    assert.equal((await service.start()).errorCode, "SPAWN_FAILED");
    assert.equal(service.getSnapshot().state, "failed");
  });

  await t.test("invalid child", async () => {
    const { service } = createService({
      probe: async () => false,
      spawnOnce: () => ({ exitCode: null, signalCode: null }),
    });
    assert.equal((await service.start()).errorCode, "SPAWN_FAILED");
  });

  for (const invalidResult of [undefined, "yes", 1]) {
    await t.test(`invalid initial probe result ${String(invalidResult)}`, async () => {
      let spawnCalls = 0;
      const { service } = createService({
        probe: async () => invalidResult,
        spawnOnce: () => { spawnCalls += 1; return new FakeChild(); },
      });
      assert.equal((await service.start()).errorCode, "PROBE_FAILED");
      assert.equal(spawnCalls, 0);
    });
  }

  await t.test("rejected initial probe", async () => {
    const { service } = createService({
      probe: async () => { throw new Error("raw probe detail"); },
    });
    const result = await service.start();
    assert.equal(result.errorCode, "PROBE_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /raw probe detail/);
  });

  await t.test("synchronous initial probe throw", async () => {
    const { service } = createService({
      probe: () => { throw new Error("raw synchronous detail"); },
    });
    const result = await service.start();
    assert.equal(result.errorCode, "PROBE_FAILED");
    assert.doesNotMatch(JSON.stringify(result), /synchronous detail/);
  });

  for (const [label, secondProbe] of [
    ["rejected post-spawn probe", async () => { throw new Error("raw post probe"); }],
    ["non-boolean post-spawn probe", async () => "ready"],
  ]) {
    await t.test(label, async () => {
      let probeCalls = 0;
      const { clock, service } = createService({
        cooldownMs: 1,
        probe: async () => {
          probeCalls += 1;
          return probeCalls === 1 ? false : secondProbe();
        },
      });
      const started = service.start();
      await drainMicrotasks();
      await clock.advanceBy(1);
      const result = await started;
      assert.equal(result.state, "failed");
      assert.equal(result.errorCode, "PROBE_FAILED");
      assert.equal(result.ownership, "owned");
      assert.equal(probeCalls, 2);
    });
  }
});

test("child loss during cooldown performs one immediate final probe", async (t) => {
  for (const [ready, expectedState] of [[false, "failed"], [true, "ready-existing"]]) {
    await t.test(String(ready), async () => {
      let probeCalls = 0;
      const child = new FakeChild();
      const { clock, service } = createService({
        child,
        cooldownMs: 500,
        probe: async () => {
          probeCalls += 1;
          return probeCalls === 1 ? false : ready;
        },
      });
      const started = service.start();
      await drainMicrotasks();
      child.exit(1);
      await drainMicrotasks();
      const result = await started;
      assert.equal(result.state, expectedState);
      assert.equal(result.ownership, "none");
      assert.equal(result.attempts, 1);
      assert.equal(result.errorCode, ready ? null : "CHILD_EXITED");
      assert.equal(probeCalls, 2);
      assert.equal(clock.pendingCount(), 0);
    });
  }
});

test("an in-flight probe becomes the only final probe after child loss", async () => {
  const pendingProbe = deferred();
  let probeCalls = 0;
  const child = new FakeChild();
  const { clock, service } = createService({
    child,
    cooldownMs: 1,
    probe: () => {
      probeCalls += 1;
      return probeCalls === 1 ? Promise.resolve(false) : pendingProbe.promise;
    },
  });
  const started = service.start();
  await drainMicrotasks();
  await clock.advanceBy(1);
  child.fail();
  pendingProbe.resolve(false);
  assert.deepEqual(await started, {
    attempts: 1,
    errorCode: "CHILD_EXITED",
    ownership: "none",
    state: "failed",
  });
  assert.equal(probeCalls, 2);
  assert.equal(clock.pendingCount(), 0);
});

test("a rejected child-loss final probe closes as CHILD_EXITED", async () => {
  let probeCalls = 0;
  const child = new FakeChild();
  const { service } = createService({
    child,
    cooldownMs: 500,
    probe: async () => {
      probeCalls += 1;
      if (probeCalls === 1) return false;
      throw new Error("raw final probe");
    },
  });
  const started = service.start();
  await drainMicrotasks();
  child.fail();
  await drainMicrotasks();
  assert.deepEqual(await started, {
    attempts: 1,
    errorCode: "CHILD_EXITED",
    ownership: "none",
    state: "failed",
  });
  assert.equal(probeCalls, 2);
});

test("child loss after ready-owned publishes one failure without probing or restarting", async () => {
  const statuses = [];
  const harness = await makeReadyOwned({ onStatus: (value) => statuses.push(value) });
  const probesBefore = harness.getProbeCalls();
  const failedBefore = statuses.filter((value) => value.state === "failed").length;
  harness.child.fail();
  harness.child.exit(1);
  await drainMicrotasks();
  assert.deepEqual(harness.service.getSnapshot(), {
    attempts: 1,
    errorCode: "CHILD_EXITED",
    ownership: "none",
    state: "failed",
  });
  assert.equal(harness.getProbeCalls(), probesBefore);
  assert.equal(
    statuses.filter((value) => value.state === "failed").length,
    failedBefore + 1,
  );
});

test("duplicate child errors are contained by one idempotent failure transition", async () => {
  const statuses = [];
  const harness = await makeReadyOwned({ onStatus: (value) => statuses.push(value) });
  const probesBefore = harness.getProbeCalls();
  const failedBefore = statuses.filter((value) => value.state === "failed").length;

  assert.doesNotThrow(() => {
    harness.child.fail();
    harness.child.fail();
  });
  await drainMicrotasks();

  assert.deepEqual(harness.service.getSnapshot(), {
    attempts: 1,
    errorCode: "CHILD_EXITED",
    ownership: "none",
    state: "failed",
  });
  assert.equal(harness.getProbeCalls(), probesBefore);
  assert.equal(
    statuses.filter((value) => value.state === "failed").length,
    failedBefore + 1,
  );
});

test("signal-only termination is terminal and is never killed again", async () => {
  let probeCalls = 0;
  const child = new FakeChild({ signalCode: "SIGTERM" });
  const { service } = createService({
    child,
    probe: async () => {
      probeCalls += 1;
      return probeCalls > 1;
    },
  });
  assert.deepEqual(await service.start(), {
    attempts: 1,
    errorCode: null,
    ownership: "none",
    state: "ready-existing",
  });
  await service.stop();
  assert.deepEqual(child.killCalls, []);
});

test("an already exited child is terminal before readiness polling", async () => {
  let probeCalls = 0;
  const child = new FakeChild({ exitCode: 1 });
  const { service } = createService({
    child,
    probe: async () => {
      probeCalls += 1;
      return probeCalls > 1;
    },
  });
  const result = await service.start();
  assert.equal(result.state, "ready-existing");
  assert.equal(result.ownership, "none");
  assert.equal(probeCalls, 2);
  await service.stop();
  assert.deepEqual(child.killCalls, []);
});

test("stop during a hung initial probe settles both operations and ignores late readiness", async () => {
  const pendingProbe = deferred();
  const { clock, service } = createService({ probe: () => pendingProbe.promise });
  const started = service.start();
  const stopped = service.stop();
  assert.strictEqual(stopped, service.stop());
  assert.equal((await stopped).state, "stopped");
  assert.equal((await started).state, "stopped");
  pendingProbe.resolve(true);
  await drainMicrotasks();
  assert.equal(service.getSnapshot().state, "stopped");
  assert.equal(clock.pendingCount(), 0);
});

test("stop during cooldown signals only the exact owned child once", async () => {
  const child = new FakeChild({
    killImpl: (_signal, target) => {
      queueMicrotask(() => target.signalExit("SIGTERM"));
      return true;
    },
  });
  const { clock, service } = createService({
    child,
    cooldownMs: 500,
    probe: async () => false,
  });
  const started = service.start();
  await drainMicrotasks();
  const stopped = service.stop();
  assert.deepEqual(await stopped, {
    attempts: 0,
    errorCode: null,
    ownership: "none",
    state: "stopped",
  });
  assert.equal((await started).state, "stopped");
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  assert.equal(clock.pendingCount(), 0);
});

test("stop during a hung post-spawn probe does not wait for it", async () => {
  const pendingProbe = deferred();
  let probeCalls = 0;
  const child = new FakeChild({
    killImpl: (_signal, target) => {
      queueMicrotask(() => target.exit(0));
      return true;
    },
  });
  const { clock, service } = createService({
    child,
    cooldownMs: 1,
    probe: () => {
      probeCalls += 1;
      return probeCalls === 1 ? Promise.resolve(false) : pendingProbe.promise;
    },
  });
  const started = service.start();
  await drainMicrotasks();
  await clock.advanceBy(1);
  assert.equal(probeCalls, 2);
  const stopped = service.stop();
  assert.equal((await stopped).state, "stopped");
  assert.equal((await started).state, "stopped");
  pendingProbe.resolve(true);
  await drainMicrotasks();
  assert.equal(service.getSnapshot().state, "stopped");
});

test("stopping a ready-existing endpoint never kills a child", async () => {
  const child = new FakeChild();
  const { service } = createService({ child, probe: async () => true });
  await service.start();
  assert.equal((await service.stop()).state, "stopped");
  assert.deepEqual(child.killCalls, []);
});

test("owned shutdown contains signal failure and timeout without retry", async (t) => {
  for (const [killResult, expectedError] of [
    [false, "SHUTDOWN_SIGNAL_FAILED"],
    [true, "SHUTDOWN_TIMEOUT"],
  ]) {
    await t.test(
      `child error after kill returns ${String(killResult)} is not exit confirmation`,
      async () => {
        const child = new FakeChild({
          killImpl: (_signal, target) => {
            target.fail();
            return killResult;
          },
        });
        const { clock, service } = await makeReadyOwned({ child });

        const stopped = service.stop();
        if (killResult) await clock.advanceBy(50);
        const result = await stopped;

        assert.equal(result.errorCode, expectedError);
        assert.equal(result.ownership, "owned");
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        assert.deepEqual(child.killCalls, ["SIGTERM"]);
        assert.equal(clock.pendingCount(), 0);
      },
    );
  }

  await t.test("kill returns false", async () => {
    const child = new FakeChild({ killImpl: () => false });
    const { service } = await makeReadyOwned({ child });
    const result = await service.stop();
    assert.equal(result.errorCode, "SHUTDOWN_SIGNAL_FAILED");
    assert.equal(result.ownership, "owned");
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
  });

  await t.test("kill throws", async () => {
    const child = new FakeChild({ killImpl: () => { throw new Error("raw kill"); } });
    const { service } = await makeReadyOwned({ child });
    const result = await service.stop();
    assert.equal(result.errorCode, "SHUTDOWN_SIGNAL_FAILED");
    assert.equal(result.ownership, "owned");
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
  });

  await t.test("kill times out", async () => {
    const child = new FakeChild({ killImpl: () => true });
    const { clock, service } = await makeReadyOwned({ child });
    const stopped = service.stop();
    assert.strictEqual(stopped, service.stop());
    await clock.advanceBy(50);
    const result = await stopped;
    assert.equal(result.errorCode, "SHUTDOWN_TIMEOUT");
    assert.equal(result.ownership, "owned");
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
    assert.equal(clock.pendingCount(), 0);
  });
});

test("timer dependency failures remain non-rejecting and closed", async (t) => {
  await t.test("deadline timer creation", async () => {
    let probeCalls = 0;
    const service = createManagedLocalService({
      clearTimer: () => {},
      now: () => 0,
      probe: async () => { probeCalls += 1; return true; },
      setTimer: () => { throw new Error("raw timer"); },
      spawnOnce: () => new FakeChild(),
    });
    const result = await service.start();
    assert.equal(result.errorCode, "READINESS_TIMEOUT");
    assert.equal(probeCalls, 0);
  });

  await t.test("cooldown timer creation", async () => {
    const clock = createFakeClock();
    let timerCalls = 0;
    const service = createManagedLocalService({
      clearTimer: clock.clearTimer,
      cooldownMs: 10,
      now: clock.now,
      probe: async () => false,
      setTimer: (callback, delay) => {
        timerCalls += 1;
        if (timerCalls === 2) throw new Error("raw cooldown timer");
        return clock.setTimer(callback, delay);
      },
      spawnOnce: () => new FakeChild(),
    });
    const result = await service.start();
    assert.equal(result.errorCode, "READINESS_TIMEOUT");
    assert.equal(clock.pendingCount(), 0);
  });

  await t.test("shutdown timer creation", async () => {
    const clock = createFakeClock();
    const child = new FakeChild({ killImpl: () => true });
    let probeCalls = 0;
    let timerCalls = 0;
    const service = createManagedLocalService({
      clearTimer: clock.clearTimer,
      cooldownMs: 1,
      now: clock.now,
      probe: async () => { probeCalls += 1; return probeCalls > 1; },
      setTimer: (callback, delay) => {
        timerCalls += 1;
        if (timerCalls === 3) throw new Error("raw shutdown timer");
        return clock.setTimer(callback, delay);
      },
      shutdownTimeoutMs: 50,
      spawnOnce: () => child,
    });
    const started = service.start();
    await drainMicrotasks();
    await clock.advanceBy(1);
    await started;
    const result = await service.stop();
    assert.equal(result.errorCode, "SHUTDOWN_TIMEOUT");
    assert.equal(result.ownership, "owned");
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
  });
});

test("synchronous status re-entry preserves cached lifecycle promises", async (t) => {
  await t.test("start from probing reuses the outer start promise", async () => {
    let probeCalls = 0;
    let reenteredStart = null;
    let service;
    const harness = createService({
      onStatus: (snapshot) => {
        if (snapshot.state === "probing" && reenteredStart === null) {
          reenteredStart = service.start();
        }
      },
      probe: async () => {
        probeCalls += 1;
        return true;
      },
    });
    service = harness.service;

    const started = service.start();

    assert.strictEqual(reenteredStart, started);
    assert.equal((await started).state, "ready-existing");
    assert.equal(probeCalls, 1);
    assert.equal(harness.clock.pendingCount(), 0);
  });

  await t.test("stop from starting prevents spawn and remains terminal", async () => {
    let reenteredStop = null;
    let service;
    let spawnCalls = 0;
    const harness = createService({
      onStatus: (snapshot) => {
        if (snapshot.state === "starting" && reenteredStop === null) {
          reenteredStop = service.stop();
        }
      },
      probe: async () => false,
      spawnOnce: () => {
        spawnCalls += 1;
        return new FakeChild();
      },
    });
    service = harness.service;

    const started = service.start();
    await drainMicrotasks();

    assert.strictEqual(reenteredStop, service.stop());
    assert.equal((await reenteredStop).state, "stopped");
    assert.equal((await started).state, "stopped");
    assert.equal(service.getSnapshot().state, "stopped");
    assert.equal(spawnCalls, 0);
    assert.equal(harness.clock.pendingCount(), 0);
  });

  await t.test("stop from post-spawn probing does not count an uninvoked probe", async () => {
    const child = new FakeChild({
      killImpl: (_signal, target) => {
        queueMicrotask(() => target.signalExit("SIGTERM"));
        return true;
      },
    });
    let probeCalls = 0;
    let reenteredStop = null;
    let sawWaiting = false;
    let service;
    const harness = createService({
      child,
      cooldownMs: 1,
      onStatus: (snapshot) => {
        if (snapshot.state === "waiting") sawWaiting = true;
        if (sawWaiting && snapshot.state === "probing" && reenteredStop === null) {
          reenteredStop = service.stop();
        }
      },
      probe: async () => {
        probeCalls += 1;
        return false;
      },
    });
    service = harness.service;

    const started = service.start();
    await drainMicrotasks();
    await harness.clock.advanceBy(1);

    assert.strictEqual(reenteredStop, service.stop());
    assert.deepEqual(await reenteredStop, {
      attempts: 0,
      errorCode: null,
      ownership: "none",
      state: "stopped",
    });
    assert.deepEqual(await started, {
      attempts: 0,
      errorCode: null,
      ownership: "none",
      state: "stopped",
    });
    assert.equal(probeCalls, 1);
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
    assert.equal(harness.clock.pendingCount(), 0);
  });

  await t.test("stop from attempt status observes the already-invoked probe", async () => {
    const pendingProbe = deferred();
    const child = new FakeChild({
      killImpl: (_signal, target) => {
        queueMicrotask(() => target.signalExit("SIGTERM"));
        return true;
      },
    });
    let probeCalls = 0;
    let probeCallsAtAttemptStatus = null;
    let reenteredStop = null;
    let service;
    const harness = createService({
      child,
      cooldownMs: 1,
      onStatus: (snapshot) => {
        if (snapshot.state === "probing" && snapshot.attempts === 1) {
          probeCallsAtAttemptStatus = probeCalls;
          reenteredStop = service.stop();
        }
      },
      probe: () => {
        probeCalls += 1;
        return probeCalls === 1 ? Promise.resolve(false) : pendingProbe.promise;
      },
    });
    service = harness.service;

    const started = service.start();
    await drainMicrotasks();
    await harness.clock.advanceBy(1);

    assert.equal(probeCallsAtAttemptStatus, 2);
    assert.strictEqual(reenteredStop, service.stop());
    assert.deepEqual(await reenteredStop, {
      attempts: 1,
      errorCode: null,
      ownership: "none",
      state: "stopped",
    });
    assert.deepEqual(await started, {
      attempts: 1,
      errorCode: null,
      ownership: "none",
      state: "stopped",
    });
    pendingProbe.resolve(true);
    await drainMicrotasks();
    assert.equal(service.getSnapshot().state, "stopped");
    assert.equal(probeCalls, 2);
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
    assert.equal(harness.clock.pendingCount(), 0);
  });

  await t.test("deadline crossed in attempt status observes the already-invoked probe", async () => {
    const clock = createFakeClock();
    let probeCalls = 0;
    let probeCallsAtAttemptStatus = null;
    const { service } = createService({
      clock,
      cooldownMs: 1,
      onStatus: (snapshot) => {
        if (snapshot.state === "probing" && snapshot.attempts === 1) {
          probeCallsAtAttemptStatus = probeCalls;
          clock.elapseWithoutTimers(9);
        }
      },
      probe: async () => {
        probeCalls += 1;
        return probeCalls > 1;
      },
      readinessDeadlineMs: 10,
    });

    const started = service.start();
    await drainMicrotasks();
    await clock.advanceBy(1);

    assert.equal(probeCallsAtAttemptStatus, 2);
    assert.deepEqual(await started, {
      attempts: 1,
      errorCode: "READINESS_TIMEOUT",
      ownership: "owned",
      state: "requires-setup",
    });
    assert.equal(probeCalls, 2);
    assert.equal(clock.pendingCount(), 0);
  });

  await t.test("stop from stopping reuses one promise and one signal", async () => {
    const child = new FakeChild({ killImpl: () => false });
    let probeCalls = 0;
    let reenteredStop = null;
    let service;
    const harness = createService({
      child,
      cooldownMs: 1,
      onStatus: (snapshot) => {
        if (snapshot.state === "stopping" && reenteredStop === null) {
          reenteredStop = service.stop();
        }
      },
      probe: async () => {
        probeCalls += 1;
        return probeCalls > 1;
      },
    });
    service = harness.service;
    const started = service.start();
    await drainMicrotasks();
    await harness.clock.advanceBy(1);
    await started;

    const stopped = service.stop();

    assert.strictEqual(reenteredStop, stopped);
    assert.deepEqual(await stopped, {
      attempts: 1,
      errorCode: "SHUTDOWN_SIGNAL_FAILED",
      ownership: "owned",
      state: "stopped",
    });
    assert.deepEqual(child.killCalls, ["SIGTERM"]);
  });
});

test("stop before start is permanent and both methods preserve promise identity", async () => {
  let probeCalls = 0;
  let spawnCalls = 0;
  const { service } = createService({
    probe: async () => { probeCalls += 1; return false; },
    spawnOnce: () => { spawnCalls += 1; return new FakeChild(); },
  });
  const stopped = service.stop();
  assert.strictEqual(stopped, service.stop());
  assert.equal((await stopped).state, "stopped");
  const started = service.start();
  assert.strictEqual(started, service.start());
  assert.equal((await started).state, "stopped");
  assert.equal(probeCalls, 0);
  assert.equal(spawnCalls, 0);
});

test("publishes frozen exact snapshots and contains observer exceptions", async () => {
  const statuses = [];
  const { service } = createService({
    onStatus: (snapshot) => {
      statuses.push(snapshot);
      throw new Error("observer failure");
    },
    probe: async () => true,
  });
  const result = await service.start();
  assert.equal(result.state, "ready-existing");
  assert.equal(statuses.length, 2);
  for (const snapshot of statuses) {
    assert.equal(Object.isFrozen(snapshot), true);
    assert.deepEqual(Object.keys(snapshot).sort(), [
      "attempts", "errorCode", "ownership", "state",
    ]);
  }
  assert.equal(Object.isFrozen(service.getSnapshot()), true);
  assert.equal(Object.isFrozen(service), true);
});

test("rejects invalid construction without performing work", () => {
  const valid = { probe: async () => true, spawnOnce: () => new FakeChild() };
  assert.throws(() => createManagedLocalService(), /probe/i);
  assert.throws(() => createManagedLocalService({ ...valid, maxAttempts: 0 }), /maxAttempts/);
  assert.throws(() => createManagedLocalService({ ...valid, cooldownMs: -1 }), /cooldownMs/);
  assert.throws(
    () => createManagedLocalService({ ...valid, readinessDeadlineMs: 0 }),
    /readinessDeadlineMs/,
  );
  assert.throws(
    () => createManagedLocalService({ ...valid, shutdownTimeoutMs: -1 }),
    /shutdownTimeoutMs/,
  );
});
