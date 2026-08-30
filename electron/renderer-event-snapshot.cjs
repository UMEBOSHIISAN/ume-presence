"use strict";

function isExternalSpeaking(voice) {
  return voice.phase === "active"
    && voice.activity === "speaking"
    && voice.outputMuted === false;
}

function isRitualCue(cue) {
  return cue === "greeting" || cue === "complete" || cue === "break";
}

function createRendererEventSnapshot() {
  let voice = null;
  let cue = null;
  let previewAnimation = null;
  let audioLevel = 0;
  let indicator = null;
  let listenerStatus = null;
  let bridgeConnected = null;

  function speechActive() {
    return voice !== null && isExternalSpeaking(voice);
  }

  function push(event) {
    if (event.type === "state") {
      const becameInactive = voice !== null
        && voice.phase !== "inactive"
        && event.state.phase === "inactive";
      voice = event.state;
      if (becameInactive || isExternalSpeaking(voice)) cue = null;
      previewAnimation = null;
      if (voice.phase !== "active" || voice.outputMuted) audioLevel = 0;
      return;
    }
    if (event.type === "audio-level") {
      audioLevel = event.level;
      return;
    }
    if (event.type === "animation") {
      if (!speechActive() && !isRitualCue(cue)) {
        cue = null;
        previewAnimation = event.animation;
      }
      return;
    }
    if (event.type === "presence-cue") {
      if (event.cue === "clear") {
        cue = null;
      } else if (speechActive()) {
        return;
      } else if (event.cue === "thinking") {
        if (voice?.phase === "active" && cue === null && previewAnimation === null) {
          cue = event.cue;
        }
      } else if (!isRitualCue(cue)) {
        cue = event.cue;
        previewAnimation = null;
      }
      return;
    }
    if (event.type === "indicator") {
      indicator = event.indicator === "clear" ? null : event.indicator;
      return;
    }
    if (event.type === "listener-status") {
      listenerStatus = event.status;
      return;
    }
    if (event.type === "bridge-status") bridgeConnected = event.connected;
  }

  function getEvents() {
    const events = [];
    if (voice !== null) events.push({ type: "state", state: voice });
    if (cue !== null) events.push({ type: "presence-cue", cue });
    else if (previewAnimation !== null) {
      events.push({ type: "animation", animation: previewAnimation });
    }
    if (audioLevel !== 0) events.push({ type: "audio-level", level: audioLevel });
    if (indicator !== null) events.push({ type: "indicator", indicator });
    if (listenerStatus !== null) {
      events.push({ type: "listener-status", status: listenerStatus });
    }
    if (bridgeConnected !== null) {
      events.push({ type: "bridge-status", connected: bridgeConnected });
    }
    return events;
  }

  return Object.freeze({ getEvents, push });
}

module.exports = { createRendererEventSnapshot };
