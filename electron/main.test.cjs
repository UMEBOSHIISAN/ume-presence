"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function loadLoginCompositionHarness(t, {
  adapterResult = "adapter",
  loginReadError = null,
  speechEngineStart = false,
  wasOpenedAtLogin = true,
} = {}) {
  const originalArgv = process.argv;
  const renderer = deferred();
  const selectedRuntime = Object.freeze({ providerId: "selected-provider" });
  const counts = { adapter: 0, service: 0, start: 0 };
  const integrations = { renderer: 0, mcp: 0, tray: 0, listener: 0 };
  const identity = { appIds: [], names: [], paths: [], tooltips: [] };
  let initiallyHidden = null;
  let showCalls = 0;
  let statusState = "idle";

  const app = new EventEmitter();
  app.dock = { hide() {} };
  app.exit = () => {};
  app.getPath = (name) => name === "appData" ? "/fixed/app-data" : "/fixed/user-data";
  app.isPackaged = false;
  app.quit = () => {};
  app.requestSingleInstanceLock = () => true;
  app.setAppUserModelId = (appId) => identity.appIds.push(appId);
  app.setName = (name) => identity.names.push(name);
  app.setPath = (name, value) => identity.paths.push([name, value]);
  app.whenReady = () => Promise.resolve();
  const ipcMain = new EventEmitter();
  ipcMain.handle = () => {};
  const electronStub = {
    app,
    BrowserWindow: class {},
    globalShortcut: { register() {}, unregisterAll() {} },
    ipcMain,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: {},
    Tray: class extends EventEmitter {
      constructor() {
        super();
        integrations.tray += 1;
      }
      setContextMenu() {}
      setToolTip(value) { identity.tooltips.push(value); }
    },
  };

  const mainPath = require.resolve("./main.cjs");
  const originalLoad = Module._load;
  t.mock.method(Module, "_load", function load(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename !== mainPath) return originalLoad.call(this, request, parent, isMain);
    if (request === "./app-bootstrap.cjs") {
      return { bootstrapPersona: ({ runRuntime }) => runRuntime() };
    }
    if (request === "./audio-listener.cjs") {
      return {
        createAudioListener() {
          integrations.listener += 1;
          return { start() {}, stop() {} };
        },
      };
    }
    if (request === "./bridge-server.cjs") {
      return {
        DEFAULT_PORT: 47831,
        createBridgeServer: () => ({ listen: () => Promise.resolve(), close: () => Promise.resolve() }),
      };
    }
    if (request === "./mcp-server.cjs") {
      return {
        createPersonaMcpHandler() {
          integrations.mcp += 1;
          return () => {};
        },
      };
    }
    if (request === "./character-runtime.cjs") {
      return {
        createCharacterRuntimeBinding: () => ({
          runtime: selectedRuntime,
          onSpeech: async () => ({ codePoints: 0 }),
          stop() {},
        }),
        createInitializationActionGate: () => ({ handle() {}, open() {} }),
      };
    }
    if (request === "./renderer-readiness.cjs") {
      return { createRendererReadiness: () => ({ getReadyWindow: () => null, acknowledge() {}, reset() {} }) };
    }
    if (request === "./renderer-speech-bridge.cjs") {
      return { createRendererSpeechBridge: () => ({ handleRendererResult() {}, play() {}, stop() {} }) };
    }
    if (request === "./speech-voice-state.cjs") {
      return {
        createSpeechVoiceState: () => ({ startInternal() {}, finishInternal() {} }),
        routeExternalEvent() {},
      };
    }
    if (request === "./window-startup-policy.cjs") {
      return {
        createActivationRevealPolicy({ initiallyHidden: hidden, showOverlay }) {
          initiallyHidden = hidden;
          return { handleActivate: () => { if (!hidden) showOverlay({ focus: true }); } };
        },
        settleAvatarWindowStartup({ initiallyHidden: hidden }) {
          initiallyHidden = hidden;
          integrations.renderer += 1;
          return renderer.promise;
        },
      };
    }
    if (request === "./login-startup.cjs") {
      return {
        readLoginStartupState() {
          if (loginReadError) throw loginReadError;
          return { status: "enabled", openAtLogin: true, wasOpenedAtLogin };
        },
      };
    }
    if (request === "./provider-registry.cjs") {
      return {
        createEngineAdapter(providerId) {
          counts.adapter += 1;
          assert.equal(providerId, "selected-provider");
          if (adapterResult === null) return null;
          return { probeReadiness() {}, spawnOnce() {} };
        },
      };
    }
    if (request === "./managed-local-service.cjs") {
      return {
        createManagedLocalService(options) {
          counts.service += 1;
          return {
            start() {
              counts.start += 1;
              options.onStatus({ state: "ready-owned", ownership: "owned", attempts: 1 });
              return Promise.resolve({ state: "ready-owned" });
            },
            stop: () => Promise.resolve({ state: "stopped" }),
          };
        },
      };
    }
    if (request === "./tray-status.cjs") {
      return {
        createTrayStatus() {
          return {
            update(snapshot) {
              const state = typeof snapshot === "string" ? snapshot : snapshot.state;
              if ((statusState === "failed" || statusState === "requires-setup")
                && state !== "failed" && state !== "requires-setup") return;
              statusState = state === "ready-owned" || state === "ready-existing" ? "ready" : state;
            },
            getStatus: () => ({ state: statusState }),
          };
        },
      };
    }
    if (request === "./app-shutdown.cjs") {
      return { createAppShutdownCoordinator: () => ({ handleBeforeQuit: (event) => event.preventDefault() }) };
    }
    return originalLoad.call(this, request, parent, isMain);
  });

  process.argv = ["Persona", "app.cjs"];
  if (speechEngineStart) process.argv.push("--speech-engine=start");
  delete require.cache[mainPath];
  require(mainPath);
  await new Promise((resolve) => setImmediate(resolve));
  const cleanup = () => {
    renderer.resolve(null);
    app.removeAllListeners();
    ipcMain.removeAllListeners();
    process.argv = originalArgv;
    delete require.cache[mainPath];
    t.mock.restoreAll();
  };
  return {
    app,
    cleanup,
    counts,
    identity,
    integrations,
    renderer,
    get initiallyHidden() { return initiallyHidden; },
    get showCalls() { return showCalls; },
    get statusState() { return statusState; },
  };
}

