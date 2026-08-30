"use strict";

const SPEECH_ENGINE_START_ARGUMENT = "--speech-engine=start";

function hasSpeechEngineStart(argv) {
  return Array.isArray(argv) && argv.some((value) => value === SPEECH_ENGINE_START_ARGUMENT);
}

module.exports = { SPEECH_ENGINE_START_ARGUMENT, hasSpeechEngineStart };
