"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  ERROR_TOKEN,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_PATH_BYTES,
  MAX_STDIN_BYTES,
  MAX_TOTAL_BYTES,
  findPrivateCharacterLeaks,
  parseTrackedFileList,
  runCli,
} = require("./check-private-character-leaks.cjs");

const projectRoot = path.join(__dirname, "..");
const scriptPath = path.join(__dirname, "check-private-character-leaks.cjs");
const privateHash = "ab".repeat(32);
const privateStyleId = 24_680;

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "private-fixture",
    displayName: "Private Fixture",
    avatar: {
      type: "image2d",
      file: "avatar.png",
      sha256: privateHash,
      accessibleLabel: "Private Fixture",
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
        styleId: privateStyleId,
        speedScale: 1,
        tempoDynamicsScale: 1,
        pitchScale: 0,
        volumeScale: 1,
      },
    },
    distributionAllowed: false,
    ...overrides,
  };
}

function temporaryExternalRoot(context) {
  const canonicalTemporaryRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(canonicalTemporaryRoot, "persona-private-manifest-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeManifest(context, manifest = validManifest()) {
  const manifestPath = path.join(temporaryExternalRoot(context), "character.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  return manifestPath;
}

function temporaryTrackedRoot(context) {
  const root = fs.mkdtempSync(path.join(projectRoot, ".private-leak-test-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repoRelative(filePath) {
  return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function trackedInput(paths) {
  return paths.length === 0 ? Buffer.alloc(0) : Buffer.from(`${paths.join("\0")}\0`);
}

function invokeCli(manifestPath, input = Buffer.alloc(0), argv = ["--manifest", manifestPath]) {
  return spawnSync(process.execPath, [scriptPath, ...argv], {
    cwd: projectRoot,
    encoding: "utf8",
    env: {},
    input,
    maxBuffer: 5 * 1024 * 1024,
  });
}

function assertClosedError(result) {
  assert.equal(result.status, 2);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${ERROR_TOKEN}\n`);
  assert.equal(result.stderr.toLowerCase().includes(privateHash), false);
  assert.equal(result.stderr.includes(String(privateStyleId)), false);
  assert.equal(result.stdout.toLowerCase().includes(privateHash), false);
  assert.equal(result.stdout.includes(String(privateStyleId)), false);
}

test("pure scan uses only the injected list/read boundary and returns sorted deduplicated paths", () => {
  const reads = [];
  let lists = 0;
  const findings = findPrivateCharacterLeaks({
    manifestBytes: Buffer.from(JSON.stringify(validManifest())),
    listFiles() {
      lists += 1;
      return ["z.txt", "clean.txt", "a.txt"];
    },
    readFile(name) {
      reads.push(name);
      if (name === "z.txt") return Buffer.from(`hash=${privateHash.toUpperCase()}`);
      if (name === "a.txt") return Buffer.from(`style=${privateStyleId}; private marker`);
      return Buffer.from(`124680 and ${privateStyleId}1 do not have digit boundaries`);
    },
  });

  assert.deepEqual(findings, ["a.txt", "z.txt"]);
  assert.equal(lists, 1);
  assert.deepEqual(reads, ["z.txt", "clean.txt", "a.txt"]);
  assert.equal(JSON.stringify(findings).includes(privateHash), false);
  assert.equal(JSON.stringify(findings).includes(String(privateStyleId)), false);
});

test("pure scan rejects a hash-bearing path before reading any candidate", () => {
  let reads = 0;
  assert.throws(
    () => findPrivateCharacterLeaks({
      manifestBytes: Buffer.from(JSON.stringify(validManifest())),
      listFiles: () => ["clean-first.txt", `image-${privateHash.toUpperCase()}.png`],
      readFile: () => {
        reads += 1;
        return Buffer.from("clean");
      },
    }),
    (error) => error.message === ERROR_TOKEN,
  );
  assert.equal(reads, 0);
});

test("pure scan applies decimal digit boundaries to style IDs in paths before reads", () => {
  const manifestBytes = Buffer.from(JSON.stringify(validManifest()));
  for (const name of [
    `style-${privateStyleId}.json`,
    `voice/${privateStyleId}/profile.json`,
  ]) {
    let reads = 0;
    assert.throws(
      () => findPrivateCharacterLeaks({
        manifestBytes,
        listFiles: () => ["clean-first.txt", name],
        readFile: () => {
          reads += 1;
          return Buffer.from("clean");
        },
      }),
      (error) => error.message === ERROR_TOKEN,
    );
    assert.equal(reads, 0);
  }

  const adjacentNames = [
    `style-1${privateStyleId}.json`,
    `style-${privateStyleId}1.json`,
  ];
  assert.deepEqual(findPrivateCharacterLeaks({
    manifestBytes,
    listFiles: () => adjacentNames,
    readFile: () => Buffer.from("clean"),
  }), []);
});

test("CLI exits 0 silently for an empty or clean tracked-file list", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const cleanPath = path.join(trackedRoot, "clean.txt");
  fs.writeFileSync(cleanPath, `124680 ${privateStyleId}1 clean`);

  for (const input of [Buffer.alloc(0), trackedInput([repoRelative(cleanPath)])]) {
    const result = invokeCli(manifestPath, input);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("CLI exits 1 with sorted path-only findings and never emits private content", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const hashPath = path.join(trackedRoot, "z-hash.txt");
  const stylePath = path.join(trackedRoot, "a-style.txt");
  fs.writeFileSync(hashPath, `surrounding secret ${privateHash.toUpperCase()} more secret`);
  fs.writeFileSync(stylePath, `surrounding secret (${privateStyleId}) more secret`);
  const names = [repoRelative(hashPath), repoRelative(stylePath)];

  const result = invokeCli(manifestPath, trackedInput(names));
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, `${[...names].sort().join("\n")}\n`);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(privateHash), false);
  assert.equal(result.stdout.includes(String(privateStyleId)), false);
  assert.equal(result.stdout.includes("surrounding secret"), false);
  assert.equal(result.stdout.includes(projectRoot), false);
});

test("CLI fails closed without printing a hash-bearing clean pathname", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const trackedPath = path.join(trackedRoot, `image-${privateHash.toUpperCase()}.png`);
  fs.writeFileSync(trackedPath, "clean");

  assertClosedError(invokeCli(manifestPath, trackedInput([repoRelative(trackedPath)])));
});

test("CLI never prints a style-bearing pathname when its content also matches", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const trackedPath = path.join(trackedRoot, `style-${privateStyleId}.txt`);
  fs.writeFileSync(trackedPath, `style=${privateStyleId}`);

  assertClosedError(invokeCli(manifestPath, trackedInput([repoRelative(trackedPath)])));
});

test("CLI accepts only --manifest followed by one absolute external path", (context) => {
  const manifestPath = writeManifest(context);
  const inRepoManifest = path.join(temporaryTrackedRoot(context), "character.json");
  fs.writeFileSync(inRepoManifest, JSON.stringify(validManifest()));

  for (const argv of [
    [],
    ["--manifest"],
    ["--manifest", "relative.json"],
    ["--manifest", manifestPath, "extra"],
    ["--other", manifestPath],
    ["--manifest", inRepoManifest],
  ]) {
    assertClosedError(invokeCli(manifestPath, Buffer.alloc(0), argv));
  }
});

test("CLI rejects an in-repository manifest reached through alternate path casing", (context) => {
  const inRepoManifest = path.join(temporaryTrackedRoot(context), "character.json");
  fs.writeFileSync(inRepoManifest, JSON.stringify(validManifest()));

  const projectName = path.basename(projectRoot);
  const alternateName = projectName.toUpperCase() === projectName
    ? projectName.toLowerCase()
    : projectName.toUpperCase();
  const aliasRoot = path.join(path.dirname(projectRoot), alternateName);
  const aliasManifest = path.join(aliasRoot, path.relative(projectRoot, inRepoManifest));
  const mapAlias = (candidatePath) => {
    const resolved = path.resolve(candidatePath);
    if (resolved === aliasRoot) return projectRoot;
    if (resolved.startsWith(`${aliasRoot}${path.sep}`)) {
      return path.join(projectRoot, resolved.slice(aliasRoot.length + 1));
    }
    return candidatePath;
  };

  const fsImpl = Object.create(fs);
  fsImpl.lstatSync = (candidatePath, ...args) => fs.lstatSync(mapAlias(candidatePath), ...args);
  fsImpl.openSync = (candidatePath, ...args) => fs.openSync(mapAlias(candidatePath), ...args);
  fsImpl.realpathSync = (candidatePath, ...args) => fs.realpathSync(mapAlias(candidatePath), ...args);

  assert.deepEqual(runCli(["--manifest", aliasManifest], {
    fsImpl,
    repoRoot: projectRoot,
    readStdinImpl: () => Buffer.alloc(0),
  }), {
    status: 2,
    stdout: "",
    stderr: `${ERROR_TOKEN}\n`,
  });
});

test("CLI rejects invalid, distributable, oversized, and symlinked manifests", (context) => {
  const externalRoot = temporaryExternalRoot(context);
  const malformedPath = path.join(externalRoot, "malformed.json");
  const distributablePath = path.join(externalRoot, "distributable.json");
  const extraFieldPath = path.join(externalRoot, "extra.json");
  const oversizedPath = path.join(externalRoot, "oversized.json");
  const validPath = path.join(externalRoot, "valid.json");
  const linkedPath = path.join(externalRoot, "linked.json");
  const linkedDirectoryRoot = path.join(externalRoot, "linked-directory");
  const directoryPath = path.join(externalRoot, "not-a-file");
  fs.writeFileSync(malformedPath, "{");
  fs.writeFileSync(distributablePath, JSON.stringify(validManifest({ distributionAllowed: true })));
  fs.writeFileSync(extraFieldPath, JSON.stringify(validManifest({ unexpected: true })));
  fs.writeFileSync(oversizedPath, Buffer.alloc((64 * 1024) + 1, 0x61));
  fs.writeFileSync(validPath, JSON.stringify(validManifest()));
  fs.symlinkSync(validPath, linkedPath, "file");
  fs.symlinkSync(path.dirname(validPath), linkedDirectoryRoot, "dir");
  fs.mkdirSync(directoryPath);

  for (const manifestPath of [
    malformedPath,
    distributablePath,
    extraFieldPath,
    oversizedPath,
    linkedPath,
    path.join(linkedDirectoryRoot, path.basename(validPath)),
    directoryPath,
  ]) {
    assertClosedError(invokeCli(manifestPath));
  }
});

test("tracked stdin requires unique trailing-NUL POSIX repo-relative paths", (context) => {
  const manifestPath = writeManifest(context);
  const invalidInputs = [
    Buffer.from("file.txt"),
    Buffer.from("\0"),
    Buffer.from("a.txt\0a.txt\0"),
    Buffer.from("/absolute.txt\0"),
    Buffer.from("back\\slash.txt\0"),
    Buffer.from("../escape.txt\0"),
    Buffer.from("dir/../escape.txt\0"),
    Buffer.from("dir/./file.txt\0"),
    Buffer.from("dir//file.txt\0"),
    Buffer.from("control\nname.txt\0"),
    Buffer.from([0xff, 0x00]),
  ];

  for (const input of invalidInputs) {
    assertClosedError(invokeCli(manifestPath, input));
  }
});

test("tracked path validation rejects bidi controls and Unicode line separators", () => {
  for (const codePoint of [
    0x061c,
    0x200e,
    0x200f,
    0x2028,
    0x2029,
    0x202a,
    0x202e,
    0x2066,
    0x2069,
  ]) {
    const unsafeName = `unsafe-${String.fromCodePoint(codePoint)}-name.txt`;
    assert.throws(
      () => parseTrackedFileList(trackedInput([unsafeName])),
      (error) => error.message === ERROR_TOKEN,
    );
  }
});

test("CLI rejects symlinked components, symlink files, and non-regular tracked entries", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const externalRoot = temporaryExternalRoot(context);
  const externalFile = path.join(externalRoot, "external.txt");
  fs.writeFileSync(externalFile, privateHash);

  const linkedFile = path.join(trackedRoot, "linked-file.txt");
  const linkedDirectory = path.join(trackedRoot, "linked-directory");
  const regularDirectory = path.join(trackedRoot, "regular-directory");
  fs.symlinkSync(externalFile, linkedFile, "file");
  fs.symlinkSync(externalRoot, linkedDirectory, "dir");
  fs.mkdirSync(regularDirectory);

  for (const name of [
    repoRelative(linkedFile),
    `${repoRelative(linkedDirectory)}/external.txt`,
    repoRelative(regularDirectory),
  ]) {
    assertClosedError(invokeCli(manifestPath, trackedInput([name])));
  }
});

test("CLI stable read rejects a manifest swapped to a symlink before open", (context) => {
  const manifestPath = writeManifest(context);
  const replacementPath = writeManifest(context);
  const fsImpl = Object.create(fs);
  let swapped = false;
  fsImpl.openSync = (candidatePath, ...args) => {
    if (!swapped && path.resolve(candidatePath) === path.resolve(manifestPath)) {
      swapped = true;
      fs.unlinkSync(manifestPath);
      fs.symlinkSync(replacementPath, manifestPath, "file");
    }
    return fs.openSync(candidatePath, ...args);
  };

  const result = runCli(["--manifest", manifestPath], {
    fsImpl,
    repoRoot: projectRoot,
    readStdinImpl: () => Buffer.alloc(0),
  });
  assert.equal(swapped, true);
  assert.deepEqual(result, {
    status: 2,
    stdout: "",
    stderr: `${ERROR_TOKEN}\n`,
  });
});

test("CLI stable read rejects a tracked file swapped to a symlink before open", (context) => {
  const manifestPath = writeManifest(context);
  const trackedRoot = temporaryTrackedRoot(context);
  const trackedPath = path.join(trackedRoot, "race.txt");
  const externalPath = path.join(temporaryExternalRoot(context), "private.txt");
  fs.writeFileSync(trackedPath, "clean");
  fs.writeFileSync(externalPath, privateHash);

  const fsImpl = Object.create(fs);
  let swapped = false;
  fsImpl.openSync = (candidatePath, ...args) => {
    if (!swapped && path.resolve(candidatePath) === path.resolve(trackedPath)) {
      swapped = true;
      fs.unlinkSync(trackedPath);
      fs.symlinkSync(externalPath, trackedPath, "file");
    }
    return fs.openSync(candidatePath, ...args);
  };

  const result = runCli(["--manifest", manifestPath], {
    fsImpl,
    repoRoot: projectRoot,
    readStdinImpl: () => trackedInput([repoRelative(trackedPath)]),
  });
  assert.equal(swapped, true);
  assert.deepEqual(result, {
    status: 2,
    stdout: "",
    stderr: `${ERROR_TOKEN}\n`,
  });
});

test("CLI fails closed when a stable descriptor cannot be closed cleanly", (context) => {
  const manifestPath = writeManifest(context);
  const trackedPath = path.join(temporaryTrackedRoot(context), "close.txt");
  fs.writeFileSync(trackedPath, "clean");

  const fsImpl = Object.create(fs);
  let closeCalls = 0;
  fsImpl.closeSync = (descriptor) => {
    closeCalls += 1;
    fs.closeSync(descriptor);
    if (closeCalls === 2) throw new Error("close failed");
  };

  const result = runCli(["--manifest", manifestPath], {
    fsImpl,
    repoRoot: projectRoot,
    readStdinImpl: () => trackedInput([repoRelative(trackedPath)]),
  });
  assert.equal(closeCalls, 2);
  assert.deepEqual(result, {
    status: 2,
    stdout: "",
    stderr: `${ERROR_TOKEN}\n`,
  });
});

test("stdin, path, file-count, per-file, and aggregate caps fail closed", () => {
  assert.throws(
    () => parseTrackedFileList(Buffer.alloc(MAX_STDIN_BYTES + 1, 0x61)),
    Error,
  );
  assert.throws(
    () => parseTrackedFileList(trackedInput(
      Array.from({ length: MAX_FILES + 1 }, (_, index) => `f${index}`),
    )),
    Error,
  );
  assert.throws(
    () => parseTrackedFileList(trackedInput(["a".repeat(MAX_PATH_BYTES + 1)])),
    Error,
  );

  const manifestBytes = Buffer.from(JSON.stringify(validManifest()));
  assert.throws(() => findPrivateCharacterLeaks({
    manifestBytes,
    listFiles: () => ["large.bin"],
    readFile: () => Buffer.alloc(MAX_FILE_BYTES + 1),
  }), Error);

  const exactFile = Buffer.alloc(MAX_FILE_BYTES);
  assert.deepEqual(findPrivateCharacterLeaks({
    manifestBytes,
    listFiles: () => ["exact.bin"],
    readFile: () => exactFile,
  }), []);

  const filesOverTotal = Array.from(
    { length: Math.floor(MAX_TOTAL_BYTES / MAX_FILE_BYTES) + 1 },
    (_, index) => `total-${index}.bin`,
  );
  assert.throws(() => findPrivateCharacterLeaks({
    manifestBytes,
    listFiles: () => filesOverTotal,
    readFile: () => exactFile,
  }), Error);
});