test("applies UME product identity before preserving the Persona user-data path", async (t) => {
  const harness = await loadLoginCompositionHarness(t);
  try {
    assert.deepEqual(harness.identity.names, ["UME Presence"]);
    assert.deepEqual(harness.identity.paths, [
      ["userData", path.join("/fixed/app-data", "Persona")],
    ]);
    assert.deepEqual(harness.identity.appIds, ["io.github.umeboshiisan.persona"]);
    assert.deepEqual(harness.identity.tooltips, ["UME Presence"]);
  } finally {
    harness.cleanup();
  }
});

test("login origin is immutable-hidden and starts exactly one selected runtime service", {
  skip: process.platform === "darwin" ? false : "Darwin-only login startup behavior",
}, async (t) => {
  const harness = await loadLoginCompositionHarness(t);
  try {
    assert.equal(harness.initiallyHidden, true);
    assert.deepEqual(harness.counts, { adapter: 1, service: 1, start: 1 });
    assert.equal(harness.statusState, "ready");
  } finally {
    harness.cleanup();
  }
});

test("speech-engine flag starts the runtime after Persona initialization", async (t) => {
  const harness = await loadLoginCompositionHarness(t, {
    speechEngineStart: true,
    wasOpenedAtLogin: false,
  });
  try {
    assert.deepEqual(harness.counts, { adapter: 1, service: 1, start: 1 });
  } finally {
    harness.cleanup();
  }
});

