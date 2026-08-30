"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  formatCommandResult,
  parseAppCommand,
  runAppCommand,
} = require("./app-command.cjs");

const FIXED_FAILURE = {
  kind: "command",
  action: null,
  ok: false,
  errorCode: "COMMAND_FAILED",
  exitCode: 1,
};

function assertFrozenExact(actual, expected) {
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual), Object.keys(expected));
  assert.equal(Object.isFrozen(actual), true);
}

function assertInvalid(argv) {
  assert.throws(() => parseAppCommand(argv), (error) => {
    assert.equal(error.code, "INVALID_APP_COMMAND");
    assert.equal(error.message, "Invalid Persona application command.");
    assert.equal(error.message.includes("private"), false);
    return true;
  });
}

test("parses only the four exact management command forms into frozen closed commands", () => {
  assert.equal(parseAppCommand(["Electron", "app.cjs", "--background"]), null);

  for (const action of ["enable", "status", "disable"]) {
    assertFrozenExact(
      parseAppCommand(["Electron", "app.cjs", `--login-startup=${action}`]),
      { kind: "login-startup", action },
    );
  }

  for (const action of ["list", "status"]) {
    assertFrozenExact(
      parseAppCommand(["Electron", "app.cjs", `--character=${action}`]),
      { kind: "character", action, id: null },
    );
  }

  for (const action of ["validate", "select"]) {
    assertFrozenExact(
      parseAppCommand([
        "Electron",
        "app.cjs",
        `--character=${action}`,
        "--character-id=sample-character",
      ]),
      { kind: "character", action, id: "sample-character" },
    );
  }
});

test("rejects malformed, duplicate, cross-namespace, unknown, and invalid-ID commands", () => {
  const privateId = "private-SECRET";
  for (const argv of [
    ["Persona", "--login-startup"],
    ["Persona", "--login-startup=unknown"],
    ["Persona", "--login-startup=status", "--login-startup=status"],
    ["Persona", "--login-startup=status", "--character=list"],
    ["Persona", "--character"],
    ["Persona", "--character=unknown"],
    ["Persona", "--character=list", "--character-id=alpha"],
    ["Persona", "--character=status", "--character-id=alpha"],
    ["Persona", "--character=validate"],
    ["Persona", "--character=select"],
    ["Persona", "--character=select", "--character-id=alpha", "--character-id=beta"],
    ["Persona", "--character=select", `--character-id=${privateId}`],
    ["Persona", "--character=select", "--character-id=-alpha"],
    ["Persona", "--character=select", "--character-id=alpha-"],
    ["Persona", "--character=select", `--character-id=${"a".repeat(65)}`],
    ["Persona", "--character=list", "--character-private=/private/secret"],
    ["Persona", "--character-id=alpha"],
  ]) {
    assertInvalid(argv);
  }
});

test("dispatches read-only character actions without writes and select only through store.select", async () => {
  const calls = [];
  const pack = {
    manifest: {
      id: "alpha",
      displayName: "Alpha",
      avatar: { private: "must-not-leak" },
      speech: { provider: "aivis", profile: { styleId: 999 } },
    },
    avatarBytes: Buffer.from("private-avatar"),
  };
  const store = {
    list() {
      calls.push(["list"]);
      return [{ id: "alpha", displayName: "Alpha", valid: true }];
    },
    status() {
      calls.push(["status"]);
      return { activeCharacterId: "alpha", available: true };
    },
    validate(id) {
      calls.push(["validate", id]);
      return pack;
    },
    select(id) {
      calls.push(["select", id]);
      return { activeCharacterId: id, restartRequired: true };
    },
  };
  const deps = {
    app: { getPath: (name) => (assert.equal(name, "userData"), "/fixed/user-data") },
    createStore(options) {
      assert.deepEqual(options, { userDataPath: "/fixed/user-data" });
      return store;
    },
  };

  const list = await runAppCommand(
    { kind: "character", action: "list", id: null },
    deps,
  );
  assert.deepEqual(list, {
    kind: "character",
    action: "list",
    ok: true,
    characters: [{ id: "alpha", displayName: "Alpha", valid: true, errorCode: null }],
    exitCode: 0,
  });
  assert.equal(Object.isFrozen(list), true);
  assert.equal(Object.isFrozen(list.characters), true);
  assert.equal(Object.isFrozen(list.characters[0]), true);
  assert.deepEqual(calls, [["list"]]);

  const status = await runAppCommand(
    { kind: "character", action: "status", id: null },
    deps,
  );
  assertFrozenExact(status, {
    kind: "character",
    action: "status",
    ok: true,
    activeCharacterId: "alpha",
    available: true,
    exitCode: 0,
  });
  assert.deepEqual(calls, [["list"], ["status"]]);

  const validated = await runAppCommand(
    { kind: "character", action: "validate", id: "alpha" },
    deps,
  );
  assert.deepEqual(validated, {
    kind: "character",
    action: "validate",
    ok: true,
    character: { id: "alpha", displayName: "Alpha", valid: true, errorCode: null },
    exitCode: 0,
  });
  assert.equal(JSON.stringify(validated).includes("avatar"), false);
  assert.equal(JSON.stringify(validated).includes("styleId"), false);
  assert.deepEqual(calls, [["list"], ["status"], ["validate", "alpha"]]);

  const selected = await runAppCommand(
    { kind: "character", action: "select", id: "alpha" },
    deps,
  );
  assertFrozenExact(selected, {
    kind: "character",
    action: "select",
    ok: true,
    activeCharacterId: "alpha",
    restartRequired: true,
    exitCode: 0,
  });
  assert.deepEqual(calls, [
    ["list"],
    ["status"],
    ["validate", "alpha"],
    ["select", "alpha"],
  ]);
});

