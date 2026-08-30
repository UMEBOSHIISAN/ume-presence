"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  NativeProcessAudioListener,
  createNdjsonParser,
  resolveNativeHelperPath,
} = require("./native-process-audio-listener.cjs");

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit("exit", 0, "SIGTERM");
  return child;
}

test("NDJSON parser buffers partial messages and rejects malformed lines", () => {
  const messages = [];
  const invalid = [];
  const parse = createNdjsonParser(
    (message) => messages.push(message),
    (line) => invalid.push(line),
  );
  parse('{"type":"rea');
  parse('dy"}\nnot-json\n{"type":"level","level":0.2}\n');
  assert.deepEqual(messages, [
    { type: "ready" },
    { type: "level", level: 0.2 },
  ]);
  assert.deepEqual(invalid, ["not-json"]);
});

test("resolves development and packaged helper locations on both native platforms", () => {
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: true,
      resourcesPath: "C:\\resources",
    }),
    "C:\\resources\\native\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "win32",
      projectRoot: "C:\\project",
      isPackaged: false,
    }),
    "C:\\project\\native\\bin\\win32\\persona-audio-listener.exe",
  );
  assert.equal(
    resolveNativeHelperPath({
      platform: "darwin",
      projectRoot: "/project",
      isPackaged: false,
    }),
    "/project/native/bin/darwin/persona-audio-listener",
  );
});

test("native listener activates on audio, smooths speech, and never hides the window", async () => {
  const activities = [];
  const sessions = [];
  const statuses = [];
  const child = fakeChild();
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids: [10, 11], rootPids: [10] }),
    spawnProcess: () => child,
    onActivity: (activity) => activities.push(activity),
    onSession: (active) => sessions.push(active),
    onStatus: (status) => statuses.push(status),
    sessionIdleMs: 35,
    speechReleaseMs: 15,
  });

  await listener.start();
  child.stdout.emit("data", '{"type":"ready","source":"Codex"}\n');
  child.stdout.emit("data", '{"type":"level","level":0.3}\n');
  child.stdout.emit("data", '{"type":"level","level":0}\n');
  await new Promise((resolve) => setTimeout(resolve, 22));

  assert.deepEqual(sessions, [true]);
  assert.deepEqual(activities, ["listening", "speaking", "listening"]);
  assert.equal(statuses.at(-1).capturing, true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(sessions, [true, false]);
  listener.stop();
});

test("native listener retries only after all discovered targets leave", async () => {
  const children = [];
  const statuses = [];
  let pids = [10, 11];
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids, rootPids: pids.slice(0, 1) }),
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    onStatus: (status) => statuses.push(status),
    pollIntervalMs: 10,
  });

  await listener.start();
  assert.equal(children.length, 1);
  children[0].emit("exit", 1, null);
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(children.length, 1);
  assert.match(statuses.at(-1).error, /exited with code 1/);

  pids = [12];
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(children.length, 1);

  pids = [];
  await new Promise((resolve) => setTimeout(resolve, 25));
  pids = [12];
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(children.length, 2);
  listener.stop();
});

test("native listener keeps one active capture when the discovered PID set churns", async () => {
  const children = [];
  let pids = [10];
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids, rootPids: pids }),
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    pollIntervalMs: 10,
  });

  await listener.start();
  pids = [12];
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(children.length, 1);
  assert.equal(listener.captureKey, "10");
  listener.stop();
});

test("native listener latches an unexpected zero exit", async () => {
  const children = [];
  const statuses = [];
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids: [10], rootPids: [10] }),
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    onStatus: (status) => statuses.push(status),
    pollIntervalMs: 10,
  });

  await listener.start();
  children[0].emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(children.length, 1);
  assert.equal(listener.failedCaptureKey, "10");
  assert.match(statuses.at(-1).error, /exited unexpectedly/);
  listener.stop();
});

test("native listener latches a helper-reported error even when the helper exits zero", async () => {
  const children = [];
  const statuses = [];
  const listener = new NativeProcessAudioListener({
    platform: "darwin",
    helperPath: __filename,
    processDiscovery: async () => ({ pids: [10, 11], rootPids: [10] }),
    spawnProcess: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
    onStatus: (status) => statuses.push(status),
    pollIntervalMs: 10,
  });

  await listener.start();
  assert.equal(children.length, 1);
  children[0].stdout.emit(
    "data",
    '{"type":"error","message":"No active Core Audio process matches the requested application."}\n',
  );
  children[0].emit("exit", 0, null);
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(children.length, 1);
  assert.equal(listener.failedCaptureKey, "10,11");
  assert.match(statuses.at(-1).error, /No active Core Audio process/);
  listener.stop();
});
