"use strict";

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const FAILED_STATUS = Object.freeze({ state: "failed" });
const GENERIC_STATES = new Set(["idle", "starting", "ready", "requires-setup", "failed"]);

function projectStatus(snapshot) {
  const state = snapshot?.state;
  if (!GENERIC_STATES.has(state)) return FAILED_STATUS;
  return Object.freeze({ state });
}

function createLoginRuntime({
  platform,
  loginState,
  characterRuntime,
  providerRegistry,
  adapterDeps,
  createManagedService,
  serviceOptions,
  trayStatus,
  debug = () => {},
} = {}) {
  let service = null;
  let startPromise = null;
  let loginLaunchPromise = null;
  let retryPromise = null;
  let stopPromise = null;
  let lastStopSnapshot = null;
  let lastStatus = Object.freeze({ state: "idle" });
  let statusFailed = false;

  function readStatus() {
    if (statusFailed) return FAILED_STATUS;
    try {
      lastStatus = projectStatus(trayStatus.getStatus());
      if (lastStatus === FAILED_STATUS) statusFailed = true;
    } catch {
      statusFailed = true;
      lastStatus = FAILED_STATUS;
    }
    return lastStatus;
  }

  function publish(snapshot) {
    if (!statusFailed) {
      try {
        trayStatus.update(snapshot);
      } catch {
        statusFailed = true;
        lastStatus = FAILED_STATUS;
      }
    }
    const status = readStatus();
    try {
      debug("speech engine status", status);
    } catch {
      // Debug observers cannot control the runtime lifecycle.
    }
    return status;
  }

  function fail() {
    return publish("failed");
  }

  function startFresh() {
    if (startPromise) return startPromise;
    const started = createDeferred();
    startPromise = started.promise;
    if (characterRuntime === null || characterRuntime === undefined) {
      started.resolve(fail());
      return startPromise;
    }

    let adapter;
    try {
      adapter = providerRegistry.createEngineAdapter(
        characterRuntime.providerId,
        adapterDeps,
      );
      if (adapter === null || typeof adapter !== "object") {
        started.resolve(fail());
        return startPromise;
      }
      service = createManagedService({
        ...serviceOptions,
        probe: adapter.probeReadiness,
        spawnOnce: adapter.spawnOnce,
        onStatus: publish,
      });
      lastStopSnapshot = null;
      if (service === null || typeof service !== "object"
        || typeof service.start !== "function" || typeof service.stop !== "function") {
        service = null;
        started.resolve(fail());
        return startPromise;
      }
    } catch {
      service = null;
      started.resolve(fail());
      return startPromise;
    }

    let serviceStart;
    try {
      serviceStart = service.start();
    } catch {
      started.resolve(fail());
      return startPromise;
    }
    Promise.resolve(serviceStart).then(
      (snapshot) => {
        if (snapshot?.state) publish(snapshot);
        started.resolve(readStatus());
      },
      () => started.resolve(fail()),
    );
    return startPromise;
  }

  function start() {
    return startFresh();
  }

  function resetForManualRetry() {
    if (statusFailed) return false;
    try {
      trayStatus.update({ state: "idle", reset: true });
    } catch {
      statusFailed = true;
      lastStatus = FAILED_STATUS;
      return false;
    }
    return readStatus().state === "idle";
  }

  function readServiceSnapshot() {
    if (service === null || typeof service.getSnapshot !== "function") return null;
    try {
      const snapshot = service.getSnapshot();
      if (snapshot !== null && typeof snapshot === "object") return snapshot;
    } catch {
      // Snapshot observers cannot control the runtime lifecycle.
    }
    return null;
  }

  function stopWasConfirmed() {
    const snapshot = readServiceSnapshot() ?? lastStopSnapshot;
    if (snapshot === null || snapshot === undefined) return false;
    return snapshot.state === "stopped" && snapshot.ownership === "none";
  }

  function retryStart() {
    if (retryPromise) return retryPromise;
    const retry = createDeferred();
    retryPromise = retry.promise;

    let serviceStop;
    try {
      serviceStop = stop();
    } catch {
      serviceStop = Promise.resolve({ state: "stop-failed" });
    }
    Promise.resolve(serviceStop).then(
      () => {
        if (!stopWasConfirmed()) {
          retryPromise = null;
          retry.resolve(readStatus());
          return;
        }
        service = null;
        startPromise = null;
        stopPromise = null;
        if (!resetForManualRetry()) {
          retryPromise = null;
          retry.resolve(readStatus());
          return;
        }
        const nextStart = startFresh();
        Promise.resolve(nextStart).then(
          (snapshot) => {
            retryPromise = null;
            retry.resolve(snapshot);
          },
          () => {
            retryPromise = null;
            retry.resolve(fail());
          },
        );
      },
      () => {
        retryPromise = null;
        retry.resolve(readStatus());
      },
    );
    return retry.promise;
  }

  function startManual() {
    const status = readStatus();
    if (status.state === "failed" || status.state === "requires-setup") {
      if (startPromise) return retryStart();
      if (!resetForManualRetry()) return Promise.resolve(readStatus());
    }
    return start();
  }

  function startIfLoginLaunch() {
    if (loginLaunchPromise) return loginLaunchPromise;
    if (platform !== "darwin" || loginState?.wasOpenedAtLogin !== true) {
      loginLaunchPromise = Promise.resolve(readStatus());
      return loginLaunchPromise;
    }
    loginLaunchPromise = start();
    return loginLaunchPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    const stopped = createDeferred();
    stopPromise = stopped.promise;
    if (service === null) {
      lastStopSnapshot = Object.freeze({ state: "stopped", ownership: "none" });
      stopped.resolve(readStatus());
      return stopPromise;
    }
    let serviceStop;
    try {
      serviceStop = service.stop();
    } catch {
      lastStopSnapshot = readServiceSnapshot() ?? Object.freeze({ state: "stop-failed" });
      stopped.resolve(readStatus());
      return stopPromise;
    }
    Promise.resolve(serviceStop).then(
      (snapshot) => {
        lastStopSnapshot = readServiceSnapshot() ?? snapshot ?? Object.freeze({ state: "stop-failed" });
        if (snapshot?.state) publish(snapshot);
        stopped.resolve(readStatus());
      },
      () => {
        lastStopSnapshot = readServiceSnapshot() ?? Object.freeze({ state: "stop-failed" });
        stopped.resolve(readStatus());
      },
    );
    return stopPromise;
  }

  function getStatus() {
    return readStatus();
  }

  return Object.freeze({ start, startManual, startIfLoginLaunch, stop, getStatus });
}

module.exports = { createLoginRuntime };
