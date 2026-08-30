"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ERROR_TOKEN,
  canonicalizeAsarEntries,
  createPackageManifest,
  inspectMacApp,
  validatePackageInventory,
} = require("./inspect-macos-package.cjs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const asar = require("@electron/asar");

const validInventory = Object.freeze({
  asarEntries: Object.freeze([
    "/LICENSE",
    "/NOTICE",
    "/dist/index.html",
    "/package.json",
  ]),
  resourceEntries: Object.freeze([
    "app.asar",
    "integrations/persona-auto-speech-hook.cjs",
    "integrations/persona-auto-speech-selection.cjs",
    "native/darwin/persona-audio-listener",
  ]),
});

const hashes = Object.freeze({
  "app.asar": "a".repeat(64),
  "integrations/persona-auto-speech-hook.cjs": "b".repeat(64),
  "integrations/persona-auto-speech-selection.cjs": "c".repeat(64),
  "native/darwin/persona-audio-listener": "d".repeat(64),
});

function assertClosedFailure(inventory, suppliedPrivatePath = "") {
  assert.throws(
    () => validatePackageInventory(inventory),
    (error) => {
      assert.equal(error.message, ERROR_TOKEN);
      if (suppliedPrivatePath) {
        assert.equal(error.message.includes(suppliedPrivatePath), false);
      }
      return true;
    },
  );
}

test("accepts the closed UME Presence package inventory", () => {
  const windowsEntries = validInventory.asarEntries.map(
    (entry) => entry.replaceAll("/", "\\"),
  );
  const summary = validatePackageInventory(validInventory);

  assert.deepEqual(canonicalizeAsarEntries(windowsEntries, "\\"), validInventory.asarEntries);
  assert.deepEqual(canonicalizeAsarEntries(validInventory.asarEntries, "/"), validInventory.asarEntries);
  assert.deepEqual(summary, {
    product: "UME Presence",
    asarEntryCount: 4,
    resourceEntryCount: 4,
  });
  assert.equal(Object.isFrozen(summary), true);
});

test("rejects VRM and VRMA package entries without disclosing their paths", () => {
  for (const privatePath of [
    "/dist/assets/private-model.vrm",
    "/dist/assets/private-motion.vrma",
  ]) {
    assertClosedFailure({
      ...validInventory,
      asarEntries: [...validInventory.asarEntries, privatePath],
    }, privatePath);
  }
});

test("rejects private character media, local-character content, and character manifests", () => {
  for (const privatePath of [
    "/dist/private-character/avatar.png",
    "/dist/private-character/model.aivm",
    "/public/local-character/avatar.webp",
    "/characters/private-character/character.json",
  ]) {
    assertClosedFailure({
      ...validInventory,
      asarEntries: [...validInventory.asarEntries, privatePath],
    }, privatePath);
  }
  assertClosedFailure({
    ...validInventory,
    resourceEntries: [...validInventory.resourceEntries, "private-pack/avatar.png"],
  }, "private-pack/avatar.png");
});

test("rejects character media at ordinary package paths", () => {
  assertClosedFailure({
    ...validInventory,
    asarEntries: [...validInventory.asarEntries, "/dist/assets/character-avatar.png"],
  }, "/dist/assets/character-avatar.png");
  assertClosedFailure({
    ...validInventory,
    resourceEntries: [...validInventory.resourceEntries, "presentation.png"],
  }, "presentation.png");
});

test("allows only the packaged core application icon", () => {
  const summary = validatePackageInventory({
    ...validInventory,
    asarEntries: [...validInventory.asarEntries, "/build/icon.png"],
  });

  assert.equal(summary.asarEntryCount, validInventory.asarEntries.length + 1);
});

test("requires every provenance, integration, and native package entry", () => {
  for (const requiredEntry of validInventory.asarEntries) {
    assertClosedFailure({
      ...validInventory,
      asarEntries: validInventory.asarEntries.filter((entry) => entry !== requiredEntry),
    });
  }
  for (const requiredEntry of validInventory.resourceEntries) {
    assertClosedFailure({
      ...validInventory,
      resourceEntries: validInventory.resourceEntries.filter(
        (entry) => entry !== requiredEntry,
      ),
    });
  }
});

test("serializes only relative inventory and exact lowercase critical hashes", () => {
  const absoluteAppPath = "/Users/private/release/UME Presence.app";
  const manifest = createPackageManifest({
    ...validInventory,
    hashes,
    appPath: absoluteAppPath,
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

  assert.equal(manifest.schemaVersion, "ume-persona-package-manifest.v1");
  assert.equal(manifest.product, "UME Presence");
  assert.equal(manifest.application, "UME Presence.app");
  assert.deepEqual(manifest.sha256, hashes);
  assert.deepEqual(manifest.asarEntries, [...validInventory.asarEntries].sort());
  assert.deepEqual(
    manifest.resourceEntries,
    [...validInventory.resourceEntries].sort(),
  );
  assert.equal(serialized.includes(absoluteAppPath), false);
  assert.equal(Object.isFrozen(manifest), true);
});

test("inspects a packaged app and atomically writes a relative manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ume-persona-inspector-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appPath = path.join(root, "UME Presence.app");
  const resourcesPath = path.join(appPath, "Contents", "Resources");
  const sourcePath = path.join(root, "asar-source");
  const outputPath = path.join(root, "package-manifest.json");
  fs.mkdirSync(path.join(sourcePath, "dist"), { recursive: true });
  fs.writeFileSync(path.join(sourcePath, "LICENSE"), "license\n");
  fs.writeFileSync(path.join(sourcePath, "NOTICE"), "notice\n");
  fs.writeFileSync(path.join(sourcePath, "package.json"), "{}\n");
  fs.writeFileSync(path.join(sourcePath, "dist", "index.html"), "<main></main>\n");
  fs.mkdirSync(path.join(resourcesPath, "integrations"), { recursive: true });
  fs.mkdirSync(path.join(resourcesPath, "native", "darwin"), { recursive: true });
  fs.writeFileSync(
    path.join(resourcesPath, "integrations", "persona-auto-speech-hook.cjs"),
    "hook\n",
  );
  fs.writeFileSync(
    path.join(resourcesPath, "integrations", "persona-auto-speech-selection.cjs"),
    "selection\n",
  );
  fs.writeFileSync(
    path.join(resourcesPath, "native", "darwin", "persona-audio-listener"),
    "listener\n",
  );
  await asar.createPackage(sourcePath, path.join(resourcesPath, "app.asar"));

  const manifest = await inspectMacApp({ appPath, outputPath });
  const written = JSON.parse(fs.readFileSync(outputPath, "utf8"));

  assert.deepEqual(written, manifest);
  assert.equal(written.application, "UME Presence.app");
  assert.equal(written.resourceEntries.includes("app.asar"), true);
  assert.equal(JSON.stringify(written).includes(root), false);
  assert.deepEqual(Object.keys(written.sha256).sort(), Object.keys(hashes).sort());
});
