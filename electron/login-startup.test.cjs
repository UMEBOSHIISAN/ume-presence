"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const test = require("node:test");

let electronModuleLoads = 0;
let loginStartup;
const originalLoad = Module._load;
try {
  Module._load = function loadWithoutElectron(request, parent, isMain) {
    if (request === "electron") {
      electronModuleLoads += 1;
      throw new Error("The login startup policy must not import Electron.");
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  loginStartup = require("./login-startup.cjs");
} finally {
  Module._load = originalLoad;
}

const {
  parseLoginStartupAction,
  readLoginStartupState,
  runLoginStartupAction,
  wasOpenedAtLogin,
} = loginStartup;

const LOGIN_ITEM_QUERY = Object.freeze({ type: "mainAppService" });

function electronSettings(overrides = {}) {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: "not-registered",
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...overrides,
  };
}

function createFakeApp({
  isPackaged = true,
  getResults = [electronSettings()],
  getImpl,
  setImpl,
} = {}) {
  const calls = [];
  const getCalls = [];
  const setCalls = [];
  let getIndex = 0;
  const app = {
    isPackaged,
    getLoginItemSettings(options) {
      calls.push("get");
      getCalls.push(options);
      if (getImpl) return getImpl(options);
      if (getIndex >= getResults.length) {
        throw new Error("unexpected extra fake read");
      }
      const result = getResults[getIndex];
      getIndex += 1;
      if (result instanceof Error) throw result;
      return result;
    },
    setLoginItemSettings(options) {
      calls.push("set");
      setCalls.push(options);
      return setImpl?.(options);
    },
  };
  return { app, calls, getCalls, setCalls };
}

function assertExactResult(result, expected) {
  assert.deepEqual(Object.keys(result), [
    "kind",
    "action",
    "status",
    "openAtLogin",
    "ok",
    "exitCode",
  ]);
  assert.deepEqual(result, expected);
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
}

function assertClosedError(operation, { code, message }) {
  assert.throws(operation, (error) => {
    assert.equal(error.name, "LoginStartupError");
    assert.equal(error.code, code);
    assert.equal(error.message, message);
    return true;
  });
}

test("loads as a pure injected policy without importing Electron", () => {
  assert.equal(electronModuleLoads, 0);
});

test("parses no option and each exact action without changing unrelated argv", () => {
  const noOption = Object.freeze(["Electron", "app.cjs", "--background"]);
  assert.equal(parseLoginStartupAction(noOption), null);
  assert.deepEqual(noOption, ["Electron", "app.cjs", "--background"]);

  for (const action of ["enable", "status", "disable"]) {
    const argv = Object.freeze([
      "Electron",
      "app.cjs",
      "--background",
      `--login-startup=${action}`,
      "--unrelated=value",
    ]);
    const before = [...argv];

    assert.equal(parseLoginStartupAction(argv), action);
    assert.deepEqual(argv, before);
  }
});

test("rejects duplicate login actions, including the same action twice", () => {
  for (const argv of [
    ["Persona", "--login-startup=enable", "--login-startup=status"],
    ["Persona", "--login-startup=disable", "--login-startup=disable"],
  ]) {
    const before = [...argv];
    assertClosedError(() => parseLoginStartupAction(argv), {
      code: "LOGIN_STARTUP_ACTION_COUNT",
      message: "Login startup requires exactly one action.",
    });
    assert.deepEqual(argv, before);
  }
});

test("rejects unknown and bare login-startup variants without reflecting argv", () => {
  const privateToken = "/private/secret/token";
  for (const argument of [
    "--login-startup",
    "--login-startup=",
    "--login-startup=yes",
    "--login-startup=STATUS",
    "--login-startup=status=extra",
    `--login-startup-${privateToken}`,
  ]) {
    assert.throws(
      () => parseLoginStartupAction(["Persona", argument]),
      (error) => {
        assert.equal(error.name, "LoginStartupError");
        assert.equal(error.code, "INVALID_LOGIN_STARTUP_ACTION");
        assert.equal(error.message, "Invalid login startup action.");
        assert.equal(error.message.includes(argument), false);
        assert.equal(error.message.includes(privateToken), false);
        return true;
      },
    );
  }
});

test("reads the main-app service into an exact frozen normalized state", () => {
  const harness = createFakeApp({
    getResults: [electronSettings({
      status: "enabled",
      openAtLogin: "true",
      wasOpenedAtLogin: 1,
    })],
  });

  const state = readLoginStartupState(harness.app);

  assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
  assert.deepEqual(harness.setCalls, []);
  assert.deepEqual(Object.keys(state), ["status", "openAtLogin", "wasOpenedAtLogin"]);
  assert.deepEqual(state, {
    status: "enabled",
    openAtLogin: false,
    wasOpenedAtLogin: false,
  });
  assert.equal(Object.isFrozen(state), true);
});

test("read failures and invalid raw states throw only closed policy errors", () => {
  const privateData = "/Users/example/private --token=secret";
  const readFailure = createFakeApp({
    getResults: [new Error(privateData)],
  });
  assertClosedError(() => readLoginStartupState(readFailure.app), {
    code: "LOGIN_ITEM_READ_FAILED",
    message: "Login startup settings are unavailable.",
  });

  for (const raw of [
    null,
    {},
    electronSettings({ status: privateData }),
  ]) {
    const harness = createFakeApp({ getResults: [raw] });
    assert.throws(
      () => readLoginStartupState(harness.app),
      (error) => {
        assert.equal(error.name, "LoginStartupError");
        assert.equal(error.code, "INVALID_LOGIN_STATUS");
        assert.equal(error.message, "Invalid login startup status.");
        assert.equal(error.message.includes(privateData), false);
        return true;
      },
    );
  }
});

test("wasOpenedAtLogin performs one exact read, normalizes, and never mutates", () => {
  for (const [rawValue, expected] of [[true, true], [false, false], ["true", false]]) {
    const harness = createFakeApp({
      getResults: [electronSettings({ wasOpenedAtLogin: rawValue })],
    });

    assert.equal(wasOpenedAtLogin(harness.app), expected);
    assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
    assert.deepEqual(harness.setCalls, []);
  }
});

test("status reads all four closed states without mutation and uses resolved exits", () => {
  const cases = [
    ["not-registered", false, true, 0],
    ["enabled", true, true, 0],
    ["requires-approval", false, false, 1],
    ["not-found", false, false, 1],
  ];

  for (const [status, openAtLogin, ok, exitCode] of cases) {
    const harness = createFakeApp({
      getResults: [electronSettings({ status, openAtLogin })],
    });

    const result = runLoginStartupAction("status", {
      app: harness.app,
      platform: "darwin",
    });

    assertExactResult(result, {
      kind: "login-startup",
      action: "status",
      status,
      openAtLogin,
      ok,
      exitCode,
    });
    assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
    assert.deepEqual(harness.setCalls, []);
  }
});

test("unsupported and development command modes fail before any Electron call", () => {
  for (const action of ["enable", "status", "disable"]) {
    for (const options of [
      { platform: "linux", isPackaged: true },
      { platform: "win32", isPackaged: true },
      { platform: "darwin", isPackaged: false },
    ]) {
      const harness = createFakeApp({ isPackaged: options.isPackaged });

      const result = runLoginStartupAction(action, {
        app: harness.app,
        platform: options.platform,
      });

      assertExactResult(result, {
        kind: "login-startup",
        action,
        status: null,
        openAtLogin: false,
        ok: false,
        exitCode: 1,
      });
      assert.deepEqual(harness.calls, []);
      assert.deepEqual(harness.getCalls, []);
      assert.deepEqual(harness.setCalls, []);
    }
  }
});

test("enable performs one exact mutation and succeeds only after its postcondition", () => {
  const harness = createFakeApp({
    getResults: [electronSettings({ status: "enabled", openAtLogin: true })],
  });

  const result = runLoginStartupAction("enable", {
    app: harness.app,
    platform: "darwin",
  });

  assertExactResult(result, {
    kind: "login-startup",
    action: "enable",
    status: "enabled",
    openAtLogin: true,
    ok: true,
    exitCode: 0,
  });
  assert.deepEqual(harness.setCalls, [{
    openAtLogin: true,
    type: "mainAppService",
  }]);
  assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
  assert.deepEqual(harness.calls, ["set", "get"]);
});

test("disable performs one exact mutation and succeeds only after its postcondition", () => {
  const harness = createFakeApp({
    getResults: [electronSettings({ status: "not-registered", openAtLogin: false })],
  });

  const result = runLoginStartupAction("disable", {
    app: harness.app,
    platform: "darwin",
  });

  assertExactResult(result, {
    kind: "login-startup",
    action: "disable",
    status: "not-registered",
    openAtLogin: false,
    ok: true,
    exitCode: 0,
  });
  assert.deepEqual(harness.setCalls, [{
    openAtLogin: false,
    type: "mainAppService",
  }]);
  assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
  assert.deepEqual(harness.calls, ["set", "get"]);
});

test("mutation postcondition mismatches preserve the observed state and fail", () => {
  const cases = [
    {
      action: "enable",
      observed: electronSettings({ status: "enabled", openAtLogin: false }),
      expectedStatus: "enabled",
      expectedOpenAtLogin: false,
      expectedSet: true,
    },
    {
      action: "enable",
      observed: electronSettings({ status: "requires-approval", openAtLogin: true }),
      expectedStatus: "requires-approval",
      expectedOpenAtLogin: true,
      expectedSet: true,
    },
    {
      action: "disable",
      observed: electronSettings({ status: "not-registered", openAtLogin: true }),
      expectedStatus: "not-registered",
      expectedOpenAtLogin: true,
      expectedSet: false,
    },
    {
      action: "disable",
      observed: electronSettings({ status: "not-found", openAtLogin: false }),
      expectedStatus: "not-found",
      expectedOpenAtLogin: false,
      expectedSet: false,
    },
  ];

  for (const item of cases) {
    const harness = createFakeApp({ getResults: [item.observed] });

    const result = runLoginStartupAction(item.action, {
      app: harness.app,
      platform: "darwin",
    });

    assertExactResult(result, {
      kind: "login-startup",
      action: item.action,
      status: item.expectedStatus,
      openAtLogin: item.expectedOpenAtLogin,
      ok: false,
      exitCode: 1,
    });
    assert.deepEqual(harness.setCalls, [{
      openAtLogin: item.expectedSet,
      type: "mainAppService",
    }]);
    assert.deepEqual(harness.getCalls, [LOGIN_ITEM_QUERY]);
    assert.deepEqual(harness.calls, ["set", "get"]);
  }
});

test("caught read, set, and invalid-state failures return one non-leaking result", () => {
  const privateData = "/private/error/path --argv=secret";
  const cases = [
    {
      action: "status",
      harness: createFakeApp({ getResults: [new Error(privateData)] }),
      expectedGets: 1,
      expectedSets: 0,
      expectedCalls: ["get"],
    },
    {
      action: "status",
      harness: createFakeApp({
        getResults: [electronSettings({ status: privateData })],
      }),
      expectedGets: 1,
      expectedSets: 0,
      expectedCalls: ["get"],
    },
    {
      action: "enable",
      harness: createFakeApp({
        setImpl: () => {
          throw new Error(privateData);
        },
      }),
      expectedGets: 0,
      expectedSets: 1,
      expectedCalls: ["set"],
    },
    {
      action: "disable",
      harness: createFakeApp({ getResults: [new Error(privateData)] }),
      expectedGets: 1,
      expectedSets: 1,
      expectedCalls: ["set", "get"],
    },
  ];

  for (const item of cases) {
    const result = runLoginStartupAction(item.action, {
      app: item.harness.app,
      platform: "darwin",
    });

    assertExactResult(result, {
      kind: "login-startup",
      action: item.action,
      status: null,
      openAtLogin: false,
      ok: false,
      exitCode: 1,
    });
    assert.equal(JSON.stringify(result).includes(privateData), false);
    assert.deepEqual(item.harness.calls, item.expectedCalls);
    assert.equal(item.harness.getCalls.length, item.expectedGets);
    assert.equal(item.harness.setCalls.length, item.expectedSets);
  }
});

test("run rejects an invalid direct action without reading or mutating settings", () => {
  const harness = createFakeApp();
  assertClosedError(
    () => runLoginStartupAction("/private/invalid/action", {
      app: harness.app,
      platform: "darwin",
    }),
    {
      code: "INVALID_LOGIN_STARTUP_ACTION",
      message: "Invalid login startup action.",
    },
  );
  assert.deepEqual(harness.getCalls, []);
  assert.deepEqual(harness.setCalls, []);
});
