"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createSpeechVoiceState,
  routeExternalEvent,
} = require("./speech-voice-state.cjs");

const idle = { activity: "idle", phase: "inactive" };
const externalSpeaking = { activity: "speaking", phase: "active" };
const internalSpeaking = { activity: "speaking", phase: "internal" };

test("restores the latest external listener state after internal speech", () => {
  const emitted = [];
  const coordinator = createSpeechVoiceState({
    initialExternalState: idle,
    internalSpeakingState: internalSpeaking,
    emit: (state) => emitted.push(state),
  });

  coordinator.startInternal();
  coordinator.updateExternal(externalSpeaking);
  assert.deepEqual(emitted, [internalSpeaking]);

  coordinator.finishInternal();
  assert.deepEqual(emitted, [internalSpeaking, externalSpeaking]);
});

test("external listener state emits normally outside internal speech", () => {
  const emitted = [];
  const coordinator = createSpeechVoiceState({
    initialExternalState: idle,
    internalSpeakingState: internalSpeaking,
    emit: (state) => emitted.push(state),
  });

  coordinator.updateExternal(externalSpeaking);

  assert.deepEqual(emitted, [externalSpeaking]);
});

test("external state events share the coordinator while other events emit directly", () => {
  const coordinated = [];
  const emitted = [];
  const coordinator = { updateExternal: (event) => coordinated.push(event) };
  const stateEvent = { type: "state", state: externalSpeaking };
  const animationEvent = { type: "animation", animation: "DANCE" };

  routeExternalEvent(stateEvent, { coordinator, emit: (event) => emitted.push(event) });
  routeExternalEvent(animationEvent, { coordinator, emit: (event) => emitted.push(event) });

  assert.deepEqual(coordinated, [stateEvent]);
  assert.deepEqual(emitted, [animationEvent]);
});
