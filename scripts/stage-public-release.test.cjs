"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const {
  FORBIDDEN_CASE_INSENSITIVE_TOKENS,
  FORBIDDEN_EXACT_TOKENS,
  REQUIRED_PUBLIC_PATHS,
  UPSTREAM_ATTRIBUTION_TOKENS,
  stagePublicRelease,
} = require("./stage-public-release.cjs");
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(root, relativePath, contents) {
  const absolutePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function createRepository(context, paths = [
  "PUBLIC_RELEASE_PATHS.txt",
  "README.md",
]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ume-presence-source-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Public Stage Test"]);
  git(root, ["config", "user.email", "stage-test@example.invalid"]);
  git(root, [
    "remote",
    "add",
    "private",
    "https://github.com/UMEBOSHIISAN/persona-private.git",
  ]);
  write(root, "PUBLIC_RELEASE_PATHS.txt", `${paths.join("\n")}\n`);
  write(root, "README.md", "public source\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  const trustedBase = git(root, ["rev-parse", "HEAD"]);
  write(root, "README.md", "public source candidate\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-q", "-m", "candidate"]);
  return { root, trustedBase };
}

test("stages one exact committed closure with fresh-history identity", (context) => {
  const { root, trustedBase } = createRepository(context);
  const output = path.join(path.dirname(root), `${path.basename(root)}-public`);
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));

  const result = stagePublicRelease({
    root,
    output,
    trustedBase,
    requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
  });
  const identity = JSON.parse(
    fs.readFileSync(path.join(output, "PUBLIC_RELEASE_IDENTITY.json"), "utf8"),
  );

  assert.equal(result.sourceCommit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(result.fileCount, 2);
  assert.equal(identity.schema, "ume.public-release-identity.v2");
  assert.equal(identity.history, "fresh-public-snapshot");
  assert.equal(identity.trustedAncestor, trustedBase);
  assert.equal(identity.binaryRelease, "HOLD");
  assert.equal(identity.physicalAcceptance, "NOT_RUN");
  assert.deepEqual(identity.payload.files.map(({ path: filePath, mode }) => ({
    path: filePath,
    mode,
  })), [
    { path: "PUBLIC_RELEASE_PATHS.txt", mode: "100644" },
    { path: "README.md", mode: "100644" },
  ]);
  assert.equal(
    fs.readFileSync(path.join(output, "README.md"), "utf8"),
    "public source candidate\n",
  );
  assert.equal(result.trustedAncestor, trustedBase);
  assert.equal(result.binaryRelease, "HOLD");
  assert.equal(result.physicalAcceptance, "NOT_RUN");
});

test("pins every staged read to one source commit while HEAD advances", (context) => {
  const { root, trustedBase } = createRepository(context);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]);
  const output = path.join(path.dirname(root), `${path.basename(root)}-pinned-public`);
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));

  const originalWriteFileSync = fs.writeFileSync;
  let advanced = false;
  fs.writeFileSync = function writeAndAdvance(filePath, ...args) {
    const result = originalWriteFileSync.call(fs, filePath, ...args);
    if (
      !advanced
      && path.basename(filePath) === "PUBLIC_RELEASE_PATHS.txt"
      && String(filePath).includes(".ume-presence-public-stage-")
    ) {
      advanced = true;
      originalWriteFileSync.call(fs, path.join(root, "README.md"), "later source\n");
      git(root, ["add", "README.md"]);
      git(root, ["commit", "-q", "-m", "advance during staging"]);
    }
    return result;
  };

  try {
    assert.throws(
      () => stagePublicRelease({
        root,
        output,
        trustedBase,
        requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
      }),
      /source HEAD changed during staging/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(advanced, true);
  assert.notEqual(git(root, ["rev-parse", "HEAD"]), sourceCommit);
  assert.equal(fs.existsSync(output), false);
});

test("public source closure excludes dormant binary release automation", () => {
  const paths = fs.readFileSync(
    path.join(__dirname, "..", "PUBLIC_RELEASE_PATHS.txt"),
    "utf8",
  ).trim().split("\n");
  const releasing = fs.readFileSync(
    path.join(__dirname, "..", "docs", "RELEASING.md"),
    "utf8",
  );

  assert.equal(paths.includes(".github/workflows/release.yml"), false);
  assert.equal(REQUIRED_PUBLIC_PATHS.includes(".github/workflows/release.yml"), false);
  assert.doesNotMatch(releasing, /existing tag workflow/u);
  assert.match(
    releasing,
    /public source closure intentionally contains no tag-triggered publication\s+workflow/u,
  );
});

