"use strict";

const LABELS = Object.freeze({
  idle: "Speech engine: idle",
  starting: "Speech engine: starting",
  ready: "Speech engine: ready",
  "requires-setup": "Speech engine: setup required",
  failed: "Speech engine: failed",
});

const TERMINAL_STATES = new Set(["requires-setup", "failed"]);

function projectState(snapshot) {
  const state = typeof snapshot === "string" ? snapshot : snapshot?.state;
  if (state === "idle" || state === "stopped") return "idle";
  if (state === "probing" || state === "starting" || state === "waiting" || state === "stopping") {
    return "starting";
  }
  if (state === "ready" || state === "ready-existing" || state === "ready-owned") return "ready";
  if (state === "requires-setup") return "requires-setup";
  return "failed";
}

function createTrayStatus({
  buildFromTemplate,
  setContextMenu,
  onShow,
  onHide,
  onPreviewListening,
  onPreviewSpeaking,
  onPreviewDance,
  onQuit,
} = {}) {
  let status = Object.freeze({ state: "idle" });

  function rebuild() {
    try {
      const menu = buildFromTemplate([
        { label: LABELS[status.state], enabled: false },
        { type: "separator" },
        { label: "Show UME Presence", click: onShow },
        { label: "Hide UME Presence", click: onHide },
        { type: "separator" },
        { label: "Preview listening", click: onPreviewListening },
        { label: "Preview speaking", click: onPreviewSpeaking },
        { label: "Preview dance", click: onPreviewDance },
        { type: "separator" },
        { label: "Quit UME Presence", click: onQuit },
      ]);
      setContextMenu(menu);
    } catch {
      // Menu rendering is observational; committed status remains authoritative.
    }
  }

  function update(snapshot) {
    if (snapshot?.reset === true) {
      status = Object.freeze({ state: "idle" });
      rebuild();
      return status;
    }
    if (TERMINAL_STATES.has(status.state)) return status;
    const state = projectState(snapshot);
    if (state === status.state) return status;
    status = Object.freeze({ state });
    rebuild();
    return status;
  }

  function getStatus() {
    return status;
  }

  rebuild();
  return Object.freeze({ update, getStatus });
}

module.exports = { createTrayStatus };
