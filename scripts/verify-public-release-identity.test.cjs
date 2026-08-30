"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  cleanGitEnvironment,
  EXPECTED_EXCLUDES,
  parseGitIndexModes,
  pathsAreEquivalent,
  pathsReferToSameEntry,
  readStableRegularFile,
  verifyPublicReleaseIdentity,
} = require("./verify-public-release-identity.cjs");

function sha256(bytes) {
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function rewriteIdentity(root, mutate) {
  const identityPath = path.join(root, "PUBLIC_RELEASE_IDENTITY.json");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  mutate(identity);
  identity.payload.rootSha256 = sha256(JSON.stringify(identity.payload.files));
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
}

function writeFixture(root) {
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "public\n");
  fs.writeFileSync(path.join(root, "src", "index.js"), "export {};\n");
  const files = ["README.md", "src/index.js"].map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return {
      path: relativePath,
      mode: "100644",
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
  });
  const identity = {
    schema: "ume.public-release-identity.v2",
    publicRepository: "UMEBOSHIISAN/ume-presence",
    sourceRepository: "UMEBOSHIISAN/persona-private",
    sourceCommit: "e".repeat(40),
    history: "fresh-public-snapshot",
    trustedAncestor: "ef97c6bad8328443fc2cd540ac9ae47d71630c78",
    binaryRelease: "HOLD",
    physicalAcceptance: "NOT_RUN",
    payloadExcludes: EXPECTED_EXCLUDES,
    payload: {
      fileCount: files.length,
      rootSha256: sha256(JSON.stringify(files)),
      files,
    },
  };
  fs.writeFileSync(
    path.join(root, "PUBLIC_RELEASE_IDENTITY.json"),
    `${JSON.stringify(identity, null, 2)}\n`,
  );
  return root;
}

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ume-presence-identity-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return writeFixture(root);
}

test("verifies an exact sorted public payload without reading excluded build trees", (context) => {
  const root = createFixture(context);
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "ignored.js"), "ignored\n");

  const result = verifyPublicReleaseIdentity(root);

  assert.deepEqual(result, {
    schema: "ume.public-release-identity.verify.v2",
    status: "passed",
    fileCount: 2,
    rootSha256: sha256(JSON.stringify([
      {
        path: "README.md",
        mode: "100644",
        sha256: sha256(Buffer.from("public\n")),
        bytes: 7,
      },
      {
        path: "src/index.js",
        mode: "100644",
        sha256: sha256(Buffer.from("export {};\n")),
        bytes: 11,
      },
    ])),
    sourceCommit: "e".repeat(40),
    trustedAncestor: "ef97c6bad8328443fc2cd540ac9ae47d71630c78",
    binaryRelease: "HOLD",
    physicalAcceptance: "NOT_RUN",
  });
});

test("uses global path order when a directory precedes a sibling filename", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ume-presence-identity-order-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "a"));
  fs.writeFileSync(path.join(root, "a", "file"), "nested\n");
  fs.writeFileSync(path.join(root, "a.txt"), "sibling\n");
  const files = ["a.txt", "a/file"].map((relativePath) => {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    return {
      path: relativePath,
      mode: "100644",
      sha256: sha256(bytes),
      bytes: bytes.length,
    };
  });
  fs.writeFileSync(
    path.join(root, "PUBLIC_RELEASE_IDENTITY.json"),
    `${JSON.stringify({
      schema: "ume.public-release-identity.v2",
      publicRepository: "UMEBOSHIISAN/ume-presence",
      sourceRepository: "UMEBOSHIISAN/persona-private",
      sourceCommit: "e".repeat(40),
      history: "fresh-public-snapshot",
      trustedAncestor: "ef97c6bad8328443fc2cd540ac9ae47d71630c78",
      binaryRelease: "HOLD",
      physicalAcceptance: "NOT_RUN",
      payloadExcludes: EXPECTED_EXCLUDES,
      payload: {
        fileCount: files.length,
        rootSha256: sha256(JSON.stringify(files)),
        files,
      },
    }, null, 2)}\n`,
  );

  assert.equal(verifyPublicReleaseIdentity(root).status, "passed");
});

