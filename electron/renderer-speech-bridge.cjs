"use strict";

const SPEECH_CHANNEL = "persona:speech";
const SPEECH_CANCEL_CHANNEL = "persona:speech-cancel";
const DEFAULT_PLAYBACK_TIMEOUT_MS = 60_000;
const MAX_RENDERER_ERROR_LENGTH = 160;

function speechError(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function boundedRendererMessage(message) {
  if (typeof message !== "string" || !message.trim()) return "Renderer speech playback failed.";
  return message.trim().slice(0, MAX_RENDERER_ERROR_LENGTH);
}

function createRendererSpeechBridge({
  getWindow,
  onStarted = () => {},
  onFinished = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  timeoutMs = DEFAULT_PLAYBACK_TIMEOUT_MS,
} = {}) {
  if (typeof getWindow !== "function") throw new TypeError("getWindow is required.");

  let sequence = 0;
  let active = null;

  function finish(operation, error) {
    if (active !== operation) return;
    clearTimer(operation.timer);
    active = null;
    if (operation.started) onFinished();
    if (error) operation.reject(error);
    else operation.resolve();
  }

  function cancelRenderer(operation) {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed?.() ||
      !window.webContents ||
      window.webContents.id !== operation.senderId
    ) {
      return;
    }
    try {
      window.webContents.send(SPEECH_CANCEL_CHANNEL, { id: operation.id });
    } catch {
      // The main-process result still settles even if the renderer disappeared.
    }
  }

  function play(wavBytes) {
    if (active) {
      return Promise.reject(speechError("Speech playback is already active.", "SPEECH_BUSY"));
    }
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed?.() ||
      !window.webContents ||
      window.webContents.isLoading?.()
    ) {
      return Promise.reject(speechError("Persona renderer is unavailable.", "RENDERER_UNAVAILABLE"));
    }

    return new Promise((resolve, reject) => {
      const operation = {
        id: `speech-${++sequence}`,
        senderId: window.webContents.id,
        started: false,
        timer: null,
        resolve,
        reject,
      };
      active = operation;
      operation.timer = setTimer(() => {
        cancelRenderer(operation);
        finish(operation, speechError("Renderer speech playback timed out.", "SPEECH_TIMEOUT"));
      }, timeoutMs);

      try {
        window.webContents.send(SPEECH_CHANNEL, {
          id: operation.id,
          wavBytes: Uint8Array.from(wavBytes),
        });
      } catch (error) {
        finish(
          operation,
          speechError(error?.message || "Persona renderer send failed.", "RENDERER_UNAVAILABLE"),
        );
      }
    });
  }

  function handleRendererResult(senderId, payload) {
    if (
      !active ||
      senderId !== active.senderId ||
      !payload ||
      payload.id !== active.id
    ) {
      return false;
    }
    if (payload.status === "started") {
      if (!active.started) {
        active.started = true;
        onStarted();
      }
      return true;
    }
    if (payload.status === "completed") {
      finish(active);
      return true;
    }
    if (payload.status === "failed") {
      finish(
        active,
        speechError(boundedRendererMessage(payload.message), "SPEECH_PLAYBACK_FAILED"),
      );
      return true;
    }
    return false;
  }

  function stop(reason = "Speech playback stopped.") {
    if (!active) return;
    cancelRenderer(active);
    finish(active, speechError(boundedRendererMessage(reason), "SPEECH_STOPPED"));
  }

  return {
    handleRendererResult,
    isBusy: () => active != null,
    play,
    stop,
  };
}

module.exports = {
  DEFAULT_PLAYBACK_TIMEOUT_MS,
  SPEECH_CANCEL_CHANNEL,
  SPEECH_CHANNEL,
  createRendererSpeechBridge,
};
