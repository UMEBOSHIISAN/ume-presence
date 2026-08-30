"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_SPEECH_CODE_POINTS,
  countUnicodeCodePoints,
  validateSpeechText,
} = require("./speech-text.cjs");

test("counts Unicode code points instead of UTF-16 code units", () => {
  assert.equal(countUnicodeCodePoints("a😀"), 2);
});

test("trims speech text and rejects empty or non-string input", () => {
  assert.equal(validateSpeechText("  おかえり。  "), "おかえり。");
  assert.throws(() => validateSpeechText("   "), /empty/i);
  assert.throws(() => validateSpeechText(null), /string/i);
});

test("accepts the Unicode speech limit and rejects one code point over it", () => {
  const exactLimit = "😀".repeat(MAX_SPEECH_CODE_POINTS);

  assert.equal(validateSpeechText(exactLimit), exactLimit);
  assert.throws(() => validateSpeechText(`${exactLimit}😀`), /240/);
});
