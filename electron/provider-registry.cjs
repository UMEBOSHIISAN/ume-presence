"use strict";

const { validateAivisProfile } = require("./aivis-profile.cjs");
const { createAivisEngineAdapter } = require("./aivis-engine-adapter.cjs");
const { createAivisSpeechProvider } = require("./aivis-speech-provider.cjs");

function createAivisProvider(validatedProfile, deps = {}) {
  return createAivisSpeechProvider({
    ...deps,
    profile: validatedProfile,
  });
}

const providerRegistry = Object.freeze(Object.assign(Object.create(null), {
  aivis: Object.freeze({
    createEngineAdapter: createAivisEngineAdapter,
    createSpeechProvider: createAivisProvider,
    validateProfile: validateAivisProfile,
  }),
}));

function getProvider(providerId) {
  if (typeof providerId !== "string" || !Object.hasOwn(providerRegistry, providerId)) {
    throw new TypeError("Unsupported speech provider.");
  }
  return providerRegistry[providerId];
}

function createSpeechProvider(providerId, profile, deps) {
  const provider = getProvider(providerId);
  const validatedProfile = provider.validateProfile(profile);
  return provider.createSpeechProvider(validatedProfile, deps);
}

function createEngineAdapter(providerId, deps) {
  if (typeof providerId !== "string" || !Object.hasOwn(providerRegistry, providerId)) {
    const error = new Error("Engine adapter unavailable.");
    error.code = "ENGINE_ADAPTER_UNAVAILABLE";
    throw error;
  }
  return providerRegistry[providerId].createEngineAdapter(deps);
}

module.exports = {
  createEngineAdapter,
  createSpeechProvider,
  getProvider,
  providerRegistry,
};
