"use strict";

const { validateAivisProfile } = require("./aivis-profile.cjs");
const { validateSpeechText } = require("./speech-text.cjs");

const AIVIS_ENGINE_ORIGIN = "http://127.0.0.1:10101";
const MAX_AUDIO_QUERY_BYTES = 256 * 1024;
const MAX_WAV_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const AUDIO_CONTENT_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "application/octet-stream",
]);
const ALLOWED_PROVIDER_OPTIONS = new Set([
  "profile",
  "fetchImpl",
  "createTimeoutSignal",
]);

function validateProviderOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Aivis speech provider options are required.");
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !ALLOWED_PROVIDER_OPTIONS.has(key)) {
      throw new TypeError("Unsupported Aivis speech provider option.");
    }
  }
}

function providerFailure() {
  const error = new Error("AivisSpeech request failed.");
  error.code = "AIVIS_PROVIDER_FAILED";
  return error;
}

function createRequestUrl(pathname, styleId, text) {
  const url = new URL(pathname, AIVIS_ENGINE_ORIGIN);
  if (text != null) url.searchParams.set("text", text);
  url.searchParams.set("speaker", String(styleId));
  return url;
}

function responseContentType(response) {
  return response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function validateDeclaredLength(response, maximumBytes) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined) return;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) throw providerFailure();
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximumBytes) throw providerFailure();
}

async function readBoundedResponse(response, maximumBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) throw providerFailure();

  const chunks = [];
  let totalBytes = 0;
  let failure = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw providerFailure();
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel?.();
        } catch {
          // Cancellation is best effort; the operation still fails closed.
        }
        throw providerFailure();
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    failure = error;
  }

  try {
    reader.releaseLock?.();
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return Buffer.concat(chunks, totalBytes);
}

async function performSynthesis(
  normalizedText,
  {
    profile,
    fetchImpl,
    createTimeoutSignal,
  },
) {
  const queryResponse = await fetchImpl(createRequestUrl(
    "/audio_query",
    profile.styleId,
    normalizedText,
  ), {
    method: "POST",
    redirect: "error",
    signal: createTimeoutSignal(DEFAULT_TIMEOUT_MS),
  });
  if (!queryResponse?.ok
    || queryResponse.redirected === true
    || responseContentType(queryResponse) !== "application/json") {
    throw providerFailure();
  }
  validateDeclaredLength(queryResponse, MAX_AUDIO_QUERY_BYTES);

  const queryBytes = await readBoundedResponse(queryResponse, MAX_AUDIO_QUERY_BYTES);
  const queryText = new TextDecoder("utf-8", { fatal: true }).decode(queryBytes);
  const query = JSON.parse(queryText);
  if (!query || typeof query !== "object" || Array.isArray(query)) throw providerFailure();

  query.speedScale = profile.speedScale;
  query.tempoDynamicsScale = profile.tempoDynamicsScale;
  query.pitchScale = profile.pitchScale;
  query.volumeScale = profile.volumeScale;

  const synthesisBody = JSON.stringify(query);
  if (Buffer.byteLength(synthesisBody, "utf8") > MAX_AUDIO_QUERY_BYTES) {
    throw providerFailure();
  }

  const synthesisResponse = await fetchImpl(createRequestUrl(
    "/synthesis",
    profile.styleId,
  ), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: synthesisBody,
    signal: createTimeoutSignal(DEFAULT_TIMEOUT_MS),
  });
  if (!synthesisResponse?.ok || synthesisResponse.redirected === true) {
    throw providerFailure();
  }

  if (!AUDIO_CONTENT_TYPES.has(responseContentType(synthesisResponse))) {
    throw providerFailure();
  }
  validateDeclaredLength(synthesisResponse, MAX_WAV_BYTES);
  return readBoundedResponse(synthesisResponse, MAX_WAV_BYTES);
}

async function synthesizeValidatedAivisSpeech(
  text,
  {
    profile,
    fetchImpl = globalThis.fetch,
    createTimeoutSignal = (duration) => AbortSignal.timeout(duration),
  } = {},
) {
  const normalizedText = validateSpeechText(text);
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");

  try {
    return await performSynthesis(normalizedText, {
      profile,
      fetchImpl,
      createTimeoutSignal,
    });
  } catch {
    throw providerFailure();
  }
}

async function synthesizeAivisSpeech() {
  throw new TypeError("An injected Aivis speech profile is required.");
}

function createAivisSpeechProvider(options = {}) {
  validateProviderOptions(options);
  const {
    profile,
    fetchImpl = globalThis.fetch,
    createTimeoutSignal = (duration) => AbortSignal.timeout(duration),
  } = options;
  const selected = validateAivisProfile(profile);
  return Object.freeze({
    synthesize: (text) => synthesizeValidatedAivisSpeech(text, {
      profile: selected,
      fetchImpl,
      createTimeoutSignal,
    }),
  });
}

module.exports = {
  MAX_AUDIO_QUERY_BYTES,
  MAX_WAV_BYTES,
  createAivisSpeechProvider,
  synthesizeAivisSpeech,
};
