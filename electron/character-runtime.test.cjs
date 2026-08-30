"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  CHARACTER_UNAVAILABLE,
  createCharacterRuntimeBinding,
  createInitializationActionGate,
  loadCharacterRuntime,
} = require("./character-runtime.cjs");

function createLoadedPack({
  provider = "aivis",
  profile = {
    styleId: 987654,
    speedScale: 1,
    tempoDynamicsScale: 1,
    pitchScale: 0,
    volumeScale: 1,
  },
} = {}) {
  return {
    avatarBytes: Buffer.from("private portrait bytes"),
    avatarMimeType: "image/png",
    manifest: {
      schemaVersion: 1,
      id: "sample-character",
      displayName: "Private Character",
      avatar: {
        type: "image2d",
        accessibleLabel: "Private Character portrait",
        backgroundMode: "transparent",
        mouth: {
          xPercent: 42,
          yPercent: 19,
          small: { widthPercent: 1.2, heightPercent: 0.3 },
          open: { widthPercent: 1.9, heightPercent: 0.8 },
        },
      },
      speech: { provider, profile },
      distributionAllowed: false,
    },
  };
}

function captureThrown(callback) {
  try {
    callback();
  } catch (error) {
    return error;
  }
  assert.fail("Expected callback to throw.");
}

function runtimeFixture() {
  const rendererCharacter = Object.freeze({ id: "sample-character" });
  const synthesized = [];
  const speechProvider = {
    async synthesize(text) {
      assert.equal(this, speechProvider);
      synthesized.push(text);
      return Buffer.from(`WAV:${text}`);
    },
  };
  return {
    rendererCharacter,
    runtime: Object.freeze({
      pack: createLoadedPack(),
      providerId: "aivis",
      rendererCharacter,
      speechProvider,
    }),
    synthesized,
  };
}

test("composes one selected pack into its renderer identity and selected speech provider", async () => {
  const loadedPack = createLoadedPack();
  const storeArguments = [];
  const factoryArguments = [];
  const spoken = [];
  let getActiveCalls = 0;
  const speechProvider = Object.freeze({
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.from("RIFF");
    },
  });

  const runtime = loadCharacterRuntime({
    userDataPath: "/fixed/user-data",
    createStore: (options) => {
      storeArguments.push(options);
      return {
        getActive() {
          getActiveCalls += 1;
          return loadedPack;
        },
      };
    },
    createSpeechProvider: (providerId, profile) => {
      factoryArguments.push([providerId, profile]);
      return speechProvider;
    },
  });

  assert.deepEqual(storeArguments, [{ userDataPath: "/fixed/user-data" }]);
  assert.equal(getActiveCalls, 1);
  assert.deepEqual(factoryArguments, [["aivis", loadedPack.manifest.speech.profile]]);
  assert.equal(runtime.pack, loadedPack);
  assert.equal(runtime.providerId, "aivis");
  assert.equal(runtime.rendererCharacter.id, loadedPack.manifest.id);
  assert.equal(runtime.rendererCharacter.displayName, loadedPack.manifest.displayName);
  assert.equal(runtime.speechProvider, speechProvider);
  assert.equal(Object.hasOwn(runtime.speechProvider, "profile"), false);
  assert.equal(Object.isFrozen(runtime), true);

  assert.equal((await runtime.speechProvider.synthesize("おかえり。")).toString(), "RIFF");
  assert.deepEqual(spoken, ["おかえり。"]);
});

