"use strict";

const RITUAL_DURATIONS_MS = Object.freeze({
  greeting: 2_600,
  work_complete: 1_800,
  break: 2_200,
});
const RITUAL_TO_CUE = Object.freeze({
  greeting: "greeting",
  work_complete: "complete",
  break: "break",
});

function createRitualController(options) {
  if (!options || typeof options.emit !== "function" ||
      typeof options.setTimer !== "function" ||
      typeof options.clearTimer !== "function") {
    throw new TypeError("emit, setTimer, and clearTimer are required");
  }

  const { emit, setTimer, clearTimer } = options;
  let active = null;
  let timer = null;

  function finish() {
    if (active === null) return false;
    const finishedTimer = timer;
    active = null;
    timer = null;
    if (finishedTimer !== null) clearTimer(finishedTimer);
    emit({ type: "presence-cue", cue: "clear" });
    return true;
  }

  return {
    start(ritual) {
      if (!Object.prototype.hasOwnProperty.call(RITUAL_DURATIONS_MS, ritual)) {
        throw new Error(`Unknown ritual: ${ritual}`);
      }
      if (active !== null) return { status: "busy", ritual: active };

      active = ritual;
      emit({ type: "presence-cue", cue: RITUAL_TO_CUE[ritual] });
      timer = setTimer(() => finish(), RITUAL_DURATIONS_MS[ritual]);
      timer.unref?.();
      return { status: "started", ritual };
    },
    cancel() {
      return finish();
    },
    dispose() {
      return finish();
    },
    getActive() {
      return active;
    },
  };
}

module.exports = {
  RITUAL_DURATIONS_MS,
  RITUAL_TO_CUE,
  createRitualController,
};
