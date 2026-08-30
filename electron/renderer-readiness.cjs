"use strict";

function createRendererReadiness({ getWindow } = {}) {
  if (typeof getWindow !== "function") throw new TypeError("getWindow is required.");
  let acknowledgedSenderId = null;
  let loadedSenderId = null;

  function reset() {
    acknowledgedSenderId = null;
    loadedSenderId = null;
  }

  function acknowledge(sender) {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed?.() ||
      !window.webContents ||
      sender !== window.webContents
    ) {
      return false;
    }
    acknowledgedSenderId = sender.id;
    return true;
  }

  function markLoaded(sender) {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed?.() ||
      !window.webContents ||
      sender !== window.webContents
    ) {
      return false;
    }
    loadedSenderId = sender.id;
    return true;
  }

  function getReadyWindow() {
    const window = getWindow();
    if (
      !window ||
      window.isDestroyed?.() ||
      !window.webContents ||
      window.webContents.isLoading?.() ||
      window.webContents.id !== acknowledgedSenderId ||
      window.webContents.id !== loadedSenderId
    ) {
      return null;
    }
    return window;
  }

  return { acknowledge, getReadyWindow, markLoaded, reset };
}

module.exports = { createRendererReadiness };
