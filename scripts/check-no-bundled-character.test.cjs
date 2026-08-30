"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  MAX_BUNDLED_ENTRIES,
  assertNoBundledCharacter,
  findBundledCharacterFiles,
  main,
} = require("./check-no-bundled-character.cjs");

function temporaryRoot(context) {
  const temporaryBase = process.platform === "win32"
    ? os.tmpdir()
    : fs.realpathSync("/tmp");
  const root = fs.mkdtempSync(path.join(temporaryBase, "persona-bundle-guard-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("missing and empty public/local-character directories pass", (context) => {
  const publicRoot = temporaryRoot(context);

  assert.deepEqual(findBundledCharacterFiles(publicRoot), []);
  assert.equal(assertNoBundledCharacter(publicRoot), undefined);

  fs.mkdirSync(path.join(publicRoot, "local-character"));
  assert.deepEqual(findBundledCharacterFiles(publicRoot), []);
  assert.equal(assertNoBundledCharacter(publicRoot), undefined);
});

test("immediate entries are reported once as sorted public-relative paths without following", (context) => {
  const publicRoot = temporaryRoot(context);
  const localRoot = path.join(publicRoot, "local-character");
  const outsideRoot = temporaryRoot(context);
  fs.mkdirSync(path.join(localRoot, "nested"), { recursive: true });
  fs.writeFileSync(path.join(localRoot, "z.png"), "z");
  fs.writeFileSync(path.join(localRoot, "nested", "a.png"), "a");
  fs.writeFileSync(path.join(outsideRoot, "must-not-be-walked.png"), "private");
  fs.symlinkSync(outsideRoot, path.join(localRoot, "linked-directory"), "dir");

  const findings = findBundledCharacterFiles(publicRoot);
  assert.deepEqual(findings, [
    "local-character/linked-directory",
    "local-character/nested",
    "local-character/z.png",
  ]);
  assert.equal(findings.some((name) => name.includes("must-not-be-walked")), false);

  assert.throws(
    () => assertNoBundledCharacter(publicRoot),
    (error) => {
      assert.match(error.message, /local-character\/linked-directory/);
      assert.match(error.message, /local-character\/nested/);
      assert.equal(error.message.includes(publicRoot), false);
      assert.ok(Buffer.byteLength(error.message, "utf8") <= 2_048);
      return true;
    },
  );
});

test("a symlinked public root or ancestor fails closed", (context) => {
  const targetBase = temporaryRoot(context);
  const publicRoot = path.join(targetBase, "public");
  fs.mkdirSync(path.join(publicRoot, "local-character"), { recursive: true });

  const directAliasBase = temporaryRoot(context);
  const directAlias = path.join(directAliasBase, "public-link");
  fs.symlinkSync(publicRoot, directAlias, "dir");

  const ancestorAliasBase = temporaryRoot(context);
  const ancestorAlias = path.join(ancestorAliasBase, "base-link");
  fs.symlinkSync(targetBase, ancestorAlias, "dir");

  for (const candidate of [directAlias, path.join(ancestorAlias, "public")]) {
    assert.throws(
      () => findBundledCharacterFiles(candidate),
      (error) => error.message === "Unable to verify bundled character exclusion.",
    );
  }
});

test("a child directory cannot hide content through a transient symlink swap", (context) => {
  const publicRoot = temporaryRoot(context);
  const localRoot = path.join(publicRoot, "local-character");
  const nestedRoot = path.join(localRoot, "nested");
  const heldRoot = path.join(localRoot, "nested-held");
  const emptyRoot = temporaryRoot(context);
  fs.mkdirSync(nestedRoot, { recursive: true });
  fs.writeFileSync(path.join(nestedRoot, "private.png"), "private");

  let childOpenAttempted = false;
  const swapDuring = (operation) => {
    childOpenAttempted = true;
    fs.renameSync(nestedRoot, heldRoot);
    fs.symlinkSync(emptyRoot, nestedRoot, "dir");
    try {
      return operation();
    } finally {
      fs.unlinkSync(nestedRoot);
      fs.renameSync(heldRoot, nestedRoot);
    }
  };

  const fsImpl = Object.create(fs);
  fsImpl.readdirSync = (candidatePath, ...args) => {
    if (path.resolve(candidatePath) === path.resolve(nestedRoot)) {
      return swapDuring(() => fs.readdirSync(candidatePath, ...args));
    }
    return fs.readdirSync(candidatePath, ...args);
  };
  fsImpl.opendirSync = (candidatePath, ...args) => {
    if (path.resolve(candidatePath) === path.resolve(nestedRoot)) {
      return swapDuring(() => fs.opendirSync(candidatePath, ...args));
    }
    return fs.opendirSync(candidatePath, ...args);
  };

  assert.deepEqual(
    findBundledCharacterFiles(publicRoot, { fsImpl }),
    ["local-character/nested"],
  );
  assert.equal(childOpenAttempted, false);
});

test("a file or symlink in place of local-character fails closed without traversal", (context) => {
  const fileRoot = temporaryRoot(context);
  fs.writeFileSync(path.join(fileRoot, "local-character"), "not a directory");
  assert.deepEqual(findBundledCharacterFiles(fileRoot), ["local-character"]);

  const linkRoot = temporaryRoot(context);
  const outsideRoot = temporaryRoot(context);
  fs.writeFileSync(path.join(outsideRoot, "hidden.png"), "private");
  fs.symlinkSync(outsideRoot, path.join(linkRoot, "local-character"), "dir");
  assert.deepEqual(findBundledCharacterFiles(linkRoot), ["local-character"]);
});

test("special entries are rejected as relative findings", async (context) => {
  if (process.platform === "win32") {
    context.skip("Unix socket fixture is not available on Windows.");
    return;
  }

  const publicRoot = temporaryRoot(context);
  const localRoot = path.join(publicRoot, "local-character");
  const socketPath = path.join(localRoot, "character.sock");
  fs.mkdirSync(localRoot);
  const server = net.createServer();
  context.after(() => server.close());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  assert.deepEqual(
    findBundledCharacterFiles(publicRoot),
    ["local-character/character.sock"],
  );
});

test("filesystem errors and entry-cap overflow fail closed without absolute paths", (context) => {
  const denied = new Error("private absolute detail");
  denied.code = "EACCES";
  assert.throws(
    () => findBundledCharacterFiles("/must/not/appear", {
      fsImpl: { lstatSync() { throw denied; } },
    }),
    (error) => error.message === "Unable to verify bundled character exclusion.",
  );

  const publicRoot = temporaryRoot(context);
  const localRoot = path.join(publicRoot, "local-character");
  fs.mkdirSync(localRoot);
  for (let index = 0; index <= MAX_BUNDLED_ENTRIES; index += 1) {
    fs.writeFileSync(path.join(localRoot, `${String(index).padStart(4, "0")}.png`), "x");
  }
  assert.throws(
    () => findBundledCharacterFiles(publicRoot),
    (error) => {
      assert.equal(error.message, "Unable to verify bundled character exclusion.");
      assert.equal(error.message.includes(publicRoot), false);
      return true;
    },
  );
});

test("entry-cap overflow stops the directory stream at 257 and closes it", (context) => {
  const publicRoot = temporaryRoot(context);
  const localRoot = path.join(publicRoot, "local-character");
  fs.mkdirSync(localRoot);

  let readCalls = 0;
  let closeCalls = 0;
  const entries = Array.from(
    { length: MAX_BUNDLED_ENTRIES + 2 },
    (_, index) => ({ name: `${String(index).padStart(4, "0")}.png` }),
  );
  const directory = {
    readSync() {
      readCalls += 1;
      if (readCalls > MAX_BUNDLED_ENTRIES + 1) {
        throw new Error("read past the bounded entry");
      }
      return entries[readCalls - 1];
    },
    closeSync() {
      closeCalls += 1;
    },
  };

  const fsImpl = Object.create(fs);
  fsImpl.readdirSync = () => {
    throw new Error("materialized the directory");
  };
  fsImpl.opendirSync = () => directory;

  assert.throws(
    () => findBundledCharacterFiles(publicRoot, { fsImpl }),
    (error) => error.message === "Unable to verify bundled character exclusion.",
  );
  assert.equal(readCalls, MAX_BUNDLED_ENTRIES + 1);
  assert.equal(closeCalls, 1);
});

test("CLI main returns closed statuses and emits only bounded generic tokens", () => {
  const cases = [
    { scan: () => [], expectedStatus: 0, expectedError: "" },
    {
      scan: () => ["local-character/private-entry.png"],
      expectedStatus: 1,
      expectedError: "BUNDLED_CHARACTER_FOUND\n",
    },
    {
      scan: () => { throw new Error("/private/absolute/path.png"); },
      expectedStatus: 2,
      expectedError: "BUNDLED_CHARACTER_CHECK_FAILED\n",
    },
  ];

  for (const fixture of cases) {
    let output = "";
    const status = main([], {
      scan: fixture.scan,
      stderr: { write(chunk) { output += chunk; } },
    });
    assert.equal(status, fixture.expectedStatus);
    assert.equal(output, fixture.expectedError);
    assert.doesNotMatch(output, /private-entry|absolute|\.png/);
    assert.ok(Buffer.byteLength(output, "utf8") <= 64);
  }
});

test("malformed CLI argv fails as usage without scanning", () => {
  let scanCalls = 0;
  let output = "";
  const status = main(["unexpected"], {
    scan() {
      scanCalls += 1;
      return [];
    },
    stderr: { write(chunk) { output += chunk; } },
  });

  assert.equal(status, 2);
  assert.equal(scanCalls, 0);
  assert.equal(output, "BUNDLED_CHARACTER_CHECK_FAILED\n");
});

test("direct entry checks its repository public root and never calls process.exit", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixturePublic = path.join(fixtureRoot, "public", "local-character");
  const copiedGuard = path.join(fixtureScripts, "check-no-bundled-character.cjs");
  const exitGuard = path.join(fixtureRoot, "forbid-process-exit.cjs");
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.mkdirSync(fixturePublic, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "check-no-bundled-character.cjs"), copiedGuard);
  fs.writeFileSync(path.join(fixturePublic, "private-entry.png"), "fixture");
  fs.writeFileSync(
    exitGuard,
    'process.exit = () => { throw new Error("process.exit called"); };\n',
  );

  const result = spawnSync(process.execPath, ["--require", exitGuard, copiedGuard], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    env: {},
  });
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "BUNDLED_CHARACTER_FOUND\n");
});
