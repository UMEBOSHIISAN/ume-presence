"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { hasSpeechEngineStart } = require("./speech-engine-command.cjs");

test("accepts only the exact speech-engine start token", () => {
  assert.equal(hasSpeechEngineStart(["Persona", "--speech-engine=start"]), true);
  assert.equal(hasSpeechEngineStart(["Persona", "--speech-engine=start=extra"]), false);
  assert.equal(hasSpeechEngineStart(["Persona", "--speech-engine", "start"]), false);
  assert.equal(hasSpeechEngineStart(["Persona"]), false);
  assert.equal(hasSpeechEngineStart(null), false);
});
