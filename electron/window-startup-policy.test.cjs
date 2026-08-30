"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  createActivationRevealPolicy,
  initializeAvatarWindow,
  settleAvatarWindowStartup,
  waitForRenderer,
} = require("./window-startup-policy.cjs");

test("activation reveal policy permanently preserves immutable launch provenance", () => {
  for (const initiallyHidden of [true, false]) {
    const shown = [];
    const policy = createActivationRevealPolicy({
      initiallyHidden,
      showOverlay: (options) => shown.push(options),
    });

    policy.handleActivate();
    policy.handleActivate();

    assert.deepEqual(shown, initiallyHidden ? [] : [{ focus: true }, { focus: true }]);
    assert.equal(Object.isFrozen(policy), true);
    assert.deepEqual(Object.keys(policy), ["handleActivate"]);
  }
});

function createHarness({ loading = true } = {}) {
  const webContents = new EventEmitter();
  webContents.isLoading = () => loading;
  const window = new EventEmitter();
  window.webContents = webContents;
  let createCalls = 0;
  const shown = [];
  return {
    webContents,
    window,
    shown,
    get createCalls() {
      return createCalls;
    },
    initialize: (initiallyHidden) =>
      initializeAvatarWindow({
        initiallyHidden,
        createWindow: () => {
          createCalls += 1;
          return window;
        },
        showOverlay: (options) => shown.push(options),
      }),
  };
}

test("background startup creates a hidden renderer and waits until it is ready", async () => {
  const harness = createHarness();
  let settled = false;
  const pending = harness.initialize(true).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(harness.createCalls, 1);
  assert.equal(settled, false);
  assert.deepEqual(harness.shown, []);

  harness.webContents.emit("did-finish-load");
  await pending;
  assert.equal(settled, true);
  assert.deepEqual(harness.shown, []);
});

test("foreground startup shows the ready renderer with focus", async () => {
  const harness = createHarness({ loading: false });

  await harness.initialize(false);

  assert.equal(harness.createCalls, 1);
  assert.deepEqual(harness.shown, [{ focus: true }]);
});

test("settled startup reports renderer failure without blocking other services", async () => {
  const harness = createHarness();
  const errors = [];
  const pending = settleAvatarWindowStartup({
    initiallyHidden: true,
    createWindow: () => harness.window,
    showOverlay: () => {},
    onError: (error) => errors.push(error),
  });

  harness.webContents.emit("did-fail-load");

  assert.equal(await pending, null);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /failed to load/i);
});

test("renderer startup wait rejects after a bounded timeout", async () => {
  const harness = createHarness();
  let timer = null;
  const pending = waitForRenderer(harness.window, {
    timeoutMs: 250,
    setTimer: (callback, timeoutMs) => {
      timer = { callback, timeoutMs };
      return 1;
    },
    clearTimer: () => {},
  });

  assert.equal(timer.timeoutMs, 250);
  timer.callback();

  await assert.rejects(pending, /timed out/i);
});

test("a foreground renderer that loads after the timeout is still shown", async () => {
  const harness = createHarness();
  let timeoutCallback = null;
  const pending = settleAvatarWindowStartup({
    initiallyHidden: false,
    createWindow: () => harness.window,
    showOverlay: (options) => harness.shown.push(options),
    rendererWaitOptions: {
      setTimer: (callback) => {
        timeoutCallback = callback;
        return 1;
      },
      clearTimer: () => {},
    },
  });

  timeoutCallback();
  assert.equal(await pending, null);
  assert.deepEqual(harness.shown, []);

  harness.webContents.emit("did-finish-load");
  assert.deepEqual(harness.shown, [{ focus: true }]);
});
