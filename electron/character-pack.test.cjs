"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  CHARACTER_SCHEMA_VERSION,
  MAX_AVATAR_BYTES,
  loadCharacterPack,
  validateCharacterId,
  validateCharacterManifest,
} = require("./character-pack.cjs");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngBytes(width = 16, height = 16) {
  const bytes = Buffer.alloc(33);
  PNG_SIGNATURE.copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function writeUInt24LE(buffer, value, offset) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}

function webpBytes(kind, width = 16, height = 16) {
  let data;
  if (kind === "VP8 ") {
    data = Buffer.alloc(10);
    data[3] = 0x9d;
    data[4] = 0x01;
    data[5] = 0x2a;
    data.writeUInt16LE(width, 6);
    data.writeUInt16LE(height, 8);
  } else if (kind === "VP8L") {
    data = Buffer.alloc(5);
    data[0] = 0x2f;
    data.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  } else if (kind === "VP8X") {
    data = Buffer.alloc(10);
    writeUInt24LE(data, width - 1, 4);
    writeUInt24LE(data, height - 1, 7);
  } else {
    data = Buffer.alloc(10);
  }

  const paddedLength = data.length + (data.length % 2);
  const bytes = Buffer.alloc(20 + paddedLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write(kind, 12, "ascii");
  bytes.writeUInt32LE(data.length, 16);
  data.copy(bytes, 20);
  return bytes;
}

function avatarSha256(avatarBytes) {
  return nodeCrypto.createHash("sha256").update(avatarBytes).digest("hex");
}

function validManifest({
  id = "sample-character",
  avatarBytes = pngBytes(),
  avatarFile = "avatar.png",
} = {}) {
  return {
    schemaVersion: 1,
    id,
    displayName: "Sample Character",
    avatar: {
      type: "image2d",
      file: avatarFile,
      sha256: avatarSha256(avatarBytes),
      accessibleLabel: "Sample Character",
      backgroundMode: "transparent",
      mouth: {
        xPercent: 50,
        yPercent: 20,
        small: { widthPercent: 1.2, heightPercent: 0.3 },
        open: { widthPercent: 1.7, heightPercent: 0.7 },
      },
    },
    speech: {
      provider: "aivis",
      profile: {
        styleId: 123,
        speedScale: 1,
        tempoDynamicsScale: 1,
        pitchScale: 0,
        volumeScale: 1,
      },
    },
    distributionAllowed: false,
  };
}

function temporaryRoot(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "persona-character-pack-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePackDirectory(
  packDirectory,
  {
    avatarBytes = pngBytes(),
    avatarFile = "avatar.png",
    manifest = validManifest({
      id: path.basename(packDirectory),
      avatarBytes,
      avatarFile,
    }),
  } = {},
) {
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.writeFileSync(path.join(packDirectory, avatarFile), avatarBytes);
  fs.writeFileSync(
    path.join(packDirectory, "character.json"),
    `${JSON.stringify(manifest)}\n`,
  );
}

function writePack(
  context,
  {
    packId = "sample-character",
    avatarBytes = pngBytes(),
    avatarFile = "avatar.png",
    manifest = validManifest({ id: packId, avatarBytes, avatarFile }),
  } = {},
) {
  const root = temporaryRoot(context);
  const charactersRoot = path.join(root, "characters");
  const packDirectory = path.join(charactersRoot, packId);
  writePackDirectory(packDirectory, { avatarBytes, avatarFile, manifest });
  return { charactersRoot, packDirectory, root };
}

function swapBeforePathOpenOrRead(triggerPath, swap) {
  const fsImpl = Object.create(fs);
  const resolvedTrigger = path.resolve(triggerPath);
  let swapped = false;

  function swapOnce(candidatePath) {
    if (
      !swapped
      && typeof candidatePath === "string"
      && path.resolve(candidatePath) === resolvedTrigger
    ) {
      swapped = true;
      swap();
    }
  }

  fsImpl.openSync = (candidatePath, ...args) => {
    swapOnce(candidatePath);
    return fs.openSync(candidatePath, ...args);
  };
  fsImpl.readFileSync = (candidatePath, ...args) => {
    swapOnce(candidatePath);
    return fs.readFileSync(candidatePath, ...args);
  };
  return fsImpl;
}

function mutatedManifest(mutator) {
  const manifest = structuredClone(validManifest());
  mutator(manifest);
  return manifest;
}

test("loads a valid PNG pack as immutable closed data", (context) => {
  const avatarBytes = pngBytes(32, 24);
  const { packDirectory } = writePack(context, { avatarBytes });

  const pack = loadCharacterPack(packDirectory);

  assert.equal(CHARACTER_SCHEMA_VERSION, 1);
  assert.equal(pack.manifest.id, "sample-character");
  assert.equal(pack.avatarMimeType, "image/png");
  assert.deepEqual(pack.avatarBytes, avatarBytes);
  assert.deepEqual(Object.keys(pack).sort(), [
    "avatarBytes",
    "avatarMimeType",
    "manifest",
  ]);
  assert.equal(Object.isFrozen(pack), true);
  assert.equal(Object.isFrozen(pack.manifest), true);
  assert.equal(Object.isFrozen(pack.manifest.avatar.mouth.open), true);
  assert.equal(Object.isFrozen(pack.manifest.speech.profile), true);
  assert.equal(Object.hasOwn(pack, "packDirectory"), false);

  const firstRead = pack.avatarBytes;
  firstRead[0] ^= 0xff;
  assert.notEqual(firstRead, pack.avatarBytes);
  assert.deepEqual(pack.avatarBytes, avatarBytes);
});

test("accepts each supported WebP dimension header", (context) => {
  for (const kind of ["VP8 ", "VP8L", "VP8X"]) {
    const avatarBytes = webpBytes(kind, 20, 12);
    const { packDirectory } = writePack(context, {
      packId: `webp-${kind.trim().toLowerCase()}`,
      avatarBytes,
      avatarFile: "avatar.webp",
    });

    const pack = loadCharacterPack(packDirectory);
    assert.equal(pack.avatarMimeType, "image/webp");
    assert.deepEqual(pack.avatarBytes, avatarBytes);
  }
});

test("validates canonical character IDs", () => {
  for (const id of ["a", "0", "sample-character", "a".repeat(64)]) {
    assert.equal(validateCharacterId(id), id);
  }

  for (const id of [
    "",
    "/",
    "..",
    "bad/id",
    "UPPERCASE",
    "white space",
    " leading",
    "trailing ",
    "-leading",
    "trailing-",
    "a".repeat(65),
    null,
    123,
  ]) {
    assert.throws(
      () => validateCharacterId(id),
      Error,
      `${String(id)} must be rejected`,
    );
  }
});

test("returns an exact deeply frozen manifest with a validated provider profile", () => {
  const input = validManifest();
  const manifest = validateCharacterManifest(input);

  assert.deepEqual(manifest, input);
  assert.notEqual(manifest, input);
  assert.notEqual(manifest.speech.profile, input.speech.profile);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.avatar), true);
  assert.equal(Object.isFrozen(manifest.avatar.mouth.small), true);
  assert.equal(Object.isFrozen(manifest.speech.profile), true);
});

