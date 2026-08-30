"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");
const { loadCharacterPack } = require("./character-pack.cjs");
const { toRendererCharacter } = require("./character-renderer-payload.cjs");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function pngBytes() {
  const bytes = Buffer.alloc(33);
  PNG_SIGNATURE.copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(16, 16);
  bytes.writeUInt32BE(16, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function webpBytes() {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes[24] = 15;
  bytes[27] = 15;
  return bytes;
}

function writeLoadedPack({ avatarBytes, extension }) {
  const charactersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "persona-renderer-payload-"),
  );
  temporaryDirectories.push(charactersRoot);
  const packDirectory = path.join(charactersRoot, "sample-character");
  fs.mkdirSync(packDirectory);
  const avatarFile = `private-portrait.${extension}`;
  const avatarSha256 = nodeCrypto
    .createHash("sha256")
    .update(avatarBytes)
    .digest("hex");
  const manifest = {
    schemaVersion: 1,
    id: "sample-character",
    displayName: "Second Character",
    avatar: {
      type: "image2d",
      file: avatarFile,
      sha256: avatarSha256,
      accessibleLabel: "Second Character portrait",
      backgroundMode: "transparent",
      mouth: {
        xPercent: 42,
        yPercent: 19,
        small: { widthPercent: 1.2, heightPercent: 0.3 },
        open: { widthPercent: 1.9, heightPercent: 0.8 },
      },
    },
    speech: {
      provider: "aivis",
      profile: {
        styleId: 987654,
        speedScale: 1,
        tempoDynamicsScale: 1,
        pitchScale: 0,
        volumeScale: 1,
      },
    },
    distributionAllowed: false,
  };
  fs.writeFileSync(
    path.join(packDirectory, "character.json"),
    JSON.stringify(manifest),
  );
  fs.writeFileSync(path.join(packDirectory, avatarFile), avatarBytes);
  return {
    avatarBytes,
    avatarFile,
    avatarSha256,
    loadedPack: loadCharacterPack(packDirectory),
    packDirectory,
  };
}

test("projects a validated pack into an exact path-free renderer payload", () => {
  const fixture = writeLoadedPack({ avatarBytes: pngBytes(), extension: "png" });

  const payload = toRendererCharacter(fixture.loadedPack);
  const serialized = JSON.stringify(payload);

  assert.equal(payload.id, "sample-character");
  assert.equal(payload.displayName, "Second Character");
  assert.deepEqual(Object.keys(payload).sort(), ["avatar", "displayName", "id"]);
  assert.deepEqual(Object.keys(payload.avatar).sort(), [
    "accessibleLabel",
    "backgroundMode",
    "mouth",
    "source",
    "type",
  ]);
  assert.deepEqual(Object.keys(payload.avatar.mouth).sort(), [
    "open",
    "small",
    "xPercent",
    "yPercent",
  ]);
  assert.deepEqual(Object.keys(payload.avatar.mouth.small).sort(), [
    "heightPercent",
    "widthPercent",
  ]);
  assert.equal(serialized.includes(fixture.packDirectory), false);
  assert.equal(serialized.includes(fixture.avatarFile), false);
  assert.equal(serialized.includes(fixture.avatarSha256), false);
  assert.equal(serialized.includes("aivis"), false);
  assert.equal(serialized.includes("987654"), false);
  assert.equal(serialized.includes("speech"), false);
  assert.equal(serialized.includes("profile"), false);
  assert.equal(serialized.includes("manifest"), false);
  assert.equal(serialized.includes("distributionAllowed"), false);
});

test("encodes validated PNG and WebP bytes with their exact MIME type", () => {
  for (const fixture of [
    { avatarBytes: pngBytes(), extension: "png", mimeType: "image/png" },
    { avatarBytes: webpBytes(), extension: "webp", mimeType: "image/webp" },
  ]) {
    const loaded = writeLoadedPack(fixture);
    const payload = toRendererCharacter(loaded.loadedPack);

    assert.equal(
      payload.avatar.source,
      `data:${fixture.mimeType};base64,${fixture.avatarBytes.toString("base64")}`,
    );
  }
});

test("freezes the main-process payload without rewriting its source or pack bytes", () => {
  const fixture = writeLoadedPack({ avatarBytes: pngBytes(), extension: "png" });
  const packBytesBefore = fixture.loadedPack.avatarBytes;
  const payload = toRendererCharacter(fixture.loadedPack);
  const sourceBefore = payload.avatar.source;

  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.avatar), true);
  assert.equal(Object.isFrozen(payload.avatar.mouth), true);
  assert.equal(Object.isFrozen(payload.avatar.mouth.small), true);
  assert.throws(() => {
    payload.avatar.source = "data:image/png;base64,rewritten";
  }, TypeError);
  assert.throws(() => {
    payload.avatar.mouth.small.widthPercent = 25;
  }, TypeError);
  assert.equal(payload.avatar.source, sourceBefore);
  assert.deepEqual(fixture.loadedPack.avatarBytes, packBytesBefore);
});
