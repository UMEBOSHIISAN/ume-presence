"use strict";

const { createCharacterPackStore } = require("./character-pack-store.cjs");
const { validateCharacterId } = require("./character-pack.cjs");
const { runLoginStartupAction } = require("./login-startup.cjs");

const LOGIN_ACTIONS = new Set(["enable", "status", "disable"]);
const CHARACTER_ACTIONS = new Set(["list", "status", "validate", "select"]);
const LOGIN_STATUSES = new Set([
  null,
  "not-registered",
  "enabled",
  "requires-approval",
  "not-found",
]);
const SUMMARY_ERROR_CODES = new Set([null, "INVALID_PACK"]);
const COMMAND_ERROR_CODES = new Set(["INVALID_APP_COMMAND", "COMMAND_FAILED"]);
const INVALID_COMMAND_MESSAGE = "Invalid Persona application command.";

const COMMAND_FAILED_RESULT = Object.freeze({
  kind: "command",
  action: null,
  ok: false,
  errorCode: "COMMAND_FAILED",
  exitCode: 1,
});

function invalidCommandError() {
  const error = new Error(INVALID_COMMAND_MESSAGE);
  error.code = "INVALID_APP_COMMAND";
  return error;
}

function parseAppCommand(argv) {
  if (!Array.isArray(argv)) throw invalidCommandError();

  const loginArguments = argv.filter(
    (argument) => typeof argument === "string" && argument.startsWith("--login-startup"),
  );
  const characterArguments = argv.filter(
    (argument) => typeof argument === "string" && argument.startsWith("--character"),
  );
  if (loginArguments.length === 0 && characterArguments.length === 0) return null;
  if (loginArguments.length > 0 && characterArguments.length > 0) {
    throw invalidCommandError();
  }

  if (loginArguments.length > 0) {
    if (loginArguments.length !== 1 || !loginArguments[0].startsWith("--login-startup=")) {
      throw invalidCommandError();
    }
    const action = loginArguments[0].slice("--login-startup=".length);
    if (!LOGIN_ACTIONS.has(action)) throw invalidCommandError();
    return Object.freeze({ kind: "login-startup", action });
  }

  const actionArguments = characterArguments.filter((argument) =>
    argument.startsWith("--character="),
  );
  const idArguments = characterArguments.filter((argument) =>
    argument.startsWith("--character-id="),
  );
  if (
    actionArguments.length !== 1
    || actionArguments.length + idArguments.length !== characterArguments.length
    || idArguments.length > 1
  ) {
    throw invalidCommandError();
  }

  const action = actionArguments[0].slice("--character=".length);
  if (!CHARACTER_ACTIONS.has(action)) throw invalidCommandError();
  if (action === "list" || action === "status") {
    if (idArguments.length !== 0) throw invalidCommandError();
    return Object.freeze({ kind: "character", action, id: null });
  }
  if (idArguments.length !== 1) throw invalidCommandError();

  const id = idArguments[0].slice("--character-id=".length);
  try {
    validateCharacterId(id);
  } catch {
    throw invalidCommandError();
  }
  return Object.freeze({ kind: "character", action, id });
}

function summaryResult({ id, displayName, valid, errorCode }) {
  return Object.freeze({
    id: id ?? null,
    displayName: displayName ?? null,
    valid: valid === true,
    errorCode: errorCode ?? null,
  });
}

function characterFailure(action) {
  return Object.freeze({
    kind: "character",
    action,
    ok: false,
    errorCode: "CHARACTER_COMMAND_FAILED",
    exitCode: 1,
  });
}