test("maps missing and invalid selections to fresh bounded errors before provider creation", () => {
  const privateDetails = [
    "missing selection at /Users/private/selected-character.json",
    "Zod profile failure: styleId=987654",
  ];
  let providerCalls = 0;
  const errors = privateDetails.map((detail) => captureThrown(() =>
    loadCharacterRuntime({
      userDataPath: "/fixed/user-data",
      createStore: () => ({
        getActive() {
          throw new Error(detail);
        },
      }),
      createSpeechProvider: () => {
        providerCalls += 1;
        return { synthesize: async () => Buffer.from("RIFF") };
      },
    })));

  assert.equal(providerCalls, 0);
  assert.notEqual(errors[0], errors[1]);
  for (const error of errors) {
    assert.equal(error.code, CHARACTER_UNAVAILABLE);
    assert.deepEqual(Object.keys(error), ["code"]);
    assert.equal(error.message.includes("/Users/private"), false);
    assert.equal(error.message.includes("Zod"), false);
    assert.equal(error.message.includes("987654"), false);
    assert.equal(error.cause, undefined);
  }
});

test("rejects an unsupported provider through the code-owned registry before renderer projection", () => {
  const loadedPack = createLoadedPack({ provider: "__proto__" });
  let avatarReads = 0;
  Object.defineProperty(loadedPack, "avatarBytes", {
    configurable: true,
    enumerable: true,
    get() {
      avatarReads += 1;
      return Buffer.from("must not be read");
    },
  });

  const error = captureThrown(() => loadCharacterRuntime({
    userDataPath: "/fixed/user-data",
    createStore: () => ({ getActive: () => loadedPack }),
  }));

  assert.equal(error.code, CHARACTER_UNAVAILABLE);
  assert.equal(avatarReads, 0);
  assert.equal(error.message.includes("__proto__"), false);
});

test("bounds provider composition failures without reflecting profile or path details", () => {
  const loadedPack = createLoadedPack();
  const privateFailure = "profile /private/character/aivis.json styleId=987654";

  const error = captureThrown(() => loadCharacterRuntime({
    userDataPath: "/fixed/user-data",
    createStore: () => ({ getActive: () => loadedPack }),
    createSpeechProvider: () => {
      throw new Error(privateFailure);
    },
  }));

  assert.equal(error.code, CHARACTER_UNAVAILABLE);
  assert.equal(error.message.includes("profile"), false);
  assert.equal(error.message.includes("/private/character"), false);
  assert.equal(error.message.includes("987654"), false);
  assert.equal(error.cause, undefined);
});

test("binding registers the captured renderer payload once and delegates speech without reloading", async () => {
  const fixture = runtimeFixture();
  const handlers = new Map();
  const playback = [];
  const stops = [];
  const rendererSpeechBridge = {
    async play(wavBytes) {
      assert.equal(this, rendererSpeechBridge);
      playback.push(wavBytes.toString());
    },
    stop(reason) {
      assert.equal(this, rendererSpeechBridge);
      stops.push(reason);
    },
  };
  let loadCalls = 0;
  const binding = createCharacterRuntimeBinding({
    userDataPath: "/fixed/user-data",
    ipcMain: {
      handle(channel, handler) {
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      },
    },
    rendererSpeechBridge,
    loadRuntime: (options) => {
      loadCalls += 1;
      assert.deepEqual(options, { userDataPath: "/fixed/user-data" });
      return fixture.runtime;
    },
  });

  assert.equal(loadCalls, 1);
  assert.equal(binding.runtime, fixture.runtime);
  assert.deepEqual(Object.keys(binding), ["runtime", "onSpeech", "stop"]);
  assert.deepEqual([...handlers.keys()], ["persona:get-character"]);
  const getCharacter = handlers.get("persona:get-character");
  assert.equal(await getCharacter(), fixture.rendererCharacter);
  assert.equal(await getCharacter(), fixture.rendererCharacter);

  assert.deepEqual(await binding.onSpeech(" 一件目です。 "), { codePoints: 6 });
  assert.deepEqual(await binding.onSpeech("二件目です。"), { codePoints: 6 });
  binding.stop();

  assert.equal(loadCalls, 1);
  assert.deepEqual(fixture.synthesized, ["一件目です。", "二件目です。"]);
  assert.deepEqual(playback, ["WAV:一件目です。", "WAV:二件目です。"]);
  assert.deepEqual(stops, ["Speech controller stopped."]);
  assert.equal(Object.isFrozen(binding), true);
});

