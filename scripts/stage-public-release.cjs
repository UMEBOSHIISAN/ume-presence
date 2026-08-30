"use strict";

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const {
  EXPECTED_EXCLUDES,
} = require("./verify-public-release-identity.cjs");

const IDENTITY_FILE = "PUBLIC_RELEASE_IDENTITY.json";
const PATHS_FILE = "PUBLIC_RELEASE_PATHS.txt";
const SOURCE_REPOSITORY = "UMEBOSHIISAN/persona-private";
const PUBLIC_REPOSITORY = "UMEBOSHIISAN/ume-presence";
const TRUSTED_BASE = "ef97c6bad8328443fc2cd540ac9ae47d71630c78";
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;
const REQUIRED_PUBLIC_PATHS = Object.freeze([
  ".github/workflows/ci.yml",
  "ASSET_LICENSES.md",
  "LICENSE",
  "NOTICE",
  PATHS_FILE,
  "README.md",
  "SECURITY.md",
  "package-lock.json",
  "package.json",
  "scripts/stage-public-release.cjs",
  "scripts/stage-public-release.test.cjs",
  "scripts/verify-public-release-identity.cjs",
  "scripts/verify-public-release-identity.test.cjs",
]);
const FORBIDDEN_CASE_INSENSITIVE_TOKENS = Object.freeze([
  ["", "Users", "umeboshi"].join("/"),
  ["Sky", "ComputerUseClient"].join(""),
  ["sky", "Executable"].join(""),
  ["Ume", "ko"].join(""),
  ["Shi", "soko"].join(""),
  ["SESSION", "_CLOSEOUT"].join(""),
  ["Ume", "Claw"].join(""),
  ["Secre", "tary"].join(""),
  ["UME", " Persona"].join(""),
  ["com.", "xik", "har", ".persona"].join(""),
]);
const FORBIDDEN_EXACT_TOKENS = Object.freeze([
  ["UME", "-Persona"].join(""),
]);
const UPSTREAM_ATTRIBUTION_TOKENS = Object.freeze([
  ["xik", "har"].join(""),
  ["github.com/", "xik", "har"].join(""),
]);

function sha256(bytes) {
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function git(root, args, encoding = "utf8") {
  return execFileSync("git", args, {
    cwd: root,
    encoding,
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function normalizeRepository(remoteUrl) {
  return remoteUrl
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}

function validateSource(root, trustedBase, sourceRepository) {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") {
    throw new Error("source must be a Git worktree");
  }
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length !== 0) {
    throw new Error("source worktree must be clean");
  }
  const repositories = git(root, ["remote", "-v"])
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter(Boolean)
    .map(normalizeRepository);
  if (!repositories.includes(sourceRepository)) {
    throw new Error("source repository identity mismatch");
  }
  const sourceCommit = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("source commit identity is invalid");
  }
  const ancestry = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", trustedBase, sourceCommit],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (ancestry.status !== 0) {
    throw new Error("source is not descended from the trusted final-freeze base");
  }
  return sourceCommit;
}

function validatePublicPath(relativePath) {
  if (
    relativePath.length < 1
    || relativePath === IDENTITY_FILE
    || relativePath.startsWith("/")
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/u.test(relativePath)
  ) {
    throw new Error("public path manifest contains an unsafe path");
  }
}

function readPublicPaths(root, requiredPaths, sourceCommit) {
  const manifestBytes = git(root, ["show", `${sourceCommit}:${PATHS_FILE}`], null);
  const manifest = manifestBytes.toString("utf8");
  if (!manifest.endsWith("\n") || manifest.includes("\r")) {
    throw new Error("public path manifest must use LF-terminated lines");
  }
  const paths = manifest.slice(0, -1).split("\n");
  for (const relativePath of paths) validatePublicPath(relativePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("public path manifest contains duplicate paths");
  }
  const sorted = [...paths].sort(compareText);
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) {
    throw new Error("public path manifest must be sorted");
  }
  for (const requiredPath of requiredPaths) {
    if (!paths.includes(requiredPath)) {
      throw new Error("public path manifest omits a required path");
    }
  }
  return paths;
}

function readCommittedFile(root, relativePath, sourceCommit) {
  const treeLine = git(root, ["ls-tree", sourceCommit, "--", relativePath]).trim();
  const match = /^(\d{6}) blob [0-9a-f]{40}\t(.+)$/u.exec(treeLine);
  if (!match || match[2] !== relativePath) {
    throw new Error("public path is not one exact committed file");
  }
  if (match[1] === "120000") {
    throw new Error("symbolic links are not allowed in the public payload");
  }
  if (match[1] !== "100644" && match[1] !== "100755") {
    throw new Error("public payload contains an unsupported file mode");
  }
  return {
    bytes: git(root, ["show", `${sourceCommit}:${relativePath}`], null),
    mode: match[1],
  };
}