function runAppCommand(
  command,
  {
    app,
    platform = process.platform,
    createStore = createCharacterPackStore,
  } = {},
) {
  if (command?.kind === "login-startup" && LOGIN_ACTIONS.has(command.action)) {
    return runLoginStartupAction(command.action, { app, platform });
  }
  if (command?.kind !== "character" || !CHARACTER_ACTIONS.has(command.action)) {
    throw invalidCommandError();
  }

  const { action } = command;
  try {
    const store = createStore({ userDataPath: app.getPath("userData") });
    if (action === "list") {
      const characters = Object.freeze(store.list().map(summaryResult));
      return Object.freeze({
        kind: "character",
        action: "list",
        ok: true,
        characters,
        exitCode: 0,
      });
    }
    if (action === "status") {
      const status = store.status();
      return Object.freeze({
        kind: "character",
        action: "status",
        ok: true,
        activeCharacterId: status.activeCharacterId,
        available: status.available,
        exitCode: 0,
      });
    }
    if (action === "validate") {
      const pack = store.validate(command.id);
      return Object.freeze({
        kind: "character",
        action: "validate",
        ok: true,
        character: summaryResult({
          id: pack.manifest.id,
          displayName: pack.manifest.displayName,
          valid: true,
          errorCode: null,
        }),
        exitCode: 0,
      });
    }

    const selection = store.select(command.id);
    return Object.freeze({
      kind: "character",
      action: "select",
      ok: true,
      activeCharacterId: selection.activeCharacterId,
      restartRequired: selection.restartRequired,
      exitCode: 0,
    });
  } catch {
    return characterFailure(action);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function snapshotPlainObject(value) {
  if (!isPlainObject(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string"
      || descriptor.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function snapshotArray(value) {
  if (!Array.isArray(value)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const lengthDescriptor = descriptors.length;
  if (
    typeof lengthDescriptor?.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 64
    || keys.length !== lengthDescriptor.value + 1
  ) {
    return null;
  }
  const snapshot = [];
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor?.enumerable !== true
      || !Object.hasOwn(descriptor, "value")
    ) {
      return null;
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function hasExactKeys(value, expected) {
  const actual = Reflect.ownKeys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isCanonicalId(value) {
  try {
    return validateCharacterId(value) === value;
  } catch {
    return false;
  }
}

function isSafeDisplayName(value) {
  if (typeof value !== "string") return false;
  const characters = [...value];
  if (characters.length < 1 || characters.length > 80) return false;
  return !characters.some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}

function projectSummary(value, { requireValid = false } = {}) {
  value = snapshotPlainObject(value);
  if (value === null) return null;
  if (!hasExactKeys(value, ["id", "displayName", "valid", "errorCode"])) return null;
  if (!isCanonicalId(value.id) || typeof value.valid !== "boolean") return null;
  if (!SUMMARY_ERROR_CODES.has(value.errorCode)) return null;
  if (value.valid) {
    if (!isSafeDisplayName(value.displayName) || value.errorCode !== null) return null;
  } else if (requireValid || value.displayName !== null || value.errorCode !== "INVALID_PACK") {
    return null;
  }
  return {
    id: value.id,
    displayName: value.displayName,
    valid: value.valid,
    errorCode: value.errorCode,
  };
}

function projectResult(result) {
  result = snapshotPlainObject(result);
  if (result === null) return null;

  if (result.kind === "login-startup") {
    if (!hasExactKeys(result, ["kind", "action", "status", "openAtLogin", "ok", "exitCode"])) {
      return null;
    }
    if (
      !LOGIN_ACTIONS.has(result.action)
      || !LOGIN_STATUSES.has(result.status)
      || typeof result.openAtLogin !== "boolean"
      || typeof result.ok !== "boolean"
      || result.exitCode !== (result.ok ? 0 : 1)
      || (result.ok && result.action === "status"
        && result.status !== "enabled" && result.status !== "not-registered")
      || (result.ok && result.action === "enable"
        && (result.status !== "enabled" || !result.openAtLogin))
      || (result.ok && result.action === "disable"
        && (result.status !== "not-registered" || result.openAtLogin))
    ) {
      return null;
    }
    return {
      kind: "login-startup",
      action: result.action,
      status: result.status,
      openAtLogin: result.openAtLogin,
      ok: result.ok,
      exitCode: result.exitCode,
    };
  }

  if (result.kind === "character" && result.ok === false) {
    if (!hasExactKeys(result, ["kind", "action", "ok", "errorCode", "exitCode"])) {
      return null;
    }
    if (
      !CHARACTER_ACTIONS.has(result.action)
      || result.errorCode !== "CHARACTER_COMMAND_FAILED"
      || result.exitCode !== 1
    ) {
      return null;
    }
    return {
      kind: "character",
      action: result.action,
      ok: false,
      errorCode: "CHARACTER_COMMAND_FAILED",
      exitCode: 1,
    };
  }

  if (result.kind === "character" && result.action === "list") {
    if (!hasExactKeys(result, ["kind", "action", "ok", "characters", "exitCode"])) {
      return null;
    }
    if (result.ok !== true || result.exitCode !== 0) {
      return null;
    }
    const inputCharacters = snapshotArray(result.characters);
    if (inputCharacters === null) return null;
    const characters = inputCharacters.map((summary) => projectSummary(summary));
    if (characters.some((summary) => summary === null)) return null;
    return { kind: "character", action: "list", ok: true, characters, exitCode: 0 };
  }

  if (result.kind === "character" && result.action === "status") {
    if (!hasExactKeys(result, ["kind", "action", "ok", "activeCharacterId", "available", "exitCode"])) {
      return null;
    }
    if (
      result.ok !== true
      || result.exitCode !== 0
      || typeof result.available !== "boolean"
      || (result.activeCharacterId !== null && !isCanonicalId(result.activeCharacterId))
      || (result.activeCharacterId === null && result.available)
    ) {
      return null;
    }
    return {
      kind: "character",
      action: "status",
      ok: true,
      activeCharacterId: result.activeCharacterId,
      available: result.available,
      exitCode: 0,
    };
  }

  if (result.kind === "character" && result.action === "validate") {
    if (!hasExactKeys(result, ["kind", "action", "ok", "character", "exitCode"])) {
      return null;
    }
    const character = projectSummary(result.character, { requireValid: true });
    if (result.ok !== true || result.exitCode !== 0 || character === null) return null;
    return { kind: "character", action: "validate", ok: true, character, exitCode: 0 };
  }

  if (result.kind === "character" && result.action === "select") {
    if (!hasExactKeys(result, ["kind", "action", "ok", "activeCharacterId", "restartRequired", "exitCode"])) {
      return null;
    }
    if (
      result.ok !== true
      || result.exitCode !== 0
      || !isCanonicalId(result.activeCharacterId)
      || result.restartRequired !== true
    ) {
      return null;
    }
    return {
      kind: "character",
      action: "select",
      ok: true,
      activeCharacterId: result.activeCharacterId,
      restartRequired: result.restartRequired,
      exitCode: 0,
    };
  }

  if (result.kind === "command") {
    if (!hasExactKeys(result, ["kind", "action", "ok", "errorCode", "exitCode"])) {
      return null;
    }
    if (
      result.action !== null
      || result.ok !== false
      || !COMMAND_ERROR_CODES.has(result.errorCode)
      || result.exitCode !== 1
    ) {
      return null;
    }
    return {
      kind: "command",
      action: null,
      ok: false,
      errorCode: result.errorCode,
      exitCode: 1,
    };
  }

  return null;
}

function formatCommandResult(result) {
  try {
    const projected = projectResult(result);
    return `${JSON.stringify(projected ?? COMMAND_FAILED_RESULT)}\n`;
  } catch {
    return `${JSON.stringify(COMMAND_FAILED_RESULT)}\n`;
  }
}

module.exports = {
  formatCommandResult,
  parseAppCommand,
  runAppCommand,
};