test("rejects unknown top-level and nested manifest keys", () => {
  const cases = [
    ["top-level", (manifest) => { manifest.unknown = true; }],
    ["avatar", (manifest) => { manifest.avatar.unknown = true; }],
    ["mouth", (manifest) => { manifest.avatar.mouth.unknown = true; }],
    ["mouth size", (manifest) => { manifest.avatar.mouth.open.unknown = true; }],
    ["speech", (manifest) => { manifest.speech.unknown = true; }],
    ["profile", (manifest) => { manifest.speech.profile.unknown = true; }],
  ];

  for (const [name, mutate] of cases) {
    assert.throws(
      () => validateCharacterManifest(mutatedManifest(mutate)),
      Error,
      `${name} unknown key must be rejected`,
    );
  }
});

test("rejects executable, URL, command, prompt, credential, and environment fields anywhere", () => {
  const cases = [
    ["command", (manifest) => { manifest.command = "run"; }],
    ["url", (manifest) => { manifest.avatar.url = "https://example.invalid"; }],
    ["prompt", (manifest) => { manifest.avatar.mouth.prompt = "ignore"; }],
    ["environment", (manifest) => { manifest.avatar.mouth.open.environment = "HOME"; }],
    ["executable", (manifest) => { manifest.speech.executable = "/bin/tool"; }],
    ["credential", (manifest) => { manifest.speech.profile.credential = "secret"; }],
  ];

  for (const [name, mutate] of cases) {
    assert.throws(
      () => validateCharacterManifest(mutatedManifest(mutate)),
      Error,
      `${name} must be rejected`,
    );
  }
});