function assertPublicBytes(relativePath, bytes) {
  const contents = bytes.toString("utf8");
  const lowerContents = contents.toLowerCase();
  const caseInsensitive = [...FORBIDDEN_CASE_INSENSITIVE_TOKENS];
  if (relativePath !== "LICENSE" && relativePath !== "NOTICE") {
    caseInsensitive.push(...UPSTREAM_ATTRIBUTION_TOKENS);
  }
  for (const token of caseInsensitive) {
    if (lowerContents.includes(token.toLowerCase())) {
      throw new Error("public payload contains a forbidden token");
    }
  }
  for (const token of FORBIDDEN_EXACT_TOKENS) {
    if (contents.includes(token)) {
      throw new Error("public payload contains a forbidden token");
    }
  }
}

function validateOutput(root, output) {
  const resolvedRoot = fs.realpathSync(root);
  const lexicalOutput = path.resolve(output);
  const parent = fs.realpathSync(path.dirname(lexicalOutput));
  const resolvedOutput = path.join(parent, path.basename(lexicalOutput));
  const relative = path.relative(resolvedRoot, resolvedOutput);
  const isOutside = relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
  if (relative === "" || !isOutside) {
    throw new Error("output must be outside the source worktree");
  }
  try {
    fs.lstatSync(resolvedOutput);
    throw new Error("output path must not exist");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error("output parent must be a directory");
  }
  return { parent, resolvedOutput };
}

function stagePublicRelease({
  root = path.join(__dirname, ".."),
  output,
  trustedBase = TRUSTED_BASE,
  sourceRepository = SOURCE_REPOSITORY,
  requiredPaths = REQUIRED_PUBLIC_PATHS,
} = {}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("one output path is required");
  }
  const resolvedRoot = fs.realpathSync(root);
  const sourceCommit = validateSource(resolvedRoot, trustedBase, sourceRepository);
  const paths = readPublicPaths(resolvedRoot, requiredPaths, sourceCommit);
  const { parent, resolvedOutput } = validateOutput(resolvedRoot, output);
  const temporary = fs.mkdtempSync(path.join(parent, ".ume-presence-public-stage-"));
  let renamed = false;
  try {
    const files = [];
    for (const relativePath of paths) {
      const { bytes, mode } = readCommittedFile(resolvedRoot, relativePath, sourceCommit);
      assertPublicBytes(relativePath, bytes);
      const destination = path.join(temporary, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { mode: mode === "100755" ? 0o755 : 0o644 });
      files.push({
        path: relativePath,
        mode,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
    const identity = {
      schema: "ume.public-release-identity.v2",
      publicRepository: PUBLIC_REPOSITORY,
      sourceRepository,
      sourceCommit,
      history: "fresh-public-snapshot",
      trustedAncestor: trustedBase,
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
      path.join(temporary, IDENTITY_FILE),
      `${JSON.stringify(identity, null, 2)}\n`,
      { mode: 0o644 },
    );
    if (validateSource(resolvedRoot, trustedBase, sourceRepository) !== sourceCommit) {
      throw new Error("source HEAD changed during staging");
    }
    fs.renameSync(temporary, resolvedOutput);
    renamed = true;
    return Object.freeze({
      schema: "ume.public-release.stage.v1",
      status: "passed",
      sourceCommit,
      fileCount: files.length,
      rootSha256: identity.payload.rootSha256,
      trustedAncestor: identity.trustedAncestor,
      binaryRelease: identity.binaryRelease,
      physicalAcceptance: identity.physicalAcceptance,
    });
  } finally {
    if (!renamed) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function parseOutput(argv) {
  if (
    argv.length !== 2
    || argv[0] !== "--output"
    || typeof argv[1] !== "string"
    || argv[1].length === 0
  ) {
    throw new Error("expected exactly --output <path>");
  }
  return path.resolve(argv[1]);
}

if (require.main === module) {
  try {
    const result = stagePublicRelease({ output: parseOutput(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("UME_PRESENCE_PUBLIC_STAGE_FAILED\n");
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  FORBIDDEN_CASE_INSENSITIVE_TOKENS,
  FORBIDDEN_EXACT_TOKENS,
  PUBLIC_REPOSITORY,
  REQUIRED_PUBLIC_PATHS,
  SOURCE_REPOSITORY,
  TRUSTED_BASE,
  UPSTREAM_ATTRIBUTION_TOKENS,
  stagePublicRelease,
});
