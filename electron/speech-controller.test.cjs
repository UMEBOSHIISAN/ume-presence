"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createSpeechController } = require("./speech-controller.cjs");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

test("synthesizes then plays one speech operation", async () => {
  const calls = [];
  const controller = createSpeechController({
    synthesize: async (text) => {
      calls.push(["synthesize", text]);
      return Buffer.from("RIFF");
    },
    play: async (wav) => {
      calls.push(["play", wav.toString()]);
    },
  });

  const result = await controller.speak(" 発送は三件です。 ");

  assert.deepEqual(calls, [
    ["synthesize", "発送は三件です。"],
    ["play", "RIFF"],
  ]);
  assert.deepEqual(result, { codePoints: 8 });
  assert.equal(controller.isBusy(), false);
});

test("rejects invalid generic speech text before synthesis", async () => {
  let synthesizeCalls = 0;
  const controller = createSpeechController({
    synthesize: async () => {
      synthesizeCalls += 1;
      return Buffer.from("RIFF");
    },
    play: async () => {},
  });

  await assert.rejects(controller.speak("   "), /empty/i);
  await assert.rejects(controller.speak("😀".repeat(241)), /240/);

  assert.equal(synthesizeCalls, 0);
  assert.equal(controller.isBusy(), false);
});

test("rejects overlap before synthesis and never queues it", async () => {
  const synthesis = deferred();
  let synthesizeCalls = 0;
  const controller = createSpeechController({
    synthesize: () => {
      synthesizeCalls += 1;
      return synthesis.promise;
    },
    play: async () => {},
  });

  const first = controller.speak("一件目です。");
  await assert.rejects(
    controller.speak("二件目です。"),
    (error) => error.code === "SPEECH_BUSY",
  );
  assert.equal(synthesizeCalls, 1);
  synthesis.resolve(Buffer.from("RIFF"));
  await first;
  assert.equal(controller.isBusy(), false);
});

test("provider and renderer failures both clear busy state", async () => {
  const providerFailure = createSpeechController({
    synthesize: async () => {
      throw new Error("provider offline");
    },
    play: async () => {},
  });
  await assert.rejects(providerFailure.speak("おかえり。"), /provider offline/);
  assert.equal(providerFailure.isBusy(), false);

  const rendererFailure = createSpeechController({
    synthesize: async () => Buffer.from("RIFF"),
    play: async () => {
      throw new Error("renderer failed");
    },
  });
  await assert.rejects(rendererFailure.speak("おかえり。"), /renderer failed/);
  assert.equal(rendererFailure.isBusy(), false);
});

test("stop delegates to the renderer bridge without adding a queue", () => {
  const reasons = [];
  const controller = createSpeechController({
    synthesize: async () => Buffer.from("RIFF"),
    play: async () => {},
    stopPlayback: (reason) => reasons.push(reason),
  });

  controller.stop();

  assert.deepEqual(reasons, ["Speech controller stopped."]);
  assert.equal(controller.isBusy(), false);
});
