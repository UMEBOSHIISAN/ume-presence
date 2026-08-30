"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

test("build and package commands run the bundle guard through one exact build", () => {
  const projectRoot = path.join(__dirname, "..");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const mainProcess = fs.readFileSync(
    path.join(projectRoot, "electron", "main.cjs"),
    "utf8",
  );

  assert.equal(packageJson.scripts.build, "node scripts/check-no-bundled-character.cjs && tsc -b && vite build");
  assert.equal(packageJson.scripts.demo, "npm run build && electron .");
  assert.equal(packageJson.scripts["dist:linux"], "npm run build && node scripts/build-linux.cjs");
  assert.equal(packageJson.scripts["dist:appimage"], "npm run build && electron-builder --linux AppImage --publish never");
  assert.equal(packageJson.scripts["dist:windows"], "npm run native:build && npm run native:test && npm run build && electron-builder --win nsis --publish never");
  assert.equal(packageJson.scripts["dist:mac"], "npm run native:build && npm run native:test && npm run build && electron-builder --mac dmg zip --publish never");
  for (const name of ["demo", "dist:linux", "dist:appimage", "dist:windows", "dist:mac"]) {
    assert.equal(packageJson.scripts[name].match(/npm run build/g)?.length, 1);
    assert.doesNotMatch(packageJson.scripts[name], /check-no-bundled-character/);
  }
  assert.doesNotMatch(mainProcess, /--demo|demoMode|startDemo/);
});

test("package contract contains no legacy checker or private media contract", () => {
  const projectRoot = path.join(__dirname, "..");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );
  const serializedPackage = JSON.stringify(packageJson);

  assert.equal(Object.hasOwn(packageJson.scripts, "character:check"), false);
  assert.doesNotMatch(serializedPackage, /check-local-character/);
  assert.doesNotMatch(serializedPackage, /public\/local-character\/[^" ]+/);
  assert.doesNotMatch(serializedPackage, /[a-f0-9]{64}/i);
  assert.equal(fs.existsSync(path.join(__dirname, "check-local-character.cjs")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "check-local-character.test.cjs")), false);
});

test("package preserves native resources and adds exactly two generic integrations", () => {
  const projectRoot = path.join(__dirname, "..");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
  );

  const integrationResources = [
    ...(packageJson.build.extraResources ?? []),
    ...(packageJson.build.mac.extraResources ?? []),
    ...(packageJson.build.win.extraResources ?? []),
  ].filter((resource) => resource.to.startsWith("integrations/"));
  assert.deepEqual(integrationResources, [
    {
      from: "scripts/persona-auto-speech-hook.cjs",
      to: "integrations/persona-auto-speech-hook.cjs",
    },
    {
      from: "scripts/persona-auto-speech-selection.cjs",
      to: "integrations/persona-auto-speech-selection.cjs",
    },
  ]);
  assert.deepEqual(packageJson.build.win.extraResources, [
    {
      from: "native/bin/win32/persona-audio-listener.exe",
      to: "native/win32/persona-audio-listener.exe",
    },
  ]);
  assert.deepEqual(packageJson.build.mac.extraResources, [
    {
      from: "native/bin/darwin/persona-audio-listener",
      to: "native/darwin/persona-audio-listener",
    },
  ]);
});
