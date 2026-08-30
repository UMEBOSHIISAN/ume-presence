"use strict";

const DEFAULT_SHUTDOWN_DEADLINE_MS = 6_000;

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createAppShutdownCoordinator({
  cleanupNow,
  stopRuntime,
  exit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  shutdownDeadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
} = {}) {
  let shutdownPromise = null;

  function handleBeforeQuit(event) {
    event?.preventDefault?.();
    if (shutdownPromise) return shutdownPromise;

    const shutdown = createDeferred();
    shutdownPromise = shutdown.promise;
    const runShutdown = async () => {
      try {
        cleanupNow();
      } catch {
        // Synchronous cleanup failure cannot block runtime shutdown.
      }

      let stopPromise;
      try {
        stopPromise = Promise.resolve(stopRuntime()).catch(() => undefined);
      } catch {
        stopPromise = Promise.resolve();
      }

      let timer = null;
      const deadline = new Promise((resolve) => {
        try {
          timer = setTimer(resolve, shutdownDeadlineMs);
          timer?.unref?.();
        } catch {
          resolve();
        }
      });
      await Promise.race([stopPromise, deadline]);
      if (timer !== null) {
        try {
          clearTimer(timer);
        } catch {
          // Timer cleanup cannot block process termination.
        }
      }
      try {
        exit(0);
      } catch {
        // Electron exit is the terminal operation.
      }
    };
    void runShutdown().then(shutdown.resolve, shutdown.resolve);
    return shutdownPromise;
  }

  return Object.freeze({ handleBeforeQuit });
}

module.exports = { createAppShutdownCoordinator };
