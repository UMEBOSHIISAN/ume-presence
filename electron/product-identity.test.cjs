"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.join(__dirname, "..");

test("UME Presence is visible while Persona compatibility identifiers remain stable", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const indexHtml = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const macListener = fs.readFileSync(
    path.join(ROOT, "native", "macos", "PersonaAudioListener.mm"),
    "utf8",
  );

  assert.equal(packageJson.name, "ume-persona");
  assert.deepEqual(packageJson.author, { name: "UMEBOSHIISAN" });
  assert.equal(packageJson.build.appId, "io.github.umeboshiisan.persona");
  assert.equal(packageJson.build.productName, "UME Presence");
  assert.equal(packageJson.build.protocols[0].name, "UME Presence");
  assert.deepEqual(packageJson.build.protocols[0].schemes, ["persona"]);
  assert.equal(packageJson.build.linux.executableName, "ume-persona");
  assert.match(packageJson.build.linux.artifactName, /^UME-Presence-/);
  assert.match(packageJson.build.win.artifactName, /^UME-Presence-/);
  assert.match(packageJson.build.mac.artifactName, /^UME-Presence-/);
  assert.equal(
    Object.hasOwn(packageJson.build.mac, "executableName"),
    false,
    "electron-builder must derive the UME Presence.app bundle name from productName",
  );
  assert.equal(packageJson.build.mac.extendInfo.CFBundleName, "Persona");
  assert.equal(packageJson.build.mac.extendInfo.CFBundleDisplayName, "UME Presence");
  assert.match(indexHtml, /<title>UME Presence<\/title>/);
  assert.match(macListener, /io\.github\.umeboshiisan\.persona\.%@/);
});
