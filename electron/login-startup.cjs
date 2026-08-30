"use strict";

const LOGIN_ITEM_TYPE = "mainAppService";
const LOGIN_STARTUP_PREFIX = "--login-startup=";
const VALID_ACTIONS = new Set(["enable", "status", "disable"]);
const VALID_STATUSES = new Set([
  "not-registered",
  "enabled",
  "requires-approval",
  "not-found",
]);

class LoginStartupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LoginStartupError";
    this.code = code;
  }
}

function invalidActionError() {
  return new LoginStartupError(
    "INVALID_LOGIN_STARTUP_ACTION",
    "Invalid login startup action.",
  );
}

function parseLoginStartupAction(argv) {
  if (!Array.isArray(argv)) throw invalidActionError();

  const actions = [];
  for (const argument of argv) {
    if (typeof argument !== "string" || !argument.startsWith("--login-startup")) {
      continue;
    }
    if (!argument.startsWith(LOGIN_STARTUP_PREFIX)) throw invalidActionError();

    const action = argument.slice(LOGIN_STARTUP_PREFIX.length);
    if (!VALID_ACTIONS.has(action)) throw invalidActionError();
    actions.push(action);
  }

  if (actions.length > 1) {
    throw new LoginStartupError(
      "LOGIN_STARTUP_ACTION_COUNT",
      "Login startup requires exactly one action.",
    );
  }
  return actions[0] ?? null;
}

function readLoginStartupState(appApi) {
  let raw;
  try {
    raw = appApi.getLoginItemSettings({ type: LOGIN_ITEM_TYPE });
  } catch {
    throw new LoginStartupError(
      "LOGIN_ITEM_READ_FAILED",
      "Login startup settings are unavailable.",
    );
  }

  let status;
  let openAtLogin;
  let openedAtLogin;
  try {
    status = raw?.status;
    openAtLogin = raw?.openAtLogin;
    openedAtLogin = raw?.wasOpenedAtLogin;
  } catch {
    throw new LoginStartupError(
      "INVALID_LOGIN_STATUS",
      "Invalid login startup status.",
    );
  }
  if (!VALID_STATUSES.has(status)) {
    throw new LoginStartupError(
      "INVALID_LOGIN_STATUS",
      "Invalid login startup status.",
    );
  }

  return Object.freeze({
    status,
    openAtLogin: openAtLogin === true,
    wasOpenedAtLogin: openedAtLogin === true,
  });
}

function wasOpenedAtLogin(appApi) {
  return readLoginStartupState(appApi).wasOpenedAtLogin;
}

function commandResult(
  action,
  {
    status = null,
    openAtLogin = false,
    ok = false,
  } = {},
) {
  return Object.freeze({
    kind: "login-startup",
    action,
    status,
    openAtLogin,
    ok,
    exitCode: ok ? 0 : 1,
  });
}

function runLoginStartupAction(
  action,
  {
    app,
    platform = process.platform,
  } = {},
) {
  if (!VALID_ACTIONS.has(action)) throw invalidActionError();
  if (platform !== "darwin") return commandResult(action);

  try {
    if (app?.isPackaged !== true) return commandResult(action);
  } catch {
    return commandResult(action);
  }

  if (action !== "status") {
    try {
      app.setLoginItemSettings({
        openAtLogin: action === "enable",
        type: LOGIN_ITEM_TYPE,
      });
    } catch {
      return commandResult(action);
    }
  }

  let state;
  try {
    state = readLoginStartupState(app);
  } catch {
    return commandResult(action);
  }

  let ok;
  if (action === "status") {
    ok = state.status === "enabled" || state.status === "not-registered";
  } else if (action === "enable") {
    ok = state.status === "enabled" && state.openAtLogin;
  } else {
    ok = state.status === "not-registered" && !state.openAtLogin;
  }

  return commandResult(action, {
    status: state.status,
    openAtLogin: state.openAtLogin,
    ok,
  });
}

module.exports = {
  parseLoginStartupAction,
  readLoginStartupState,
  runLoginStartupAction,
  wasOpenedAtLogin,
};
