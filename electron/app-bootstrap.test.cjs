"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { bootstrapPersona } = require("./app-bootstrap.cjs");

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function harness({ ready = Promise.resolve(), writeReturn = true } = {}) {
  const sequence = [];
  const writes = [];
  const callbacks = [];
  const stderrWrites = [];
  const app = {
    whenReady() {
      sequence.push("ready");
      return ready;
    },
    exit(code) {
      sequence.push(`exit:${code}`);
    },
    requestSingleInstanceLock() {
      sequence.push("lock");
      return true;
    },
  };
  const stdout = {
    write(line, callback) {
      sequence.push("write");
      writes.push(line);
      callbacks.push(callback);
      return writeReturn;
    },
  };
  const stderr = {
    write(value) {
      stderrWrites.push(value);
    },
  };
  return { app, callbacks, sequence, stderr, stderrWrites, stdout, writes };
}

test("normal argv runs only the normal runtime path", async () => {
  const testHarness = harness();
  let runtimeCalls = 0;
  let commandCalls = 0;

  await bootstrapPersona({
    app: testHarness.app,
    argv: ["Electron", "app.cjs", "--background"],
    runRuntime() {
      runtimeCalls += 1;
    },
    runCommand() {
      commandCalls += 1;
    },
    stdout: testHarness.stdout,
    stderr: testHarness.stderr,
  });

  assert.equal(runtimeCalls, 1);
  assert.equal(commandCalls, 0);
  assert.deepEqual(testHarness.sequence, []);
  assert.deepEqual(testHarness.writes, []);
  assert.deepEqual(testHarness.stderrWrites, []);
});

test("speech-engine runtime flag remains in the normal runtime path", async () => {
  const testHarness = harness();
  let runtimeCalls = 0;
  let commandCalls = 0;

  await bootstrapPersona({
    app: testHarness.app,
    argv: ["Electron", "app.cjs", "--speech-engine=start"],
    runRuntime() {
      runtimeCalls += 1;
    },
    runCommand() {
      commandCalls += 1;
    },
    stdout: testHarness.stdout,
    stderr: testHarness.stderr,
  });

  assert.equal(runtimeCalls, 1);
  assert.equal(commandCalls, 0);
  assert.deepEqual(testHarness.sequence, []);
});

test("command mode waits for readiness and the stdout callback before exiting", async () => {
  const ready = deferred();
  const testHarness = harness({ ready: ready.promise, writeReturn: false });
  const commandResult = {
    kind: "character",
    action: "status",
    ok: true,
    activeCharacterId: "alpha",
    available: true,
    exitCode: 0,
  };
  let commandCalls = 0;
  let runtimeCalls = 0;
  const pending = bootstrapPersona({
    app: testHarness.app,
    argv: ["Electron", "app.cjs", "--character=status"],
    runRuntime() {
      runtimeCalls += 1;
    },
    runCommand(command) {
      commandCalls += 1;
      assert.deepEqual(command, { kind: "character", action: "status", id: null });
      return commandResult;
    },
    stdout: testHarness.stdout,
    stderr: testHarness.stderr,
  });

  assert.deepEqual(testHarness.sequence, ["ready"]);
  assert.equal(commandCalls, 0);
  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandCalls, 1);
  assert.equal(runtimeCalls, 0);
  assert.deepEqual(testHarness.sequence, ["ready", "write"]);
  assert.deepEqual(testHarness.writes, [`${JSON.stringify(commandResult)}\n`]);
  assert.deepEqual(testHarness.stderrWrites, []);

  testHarness.callbacks[0]();
  await pending;
  assert.deepEqual(testHarness.sequence, ["ready", "write", "exit:0"]);
});

test("malformed management argv waits once, skips command dispatch, and writes one closed failure", async () => {
  const testHarness = harness();
  let commandCalls = 0;
  const pending = bootstrapPersona({
    app: testHarness.app,
    argv: ["Electron", "app.cjs", "--character=validate", "--character-id=/private/id"],
    runRuntime: () => assert.fail("runtime must stay isolated"),
    runCommand() {
      commandCalls += 1;
    },
    stdout: testHarness.stdout,
    stderr: testHarness.stderr,
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commandCalls, 0);
  assert.deepEqual(testHarness.sequence, ["ready", "write"]);
  assert.equal(testHarness.writes.length, 1);
  assert.deepEqual(JSON.parse(testHarness.writes[0]), {
    kind: "command",
    action: null,
    ok: false,
    errorCode: "INVALID_APP_COMMAND",
    exitCode: 1,
  });
  assert.equal(testHarness.writes[0].includes("/private/id"), false);
  testHarness.callbacks[0]();
  await pending;
  assert.deepEqual(testHarness.sequence, ["ready", "write", "exit:1"]);
  assert.deepEqual(testHarness.stderrWrites, []);
});

test("operational and formatter failures each emit one bounded stdout-only failure", async () => {
  const privateMessage = "private caught message at /private/path";
  const cases = [
    {
      runCommand() {
        throw new Error(privateMessage);
      },
    },
    {
      runCommand() {
        return {
          kind: "character",
          action: "select",
          ok: true,
          activeCharacterId: "alpha",
          restartRequired: true,
          exitCode: 0,
          nested: { privateMessage },
        };
      },
    },
  ];

  for (const testCase of cases) {
    const testHarness = harness();
    const pending = bootstrapPersona({
      app: testHarness.app,
      argv: ["Persona", "--character=select", "--character-id=private-id"],
      runRuntime: () => assert.fail("runtime must stay isolated"),
      runCommand: testCase.runCommand,
      stdout: testHarness.stdout,
      stderr: testHarness.stderr,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(testHarness.writes.length, 1);
    assert.ok(Buffer.byteLength(testHarness.writes[0], "utf8") < 1024);
    assert.deepEqual(JSON.parse(testHarness.writes[0]), {
      kind: "command",
      action: null,
      ok: false,
      errorCode: "COMMAND_FAILED",
      exitCode: 1,
    });
    assert.equal(testHarness.writes[0].includes("private-id"), false);
    assert.equal(testHarness.writes[0].includes(privateMessage), false);
    assert.deepEqual(testHarness.stderrWrites, []);
    testHarness.callbacks[0]();
    await pending;
    assert.deepEqual(testHarness.sequence, ["ready", "write", "exit:1"]);
  }
});
