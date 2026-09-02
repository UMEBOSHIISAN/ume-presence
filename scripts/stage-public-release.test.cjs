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

test("public first screen is source-first and keeps binary release on hold", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const orderedClaims = [
    "# UME Presence",
    "A human-facing local presence for AI-assisted work.",
    "UME Presence is a visible, local presentation surface; its authority is none.",
    "![Source-built Default Presence renderer](docs/images/default-presence.png)",
    "**Status: Source Preview**",
    "**Binary release: Not yet published (HOLD).**",
    "## Source quick start (macOS / Node.js 24)",
    "Node.js 24 and Xcode Command Line Tools with the macOS SDK",
    "npm ci",
    "npm run native:build",
    "npm run native:test",
    "npm run demo",
    "## Product boundary and limitations",
  ];
  let previousIndex = -1;
  for (const claim of orderedClaims) {
    const claimIndex = readme.indexOf(claim);
    assert.ok(claimIndex > previousIndex, `README claim is missing or out of order: ${claim}`);
    previousIndex = claimIndex;
  }

  const firstScreen = readme.slice(0, readme.indexOf("## Product boundary and limitations"));
  assert.doesNotMatch(firstScreen, /supplied[^\n]*(?:ZIP|DMG)|(?:ZIP|DMG)[^\n]*supplied/iu);
  assert.match(firstScreen, /source-built renderer capture with no Character Pack/iu);
  assert.match(
    firstScreen,
    /not a\s+signed binary capture or clean-machine acceptance proof/iu,
  );
});

test("public renderer screenshot is a real staged PNG", () => {
  const relativeImagePath = "docs/images/default-presence.png";
  const imagePath = path.join(__dirname, "..", relativeImagePath);
  const publicPaths = fs.readFileSync(
    path.join(__dirname, "..", "PUBLIC_RELEASE_PATHS.txt"),
    "utf8",
  ).trim().split("\n");

  assert.equal(fs.existsSync(imagePath), true);
  assert.equal(fs.lstatSync(imagePath).isFile(), true);
  const image = fs.readFileSync(imagePath);
  assert.deepEqual(image.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.ok(image.readUInt32BE(16) > 0);
  assert.ok(image.readUInt32BE(20) > 0);
  assert.equal(publicPaths.includes(relativeImagePath), true);
  assert.equal(publicPaths.includes("scripts/stage-public-release.test.cjs"), true);
});

test("LICENSE remains the exact upstream MIT text", () => {
  const upstreamAuthor = ["xik", "har"].join("");
  const expectedLicense = `MIT License

Copyright (c) 2026 ${upstreamAuthor}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

  assert.equal(fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8"), expectedLicense);
});

test("asset guidance keeps rights separate from distributionAllowed metadata", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const assetLicenses = fs.readFileSync(
    path.join(__dirname, "..", "ASSET_LICENSES.md"),
    "utf8",
  );
  const license = fs.readFileSync(path.join(__dirname, "..", "LICENSE"), "utf8");
  const notice = fs.readFileSync(path.join(__dirname, "..", "NOTICE"), "utf8");
  const guidance = `${readme}\n${assetLicenses}`;

  assert.match(assetLicenses, /MIT license[\s\S]*?does not grant rights to external/iu);
  assert.match(guidance, /`distributionAllowed` is app safety metadata/iu);
  assert.match(
    guidance,
    /not proof of\s+ownership,\s+license,\s+consent,\s+or redistribution rights/iu,
  );
  assert.doesNotMatch(guidance, /`distributionAllowed`[^\n]*authoritative for redistribution/iu);
  assert.doesNotMatch(`${license}\n${notice}`, /character|distributionAllowed/iu);
  for (const token of UPSTREAM_ATTRIBUTION_TOKENS) assert.match(notice, new RegExp(token, "iu"));
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
