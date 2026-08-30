"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { parseProtocolUrl } = require("./protocol-actions.cjs");

test("maps Persona URLs to lifecycle and clamped level events", () => {
  const commands = parseProtocolUrl("persona://speaking?level=3");
  assert.equal(commands[0].event.state.activity, "speaking");
  assert.deepEqual(commands[1].event, { type: "audio-level", level: 1 });
  assert.equal(parseProtocolUrl("persona://inactive")[0].event.state.phase, "inactive");
});

test("maps window and animation URLs without accepting another scheme", () => {
  assert.deepEqual(parseProtocolUrl("persona://toggle"), [{ type: "toggle" }]);
  assert.deepEqual(parseProtocolUrl("persona://dance"), [
    { type: "event", event: { type: "animation", animation: "DANCE" } },
  ]);
  assert.equal(parseProtocolUrl("another-product://show"), null);
  assert.equal(parseProtocolUrl("not a URL"), null);
});

test("maps thinking and closed ritual URLs without accepting arbitrary names", () => {
  assert.deepEqual(parseProtocolUrl("persona://thinking"), [
    { type: "event", event: { type: "presence-cue", cue: "thinking" } },
  ]);
  assert.deepEqual(parseProtocolUrl("persona://ritual/greeting"), [
    { type: "ritual", ritual: "greeting" },
  ]);
  assert.deepEqual(parseProtocolUrl("persona://ritual/work-complete"), [
    { type: "ritual", ritual: "work_complete" },
  ]);
  assert.deepEqual(parseProtocolUrl("persona://ritual/break"), [
    { type: "ritual", ritual: "break" },
  ]);
  assert.equal(parseProtocolUrl("persona://ritual/run-command"), null);
});

test("rejects authority and envelope modifiers on closed presence URLs", () => {
  const malformedUrls = [
    "persona://thinking/extra",
    "persona://thinking?text=secret",
    "persona://thinking#fragment",
    "persona://thinking?",
    "persona://thinking#",
    "persona://user@thinking",
    "persona://thinking:444",
    "persona://ritual/break?duration=999",
    "persona://ritual/break#fragment",
    "persona://user@ritual/break",
    "persona://ritual:444/break",
    "persona://ritual/anything/../break",
    "persona://ritual/%2e%2e/break",
    "persona://ritual/break?",
    "persona://ritual/break#",
  ];

  for (const url of malformedUrls) assert.equal(parseProtocolUrl(url), null, url);
});
