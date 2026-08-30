"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createLoginRuntime } = require("./login-runtime.cjs");

function createHarness({
  platform = "darwin",
  wasOpenedAtLogin = true,
  characterRuntime = Object.freeze({ providerId: "selected-provider" }),
  adapterFailure = null,
  adapterResult,
} = {}) {
  const updates = [];
  let state = "idle";
  const serviceCalls = [];
  const adapter = Object.freeze({
    probeReadiness: () => false,
    spawnOnce: () => ({ child: true }),
  });
  let onStatus = null;
  let startCalls = 0;
  let stopCalls = 0;
  let startResult = Promise.resolve({ state: "ready-owned" });
  let stopResult = Promise.resolve({ state: "stopped", ownership: "none" });
  const service = Object.freeze({
    start() {
      startCalls += 1;
      return startResult;
    },
    stop() {
      stopCalls += 1;
      return stopResult;
    },
  });
  const trayStatus = Object.freeze({
    update(snapshot) {
      if (snapshot?.reset === true) {
        state = "idle";
        updates.push("reset");
        return;
      }
      const value = typeof snapshot === "string" ? snapshot : snapshot.state;
      if (state === "failed" || state === "requires-setup") return;
      state = value === "ready-owned" || value === "ready-existing" ? "ready" : value;
      updates.push(value);
    },
    getStatus: () => Object.freeze({ state }),
  });
  const providerCalls = [];
  const serviceOptions = Object.freeze({ readinessDeadlineMs: 120_000 });
  const adapterDeps = Object.freeze({ platform: "darwin", marker: true });
  const runtime = createLoginRuntime({
    platform,
    loginState: Object.freeze({ wasOpenedAtLogin }),
    characterRuntime,
    providerRegistry: {
      createEngineAdapter(providerId, deps) {
        providerCalls.push([providerId, deps]);
        if (adapterFailure) throw adapterFailure;
        return adapterResult === undefined ? adapter : adapterResult;
      },
    },
    adapterDeps,
    createManagedService(options) {
      serviceCalls.push(options);
      onStatus = options.onStatus;
      return service;
    },
    serviceOptions,
    trayStatus,
    debug: () => {},
  });

  return {
    adapter,
    adapterDeps,
    providerCalls,
    runtime,
    serviceCalls,
    serviceOptions,
    trayStatus,
    updates,
    emitStatus: (snapshot) => onStatus(snapshot),
    get startCalls() { return startCalls; },
    get stopCalls() { return stopCalls; },
    rejectStart(error) { startResult = Promise.reject(error); },
    resolveStart(snapshot = { state: "ready-owned" }) { startResult = Promise.resolve(snapshot); },
    rejectStop(error) { stopResult = Promise.reject(error); },
    setStopResult(snapshot = { state: "stopped", ownership: "none" }) {
      stopResult = Promise.resolve(snapshot);
    },
    stopWithoutResult() {
      stopResult = undefined;
    },
  };
}

test("manual launches stay idle without resolving an adapter or constructing a service", async () => {
  for (const options of [
    { platform: "darwin", wasOpenedAtLogin: false },
    { platform: "linux", wasOpenedAtLogin: true },
    { platform: "win32", wasOpenedAtLogin: true, characterRuntime: null },
  ]) {
    const harness = createHarness(options);
    const first = harness.runtime.startIfLoginLaunch();
    const second = harness.runtime.startIfLoginLaunch();

    assert.equal(first, second);
    assert.deepEqual(await first, { state: "idle" });
    assert.deepEqual(harness.providerCalls, []);
    assert.deepEqual(harness.serviceCalls, []);
    assert.deepEqual(harness.runtime.getStatus(), { state: "idle" });
  }
});

test("manual start works after a non-login startup check", async () => {
  const harness = createHarness({ wasOpenedAtLogin: false });

  assert.deepEqual(await harness.runtime.startIfLoginLaunch(), { state: "idle" });
  assert.deepEqual(await harness.runtime.startManual(), { state: "ready" });
  assert.equal(harness.providerCalls.length, 1);
  assert.equal(harness.startCalls, 1);
});

test("manual and login starts share one cached service start", async () => {
  const harness = createHarness();

  const first = harness.runtime.startManual();
  const second = harness.runtime.startIfLoginLaunch();
  assert.equal(first, second);
  await first;
  assert.equal(harness.providerCalls.length, 1);
  assert.equal(harness.serviceCalls.length, 1);
  assert.equal(harness.startCalls, 1);
  assert.deepEqual(Object.keys(harness.runtime), [
    "start",
    "startManual",
    "startIfLoginLaunch",
    "stop",
    "getStatus",
  ]);
});

