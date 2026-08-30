"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createTrayStatus } = require("./tray-status.cjs");

function createHarness() {
  const menus = [];
  const callbacks = Object.freeze({
    onShow: () => "show",
    onHide: () => "hide",
    onPreviewListening: () => "listen",
    onPreviewSpeaking: () => "speak",
    onPreviewDance: () => "dance",
    onQuit: () => "quit",
  });
  const status = createTrayStatus({
    buildFromTemplate(template) {
      return Object.freeze({ template });
    },
    setContextMenu(menu) {
      menus.push(menu);
    },
    ...callbacks,
  });
  return { callbacks, menus, status };
}

test("tray status renders one neutral disabled item and preserves every existing callback", () => {
  const harness = createHarness();
  assert.equal(harness.menus.length, 1);
  const template = harness.menus[0].template;

  assert.deepEqual(template.map((item) => item.label ?? item.type), [
    "Speech engine: idle",
    "separator",
    "Show UME Presence",
    "Hide UME Presence",
    "separator",
    "Preview listening",
    "Preview speaking",
    "Preview dance",
    "separator",
    "Quit UME Presence",
  ]);
  assert.equal(template[0].enabled, false);
  assert.equal(template[2].click, harness.callbacks.onShow);
  assert.equal(template[3].click, harness.callbacks.onHide);
  assert.equal(template[5].click, harness.callbacks.onPreviewListening);
  assert.equal(template[6].click, harness.callbacks.onPreviewSpeaking);
  assert.equal(template[7].click, harness.callbacks.onPreviewDance);
  assert.equal(template[9].click, harness.callbacks.onQuit);
});

test("managed snapshots map to the five closed generic states without leaking details", () => {
  const harness = createHarness();
  const cases = [
    ["idle", "idle", "Speech engine: idle"],
    ["stopped", "idle", "Speech engine: idle"],
    ["probing", "starting", "Speech engine: starting"],
    ["starting", "starting", "Speech engine: starting"],
    ["waiting", "starting", "Speech engine: starting"],
    ["stopping", "starting", "Speech engine: starting"],
    ["ready-existing", "ready", "Speech engine: ready"],
    ["ready-owned", "ready", "Speech engine: ready"],
    ["requires-setup", "requires-setup", "Speech engine: setup required"],
    ["failed", "failed", "Speech engine: failed"],
  ];

  for (const [internal, state, label] of cases) {
    const next = createHarness();
    next.status.update({
      state: internal,
      ownership: "owned-private",
      attempts: 999,
      errorCode: "/secret/engine",
      executablePath: "/secret/engine",
    });
    assert.deepEqual(next.status.getStatus(), { state });
    assert.equal(next.menus.at(-1).template[0].label, label);
    assert.deepEqual(Object.keys(next.status.getStatus()), ["state"]);
    assert.equal(Object.isFrozen(next.status.getStatus()), true);
  }
  assert.equal(Object.isFrozen(harness.status), true);
  assert.deepEqual(Object.keys(harness.status), ["update", "getStatus"]);
});

test("failed and requires-setup latch until process shutdown", () => {
  for (const terminal of ["failed", "requires-setup"]) {
    const harness = createHarness();
    harness.status.update(terminal);
    const menuCount = harness.menus.length;
    for (const later of ["starting", "ready-owned", "stopped", "idle"]) {
      harness.status.update({ state: later });
    }
    assert.deepEqual(harness.status.getStatus(), { state: terminal });
    assert.equal(harness.menus.length, menuCount);
  }
});

test("an explicit manual retry reset clears a terminal status", () => {
  const harness = createHarness();
  harness.status.update("failed");
  const menuCount = harness.menus.length;

  harness.status.update({ state: "idle", reset: true });
  assert.deepEqual(harness.status.getStatus(), { state: "idle" });
  assert.equal(harness.menus.length, menuCount + 1);

  harness.status.update("starting");
  assert.deepEqual(harness.status.getStatus(), { state: "starting" });
});

test("menu build and installation failures cannot escape or roll back committed status", () => {
  for (const failurePoint of ["build", "set"]) {
    let buildCalls = 0;
    let setCalls = 0;
    let status = null;
    assert.doesNotThrow(() => {
      status = createTrayStatus({
        buildFromTemplate(template) {
          buildCalls += 1;
          if (failurePoint === "build") throw new Error("private menu build failure");
          return template;
        },
        setContextMenu() {
          setCalls += 1;
          if (failurePoint === "set") throw new Error("private menu install failure");
        },
        onShow() {},
        onHide() {},
        onPreviewListening() {},
        onPreviewSpeaking() {},
        onPreviewDance() {},
        onQuit() {},
      });
    });

    assert.doesNotThrow(() => status.update("starting"));
    assert.doesNotThrow(() => status.update("failed"));
    assert.doesNotThrow(() => status.update("ready"));
    assert.deepEqual(status.getStatus(), { state: "failed" });
    assert.equal(buildCalls, 3);
    assert.equal(setCalls, failurePoint === "set" ? 3 : 0);
  }
});