test("binding survives expected unavailability with null IPC and fresh bounded speech errors", async () => {
  const handlers = new Map();
  const original = new Error("private pack path /Users/private/character");
  original.code = CHARACTER_UNAVAILABLE;
  let loadCalls = 0;
  let controllerCalls = 0;
  const binding = createCharacterRuntimeBinding({
    userDataPath: "/fixed/user-data",
    ipcMain: {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    rendererSpeechBridge: {
      play: async () => assert.fail("play must not be called"),
      stop: () => assert.fail("stop must not be called"),
    },
    loadRuntime: () => {
      loadCalls += 1;
      throw original;
    },
    createController: () => {
      controllerCalls += 1;
      throw new Error("controller must not be created");
    },
  });

  const getCharacter = handlers.get("persona:get-character");
  assert.equal(await getCharacter(), null);
  assert.equal(await getCharacter(), null);
  assert.equal(loadCalls, 1);
  assert.equal(controllerCalls, 0);
  assert.equal(binding.runtime, null);
  assert.deepEqual(Object.keys(binding), ["runtime", "onSpeech", "stop"]);

  const speechErrors = [];
  for (const text of ["秘密の入力一", "秘密の入力二"]) {
    await assert.rejects(binding.onSpeech(text), (error) => {
      speechErrors.push(error);
      assert.equal(error.code, CHARACTER_UNAVAILABLE);
      assert.deepEqual(Object.keys(error), ["code"]);
      assert.equal(error.message.includes(text), false);
      assert.equal(error.message.includes("/Users/private"), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.notEqual(speechErrors[0], speechErrors[1]);
  assert.notEqual(speechErrors[0], original);
  assert.doesNotThrow(() => binding.stop());
});

test("binding propagates unexpected loader, controller, and IPC registration failures", () => {
  const unexpectedLoaderError = new Error("programming failure");
  let loaderHandlerCalls = 0;
  assert.throws(
    () => createCharacterRuntimeBinding({
      userDataPath: "/fixed/user-data",
      ipcMain: { handle: () => { loaderHandlerCalls += 1; } },
      rendererSpeechBridge: {},
      loadRuntime: () => { throw unexpectedLoaderError; },
    }),
    (error) => error === unexpectedLoaderError,
  );
  assert.equal(loaderHandlerCalls, 0);

  const fixture = runtimeFixture();
  const controllerError = new Error("controller programming failure");
  let controllerHandlerCalls = 0;
  assert.throws(
    () => createCharacterRuntimeBinding({
      userDataPath: "/fixed/user-data",
      ipcMain: { handle: () => { controllerHandlerCalls += 1; } },
      rendererSpeechBridge: { play: async () => {}, stop: () => {} },
      loadRuntime: () => fixture.runtime,
      createController: () => { throw controllerError; },
    }),
    (error) => error === controllerError,
  );
  assert.equal(controllerHandlerCalls, 0);

  let invalidControllerHandlerCalls = 0;
  assert.throws(
    () => createCharacterRuntimeBinding({
      userDataPath: "/fixed/user-data",
      ipcMain: { handle: () => { invalidControllerHandlerCalls += 1; } },
      rendererSpeechBridge: { play: async () => {}, stop: () => {} },
      loadRuntime: () => fixture.runtime,
      createController: () => null,
    }),
    /controller/i,
  );
  assert.equal(invalidControllerHandlerCalls, 0);

  const registrationError = new Error("IPC registration failure");
  assert.throws(
    () => createCharacterRuntimeBinding({
      userDataPath: "/fixed/user-data",
      ipcMain: { handle: () => { throw registrationError; } },
      rendererSpeechBridge: { play: async () => {}, stop: () => {} },
      loadRuntime: () => fixture.runtime,
      createController: () => ({ speak: async () => {}, stop: () => {} }),
    }),
    (error) => error === registrationError,
  );
});

test("initialization gate defers protocol actions until the real binding registers once", () => {
  const fixture = runtimeFixture();
  const handlers = new Map();
  const dispatched = [];
  let handlerRegistrations = 0;
  const gate = createInitializationActionGate({
    dispatch(action) {
      assert.equal(handlers.has("persona:get-character"), true);
      dispatched.push(action);
      return true;
    },
  });

  assert.equal(gate.handle("persona://show"), true);
  assert.equal(gate.handle("persona://toggle"), true);
  assert.deepEqual(dispatched, []);
  assert.equal(handlerRegistrations, 0);

  createCharacterRuntimeBinding({
    userDataPath: "/fixed/user-data",
    ipcMain: {
      handle(channel, handler) {
        handlerRegistrations += 1;
        assert.equal(handlers.has(channel), false);
        handlers.set(channel, handler);
      },
    },
    rendererSpeechBridge: { play: async () => {}, stop: () => {} },
    loadRuntime: () => fixture.runtime,
  });

  assert.equal(handlerRegistrations, 1);
  assert.equal(gate.open(), true);
  assert.deepEqual(dispatched, ["persona://show", "persona://toggle"]);
  assert.equal(gate.open(), false);
  assert.deepEqual(dispatched, ["persona://show", "persona://toggle"]);

  assert.equal(gate.handle("persona://hide"), true);
  assert.deepEqual(dispatched, [
    "persona://show",
    "persona://toggle",
    "persona://hide",
  ]);
});

test("initialization gate bounds pending count and stored URL length", () => {
  const dispatched = [];
  const gate = createInitializationActionGate({
    dispatch(action) {
      dispatched.push(action);
      return true;
    },
    maxPending: 2,
    maxActionLength: 16,
  });

  assert.equal(gate.handle("persona://show"), true);
  assert.equal(gate.handle("persona://way-too-long"), false);
  assert.equal(gate.handle("persona://hide"), true);
  assert.equal(gate.handle("persona://toggle"), false);
  assert.deepEqual(dispatched, []);

  assert.equal(gate.open(), true);
  assert.deepEqual(dispatched, ["persona://show", "persona://hide"]);
  assert.equal(gate.handle("persona://toggle"), true);
  assert.deepEqual(dispatched, [
    "persona://show",
    "persona://hide",
    "persona://toggle",
  ]);
});

test("initialization gate never retries a drained batch after dispatch failure", () => {
  const dispatched = [];
  const failure = new Error("protocol dispatch failed");
  const gate = createInitializationActionGate({
    dispatch(action) {
      dispatched.push(action);
      if (action === "persona://show") throw failure;
      return true;
    },
  });
  gate.handle("persona://show");
  gate.handle("persona://toggle");

  assert.throws(() => gate.open(), (error) => error === failure);
  assert.deepEqual(dispatched, ["persona://show"]);
  assert.equal(gate.open(), false);
  assert.deepEqual(dispatched, ["persona://show"]);

  assert.equal(gate.handle("persona://hide"), true);
  assert.deepEqual(dispatched, ["persona://show", "persona://hide"]);
});

test("unexpected real binding failure leaves queued protocol actions undispatched", () => {
  const dispatched = [];
  const failure = new Error("binding programming failure");
  const gate = createInitializationActionGate({
    dispatch(action) {
      dispatched.push(action);
      return true;
    },
  });
  gate.handle("persona://show");

  assert.throws(() => {
    createCharacterRuntimeBinding({
      userDataPath: "/fixed/user-data",
      ipcMain: { handle: () => assert.fail("IPC must not register") },
      rendererSpeechBridge: {},
      loadRuntime: () => { throw failure; },
    });
    gate.open();
  }, (error) => error === failure);

  assert.deepEqual(dispatched, []);
  assert.equal(gate.handle("persona://toggle"), true);
  assert.deepEqual(dispatched, []);
});
