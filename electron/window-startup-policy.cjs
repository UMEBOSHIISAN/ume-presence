"use strict";

const DEFAULT_RENDERER_STARTUP_TIMEOUT_MS = 10_000;

function createActivationRevealPolicy({ initiallyHidden, showOverlay } = {}) {
  if (typeof showOverlay !== "function") throw new TypeError("showOverlay is required.");
  const handleActivate = initiallyHidden
    ? () => {}
    : () => showOverlay({ focus: true });
  return Object.freeze({ handleActivate });
}

function waitForRenderer(
  window,
  {
    timeoutMs = DEFAULT_RENDERER_STARTUP_TIMEOUT_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  const webContents = window?.webContents;
  if (!webContents || typeof webContents.isLoading !== "function") {
    return Promise.reject(new Error("Persona renderer is unavailable."));
  }
  if (!webContents.isLoading()) return Promise.resolve(window);

  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      clearTimer(timer);
      webContents.removeListener("did-finish-load", onReady);
      webContents.removeListener("did-fail-load", onFailed);
      webContents.removeListener("render-process-gone", onFailed);
      window.removeListener("closed", onFailed);
    };
    const onReady = () => {
      cleanup();
      resolve(window);
    };
    const onFailed = () => {
      cleanup();
      reject(new Error("Persona renderer failed to load."));
    };
    const onTimeout = () => {
      cleanup();
      reject(new Error("Persona renderer startup timed out."));
    };
    webContents.once("did-finish-load", onReady);
    webContents.once("did-fail-load", onFailed);
    webContents.once("render-process-gone", onFailed);
    window.once("closed", onFailed);
    timer = setTimer(onTimeout, timeoutMs);
    timer?.unref?.();
  });
}

async function initializeAvatarWindow({
  initiallyHidden,
  createWindow,
  showOverlay,
  rendererWaitOptions,
} = {}) {
  if (typeof createWindow !== "function") throw new TypeError("createWindow is required.");
  if (typeof showOverlay !== "function") throw new TypeError("showOverlay is required.");

  const window = createWindow();
  let shown = false;
  const showForeground = () => {
    if (initiallyHidden || shown) return;
    shown = true;
    showOverlay({ focus: true });
  };
  if (!initiallyHidden) {
    if (window.webContents.isLoading()) {
      window.webContents.once("did-finish-load", showForeground);
    } else {
      showForeground();
    }
  }
  await waitForRenderer(window, rendererWaitOptions);
  showForeground();
  return window;
}

async function settleAvatarWindowStartup({ onError = () => {}, ...options } = {}) {
  try {
    return await initializeAvatarWindow(options);
  } catch (error) {
    onError(error);
    return null;
  }
}

module.exports = {
  DEFAULT_RENDERER_STARTUP_TIMEOUT_MS,
  createActivationRevealPolicy,
  initializeAvatarWindow,
  settleAvatarWindowStartup,
  waitForRenderer,
};