test("second-instance speech-engine flag reaches the existing login runtime", async (t) => {
  const harness = await loadLoginCompositionHarness(t, { wasOpenedAtLogin: false });
  try {
    harness.app.emit("second-instance", {}, ["Persona", "--speech-engine=start"]);
    assert.deepEqual(harness.counts, { adapter: 1, service: 1, start: 1 });
    assert.equal(harness.showCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("login provider construction failure stays hidden before and after renderer rejection", {
  skip: process.platform === "darwin" ? false : "Darwin-only login startup behavior",
}, async (t) => {
  const harness = await loadLoginCompositionHarness(t, { adapterResult: null });
  try {
    assert.equal(harness.initiallyHidden, true);
    assert.deepEqual(harness.counts, { adapter: 1, service: 0, start: 0 });
    assert.equal(harness.statusState, "failed");
    harness.app.emit("activate");
    assert.equal(harness.showCalls, 0);

    harness.renderer.reject(new Error("renderer failed"));
    await new Promise((resolve) => setImmediate(resolve));
    harness.app.emit("activate");
    assert.equal(harness.showCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("login-state read failure stays private-hidden and preserves all core composition", {
  skip: process.platform === "darwin" ? false : "Darwin-only login startup behavior",
}, async (t) => {
  const harness = await loadLoginCompositionHarness(t, {
    loginReadError: new Error("private login settings failure /secret/path"),
  });
  try {
    assert.equal(harness.initiallyHidden, true);
    assert.deepEqual(harness.counts, { adapter: 0, service: 0, start: 0 });
    assert.deepEqual(harness.integrations, { renderer: 1, mcp: 1, tray: 1, listener: 1 });
    assert.equal(harness.statusState, "failed");
    harness.app.emit("activate");
    assert.equal(harness.showCalls, 0);

    harness.renderer.reject(new Error("renderer failed after login read failure"));
    await new Promise((resolve) => setImmediate(resolve));
    harness.app.emit("activate");
    assert.equal(harness.showCalls, 0);
  } finally {
    harness.cleanup();
  }
});

test("activate cannot create the renderer before character IPC initialization", async (t) => {
  const sequence = [];
  const ready = deferred();
  const rendererSettlement = deferred();
  const selectedRuntime = Object.freeze({ providerId: "selected-provider" });
  const windows = [];
  let loadCalls = 0;
  let showCalls = 0;
  let focusCalls = 0;

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.id = 1;
      this.webContents.isLoading = () => false;
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      windows.push(this);
    }

    focus() {
      focusCalls += 1;
    }

    getBounds() {
      return { width: 430, height: 680 };
    }

    hide() {
      this.visible = false;
    }

    isDestroyed() {
      return false;
    }

    isMinimized() {
      return false;
    }

    isVisible() {
      return this.visible;
    }

    loadURL() {
      loadCalls += 1;
      return Promise.resolve();
    }

    restore() {}

    setAlwaysOnTop() {}

    setOpacity() {}

    setPosition() {}

    setVisibleOnAllWorkspaces() {}

    show() {
      showCalls += 1;
      this.visible = true;
    }

    showInactive() {
      this.visible = true;
    }
  }

  const app = new EventEmitter();
  const appOn = app.on.bind(app);
  app.on = (eventName, listener) => {
    sequence.push(`app:on:${eventName}`);
    return appOn(eventName, listener);
  };
  app.dock = { hide: () => {} };
  app.getPath = (name) => {
    assert.match(name, /^(?:appData|userData)$/);
    if (name === "appData") return "/fixed/app-data";
    return "/fixed/missing-user-data";
  };
  app.isPackaged = false;
  app.exit = () => sequence.push("app:exit");
  app.quit = () => {};
  app.requestSingleInstanceLock = () => (sequence.push("app:lock"), true);
  app.setAppUserModelId = () => {};
  app.setName = () => {};
  app.setPath = () => {};
  app.whenReady = () => ready.promise;

  const ipcMain = new EventEmitter();
  const ipcOn = ipcMain.on.bind(ipcMain);
  const ipcHandlers = new Map();
  ipcMain.handle = (channel, handler) => {
    sequence.push(`ipc:handle:${channel}`);
    assert.equal(ipcHandlers.has(channel), false);
    ipcHandlers.set(channel, handler);
  };
  ipcMain.on = (channel, handler) => {
    sequence.push(`ipc:on:${channel}`);
    return ipcOn(channel, handler);
  };

  const electronStub = {
    app,
    BrowserWindow: FakeBrowserWindow,
    globalShortcut: { register: () => {}, unregisterAll: () => {} },
    ipcMain,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    },
    Tray: class extends EventEmitter {
      constructor() {
        super();
        sequence.push("tray:create");
      }

      setContextMenu() {}
      setToolTip() {}
    },
  };

  const mainPath = require.resolve("./main.cjs");
  const originalLoad = Module._load;
  t.mock.method(Module, "_load", function load(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename === mainPath && request === "./audio-listener.cjs") {
      return {
        createAudioListener() {
          sequence.push("listener:create");
          return { start: () => sequence.push("listener:start"), stop() {} };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./bridge-server.cjs") {
      return {
        DEFAULT_PORT: 47831,
        createBridgeServer() {
          sequence.push("bridge:create");
          return {
            close: () => Promise.resolve(),
            listen() {
              sequence.push("bridge:listen");
              return Promise.resolve();
            },
          };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./character-runtime.cjs") {
      return {
        createCharacterRuntimeBinding({ ipcMain: injectedIpcMain }) {
          sequence.push("character:binding");
          injectedIpcMain.handle("persona:get-character", () => null);
          return { runtime: selectedRuntime, onSpeech: () => {}, stop() {} };
        },
        createInitializationActionGate() {
          return {
            handle() {
              sequence.push("protocol:queue");
            },
            open() {
              sequence.push("protocol:open");
              sequence.push("protocol:drain");
            },
          };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./window-startup-policy.cjs") {
      return {
        createActivationRevealPolicy({ initiallyHidden, showOverlay }) {
          sequence.push(`activation-policy:${initiallyHidden}`);
          return {
            handleActivate: () => {
              if (!initiallyHidden) showOverlay({ focus: true });
            },
          };
        },
        settleAvatarWindowStartup() {
          sequence.push("startup:settle");
          return rendererSettlement.promise.then(() => sequence.push("startup:settled"));
        },
      };
    }
    if (parent?.filename === mainPath && request === "./login-startup.cjs") {
      return {
        readLoginStartupState() {
          sequence.push("login-state:read");
          return { status: "enabled", openAtLogin: true, wasOpenedAtLogin: false };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./login-runtime.cjs") {
      return {
        createLoginRuntime(options) {
          sequence.push("login-runtime:create");
          assert.equal(options.characterRuntime, selectedRuntime);
          return {
            startIfLoginLaunch() {
              sequence.push("login-runtime:start");
              return new Promise(() => {});
            },
            stop: () => Promise.resolve(),
            getStatus: () => ({ state: "idle" }),
          };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./tray-status.cjs") {
      return {
        createTrayStatus() {
          sequence.push("tray-status:create");
          return { update() {}, getStatus: () => ({ state: "idle" }) };
        },
      };
    }
    if (parent?.filename === mainPath && request === "./app-shutdown.cjs") {
      return {
        createAppShutdownCoordinator() {
          sequence.push("shutdown:create");
          return { handleBeforeQuit: (event) => event?.preventDefault?.() };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  });

  delete require.cache[mainPath];
  require(mainPath);
  t.mock.restoreAll();
  t.after(() => {
    app.emit("before-quit");
    app.removeAllListeners();
    ipcMain.removeAllListeners();
    delete require.cache[mainPath];
  });

  app.emit("activate");
  assert.equal(windows.length, 0);
  assert.equal(loadCalls, 0);

  app.emit("open-url", { preventDefault() {} }, "persona://show");
  assert.equal(sequence.includes("protocol:queue"), true);

  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ipcHandlers.has("persona:get-character"), true);
  const bindingIndex = sequence.indexOf("ipc:handle:persona:get-character");
  const resultIndex = sequence.indexOf("ipc:on:persona:speech-result");
  const readyIndex = sequence.indexOf("ipc:on:persona:speech-ready");
  const activateIndex = sequence.indexOf("app:on:activate");
  const startupIndex = sequence.indexOf("startup:settle");
  assert.ok(bindingIndex < resultIndex);
  assert.ok(resultIndex < readyIndex);
  assert.ok(readyIndex < activateIndex);
  assert.ok(activateIndex < startupIndex);

  const secondInstanceIndex = sequence.indexOf("app:on:second-instance");
  const openUrlIndex = sequence.indexOf("app:on:open-url");
  const protocolOpenIndex = sequence.indexOf("protocol:open");
  const protocolDrainIndex = sequence.indexOf("protocol:drain");
  const bridgeIndex = sequence.indexOf("bridge:create");
  const trayIndex = sequence.indexOf("tray:create");
  const listenerIndex = sequence.indexOf("listener:create");
  const trayStatusIndex = sequence.indexOf("tray-status:create");
  const loginRuntimeIndex = sequence.indexOf("login-runtime:create");
  const loginStartIndex = sequence.indexOf("login-runtime:start");
  assert.ok(secondInstanceIndex < openUrlIndex);
  assert.ok(protocolOpenIndex < protocolDrainIndex);
  assert.ok(protocolDrainIndex < startupIndex);
  assert.ok(startupIndex < trayStatusIndex);
  assert.ok(trayStatusIndex < loginRuntimeIndex);
  assert.ok(loginRuntimeIndex < loginStartIndex);
  assert.ok(loginStartIndex < bridgeIndex);
  assert.ok(bridgeIndex < trayIndex);
  assert.ok(trayIndex < listenerIndex);
  assert.equal(sequence.includes("startup:settled"), false);

  rendererSettlement.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(listenerIndex < sequence.indexOf("startup:settled"));

  app.emit("activate");
  assert.equal(windows.length, 1);
  assert.equal(loadCalls, 1);
  assert.equal(showCalls, 1);
  assert.equal(focusCalls, 1);
});

test("management argv exits through bootstrap without constructing normal runtime", async (t) => {
  const originalArgv = process.argv;
  const calls = [];
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const app = {
    exit(code) {
      calls.push(["exit", code]);
      resolveExit();
    },
    getPath(name) {
      return name === "appData" ? "/private/app-data" : "/private/user-data";
    },
    on() {
      calls.push(["app.on"]);
    },
    requestSingleInstanceLock() {
      calls.push(["lock"]);
      return true;
    },
    setName() {},
    setPath() {},
    whenReady() {
      calls.push(["ready"]);
      return Promise.resolve();
    },
  };
  const stdout = {
    write(line, callback) {
      calls.push(["stdout", line]);
      queueMicrotask(callback);
      return false;
    },
  };
  const factoryNames = [
    "activation-policy",
    "app-shutdown",
    "audio-listener",
    "bridge",
    "character-binding",
    "engine",
    "listener",
    "login-runtime",
    "login-state",
    "mcp",
    "readiness",
    "renderer-speech",
    "speech",
    "startup",
    "tray",
    "tray-status",
    "window",
  ];
  const constructionCalls = new Map(factoryNames.map((name) => [name, 0]));
  const count = (name) => {
    constructionCalls.set(name, constructionCalls.get(name) + 1);
  };

  class ForbiddenWindow {
    constructor() {
      count("window");
    }
  }
  class ForbiddenTray {
    constructor() {
      count("tray");
    }
  }
  const electronStub = {
    app,
    BrowserWindow: ForbiddenWindow,
    globalShortcut: { register: () => {}, unregisterAll: () => {} },
    ipcMain: new EventEmitter(),
    Menu: { buildFromTemplate: () => [] },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: {},
    Tray: ForbiddenTray,
  };

  const realBootstrap = require("./app-bootstrap.cjs").bootstrapPersona;
  const mainPath = require.resolve("./main.cjs");
  const originalLoad = Module._load;
  t.mock.method(Module, "_load", function load(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename === mainPath && request === "./app-bootstrap.cjs") {
      return {
        bootstrapPersona(options) {
          return realBootstrap({
            ...options,
            stdout,
            runCommand() {
              calls.push(["command"]);
              return {
                kind: "character",
                action: "status",
                ok: true,
                activeCharacterId: null,
                available: false,
                exitCode: 0,
              };
            },
          });
        },
      };
    }
    if (parent?.filename === mainPath && request === "./audio-listener.cjs") {
      return { createAudioListener: () => count("audio-listener") };
    }
    if (parent?.filename === mainPath && request === "./bridge-server.cjs") {
      return { DEFAULT_PORT: 47831, createBridgeServer: () => count("bridge") };
    }
    if (parent?.filename === mainPath && request === "./mcp-server.cjs") {
      return { createPersonaMcpHandler: () => count("mcp") };
    }
    if (parent?.filename === mainPath && request === "./character-runtime.cjs") {
      return {
        createCharacterRuntimeBinding: () => count("character-binding"),
        createInitializationActionGate: () => count("startup"),
      };
    }
    if (parent?.filename === mainPath && request === "./renderer-readiness.cjs") {
      return { createRendererReadiness: () => count("readiness") };
    }
    if (parent?.filename === mainPath && request === "./renderer-speech-bridge.cjs") {
      return { createRendererSpeechBridge: () => count("renderer-speech") };
    }
    if (parent?.filename === mainPath && request === "./speech-voice-state.cjs") {
      return {
        createSpeechVoiceState: () => count("speech"),
        routeExternalEvent: () => {},
      };
    }
    if (parent?.filename === mainPath && request === "./window-startup-policy.cjs") {
      return {
        createActivationRevealPolicy: () => count("activation-policy"),
        settleAvatarWindowStartup: () => count("startup"),
      };
    }
    if (parent?.filename === mainPath && request === "./login-startup.cjs") {
      return { readLoginStartupState: () => count("login-state") };
    }
    if (parent?.filename === mainPath && request === "./login-runtime.cjs") {
      return { createLoginRuntime: () => count("login-runtime") };
    }
    if (parent?.filename === mainPath && request === "./tray-status.cjs") {
      return { createTrayStatus: () => count("tray-status") };
    }
    if (parent?.filename === mainPath && request === "./app-shutdown.cjs") {
      return { createAppShutdownCoordinator: () => count("app-shutdown") };
    }
    if (parent?.filename === mainPath && request === "./managed-local-service.cjs") {
      return { createManagedLocalService: () => count("engine") };
    }
    return originalLoad.call(this, request, parent, isMain);
  });

  process.argv = ["Persona", "app.cjs", "--character=status"];
  delete require.cache[mainPath];
  try {
    require(mainPath);
    await Promise.race([exited, new Promise((resolve) => setImmediate(resolve))]);
  } finally {
    process.argv = originalArgv;
    delete require.cache[mainPath];
    t.mock.restoreAll();
  }

  assert.deepEqual(calls.map(([name]) => name), ["ready", "command", "stdout", "exit"]);
  assert.deepEqual(JSON.parse(calls[2][1]), {
    kind: "character",
    action: "status",
    ok: true,
    activeCharacterId: null,
    available: false,
    exitCode: 0,
  });
  assert.equal(calls[3][1], 0);
  assert.deepEqual([...constructionCalls.values()], factoryNames.map(() => 0));
});

test("hidden launch ignores global activate while every explicit reveal path remains available", async (t) => {
  const originalArgv = process.argv;
  const ready = deferred();
  const rendererSettlement = deferred();
  const sentEvents = [];
  const selectedRuntime = Object.freeze({ providerId: "selected-provider" });
  let showCalls = 0;
  let trayCallbacks = null;
  let mcpController = null;
  let ritualController = null;
  let thinkingCueExpiry = null;
  let cleanupNow = null;
  let bridgeOptions = null;
  let listenerOptions = null;
  let rendererBridge = null;
  let speechFailure = null;
  let trayModel = null;
  let adapterCalls = 0;
  let serviceFactoryCalls = 0;
  const windows = [];

  class FakeBrowserWindow extends EventEmitter {
    constructor() {
      super();
      windows.push(this);
      this.visible = false;
      this.webContents = new EventEmitter();
      this.webContents.id = 8;
      this.webContents.isLoading = () => false;
      this.webContents.send = (_channel, event) => sentEvents.push(event);
      this.webContents.setWindowOpenHandler = () => {};
    }
    focus() {}
    getBounds() { return { width: 430, height: 680 }; }
    hide() { this.visible = false; }
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isVisible() { return this.visible; }
    loadURL() { return Promise.resolve(); }
    restore() {}
    setAlwaysOnTop() {}
    setOpacity() {}
    setPosition() {}
    setVisibleOnAllWorkspaces() {}
    show() { this.visible = true; showCalls += 1; }
    showInactive() { this.visible = true; showCalls += 1; }
  }

  const app = new EventEmitter();
  app.dock = { hide() {} };
  app.exit = () => {};
  app.getPath = (name) => name === "appData" ? "/fixed/app-data" : "/fixed/user-data";
  app.isPackaged = false;
  app.quit = () => {};
  app.requestSingleInstanceLock = () => true;
  app.setAppUserModelId = () => {};
  app.setName = () => {};
  app.setPath = () => {};
  app.whenReady = () => ready.promise;
  const ipcMain = new EventEmitter();
  const ipcHandlers = new Map();
  ipcMain.handle = (channel, handler) => ipcHandlers.set(channel, handler);

  const electronStub = {
    app,
    BrowserWindow: FakeBrowserWindow,
    globalShortcut: { register() {}, unregisterAll() {} },
    ipcMain,
    Menu: { buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    },
    Tray: class extends EventEmitter {
      setContextMenu() {}
      setToolTip() {}
    },
  };

  const mainPath = require.resolve("./main.cjs");
  const originalLoad = Module._load;
  t.mock.method(Module, "_load", function load(request, parent, isMain) {
    if (request === "electron") return electronStub;
    if (parent?.filename !== mainPath) return originalLoad.call(this, request, parent, isMain);
    if (request === "./app-bootstrap.cjs") {
      return { bootstrapPersona: ({ runRuntime }) => runRuntime() };
    }
    if (request === "./audio-listener.cjs") {
      return {
        createAudioListener(options) {
          listenerOptions = options;
          return { start() {}, stop() {} };
        },
      };
    }
    if (request === "./ritual-controller.cjs") {
      return {
        createRitualController(options) {
          assert.equal(options.setTimer, setTimeout);
          assert.equal(options.clearTimer, clearTimeout);
          ritualController = {
            cancelCalls: 0,
            disposeCalls: 0,
            starts: [],
            cancel() {
              this.cancelCalls += 1;
              options.emit({ type: "presence-cue", cue: "clear" });
              return true;
            },
            dispose() { this.disposeCalls += 1; return true; },
            start(ritual) {
              this.starts.push(ritual);
              options.emit({ type: "presence-cue", cue: ritual === "work_complete" ? "complete" : ritual });
              return { status: "started", ritual };
            },
          };
          return ritualController;
        },
      };
    }
    if (request === "./thinking-cue-expiry.cjs") {
      return {
        createThinkingCueExpiry(options) {
          let active = false;
          thinkingCueExpiry = {
            cancelCalls: 0,
            disposeCalls: 0,
            startCalls: 0,
            cancel() {
              this.cancelCalls += 1;
              const wasActive = active;
              active = false;
              return wasActive;
            },
            dispose() { this.disposeCalls += 1; active = false; },
            expire() {
              active = false;
              options.emit({ type: "presence-cue", cue: "clear" });
            },
            start() { this.startCalls += 1; active = true; },
          };
          return thinkingCueExpiry;
        },
      };
    }
    if (request === "./bridge-server.cjs") {
      return {
        DEFAULT_PORT: 47831,
        createBridgeServer: (options) => {
          bridgeOptions = options;
          return { listen: () => Promise.resolve(), close: () => Promise.resolve() };
        },
      };
    }
    if (request === "./mcp-server.cjs") {
      return {
        createPersonaMcpHandler(controller) {
          mcpController = controller;
          return () => {};
        },
      };
    }
    if (request === "./character-runtime.cjs") {
      return {
        createCharacterRuntimeBinding({ rendererSpeechBridge }) {
          rendererBridge = rendererSpeechBridge;
          return {
            runtime: selectedRuntime,
            async onSpeech(text) {
              if (speechFailure) throw speechFailure;
              rendererSpeechBridge.startForTest();
              return { codePoints: [...text].length };
            },
            stop() {},
          };
        },
        createInitializationActionGate({ dispatch }) {
          let open = false;
          const pending = [];
          return {
            handle(value) {
              if (open) return dispatch(value);
              pending.push(value);
              return true;
            },
            open() {
              open = true;
              for (const value of pending.splice(0)) dispatch(value);
            },
          };
        },
      };
    }
    if (request === "./renderer-readiness.cjs") {
      return { createRendererReadiness: () => ({ getReadyWindow: () => null, acknowledge() {}, reset() {} }) };
    }
    if (request === "./renderer-speech-bridge.cjs") {
      return {
        createRendererSpeechBridge(options) {
          return {
            handleRendererResult() {},
            play() {},
            stop() {},
            startForTest: options.onStarted,
          };
        },
      };
    }
    if (request === "./speech-voice-state.cjs") {
      return {
        createSpeechVoiceState({ emit }) {
          return {
            startInternal: () => emit({ type: "state", state: { phase: "starting" } }),
            finishInternal() {},
          };
        },
        routeExternalEvent: (event, { emit }) => emit(event),
      };
    }
    if (request === "./window-startup-policy.cjs") {
      return {
        createActivationRevealPolicy({ initiallyHidden, showOverlay }) {
          assert.equal(initiallyHidden, true);
          return { handleActivate: () => { if (!initiallyHidden) showOverlay({ focus: true }); } };
        },
        settleAvatarWindowStartup({ initiallyHidden, createWindow }) {
          assert.equal(initiallyHidden, true);
          createWindow();
          return rendererSettlement.promise;
        },
      };
    }
    if (request === "./login-startup.cjs") {
      return { readLoginStartupState: () => ({ status: "enabled", openAtLogin: true, wasOpenedAtLogin: false }) };
    }
    if (request === "./tray-status.cjs") {
      const realTrayStatus = originalLoad.call(this, request, parent, isMain);
      return {
        createTrayStatus(options) {
          trayCallbacks = options;
          trayModel = realTrayStatus.createTrayStatus({
            ...options,
            buildFromTemplate() {
              throw new Error("private tray menu rebuild failure");
            },
          });
          return trayModel;
        },
      };
    }
    if (request === "./app-shutdown.cjs") {
      return {
        createAppShutdownCoordinator(options) {
          cleanupNow = options.cleanupNow;
          return { handleBeforeQuit: (event) => event.preventDefault() };
        },
      };
    }
    if (request === "./provider-registry.cjs") {
      return { createEngineAdapter() { adapterCalls += 1; } };
    }
    if (request === "./managed-local-service.cjs") {
      return { createManagedLocalService() { serviceFactoryCalls += 1; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  });

  process.argv = ["Persona", "app.cjs", "--background"];
  delete require.cache[mainPath];
  try {
    require(mainPath);
    ready.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(adapterCalls, 0);
    assert.equal(serviceFactoryCalls, 0);

    app.emit("activate");
    assert.equal(showCalls, 0);

    trayCallbacks.onShow();
    windows[0].hide();
    app.emit("second-instance", {}, ["Persona", "app.cjs"]);
    windows[0].hide();
    app.emit("open-url", { preventDefault() {} }, "persona://show");
    windows[0].hide();
    await mcpController.onSpeech("声です");
    windows[0].hide();
    listenerOptions.onLevel(0.5);
    assert.equal(showCalls, 5);
    assert.equal(rendererBridge !== null, true);
    assert.equal(sentEvents.some((event) => event.type === "state"), true);
    assert.equal(sentEvents.some((event) => event.type === "audio-level"), true);

    listenerOptions.onActivity("speaking");
    assert.deepEqual(ritualController.starts, []);

    assert.deepEqual(mcpController.onRitual("work_complete"), {
      status: "busy",
      ritual: "work_complete",
    });
    assert.deepEqual(ritualController.starts, []);

    listenerOptions.onSession(false);
    assert.equal(ritualController.cancelCalls, 2);
    bridgeOptions.onEvent({ type: "presence-cue", cue: "complete" });
    assert.deepEqual(ritualController.starts, ["work_complete"]);
    assert.equal(sentEvents.some((event) => event.type === "presence-cue" && event.cue === "complete"), true);
    assert.equal(windows[0].isVisible(), true);
    bridgeOptions.onEvent({ type: "presence-cue", cue: "clear" });
    assert.equal(ritualController.cancelCalls, 3);

    listenerOptions.onSession(true);
    assert.deepEqual(ritualController.starts, ["work_complete", "greeting"]);
    windows[0].hide();
    const beforeThinkingReveal = showCalls;
    app.emit("open-url", { preventDefault() {} }, "persona://thinking");
    assert.equal(showCalls, beforeThinkingReveal + 1);
    assert.equal(thinkingCueExpiry.startCalls, 1);
    windows[0].hide();
    thinkingCueExpiry.expire();
    assert.equal(windows[0].isVisible(), false);
    assert.deepEqual(sentEvents.slice(-2), [
      { type: "presence-cue", cue: "clear" },
      {
        type: "state",
        state: {
          activity: "listening",
          microphoneMuted: false,
          outputMuted: false,
          phase: "active",
        },
      },
    ]);
    assert.equal(Array.isArray(ipcHandlers.get("persona:get-snapshot")()), true);
    assert.deepEqual(
      ipcHandlers.get("persona:get-snapshot").call().findLast((event) => event.type === "state"),
      sentEvents.findLast((event) => event.type === "state"),
    );
    listenerOptions.onActivity("speaking");
    assert.equal(ritualController.cancelCalls, 4);

    listenerOptions.onSession(false);
    assert.equal(ritualController.cancelCalls, 5);
    app.emit("open-url", { preventDefault() {} }, "persona://ritual/break");
    assert.deepEqual(ritualController.starts, ["work_complete", "greeting", "break"]);
    bridgeOptions.onEvent({
      type: "state",
      state: {
        activity: "speaking",
        microphoneMuted: true,
        outputMuted: false,
        phase: "active",
      },
    });
    assert.equal(ritualController.cancelCalls, 6);

    bridgeOptions.onEvent({ type: "audio-level", level: 0.8 });
    bridgeOptions.onEvent({
      type: "state",
      state: {
        activity: "idle",
        microphoneMuted: false,
        outputMuted: false,
        phase: "inactive",
      },
    });
    const chronologicalSnapshot = ipcHandlers.get("persona:get-snapshot")();
    const finalAudioIndex = chronologicalSnapshot.findLastIndex(
      (event) => event.type === "audio-level",
    );
    const finalInactiveIndex = chronologicalSnapshot.findLastIndex(
      (event) => event.type === "state" && event.state.phase === "inactive",
    );
    assert.equal(finalAudioIndex, -1);
    assert.equal(finalInactiveIndex >= 0, true);

    bridgeOptions.onEvent({
      type: "state",
      state: {
        activity: "listening",
        microphoneMuted: false,
        outputMuted: false,
        phase: "active",
      },
    });
    ritualController.cancel();
    bridgeOptions.onEvent({ type: "animation", animation: "DANCE" });
    const previewSnapshot = ipcHandlers.get("persona:get-snapshot")();
    const finalStateIndex = previewSnapshot.findLastIndex(
      (event) => event.type === "state",
    );
    const finalAnimationIndex = previewSnapshot.findLastIndex(
      (event) => event.type === "animation",
    );
    assert.equal(finalAnimationIndex > finalStateIndex, true);

    for (let index = 0; index < 65; index += 1) {
      bridgeOptions.onEvent({ type: "audio-level", level: index / 100 });
    }
    const retainedPreviewSnapshot = ipcHandlers.get("persona:get-snapshot")();
    assert.equal(
      retainedPreviewSnapshot.some(
        (event) => event.type === "animation" && event.animation === "DANCE",
      ),
      true,
    );

    bridgeOptions.onEvent({
      type: "state",
      state: {
        activity: "listening",
        microphoneMuted: false,
        outputMuted: false,
        phase: "active",
      },
    });
    bridgeOptions.onEvent({ type: "presence-cue", cue: "thinking" });
    for (let index = 0; index < 65; index += 1) {
      bridgeOptions.onEvent({ type: "audio-level", level: index / 100 });
    }
    const retainedCueSnapshot = ipcHandlers.get("persona:get-snapshot")();
    assert.equal(
      retainedCueSnapshot.some(
        (event) => event.type === "presence-cue" && event.cue === "thinking",
      ),
      true,
    );

    cleanupNow();
    cleanupNow();
    assert.equal(ritualController.disposeCalls, 1);
    assert.equal(thinkingCueExpiry.disposeCalls, 1);

    speechFailure = new Error("private provider failure");
    speechFailure.code = "AIVIS_PROVIDER_FAILED";
    await assert.rejects(mcpController.onSpeech("失敗"), (error) => error === speechFailure);
    trayModel.update({ state: "ready-owned", ownership: "owned", attempts: 2 });
    assert.deepEqual(mcpController.getStatus().speechEngine, { state: "failed" });
  } finally {
    rendererSettlement.resolve();
    app.removeAllListeners();
    ipcMain.removeAllListeners();
    process.argv = originalArgv;
    delete require.cache[mainPath];
    t.mock.restoreAll();
  }
});