test("rejects dirty source, symlinks, private tokens, and existing output", (context) => {
  const dirty = createRepository(context);
  write(dirty.root, "README.md", "uncommitted\n");
  assert.throws(
    () => stagePublicRelease({
      root: dirty.root,
      output: path.join(path.dirname(dirty.root), "dirty-output"),
      trustedBase: dirty.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /source worktree must be clean/,
  );

  const linked = createRepository(context, [
    "PUBLIC_RELEASE_PATHS.txt",
    "README.md",
    "linked-readme",
  ]);
  fs.symlinkSync("README.md", path.join(linked.root, "linked-readme"));
  git(linked.root, ["add", "PUBLIC_RELEASE_PATHS.txt", "linked-readme"]);
  git(linked.root, ["commit", "-q", "-m", "add link"]);
  assert.throws(
    () => stagePublicRelease({
      root: linked.root,
      output: path.join(path.dirname(linked.root), "linked-output"),
      trustedBase: linked.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /symbolic links are not allowed/,
  );

  const privateToken = createRepository(context);
  write(
    privateToken.root,
    "README.md",
    `path: ${FORBIDDEN_CASE_INSENSITIVE_TOKENS[0]}/private\n`,
  );
  git(privateToken.root, ["add", "README.md"]);
  git(privateToken.root, ["commit", "-q", "-m", "add private token"]);
  assert.throws(
    () => stagePublicRelease({
      root: privateToken.root,
      output: path.join(path.dirname(privateToken.root), "token-output"),
      trustedBase: privateToken.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /public payload contains a forbidden token/,
  );

  const existing = createRepository(context);
  const output = path.join(path.dirname(existing.root), "existing-output");
  fs.mkdirSync(output);
  context.after(() => fs.rmSync(output, { recursive: true, force: true }));
  assert.throws(
    () => stagePublicRelease({
      root: existing.root,
      output,
      trustedBase: existing.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /output path must not exist/,
  );
});

test("rejects case variants without embedding forbidden tokens in the stager", (context) => {
  const candidate = createRepository(context);
  write(
    candidate.root,
    "README.md",
    `${FORBIDDEN_CASE_INSENSITIVE_TOKENS[0].toUpperCase()}\n`,
  );
  git(candidate.root, ["add", "README.md"]);
  git(candidate.root, ["commit", "-q", "-m", "add uppercase private token"]);
  assert.throws(
    () => stagePublicRelease({
      root: candidate.root,
      output: path.join(path.dirname(candidate.root), "uppercase-token-output"),
      trustedBase: candidate.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /public payload contains a forbidden token/,
  );

  for (const relativePath of [
    "stage-public-release.cjs",
    "stage-public-release.test.cjs",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, relativePath), "utf8");
    const lowerSource = source.toLowerCase();
    for (const token of FORBIDDEN_CASE_INSENSITIVE_TOKENS) {
      assert.equal(lowerSource.includes(token.toLowerCase()), false, relativePath);
    }
    for (const token of FORBIDDEN_EXACT_TOKENS) {
      assert.equal(source.includes(token), false, relativePath);
    }
    for (const token of UPSTREAM_ATTRIBUTION_TOKENS) {
      assert.equal(lowerSource.includes(token.toLowerCase()), false, relativePath);
    }
  }
});

test("rejects an output whose symlinked parent resolves inside the source", (context) => {
  const candidate = createRepository(context);
  const alias = `${candidate.root}-alias`;
  fs.symlinkSync(candidate.root, alias, "dir");
  context.after(() => {
    try {
      fs.unlinkSync(alias);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });

  assert.throws(
    () => stagePublicRelease({
      root: candidate.root,
      output: path.join(alias, "generated-public"),
      trustedBase: candidate.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /output must be outside the source worktree/,
  );
});

test("rejects an in-tree output whose basename only starts with two dots", (context) => {
  const candidate = createRepository(context);
  const output = path.join(candidate.root, "..public");

  assert.throws(
    () => stagePublicRelease({
      root: candidate.root,
      output,
      trustedBase: candidate.trustedBase,
      requiredPaths: ["PUBLIC_RELEASE_PATHS.txt", "README.md"],
    }),
    /output must be outside the source worktree/,
  );
  assert.equal(fs.existsSync(output), false);
});