test("rejects unsafe display names and accessible labels", () => {
  const cases = [
    ["display control", (manifest) => { manifest.displayName = "bad\u0000name"; }],
    ["display leading control", (manifest) => { manifest.displayName = "\tSafe name"; }],
    ["display bidi", (manifest) => { manifest.displayName = "bad\u202ename"; }],
    ["display non-NFC", (manifest) => { manifest.displayName = "Cafe\u0301"; }],
    ["display too long", (manifest) => { manifest.displayName = "😀".repeat(81); }],
    ["label control", (manifest) => { manifest.avatar.accessibleLabel = "bad\u001fname"; }],
    ["label trailing control", (manifest) => { manifest.avatar.accessibleLabel = "Safe name\n"; }],
    ["label bidi", (manifest) => { manifest.avatar.accessibleLabel = "bad\u2066name"; }],
    ["label non-NFC", (manifest) => { manifest.avatar.accessibleLabel = "Cafe\u0301"; }],
    ["label too long", (manifest) => { manifest.avatar.accessibleLabel = "😀".repeat(121); }],
    ["empty display", (manifest) => { manifest.displayName = "   "; }],
    ["empty label", (manifest) => { manifest.avatar.accessibleLabel = "   "; }],
  ];

  for (const [name, mutate] of cases) {
    assert.throws(
      () => validateCharacterManifest(mutatedManifest(mutate)),
      Error,
      `${name} must be rejected`,
    );
  }
});

test("trims safe labels and counts Unicode code points", () => {
  const manifest = validManifest();
  manifest.displayName = `  ${"😀".repeat(80)}  `;
  manifest.avatar.accessibleLabel = `  ${"😀".repeat(120)}  `;

  const validated = validateCharacterManifest(manifest);
  assert.equal(validated.displayName, "😀".repeat(80));
  assert.equal(validated.avatar.accessibleLabel, "😀".repeat(120));
});

test("rejects invalid avatar filenames", () => {
  for (const file of [
    "/tmp/avatar.png",
    "nested/avatar.png",
    "nested\\avatar.png",
    "https://example.invalid/avatar.png",
    "avatar.jpg",
    "avatar.PNG",
    ".avatar.png",
  ]) {
    assert.throws(
      () => validateCharacterManifest(mutatedManifest((manifest) => {
        manifest.avatar.file = file;
      })),
      Error,
      `${file} must be rejected`,
    );
  }
});

test("rejects a manifest ID different from its pack directory", (context) => {
  const avatarBytes = pngBytes();
  const manifest = validManifest({ id: "different-character", avatarBytes });
  const { packDirectory } = writePack(context, { manifest, avatarBytes });

  assert.throws(() => loadCharacterPack(packDirectory), /directory/i);
});

