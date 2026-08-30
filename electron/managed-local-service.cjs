"use strict";

const DEFAULT_MAX_ATTEMPTS = 60;
const DEFAULT_COOLDOWN_MS = 2_000;
const DEFAULT_READINESS_DEADLINE_MS = 120_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

const STATES = new Set([
  "idle",
  "probing",
  "starting",
  "waiting",
  "ready-existing",
  "ready-owned",
  "requires-setup",
  "failed",
  "stopping",
  "stopped",
]);

const ERROR_CODES = new Set([
  null,
  "ENGINE_EXECUTABLE_MISSING",
  "PROBE_FAILED",
  "SPAWN_FAILED",
  "CHILD_EXITED",
  "READINESS_TIMEOUT",
  "SHUTDOWN_SIGNAL_FAILED",
  "SHUTDOWN_TIMEOUT",
]);

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function.`);
  return value;
}

function requireInteger(value, name, { minimum }) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function sameSnapshot(left, right) {
  return left.state === right.state
    && left.ownership === right.ownership
    && left.attempts === right.attempts
    && left.errorCode === right.errorCode;
}

function isChildLike(value) {
  return value !== null
    && typeof value === "object"
    && typeof value.on === "function"
    && typeof value.once === "function"
    && typeof value.kill === "function"
    && Object.hasOwn(value, "exitCode")
    && Object.hasOwn(value, "signalCode");
}

function isChildLive(value) {
  return value?.exitCode === null && value?.signalCode === null;
}

function createManagedLocalService({
  probe,
  spawnOnce,
  onStatus,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  now = () => performance.now(),
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  cooldownMs = DEFAULT_COOLDOWN_MS,
  readinessDeadlineMs = DEFAULT_READINESS_DEADLINE_MS,
  shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  requireFunction(probe, "probe");
  requireFunction(spawnOnce, "spawnOnce");
  if (onStatus !== undefined) requireFunction(onStatus, "onStatus");
  requireFunction(setTimer, "setTimer");
  requireFunction(clearTimer, "clearTimer");
  requireFunction(now, "now");
  requireInteger(maxAttempts, "maxAttempts", { minimum: 1 });
  requireInteger(cooldownMs, "cooldownMs", { minimum: 0 });
  requireInteger(readinessDeadlineMs, "readinessDeadlineMs", { minimum: 1 });
  requireInteger(shutdownTimeoutMs, "shutdownTimeoutMs", { minimum: 0 });

  let snapshot = Object.freeze({
    state: "idle",
    ownership: "none",
    attempts: 0,
    errorCode: null,
  });
  let startPromise = null;
  let stopPromise = null;
  let deadlineAt = null;
  let deadlineTimer = null;
  let cooldownTimer = null;
  let shutdownTimer = null;
  let deadlineReached = false;
  let stopRequested = false;
  let readinessSettled = false;
  let child = null;
  let childLost = false;
  let childLossSignal = null;
  let childExitSignal = null;
  const stopSignal = createDeferred();
  let deadlineSignal = null;

  function commitSnapshot({
    state = snapshot.state,
    ownership = snapshot.ownership,
    attempts = snapshot.attempts,
    errorCode = snapshot.errorCode,
  }) {
    if (!STATES.has(state)) throw new TypeError("Invalid managed service state.");
    if (ownership !== "none" && ownership !== "owned") {
      throw new TypeError("Invalid managed service ownership.");
    }
    if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > maxAttempts) {
      throw new TypeError("Invalid managed service attempt count.");
    }
    if (!ERROR_CODES.has(errorCode)) throw new TypeError("Invalid managed service error code.");
    const next = { state, ownership, attempts, errorCode };
    if (sameSnapshot(snapshot, next)) return null;
    snapshot = Object.freeze(next);
    return snapshot;
  }

  function notifyStatus(statusSnapshot) {
    if (onStatus) {
      try {
        onStatus(statusSnapshot);
      } catch {
        // Status observers cannot control lifecycle progress.
      }
    }
  }

  function publish(update) {
    const committed = commitSnapshot(update);
    if (committed !== null) notifyStatus(committed);
    return snapshot;
  }

  function clearKnownTimer(timer) {
    if (timer === null) return;
    try {
      clearTimer(timer);
    } catch {
      // Injected timer cleanup cannot reopen or reject a terminal state.
    }
  }

  function clearReadinessTimers() {
    clearKnownTimer(deadlineTimer);
    clearKnownTimer(cooldownTimer);
    deadlineTimer = null;
    cooldownTimer = null;
  }

  function isAtDeadline() {
    return deadlineReached || (deadlineAt !== null && now() >= deadlineAt);
  }

  function armDeadline() {
    const delayMs = Math.max(0, deadlineAt - now());
    try {
      deadlineTimer = setTimer(() => {
        deadlineTimer = null;
        deadlineReached = true;
        deadlineSignal.resolve("deadline");
      }, delayMs);
    } catch {
      deadlineReached = true;
      deadlineSignal.resolve("deadline");
    }
  }

  function settleReadiness(state, errorCode, ownership = snapshot.ownership) {
    if (readinessSettled || stopRequested) return snapshot;
    readinessSettled = true;
    clearReadinessTimers();
    return publish({ state, ownership, errorCode });
  }

  async function waitForStopCompletion() {
    if (stopPromise) await stopPromise;
    return snapshot;
  }

  async function invokeProbe({ countAttempt = false } = {}) {
    if (stopRequested) return { kind: "stop" };
    if (isAtDeadline()) return { kind: "deadline" };
    const attemptSnapshot = countAttempt
      ? commitSnapshot({ attempts: snapshot.attempts + 1 })
      : null;

    let rawResult;
    try {
      rawResult = probe();
    } catch {
      rawResult = Promise.reject(new Error("probe failed"));
    }
    if (attemptSnapshot !== null) notifyStatus(attemptSnapshot);
    const observed = Promise.resolve(rawResult).then(
      (value) => ({ kind: "probe", value }),
      () => ({ kind: "probe-error" }),
    );
    const result = await Promise.race([
      observed,
      stopSignal.promise.then(() => ({ kind: "stop" })),
      deadlineSignal.promise.then(() => ({ kind: "deadline" })),
    ]);
    if (result.kind === "probe" || result.kind === "probe-error") {
      if (stopRequested) return { kind: "stop" };
      if (isAtDeadline()) return { kind: "deadline" };
    }
    if (result.kind === "probe" && typeof result.value !== "boolean") {
      return { kind: "probe-error" };
    }
    return result;
  }

  async function waitForCooldownOrSignal() {
    if (stopRequested) return "stop";
    if (isAtDeadline()) return "deadline";
    if (childLost) return "child";

    const elapsed = createDeferred();
    try {
      cooldownTimer = setTimer(() => {
        cooldownTimer = null;
        elapsed.resolve("elapsed");
      }, cooldownMs);
    } catch {
      return "deadline";
    }
    const result = await Promise.race([
      elapsed.promise,
      stopSignal.promise.then(() => "stop"),
      deadlineSignal.promise.then(() => "deadline"),
      childLossSignal.promise.then(() => "child"),
    ]);
    if (cooldownTimer !== null) {
      clearKnownTimer(cooldownTimer);
      cooldownTimer = null;
    }
    if (result === "elapsed" && isAtDeadline()) return "deadline";
    return result;
  }

  function observeChildLoss(target) {
    if (target !== child || childLost) return;
    childLost = true;
    childLossSignal.resolve("child");
    childExitSignal.resolve("child");

    if (readinessSettled && snapshot.state === "ready-owned" && !stopRequested) {
      publish({ state: "failed", ownership: "none", errorCode: "CHILD_EXITED" });
      return;
    }
    if (snapshot.ownership === "owned") publish({ ownership: "none" });
  }

  function attachChild(target) {
    child = target;
    childLost = false;
    childLossSignal = createDeferred();
    childExitSignal = createDeferred();
    target.on("error", () => {
      if (stopRequested && isChildLive(target)) return;
      observeChildLoss(target);
    });
    target.once("exit", () => observeChildLoss(target));
    if (!isChildLive(target)) observeChildLoss(target);
  }

  async function runStart() {
    publish({ state: "probing", errorCode: null });
    const initial = await invokeProbe();
    if (initial.kind === "stop") return waitForStopCompletion();
    if (initial.kind === "deadline") {
      return settleReadiness("requires-setup", "READINESS_TIMEOUT", "none");
    }
    if (initial.kind === "probe-error") {
      return settleReadiness("failed", "PROBE_FAILED", "none");
    }
    if (initial.value) return settleReadiness("ready-existing", null, "none");

    publish({ state: "starting", ownership: "none", errorCode: null });
    if (stopRequested) return waitForStopCompletion();
    let spawned;
    try {
      spawned = spawnOnce();
    } catch (error) {
      const code = error?.code === "ENGINE_EXECUTABLE_MISSING"
        ? "ENGINE_EXECUTABLE_MISSING"
        : "SPAWN_FAILED";
      const state = code === "ENGINE_EXECUTABLE_MISSING" ? "requires-setup" : "failed";
      return settleReadiness(state, code, "none");
    }
    if (!isChildLike(spawned)) return settleReadiness("failed", "SPAWN_FAILED", "none");
    attachChild(spawned);
    publish({
      state: "waiting",
      ownership: childLost ? "none" : "owned",
      errorCode: null,
    });

    while (!readinessSettled && !stopRequested) {
      if (snapshot.attempts >= maxAttempts) {
        return settleReadiness("requires-setup", "READINESS_TIMEOUT");
      }
      if (isAtDeadline()) return settleReadiness("requires-setup", "READINESS_TIMEOUT");

      if (!childLost) {
        const waitResult = await waitForCooldownOrSignal();
        if (waitResult === "stop") return waitForStopCompletion();
        if (waitResult === "deadline") {
          return settleReadiness("requires-setup", "READINESS_TIMEOUT");
        }
      }
      if (stopRequested) return waitForStopCompletion();
      if (isAtDeadline()) return settleReadiness("requires-setup", "READINESS_TIMEOUT");

      publish({ state: "probing" });
      const result = await invokeProbe({ countAttempt: true });
      if (result.kind === "stop") return waitForStopCompletion();
      if (result.kind === "deadline") {
        return settleReadiness("requires-setup", "READINESS_TIMEOUT");
      }
      if (!childLost && !isChildLive(child)) observeChildLoss(child);
      if (result.kind === "probe-error") {
        return settleReadiness(
          "failed",
          childLost ? "CHILD_EXITED" : "PROBE_FAILED",
          childLost ? "none" : "owned",
        );
      }
      if (result.value) {
        return settleReadiness(
          childLost ? "ready-existing" : "ready-owned",
          null,
          childLost ? "none" : "owned",
        );
      }
      if (childLost) return settleReadiness("failed", "CHILD_EXITED", "none");
      publish({ state: "waiting", ownership: "owned", errorCode: null });
    }
    return stopRequested ? waitForStopCompletion() : snapshot;
  }

  function start() {
    if (startPromise) return startPromise;
    const started = createDeferred();
    startPromise = started.promise;
    if (stopRequested || snapshot.state === "stopped") {
      started.resolve(snapshot);
      return startPromise;
    }
    let operation;
    try {
      deadlineAt = now() + readinessDeadlineMs;
      deadlineSignal = createDeferred();
      armDeadline();
      operation = runStart();
    } catch {
      operation = settleReadiness("failed", "PROBE_FAILED", "none");
    }
    Promise.resolve(operation).then(
      (result) => started.resolve(result),
      () => started.resolve(settleReadiness("failed", "PROBE_FAILED", "none")),
    );
    return startPromise;
  }

  async function waitForOwnedChildExit() {
    if (!child || childLost || !isChildLive(child)) {
      if (child && !childLost) observeChildLoss(child);
      return "exited";
    }
    const expired = createDeferred();
    try {
      shutdownTimer = setTimer(() => {
        shutdownTimer = null;
        expired.resolve("timeout");
      }, shutdownTimeoutMs);
    } catch {
      return "timeout";
    }
    const result = await Promise.race([
      childExitSignal.promise.then(() => "exited"),
      expired.promise,
    ]);
    if (shutdownTimer !== null) {
      clearKnownTimer(shutdownTimer);
      shutdownTimer = null;
    }
    return result;
  }

  async function runStop() {
    stopRequested = true;
    stopSignal.resolve("stop");
    clearReadinessTimers();
    publish({ state: "stopping", errorCode: null });

    if (child && snapshot.ownership === "owned") {
      if (!isChildLive(child)) observeChildLoss(child);
      if (!childLost && isChildLive(child)) {
        let signaled;
        try {
          signaled = child.kill("SIGTERM") === true;
        } catch {
          signaled = false;
        }
        if (!signaled) {
          return publish({ state: "stopped", errorCode: "SHUTDOWN_SIGNAL_FAILED" });
        }
        const outcome = await waitForOwnedChildExit();
        if (outcome === "timeout") {
          return publish({ state: "stopped", errorCode: "SHUTDOWN_TIMEOUT" });
        }
      }
    }
    return publish({ state: "stopped", errorCode: null });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const stopped = createDeferred();
    stopPromise = stopped.promise;
    let operation;
    try {
      operation = runStop();
    } catch {
      operation = publish({
        state: "stopped",
        errorCode: snapshot.ownership === "owned"
          ? "SHUTDOWN_SIGNAL_FAILED"
          : null,
      });
    }
    Promise.resolve(operation).then(
      (result) => stopped.resolve(result),
      () => stopped.resolve(publish({
        state: "stopped",
        errorCode: snapshot.ownership === "owned"
          ? "SHUTDOWN_SIGNAL_FAILED"
          : null,
      })),
    );
    return stopPromise;
  }

  function getSnapshot() {
    return snapshot;
  }

  return Object.freeze({ getSnapshot, start, stop });
}

module.exports = {
  createManagedLocalService,
};
