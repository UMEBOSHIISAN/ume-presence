"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createRendererReadiness } = require("./renderer-readiness.cjs");

test("renderer requires both load completion and an explicit speech handshake", () => {
  const webContents = { id: 7, isLoading: () => false };
  const window = {
    isDestroyed: () => false,
    webContents,
  };
  const readiness = createRendererReadiness({ getWindow: () => window });

  assert.equal(readiness.getReadyWindow(), null);
  assert.equal(readiness.acknowledge({ id: 8 }), false);
  assert.equal(readiness.getReadyWindow(), null);
  assert.equal(readiness.acknowledge(webContents), true);
  assert.equal(readiness.getReadyWindow(), null);
  assert.equal(readiness.markLoaded(webContents), true);
  assert.equal(readiness.getReadyWindow(), window);

  readiness.reset();
  assert.equal(readiness.getReadyWindow(), null);
  assert.equal(readiness.markLoaded(webContents), true);
  assert.equal(readiness.getReadyWindow(), null);
  assert.equal(readiness.acknowledge(webContents), true);
  assert.equal(readiness.getReadyWindow(), window);
});
