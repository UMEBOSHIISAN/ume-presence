"use strict";

const MAX_SPEECH_CODE_POINTS = 240;

function countUnicodeCodePoints(text) {
  return [...String(text)].length;
}

function validateSpeechText(text) {
  if (typeof text !== "string") throw new TypeError("Speech text must be a string.");
  const trimmed = text.trim();
  if (!trimmed) throw new TypeError("Speech text cannot be empty.");
  if (countUnicodeCodePoints(trimmed) > MAX_SPEECH_CODE_POINTS) {
    throw new RangeError(`Speech text cannot exceed ${MAX_SPEECH_CODE_POINTS} characters.`);
  }
  return trimmed;
}

module.exports = {
  MAX_SPEECH_CODE_POINTS,
  countUnicodeCodePoints,
  validateSpeechText,
};
