"use strict";

const { createCharacterPackStore } = require("./character-pack-store.cjs");
const { toRendererCharacter } = require("./character-renderer-payload.cjs");
const providerRegistry = require("./provider-registry.cjs");
const { createSpeechController } = require("./speech-controller.cjs");

const CHARACTER_UNAVAILABLE = "CHARACTER_UNAVAILABLE";
const CHARACTER_CHANNEL = "persona:get-character";
const DEFAULT_MAX_PENDING_ACTIONS = 16;
const DEFAULT_MAX_ACTION_LENGTH = 2048;

function characterUnavailableError() {
  const error = new Error("Installed character is unavailable.");
  error.code = CHARACTER_UNAVAILABLE;
  return error;
}

function createInitializationActionGate({
  dispatch,
  maxPending = DEFAULT_MAX_PENDING_ACTIONS,
  maxActionLength = DEFAULT_MAX_ACTION_LENGTH,
} = {}) {
  if (typeof dispatch !== "function") throw new TypeError("dispatch is required.");
  if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("maxPending must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maxActionLength) || maxActionLength < 1) {
    throw new TypeError("maxActionLength must be a positive safe integer.");
  }

  const pending = [];
  let opened = false;

  function handle(action) {
    if (
      typeof action !== "string"
      || action.length === 0
      || action.length > maxActionLength
    ) {
      return false;
    }
    if (opened) return dispatch(action);
    if (pending.length >= maxPending) return false;
    pending.push(action);
    return true;
  }

  function open() {
    if (opened) return false;
    opened = true;
    const batch = pending.splice(0, pending.length);
    for (const action of batch) dispatch(action);
    return true;
  }

  return Object.freeze({ handle, open });
}

function loadCharacterRuntime({
  userDataPath,
  createStore = createCharacterPackStore,
  createSpeechProvider = providerRegistry.createSpeechProvider,
} = {}) {
  try {
    const store = createStore({ userDataPath });
    const pack = store.getActive();
    const providerId = pack.manifest.speech.provider;
    const speechProvider = createSpeechProvider(
      providerId,
      pack.manifest.speech.profile,
    );
    const rendererCharacter = toRendererCharacter(pack);
    return Object.freeze({
      pack,
      providerId,
      rendererCharacter,
      speechProvider,
    });
  } catch {
    throw characterUnavailableError();
  }
}

function createCharacterRuntimeBinding({
  userDataPath,
  ipcMain,
  rendererSpeechBridge,
  loadRuntime = loadCharacterRuntime,
  createController = createSpeechController,
} = {}) {
  let runtime = null;
  try {
    runtime = loadRuntime({ userDataPath });
  } catch (error) {
    if (error?.code !== CHARACTER_UNAVAILABLE) throw error;
  }

  let controller = null;
  if (runtime !== null) {
    controller = createController({
      synthesize: runtime.speechProvider.synthesize.bind(runtime.speechProvider),
      play: rendererSpeechBridge.play.bind(rendererSpeechBridge),
      stopPlayback: rendererSpeechBridge.stop.bind(rendererSpeechBridge),
    });
    if (
      controller === null
      || typeof controller !== "object"
      || typeof controller.speak !== "function"
      || typeof controller.stop !== "function"
    ) {
      throw new TypeError("Speech controller is invalid.");
    }
  }

  const rendererCharacter = runtime?.rendererCharacter ?? null;
  ipcMain.handle(CHARACTER_CHANNEL, () => rendererCharacter);

  if (controller === null) {
    return Object.freeze({
      runtime,
      onSpeech: async () => {
        throw characterUnavailableError();
      },
      stop: () => {},
    });
  }

  return Object.freeze({
    runtime,
    onSpeech: (text) => controller.speak(text),
    stop: () => controller.stop(),
  });
}

module.exports = {
  CHARACTER_UNAVAILABLE,
  createCharacterRuntimeBinding,
  createInitializationActionGate,
  loadCharacterRuntime,
};