test("Darwin login constructs and starts exactly one selected-provider service", async () => {
  const harness = createHarness();

  const started = harness.runtime.startIfLoginLaunch();
  assert.equal(harness.startCalls, 1);
  assert.deepEqual(harness.providerCalls, [["selected-provider", harness.adapterDeps]]);
  assert.equal(harness.serviceCalls.length, 1);
  assert.equal(harness.serviceCalls[0].probe, harness.adapter.probeReadiness);
  assert.equal(harness.serviceCalls[0].spawnOnce, harness.adapter.spawnOnce);
  assert.equal(harness.serviceCalls[0].readinessDeadlineMs, 120_000);
  assert.equal(typeof harness.serviceCalls[0].onStatus, "function");

  harness.emitStatus({
    state: "ready-existing",
    ownership: "none",
    attempts: 0,
    errorCode: null,
  });
  await started;
  assert.deepEqual(harness.runtime.getStatus(), { state: "ready" });
  assert.equal(Object.isFrozen(harness.runtime), true);
  assert.deepEqual(Object.keys(harness.runtime), [
    "start",
    "startManual",
    "startIfLoginLaunch",
    "stop",
    "getStatus",
  ]);
});

test("missing selected runtime or adapter is a bounded visible login failure", async () => {
  const privateFailure = new Error("private provider path /secret/provider");
  for (const options of [
    { characterRuntime: null },
    { adapterFailure: privateFailure },
    { adapterResult: null },
  ]) {
    const harness = createHarness(options);
    const result = await harness.runtime.startIfLoginLaunch();

    assert.deepEqual(result, { state: "failed" });
    assert.deepEqual(harness.runtime.getStatus(), { state: "failed" });
    assert.deepEqual(harness.serviceCalls, []);
  }
});

test("manager status is projected generically and terminal setup/failure cannot be cleared", async () => {
  for (const terminal of ["requires-setup", "failed"]) {
    const harness = createHarness();
    void harness.runtime.startIfLoginLaunch();
    harness.emitStatus({
      state: terminal,
      ownership: "owned",
      attempts: 59,
      errorCode: "private-error",
    });
    harness.emitStatus({
      state: "ready-owned",
      ownership: "owned",
      attempts: 60,
      errorCode: null,
    });

    assert.deepEqual(harness.runtime.getStatus(), { state: terminal });
  }
});

test("start and stop are exact cached non-rejecting promises", async () => {
  const harness = createHarness();
  harness.rejectStart(new Error("private start failure"));
  const firstStart = harness.runtime.startIfLoginLaunch();
  assert.equal(firstStart, harness.runtime.startIfLoginLaunch());
  assert.doesNotReject(firstStart);
  await firstStart;
  assert.deepEqual(harness.runtime.getStatus(), { state: "failed" });

  harness.rejectStop(new Error("private stop failure"));
  const firstStop = harness.runtime.stop();
  assert.equal(firstStop, harness.runtime.stop());
  await assert.doesNotReject(firstStop);
  assert.equal(harness.stopCalls, 1);
});

test("manual start retries a failed service only after an explicit user request", async () => {
  const harness = createHarness();
  harness.rejectStart(new Error("private start failure"));

  const firstStart = harness.runtime.startIfLoginLaunch();
  assert.deepEqual(await firstStart, { state: "failed" });
  assert.equal(harness.serviceCalls.length, 1);

  harness.resolveStart();
  const retryStart = harness.runtime.startManual();
  assert.notEqual(retryStart, firstStart);
  assert.deepEqual(await retryStart, { state: "ready" });
  assert.equal(harness.serviceCalls.length, 2);
  assert.equal(harness.startCalls, 2);
  assert.equal(harness.stopCalls, 1);
});

test("manual start clears a pre-start terminal status before constructing a service", async () => {
  const harness = createHarness({ wasOpenedAtLogin: false });
  harness.trayStatus.update("failed");

  assert.deepEqual(await harness.runtime.startManual(), { state: "ready" });
  assert.equal(harness.serviceCalls.length, 1);
  assert.equal(harness.startCalls, 1);
  assert.ok(harness.updates.includes("reset"));
});

test("manual retry preserves the service when owned shutdown is not confirmed", async () => {
  const harness = createHarness();
  harness.rejectStart(new Error("private start failure"));

  assert.deepEqual(await harness.runtime.startIfLoginLaunch(), { state: "failed" });
  harness.setStopResult({
    state: "stopped",
    ownership: "owned",
    errorCode: "SHUTDOWN_TIMEOUT",
  });

  assert.deepEqual(await harness.runtime.startManual(), { state: "failed" });
  assert.equal(harness.serviceCalls.length, 1);
  assert.equal(harness.startCalls, 1);
  assert.equal(harness.stopCalls, 1);
});

