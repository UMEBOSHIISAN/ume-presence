"use strict";

const {
  countUnicodeCodePoints,
  validateSpeechText,
} = require("./speech-text.cjs");

function busyError() {
  const error = new Error("Speech is already active.");
  error.code = "SPEECH_BUSY";
  return error;
}

function createSpeechController({ synthesize, play, stopPlayback = () => {} } = {}) {
  if (typeof synthesize !== "function") throw new TypeError("synthesize is required.");
  if (typeof play !== "function") throw new TypeError("play is required.");
  let busy = false;

  async function speak(text) {
    if (busy) throw busyError();
    const normalizedText = validateSpeechText(text);
    busy = true;
    try {
      const wav = await synthesize(normalizedText);
      await play(wav);
      return { codePoints: countUnicodeCodePoints(normalizedText) };
    } finally {
      busy = false;
    }
  }

  return {
    isBusy: () => busy,
    speak,
    stop: () => stopPlayback("Speech controller stopped."),
  };
}

module.exports = { createSpeechController };
