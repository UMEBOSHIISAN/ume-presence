"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const AIVIS_ENGINE_ORIGIN = "http://127.0.0.1:10101";
const AIVIS_EXECUTABLE_SUFFIX = "Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run";
const MAX_VERSION_BYTES = 128;
const PROBE_TIMEOUT_MS = 2_000;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const ALLOWED_OPTIONS = new Set([
  "homeDirectory",
  "fsImpl",
  "fetchImpl",
  "spawnImpl",
  "createTimeoutSignal",
  "platform",
]);

function engineError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Aivis engine adapter options are required.");
  }
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !ALLOWED_OPTIONS.has(key)) {
      throw new TypeError("Unsupported Aivis engine adapter option.");
    }
  }
}

function requireFunction(value, label) {
  if (typeof value !== "function") throw new TypeError(`${label} must be a function.`);
  return value;
}

function normalizeHomeDirectory(homeDirectory) {
  if (typeof homeDirectory !== "string"
    || homeDirectory.length === 0
    || !path.posix.isAbsolute(homeDirectory)
    || homeDirectory.includes("\0")) {
    throw new TypeError("A POSIX home directory is required.");
  }
  return path.posix.normalize(homeDirectory);
}

function isComponentContained(root, candidate) {
  const relative = path.posix.relative(root, candidate);
  return relative.length > 0
    && relative !== ".."
    && !relative.startsWith("../")
    && !path.posix.isAbsolute(relative);
}

function isMissing(error) {
  return error !== null && typeof error === "object" && error.code === "ENOENT";
}

function validateCandidate(fsImpl, root, candidate) {
  let stats;
  try {
    stats = fsImpl.lstatSync(candidate);
  } catch (error) {
    if (isMissing(error)) return null;
    throw engineError("ENGINE_EXECUTABLE_INVALID", "AivisSpeech Engine executable is invalid.");
  }

  try {
    if (!isComponentContained(root, candidate)
      || stats.isSymbolicLink()
      || !stats.isFile()
      || fsImpl.realpathSync(candidate) !== candidate) {
      throw engineError("ENGINE_EXECUTABLE_INVALID", "AivisSpeech Engine executable is invalid.");
    }
    fsImpl.accessSync(candidate, fsImpl.constants.X_OK);
  } catch {
    throw engineError("ENGINE_EXECUTABLE_INVALID", "AivisSpeech Engine executable is invalid.");
  }
  return candidate;
}

function responseContentType(response) {
  return response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "";
}

function validateDeclaredLength(response, maximumBytes) {
  const raw = response.headers?.get?.("content-length");
  if (raw === null || raw === undefined) return;
  if (!/^[0-9]+$/.test(raw)) throw new Error("Invalid declared length.");
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new Error("Invalid declared length.");
  }
}

async function readBoundedBytes(response, maximumBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("Invalid response stream.");

  const chunks = [];
  let totalBytes = 0;
  let releaseFailed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid response chunk.");
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel?.();
        } catch {
          // Probe failures are intentionally collapsed to false.
        }
        throw new Error("Response exceeded the byte cap.");
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) throw new Error("Response reader release failed.");
  return Buffer.concat(chunks, totalBytes);
}

function createAivisEngineAdapter(options = {}) {
  validateOptions(options);
  const homeDirectory = normalizeHomeDirectory(options.homeDirectory);
  const fsImpl = options.fsImpl ?? fs;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const spawnImpl = options.spawnImpl ?? spawn;
  const createTimeoutSignal = options.createTimeoutSignal
    ?? ((duration) => AbortSignal.timeout(duration));
  const platform = options.platform ?? process.platform;

  requireFunction(fsImpl?.lstatSync, "fsImpl.lstatSync");
  requireFunction(fsImpl?.realpathSync, "fsImpl.realpathSync");
  requireFunction(fsImpl?.accessSync, "fsImpl.accessSync");
  if (!fsImpl?.constants || fsImpl.constants.X_OK === undefined) {
    throw new TypeError("fsImpl.constants.X_OK is required.");
  }
  requireFunction(fetchImpl, "fetchImpl");
  requireFunction(spawnImpl, "spawnImpl");
  requireFunction(createTimeoutSignal, "createTimeoutSignal");
  if (typeof platform !== "string") throw new TypeError("platform must be a string.");

  const userRoot = homeDirectory;
  const userCandidate = path.posix.join(userRoot, AIVIS_EXECUTABLE_SUFFIX);
  const systemRoot = "/Applications";
  const systemCandidate = path.posix.join(
    systemRoot,
    "AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run",
  );

  function requireDarwin() {
    if (platform !== "darwin") {
      throw engineError(
        "ENGINE_PLATFORM_UNSUPPORTED",
        "AivisSpeech Engine is unsupported on this platform.",
      );
    }
  }

  function resolveInstalledExecutable() {
    requireDarwin();
    const userExecutable = validateCandidate(fsImpl, userRoot, userCandidate);
    if (userExecutable) return userExecutable;
    const systemExecutable = validateCandidate(fsImpl, systemRoot, systemCandidate);
    if (systemExecutable) return systemExecutable;
    throw engineError(
      "ENGINE_EXECUTABLE_MISSING",
      "AivisSpeech Engine executable is missing.",
    );
  }

  async function probeReadiness() {
    try {
      const response = await fetchImpl(`${AIVIS_ENGINE_ORIGIN}/version`, {
        method: "GET",
        redirect: "error",
        signal: createTimeoutSignal(PROBE_TIMEOUT_MS),
      });
      if (!response?.ok
        || response.redirected === true
        || responseContentType(response) !== "application/json") {
        return false;
      }
      validateDeclaredLength(response, MAX_VERSION_BYTES);
      const bytes = await readBoundedBytes(response, MAX_VERSION_BYTES);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(text);
      return typeof parsed === "string" && VERSION_PATTERN.test(parsed);
    } catch {
      return false;
    }
  }

  function spawnOnce() {
    const executable = resolveInstalledExecutable();
    try {
      return spawnImpl(executable, [], {
        cwd: path.posix.dirname(executable),
        detached: false,
        shell: false,
        stdio: "ignore",
      });
    } catch {
      throw engineError("ENGINE_SPAWN_FAILED", "AivisSpeech Engine could not be started.");
    }
  }

  return Object.freeze({
    id: "aivis",
    resolveInstalledExecutable,
    probeReadiness,
    spawnOnce,
  });
}

module.exports = {
  createAivisEngineAdapter,
};