test("rejects missing, malformed, or altered identity truth metadata", (context) => {
  const cases = [
    ["missing trusted ancestor", (identity) => { delete identity.trustedAncestor; }],
    ["malformed trusted ancestor", (identity) => { identity.trustedAncestor = "not-a-commit"; }],
    ["altered trusted ancestor", (identity) => { identity.trustedAncestor = "a".repeat(40); }],
    ["missing binary release", (identity) => { delete identity.binaryRelease; }],
    ["altered binary release", (identity) => { identity.binaryRelease = "READY"; }],
    ["missing physical acceptance", (identity) => { delete identity.physicalAcceptance; }],
    ["altered physical acceptance", (identity) => { identity.physicalAcceptance = "ACCEPTED"; }],
  ];

  for (const [name, mutate] of cases) {
    const root = createFixture(context);
    rewriteIdentity(root, mutate);
    assert.throws(
      () => verifyPublicReleaseIdentity(root),
      /public release identity (has unexpected fields|metadata is invalid)/,
      name,
    );
  }
});

test("fails closed on tampering, extra files, and symlinks", (context) => {
  const root = createFixture(context);
  fs.writeFileSync(path.join(root, "README.md"), "tampered\n");
  assert.throws(() => verifyPublicReleaseIdentity(root), /payload identity mismatch/);

  fs.writeFileSync(path.join(root, "README.md"), "public\n");
  fs.writeFileSync(path.join(root, "extra.txt"), "extra\n");
  assert.throws(() => verifyPublicReleaseIdentity(root), /payload identity mismatch/);

  fs.rmSync(path.join(root, "extra.txt"));
  fs.symlinkSync("README.md", path.join(root, "linked-readme"));
  assert.throws(() => verifyPublicReleaseIdentity(root), /symbolic links are not allowed/);
});

test("rejects a symlinked release identity file", (context) => {
  const root = createFixture(context);
  const identityPath = path.join(root, "PUBLIC_RELEASE_IDENTITY.json");
  const externalIdentity = path.join(root, "..", `${path.basename(root)}-identity.json`);
  context.after(() => {
    try {
      fs.unlinkSync(externalIdentity);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
  fs.renameSync(identityPath, externalIdentity);
  fs.symlinkSync(externalIdentity, identityPath);

  assert.throws(
    () => verifyPublicReleaseIdentity(root),
    /release identity must be a regular non-symbolic-link file/,
  );
});

test("stable payload read rejects a symlink swap immediately before open", (context) => {
  const root = createFixture(context);
  const target = path.join(root, "README.md");
  const original = path.join(root, "README.original.md");
  const external = path.join(path.dirname(root), `${path.basename(root)}-external.md`);
  fs.writeFileSync(external, "public\n");
  context.after(() => fs.rmSync(external, { force: true }));

  const fsImpl = Object.create(fs);
  let readCalls = 0;
  fsImpl.openSync = (filePath, flags) => {
    if (filePath === target) {
      fs.renameSync(target, original);
      fs.symlinkSync(external, target);
    }
    return fs.openSync(filePath, flags);
  };
  fsImpl.readSync = (...args) => {
    readCalls += 1;
    return fs.readSync(...args);
  };

  assert.throws(
    () => readStableRegularFile(root, "README.md", { fsImpl }),
    /public payload entry changed during verification/,
  );
  assert.equal(readCalls, 0);
});

test("stable payload read rejects a path replaced after descriptor open", (context) => {
  const root = createFixture(context);
  const target = path.join(root, "README.md");
  const original = path.join(root, "README.original.md");
  const fsImpl = Object.create(fs);
  let replaced = false;
  fsImpl.readSync = (...args) => {
    const bytesRead = fs.readSync(...args);
    if (!replaced) {
      replaced = true;
      fs.renameSync(target, original);
      fs.writeFileSync(target, "public\n");
    }
    return bytesRead;
  };

  assert.throws(
    () => readStableRegularFile(root, "README.md", { fsImpl }),
    /public payload entry changed during verification/,
  );
  assert.equal(replaced, true);
});

test("rejects executable-bit tampering", (context) => {
  const root = createFixture(context);
  if (process.platform === "win32") {
    rewriteIdentity(root, (identity) => {
      identity.payload.files[0].mode = "100755";
    });
  } else {
    fs.chmodSync(path.join(root, "README.md"), 0o755);
  }

  assert.throws(() => verifyPublicReleaseIdentity(root), /payload identity mismatch/);
});

test("rejects executable-bit tampering recorded only in the Git index", (context) => {
  const root = createFixture(context);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "README.md", "src/index.js"], { cwd: root });
  execFileSync("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });

  assert.throws(
    () => verifyPublicReleaseIdentity(root),
    /public payload Git mode mismatch|public payload identity mismatch/,
  );
});

test("rejects a non-excluded path present only in the Git index", (context) => {
  const root = createFixture(context);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "README.md", "src/index.js"], { cwd: root });
  fs.writeFileSync(path.join(root, "index-only.js"), "not in the payload\n");
  execFileSync("git", ["add", "index-only.js"], { cwd: root });
  fs.unlinkSync(path.join(root, "index-only.js"));

  assert.throws(
    () => verifyPublicReleaseIdentity(root),
    /public payload Git path set mismatch/,
  );
});