test("keeps the existing login result unchanged and closes character operational failures", async () => {
  const login = await runAppCommand(
    { kind: "login-startup", action: "status" },
    { app: { isPackaged: false }, platform: "darwin" },
  );
  assertFrozenExact(login, {
    kind: "login-startup",
    action: "status",
    status: null,
    openAtLogin: false,
    ok: false,
    exitCode: 1,
  });

  const privateId = "private-character";
  const failed = await runAppCommand(
    { kind: "character", action: "validate", id: privateId },
    {
      app: { getPath: () => "/private/user-data" },
      createStore: () => ({
        validate() {
          throw new Error(`failed ${privateId} at /private/pack`);
        },
      }),
    },
  );
  assertFrozenExact(failed, {
    kind: "character",
    action: "validate",
    ok: false,
    errorCode: "CHARACTER_COMMAND_FAILED",
    exitCode: 1,
  });
  assert.equal(JSON.stringify(failed).includes(privateId), false);
});

test("formats declared results as one LF-terminated bounded JSON line", () => {
  const result = Object.freeze({
    kind: "character",
    action: "list",
    ok: true,
    characters: Object.freeze([
      Object.freeze({ id: "alpha", displayName: "Alpha", valid: true, errorCode: null }),
      Object.freeze({ id: "broken", displayName: null, valid: false, errorCode: "INVALID_PACK" }),
    ]),
    exitCode: 0,
  });
  const line = formatCommandResult(result);

  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false);
  assert.deepEqual(JSON.parse(line), result);
  assert.ok(Buffer.byteLength(line, "utf8") < 16 * 1024);
});

test("formatter maps extra-bearing, nested, oversized, and inconsistent inputs to one fixed failure", () => {
  const validSummary = { id: "alpha", displayName: "Alpha", valid: true, errorCode: null };
  const hiddenExtra = { kind: "command", action: null, ok: false, errorCode: "COMMAND_FAILED", exitCode: 1 };
  Object.defineProperty(hiddenExtra, "private", { value: "hidden" });
  const symbolExtra = { kind: "command", action: null, ok: false, errorCode: "COMMAND_FAILED", exitCode: 1 };
  symbolExtra[Symbol("private")] = "hidden";
  const sixtyFive = Array.from({ length: 65 }, (_, index) => ({
    id: `pack-${String(index).padStart(2, "0")}`,
    displayName: "Pack",
    valid: true,
    errorCode: null,
  }));
  for (const result of [
    { kind: "character", action: "validate", ok: true, character: { ...validSummary, nested: { secret: true } }, exitCode: 0 },
    { kind: "character", action: "validate", ok: true, character: { ...validSummary, displayName: "x".repeat(81) }, exitCode: 0 },
    { kind: "character", action: "list", ok: true, characters: sixtyFive, exitCode: 0 },
    { kind: "character", action: "status", ok: true, activeCharacterId: null, available: true, exitCode: 0 },
    { kind: "character", action: "select", ok: true, activeCharacterId: "Bad ID", restartRequired: true, exitCode: 0 },
    { kind: "character", action: "select", ok: true, activeCharacterId: "alpha", restartRequired: false, exitCode: 0 },
    { kind: "login-startup", action: "status", status: "private", openAtLogin: false, ok: false, exitCode: 1 },
    { kind: "login-startup", action: "status", status: null, openAtLogin: false, ok: true, exitCode: 0 },
    { kind: "command", action: null, ok: false, errorCode: "private", exitCode: 1 },
    hiddenExtra,
    symbolExtra,
  ]) {
    assert.equal(formatCommandResult(result), `${JSON.stringify(FIXED_FAILURE)}\n`);
  }
});

test("formatter rejects accessor-backed values that change after validation", () => {
  let displayNameReads = 0;
  const character = {
    id: "alpha",
    get displayName() {
      displayNameReads += 1;
      return displayNameReads === 1 ? "Safe" : { nested: "escaped" };
    },
    valid: true,
    errorCode: null,
  };

  assert.equal(formatCommandResult({
    kind: "character",
    action: "validate",
    ok: true,
    character,
    exitCode: 0,
  }), `${JSON.stringify(FIXED_FAILURE)}\n`);
  assert.ok(displayNameReads <= 1);
});

test("formatter rejects an enumerable own __proto__ data property", () => {
  const result = {
    kind: "character",
    action: "status",
    ok: true,
    activeCharacterId: null,
    available: false,
    exitCode: 0,
  };
  Object.defineProperty(result, "__proto__", {
    value: { nested: "escaped" },
    enumerable: true,
    configurable: true,
    writable: true,
  });

  assert.equal(
    formatCommandResult(result),
    `${JSON.stringify(FIXED_FAILURE)}\n`,
  );
});
