"use strict";

function createSpeechVoiceState({ initialExternalState, internalSpeakingState, emit } = {}) {
  if (typeof emit !== "function") throw new TypeError("emit is required.");
  let externalState = initialExternalState;
  let internalActive = false;

  function updateExternal(state) {
    externalState = state;
    if (!internalActive) emit(state);
  }

  function startInternal() {
    internalActive = true;
    emit(internalSpeakingState);
  }

  function finishInternal() {
    if (!internalActive) return;
    internalActive = false;
    emit(externalState);
  }

  return { finishInternal, startInternal, updateExternal };
}

function routeExternalEvent(event, { coordinator, emit } = {}) {
  if (event?.type === "state" && coordinator) coordinator.updateExternal(event);
  else emit(event);
}

module.exports = { createSpeechVoiceState, routeExternalEvent };