test("manual retry closes an unreported shutdown without creating a second service", async () => {
  const harness = createHarness();
  harness.rejectStart(new Error("private start failure"));

  assert.deepEqual(await harness.runtime.startIfLoginLaunch(), { state: "failed" });
  harness.stopWithoutResult();

  assert.deepEqual(await harness.runtime.startManual(), { state: "failed" });
  assert.equal(harness.serviceCalls.length, 1);
  assert.equal(harness.startCalls, 1);
  assert.equal(harness.stopCalls, 1);
});

test("synchronous adapter construction re-entry observes the exact cached start promise", async () => {
  let runtime = null;
  let reentered = null;
  let didReenter = false;
  let adapterCalls = 0;
  let serviceCalls = 0;
  let startCalls = 0;
  let state = "idle";
  runtime = createLoginRuntime({
    platform: "darwin",
    loginState: { wasOpenedAtLogin: true },
    characterRuntime: { providerId: "selected-provider" },
    providerRegistry: {
      createEngineAdapter() {
        adapterCalls += 1;
        if (!didReenter) {
          didReenter = true;
          reentered = runtime.startIfLoginLaunch();
        }
        return { probeReadiness() {}, spawnOnce() {} };
      },
    },
    adapterDeps: {},
    createManagedService() {
      serviceCalls += 1;
      return {
        start() {
          startCalls += 1;
          return Promise.resolve({ state: "ready-owned" });
        },
        stop: () => Promise.resolve({ state: "stopped" }),
      };
    },
    serviceOptions: {},
    trayStatus: {
      update(snapshot) {
        state = snapshot.state === "ready-owned" ? "ready" : snapshot.state;
      },
      getStatus: () => ({ state }),
    },
  });

  const first = runtime.startIfLoginLaunch();
  assert.equal(first, reentered);
  await first;
  assert.equal(adapterCalls, 1);
  assert.equal(serviceCalls, 1);
  assert.equal(startCalls, 1);
});

test("synchronous service stop re-entry observes the exact cached stop promise", async () => {
  let runtime = null;
  let reentered = null;
  let didReenter = false;
  let stopCalls = 0;
  const service = {
    start: () => Promise.resolve({ state: "ready-owned" }),
    stop() {
      stopCalls += 1;
      if (!didReenter) {
        didReenter = true;
        reentered = runtime.stop();
      }
      return Promise.resolve({ state: "stopped" });
    },
  };
  runtime = createLoginRuntime({
    platform: "darwin",
    loginState: { wasOpenedAtLogin: true },
    characterRuntime: { providerId: "selected-provider" },
    providerRegistry: {
      createEngineAdapter: () => ({ probeReadiness() {}, spawnOnce() {} }),
    },
    adapterDeps: {},
    createManagedService: () => service,
    serviceOptions: {},
    trayStatus: { update() {}, getStatus: () => ({ state: "ready" }) },
  });
  await runtime.startIfLoginLaunch();

  const first = runtime.stop();
  assert.equal(first, reentered);
  await first;
  assert.equal(stopCalls, 1);
});

test("throwing tray observers cannot reject or strand cached start and stop promises", async () => {
  let onStatus = null;
  let startCalls = 0;
  let stopCalls = 0;
  const runtime = createLoginRuntime({
    platform: "darwin",
    loginState: { wasOpenedAtLogin: true },
    characterRuntime: { providerId: "selected-provider" },
    providerRegistry: {
      createEngineAdapter: () => ({ probeReadiness() {}, spawnOnce() {} }),
    },
    adapterDeps: {},
    createManagedService(options) {
      onStatus = options.onStatus;
      return {
        start() {
          startCalls += 1;
          onStatus({ state: "starting" });
          return Promise.resolve({ state: "ready-owned" });
        },
        stop() {
          stopCalls += 1;
          onStatus({ state: "stopping" });
          return Promise.resolve({ state: "stopped" });
        },
      };
    },
    serviceOptions: {},
    trayStatus: {
      update() {
        throw new Error("private tray observer failure");
      },
      getStatus() {
        throw new Error("private tray snapshot failure");
      },
    },
  });

  const start = runtime.startIfLoginLaunch();
  assert.equal(start, runtime.startIfLoginLaunch());
  assert.deepEqual(await start, { state: "failed" });
  const stop = runtime.stop();
  assert.equal(stop, runtime.stop());
  assert.deepEqual(await stop, { state: "failed" });
  assert.deepEqual(runtime.getStatus(), { state: "failed" });
  assert.equal(startCalls, 1);
  assert.equal(stopCalls, 1);
});