test("rejects symlinked pack directories and characters roots", (context) => {
  const root = temporaryRoot(context);
  const realCharacters = path.join(root, "real-characters");
  const realPack = path.join(realCharacters, "sample-character");
  const avatarBytes = pngBytes();
  fs.mkdirSync(realPack, { recursive: true });
  fs.writeFileSync(path.join(realPack, "avatar.png"), avatarBytes);
  fs.writeFileSync(
    path.join(realPack, "character.json"),
    JSON.stringify(validManifest({ avatarBytes })),
  );

  const linkedPack = path.join(root, "linked-pack");
  fs.symlinkSync(
    realPack,
    linkedPack,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(() => loadCharacterPack(linkedPack), /symlink|directory/i);

  const linkedCharacters = path.join(root, "characters");
  fs.symlinkSync(
    realCharacters,
    linkedCharacters,
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.throws(
    () => loadCharacterPack(path.join(linkedCharacters, "sample-character")),
    /symlink|root/i,
  );
});

test("rejects symlinked manifests and avatar files", (context) => {
  for (const target of ["character.json", "avatar.png"]) {
    const { packDirectory } = writePack(context);
    const originalPath = path.join(packDirectory, target);
    const realPath = path.join(packDirectory, `${target}.real`);
    fs.renameSync(originalPath, realPath);
    fs.symlinkSync(realPath, originalPath, "file");

    assert.throws(
      () => loadCharacterPack(packDirectory),
      /symlink|file/i,
      `${target} symlink must be rejected`,
    );
  }
});

test("rejects a manifest swapped to a symlink immediately before opening", (context) => {
  const { packDirectory } = writePack(context);
  const manifestPath = path.join(packDirectory, "character.json");
  const replacementPath = path.join(packDirectory, "replacement-character.json");
  const replacementManifest = validManifest();
  replacementManifest.displayName = "Swapped Character";
  fs.writeFileSync(replacementPath, JSON.stringify(replacementManifest));

  const fsImpl = swapBeforePathOpenOrRead(manifestPath, () => {
    fs.renameSync(manifestPath, path.join(packDirectory, "original-character.json"));
    fs.symlinkSync(replacementPath, manifestPath, "file");
  });

  assert.throws(
    () => loadCharacterPack(packDirectory, { fsImpl }),
    /changed|identity|symlink/i,
  );
});

test("rejects an avatar swapped to a symlink immediately before opening", (context) => {
  const originalAvatar = pngBytes(16, 16);
  const replacementAvatar = pngBytes(32, 24);
  const manifest = validManifest({ avatarBytes: replacementAvatar });
  const { packDirectory } = writePack(context, {
    avatarBytes: originalAvatar,
    manifest,
  });
  const avatarPath = path.join(packDirectory, "avatar.png");
  const replacementPath = path.join(packDirectory, "replacement-avatar.png");
  fs.writeFileSync(replacementPath, replacementAvatar);

  const fsImpl = swapBeforePathOpenOrRead(avatarPath, () => {
    fs.renameSync(avatarPath, path.join(packDirectory, "original-avatar.png"));
    fs.symlinkSync(replacementPath, avatarPath, "file");
  });

  assert.throws(
    () => loadCharacterPack(packDirectory, { fsImpl }),
    /changed|identity|symlink/i,
  );
});

test("rejects a pack directory replaced immediately before opening its manifest", (context) => {
  const { packDirectory, root } = writePack(context);
  const replacementPack = path.join(root, "replacement-pack");
  const replacementManifest = validManifest();
  replacementManifest.displayName = "Replacement Pack";
  writePackDirectory(replacementPack, { manifest: replacementManifest });

  const manifestPath = path.join(packDirectory, "character.json");
  const fsImpl = swapBeforePathOpenOrRead(manifestPath, () => {
    fs.renameSync(packDirectory, path.join(root, "original-pack"));
    fs.renameSync(replacementPack, packDirectory);
  });

  assert.throws(
    () => loadCharacterPack(packDirectory, { fsImpl }),
    /changed|identity/i,
  );
});

test("rejects a characters root replaced before opening the pack manifest", (context) => {
  const { charactersRoot, packDirectory, root } = writePack(context);
  const replacementRoot = path.join(root, "replacement-characters");
  const replacementManifest = validManifest();
  replacementManifest.displayName = "Replacement Root";
  writePackDirectory(path.join(replacementRoot, "sample-character"), {
    manifest: replacementManifest,
  });

  const manifestPath = path.join(packDirectory, "character.json");
  const fsImpl = swapBeforePathOpenOrRead(manifestPath, () => {
    fs.renameSync(charactersRoot, path.join(root, "original-characters"));
    fs.renameSync(replacementRoot, charactersRoot);
  });

  assert.throws(
    () => loadCharacterPack(packDirectory, { fsImpl }),
    /changed|identity/i,
  );
});

test("rejects oversized manifests before parsing", (context) => {
  const root = temporaryRoot(context);
  const packDirectory = path.join(root, "characters", "sample-character");
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(packDirectory, "character.json"),
    Buffer.alloc((64 * 1024) + 1, 0x20),
  );

  assert.throws(() => loadCharacterPack(packDirectory), /manifest|large/i);
});

test("rejects empty and oversized avatar files", (context) => {
  for (const avatarBytes of [Buffer.alloc(0), Buffer.alloc(MAX_AVATAR_BYTES + 1)]) {
    const { packDirectory } = writePack(context, { avatarBytes });
    assert.throws(
      () => loadCharacterPack(packDirectory),
      /avatar|empty|large/i,
    );
  }
});

test("rejects truncated, mismatched, and unsupported image headers", (context) => {
  const mismatchedWebp = webpBytes("VP8X");
  mismatchedWebp.write("NOPE", 8, "ascii");
  const unsupportedWebp = webpBytes("ANIM");
  const cases = [
    ["truncated PNG", PNG_SIGNATURE, "avatar.png"],
    ["mismatched PNG", Buffer.alloc(33), "avatar.png"],
    ["truncated WebP", webpBytes("VP8X").subarray(0, 25), "avatar.webp"],
    ["mismatched WebP", mismatchedWebp, "avatar.webp"],
    ["unsupported WebP", unsupportedWebp, "avatar.webp"],
    ["PNG extension with WebP", webpBytes("VP8X"), "avatar.png"],
    ["WebP extension with PNG", pngBytes(), "avatar.webp"],
  ];

  for (const [name, avatarBytes, avatarFile] of cases) {
    const { packDirectory } = writePack(context, {
      packId: `invalid-${name.toLowerCase().replaceAll(/[^a-z]+/g, "-").replace(/-$/, "")}`,
      avatarBytes,
      avatarFile,
    });
    assert.throws(
      () => loadCharacterPack(packDirectory),
      /image|png|webp|signature|header|format/i,
      `${name} must be rejected`,
    );
  }
});

test("rejects zero, overflowing, excessive, and over-pixel image dimensions", (context) => {
  const cases = [
    ["zero", pngBytes(0, 16)],
    ["dimension cap", pngBytes(8193, 1)],
    ["integer overflow", pngBytes(0xffffffff, 0xffffffff)],
    ["pixel cap", pngBytes(8192, 8192)],
  ];

  for (const [name, avatarBytes] of cases) {
    const { packDirectory } = writePack(context, {
      packId: `invalid-dimensions-${name.replaceAll(" ", "-")}`,
      avatarBytes,
    });
    assert.throws(
      () => loadCharacterPack(packDirectory),
      /dimension|pixel|image/i,
      `${name} must be rejected`,
    );
  }
});

test("rejects missing and mismatched avatar hashes", (context) => {
  const missingHash = validManifest();
  delete missingHash.avatar.sha256;
  const missingFixture = writePack(context, { manifest: missingHash });
  assert.throws(() => loadCharacterPack(missingFixture.packDirectory), /sha|hash|required/i);

  const mismatchedHash = validManifest();
  mismatchedHash.avatar.sha256 = "0".repeat(64);
  const mismatchFixture = writePack(context, { manifest: mismatchedHash });
  assert.throws(() => loadCharacterPack(mismatchFixture.packDirectory), /sha|hash|digest/i);
});

test("rejects non-finite, negative, and out-of-bounds mouth geometry", () => {
  const cases = [
    ["xPercent", -1],
    ["xPercent", 101],
    ["yPercent", Number.NaN],
    ["yPercent", Number.POSITIVE_INFINITY],
    ["small.widthPercent", 0],
    ["small.widthPercent", 25.1],
    ["small.heightPercent", -1],
    ["open.widthPercent", Number.NaN],
    ["open.heightPercent", Number.POSITIVE_INFINITY],
  ];

  for (const [field, value] of cases) {
    assert.throws(
      () => validateCharacterManifest(mutatedManifest((manifest) => {
        const parts = field.split(".");
        let target = manifest.avatar.mouth;
        while (parts.length > 1) target = target[parts.shift()];
        target[parts[0]] = value;
      })),
      Error,
      `${field}=${String(value)} must be rejected`,
    );
  }
});

test("rejects unsupported providers and invalid profiles before loading media", () => {
  assert.throws(
    () => validateCharacterManifest(mutatedManifest((manifest) => {
      manifest.speech.provider = "unsupported";
    })),
    /unsupported/i,
  );

  assert.throws(
    () => validateCharacterManifest(mutatedManifest((manifest) => {
      manifest.speech.profile.styleId = Number.MAX_SAFE_INTEGER + 1;
    })),
    Error,
  );

  assert.throws(
    () => validateCharacterManifest(mutatedManifest((manifest) => {
      manifest.speech.profile.speedScale = 2.01;
    })),
    Error,
  );
});