test("preserves literal backslashes in Git index paths", () => {
  const oid = "a".repeat(40);
  const modes = parseGitIndexModes(`100644 ${oid} 0\tsrc\\index.js\0`);

  assert.deepEqual([...modes], [["src\\index.js", "100644"]]);
});

test("compares resolved Windows paths with platform-native casing rules", () => {
  assert.equal(
    pathsAreEquivalent("D:\\a\\persona-private", "d:\\A\\PERSONA-PRIVATE", path.win32),
    true,
  );
  assert.equal(
    pathsAreEquivalent("D:\\a\\persona-private", "D:\\a\\persona-private\\child", path.win32),
    false,
  );
});

test("accepts two Windows path spellings only when they identify the same directory", () => {
  const identities = new Map([
    ["\\\\?\\D:\\a\\persona-private", { dev: 7n, ino: 11n }],
    ["D:\\a\\persona-private", { dev: 7n, ino: 11n }],
    ["D:\\a\\other", { dev: 7n, ino: 12n }],
  ]);
  const statSync = (candidate) => identities.get(candidate);

  assert.equal(
    pathsReferToSameEntry(
      "\\\\?\\D:\\a\\persona-private",
      "D:\\a\\persona-private",
      { pathImplementation: path.win32, statSync },
    ),
    true,
  );
  assert.equal(
    pathsReferToSameEntry(
      "\\\\?\\D:\\a\\persona-private",
      "D:\\a\\other",
      { pathImplementation: path.win32, statSync },
    ),
    false,
  );
});

test("a Gitless snapshot ignores an ambient parent worktree", (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ume-presence-parent-worktree-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: parent });
  const root = path.join(parent, "public-snapshot");
  fs.mkdirSync(root);
  writeFixture(root);

  assert.equal(verifyPublicReleaseIdentity(root).status, "passed");
});

test("ignores inherited Git index overrides", (context) => {
  const root = createFixture(context);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "README.md", "src/index.js"], { cwd: root });
  const alternateIndex = path.join(root, "..", `${path.basename(root)}-alternate-index`);
  context.after(() => fs.rmSync(alternateIndex, { force: true }));
  fs.copyFileSync(path.join(root, ".git", "index"), alternateIndex);
  execFileSync("git", ["update-index", "--chmod=+x", "README.md"], { cwd: root });
  const previous = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = alternateIndex;
  try {
    assert.throws(
      () => verifyPublicReleaseIdentity(root),
      /public payload Git mode mismatch|public payload identity mismatch/,
    );
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
});

test("removes Git repository overrides case-insensitively", () => {
  const source = {
    PATH: "/bin",
    git_index_file: "/tmp/alternate-index",
    GiT_WoRk_TrEe: "/tmp/alternate-worktree",
    SAFE_VALUE: "preserved",
  };

  assert.deepEqual(cleanGitEnvironment(source), {
    PATH: "/bin",
    SAFE_VALUE: "preserved",
  });
  assert.equal(source.git_index_file, "/tmp/alternate-index");
});

test("does not execute a configured fsmonitor hook while reading index modes", (context) => {
  const root = createFixture(context);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "README.md", "src/index.js"], { cwd: root });
  const hook = path.join(root, ".git", "fsmonitor-hook");
  const marker = path.join(root, ".git", "fsmonitor-invoked");
  fs.writeFileSync(hook, [
    "#!/bin/sh",
    "printf 'tampered\\n' > README.md",
    "printf 'invoked\\n' > .git/fsmonitor-invoked",
    "printf '\\n'",
    "",
  ].join("\n"));
  fs.chmodSync(hook, 0o755);
  execFileSync("git", ["config", "core.fsmonitor", hook], { cwd: root });

  assert.equal(verifyPublicReleaseIdentity(root).status, "passed");
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "public\n");
  assert.equal(fs.existsSync(marker), false);
});

test("accepts index records from a SHA-256 Git repository", (context) => {
  const root = createFixture(context);
  execFileSync("git", ["init", "--quiet", "--object-format=sha256"], { cwd: root });
  execFileSync("git", ["add", "README.md", "src/index.js"], { cwd: root });

  assert.equal(verifyPublicReleaseIdentity(root).status, "passed");
});
