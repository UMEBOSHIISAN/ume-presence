"use strict";

const THINKING_TIMEOUT_MS = 30_000;

function createThinkingCueExpiry(options) {
  if (!options || typeof options.emit !== "function" ||
      typeof options.setTimer !== "function" ||
      typeof options.clearTimer !== "function") {
    throw new TypeError("emit, setTimer, and clearTimer are required");
  }

  const { emit, setTimer, clearTimer } = options;
  let active = false;
  let timer = null;

  function cancel() {
    if (!active) return false;
    const activeTimer = timer;
    active = false;
    timer = null;
    if (activeTimer !== null) clearTimer(activeTimer);
    return true;
  }

  function finish() {
    if (!active) return false;
    active = false;
    timer = null;
    emit({ type: "presence-cue", cue: "clear" });
    return true;
  }

  return {
    start() {
      cancel();
      active = true;
      timer = setTimer(finish, THINKING_TIMEOUT_MS);
      timer.unref?.();
    },
    cancel,
    dispose: cancel,
    isActive: () => active,
  };
}

module.exports = {
  THINKING_TIMEOUT_MS,
  createThinkingCueExpiry,
};
