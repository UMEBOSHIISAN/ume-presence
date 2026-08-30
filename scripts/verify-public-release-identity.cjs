"use strict";

const nodeCrypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const IDENTITY_FILE = "PUBLIC_RELEASE_IDENTITY.json";
const TRUSTED_ANCESTOR = "ef97c6bad8328443fc2cd540ac9ae47d71630c78";
const EXPECTED_EXCLUDES = Object.freeze([
  IDENTITY_FILE,
  ".git",
  "node_modules",
  "dist",
  "release",
  "native/bin",
]);
const GIT_REPOSITORY_OVERRIDE_ENV = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
]);

function sha256(bytes) {
  return nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function isExcluded(relativePath) {
  return EXPECTED_EXCLUDES.some(
    (excluded) => relativePath === excluded || relativePath.startsWith(`${excluded}/`),
  );
}

function normalizedFileMode(stats) {
  return (stats.mode & 0o111) === 0 ? "100644" : "100755";
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableEntry(left, right) {
  return sameFileIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function requireStableDirectoryStats(stats) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("public payload entry changed during verification");
  }
}

function requireStableFileStats(stats) {
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || !Number.isSafeInteger(stats.size)
    || stats.size < 0
  ) {
    throw new Error("public payload entry changed during verification");
  }
}

function captureDirectoryChain(root, relativePath, fsImpl) {
  const chain = [];
  let current = root;
  const segments = relativePath.split("/").slice(0, -1);
  for (const segment of [null, ...segments]) {
    if (segment !== null) current = path.join(current, segment);
    const stats = fsImpl.lstatSync(current);
    requireStableDirectoryStats(stats);
    chain.push([current, stats]);
  }
  return chain;
}

function verifyDirectoryChain(chain, fsImpl) {
  for (const [directoryPath, expected] of chain) {
    const current = fsImpl.lstatSync(directoryPath);
    requireStableDirectoryStats(current);
    if (!sameStableEntry(expected, current)) {
      throw new Error("public payload entry changed during verification");
    }
  }
}

function readStableRegularFile(root, relativePath, { fsImpl = fs, expectedStats } = {}) {
  const filePath = path.join(root, ...relativePath.split("/"));
  const directoryChain = captureDirectoryChain(root, relativePath, fsImpl);
  let descriptor;
  let result;
  let failed = false;

  try {
    verifyDirectoryChain(directoryChain, fsImpl);
    const pathStatsBefore = fsImpl.lstatSync(filePath);
    requireStableFileStats(pathStatsBefore);
    if (expectedStats !== undefined && !sameStableEntry(expectedStats, pathStatsBefore)) {
      throw new Error("public payload entry changed during verification");
    }

    const constants = fsImpl.constants ?? fs.constants;
    let flags = constants.O_RDONLY;
    if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
    descriptor = fsImpl.openSync(filePath, flags);

    const descriptorStatsBefore = fsImpl.fstatSync(descriptor);
    requireStableFileStats(descriptorStatsBefore);
    if (!sameStableEntry(pathStatsBefore, descriptorStatsBefore)) {
      throw new Error("public payload entry changed during verification");
    }

    const capacity = descriptorStatsBefore.size + 1;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("public payload entry changed during verification");
    }
    const bytes = Buffer.allocUnsafe(capacity);
    let totalBytes = 0;
    while (totalBytes < bytes.byteLength) {
      const bytesRead = fsImpl.readSync(
        descriptor,
        bytes,
        totalBytes,
        bytes.byteLength - totalBytes,
        null,
      );
      if (
        !Number.isSafeInteger(bytesRead)
        || bytesRead < 0
        || bytesRead > bytes.byteLength - totalBytes
      ) {
        throw new Error("public payload entry changed during verification");
      }
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes !== descriptorStatsBefore.size) {
      throw new Error("public payload entry changed during verification");
    }

    const descriptorStatsAfter = fsImpl.fstatSync(descriptor);
    requireStableFileStats(descriptorStatsAfter);
    if (!sameStableEntry(descriptorStatsBefore, descriptorStatsAfter)) {
      throw new Error("public payload entry changed during verification");
    }
    const pathStatsAfter = fsImpl.lstatSync(filePath);
    requireStableFileStats(pathStatsAfter);
    if (!sameStableEntry(descriptorStatsAfter, pathStatsAfter)) {
      throw new Error("public payload entry changed during verification");
    }
    verifyDirectoryChain(directoryChain, fsImpl);
    result = bytes.subarray(0, totalBytes);
  } catch {
    failed = true;
  }

  if (descriptor !== undefined) {
    try {
      fsImpl.closeSync(descriptor);
    } catch {
      failed = true;
    }
  }
  if (failed || result === undefined) {
    throw new Error("public payload entry changed during verification");
  }
  return result;
}

function cleanGitEnvironment(source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (!GIT_REPOSITORY_OVERRIDE_ENV.includes(name.toUpperCase())) {
      environment[name] = value;
    }
  }
  return environment;
}

function parseGitIndexModes(output) {
  const modes = new Map();
  for (const record of output.split("\0")) {
    if (record.length === 0) continue;
    const match = /^(\d{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) (\d+)\t(.+)$/u.exec(record);
    if (!match || match[2] !== "0" || modes.has(match[3])) {
      throw new Error("Git index contains an unsupported payload entry");
    }
    modes.set(match[3], match[1]);
  }
  return modes;
}

function pathsAreEquivalent(left, right, pathImplementation = path) {
  return pathImplementation.relative(left, right) === "";
}

function pathsReferToSameEntry(
  left,
  right,
  { pathImplementation = path, statSync = fs.statSync } = {},
) {
  if (pathsAreEquivalent(left, right, pathImplementation)) return true;
  const leftStats = statSync(left, { bigint: true });
  const rightStats = statSync(right, { bigint: true });
  return leftStats.ino !== 0n
    && rightStats.ino !== 0n
    && leftStats.dev === rightStats.dev
    && leftStats.ino === rightStats.ino;
}

function collectGitIndexModes(root) {
  const gitMarker = path.join(root, ".git");
  const hasGitMarker = fs.existsSync(gitMarker);
  if (!hasGitMarker) return null;
  const environment = cleanGitEnvironment();
  const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (topLevel.error) {
    throw new Error("Git index mode verification failed");
  }
  if (topLevel.status !== 0) {
    throw new Error("Git index mode verification failed");
  }
  const resolvedTopLevel = fs.realpathSync(topLevel.stdout.trim());
  if (!pathsReferToSameEntry(resolvedTopLevel, fs.realpathSync(root))) {
    throw new Error("public release root must be the Git worktree root");
  }

  const listed = spawnSync("git", [
    "-c",
    "core.fsmonitor=false",
    "ls-files",
    "--stage",
    "-z",
  ], {
    cwd: root,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (listed.error || listed.status !== 0) {
    throw new Error("Git index mode verification failed");
  }
  return parseGitIndexModes(listed.stdout);
}

function collectPayload(root) {
  const files = [];

  function visit(directory, prefix = "") {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isExcluded(relativePath)) continue;
      const absolutePath = path.join(directory, entry.name);
      const entryStats = fs.lstatSync(absolutePath);
      if (entryStats.isSymbolicLink()) {
        throw new Error("symbolic links are not allowed in the public payload");
      }
      if (entryStats.isDirectory()) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entryStats.isFile()) {
        throw new Error("special files are not allowed in the public payload");
      }
      const bytes = readStableRegularFile(root, relativePath, { expectedStats: entryStats });
      files.push({
        path: relativePath,
        mode: normalizedFileMode(entryStats),
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
  }

  visit(root);
  const sortedFiles = files.sort((left, right) => (
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  ));
  const gitModes = collectGitIndexModes(root);
  if (gitModes !== null) {
    const payloadPaths = sortedFiles.map((file) => file.path);
    const gitPayloadPaths = [...gitModes.keys()]
      .filter((relativePath) => !isExcluded(relativePath))
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    if (JSON.stringify(gitPayloadPaths) !== JSON.stringify(payloadPaths)) {
      throw new Error("public payload Git path set mismatch");
    }
    for (const file of sortedFiles) {
      const gitMode = gitModes.get(file.path);
      if (gitMode !== "100644" && gitMode !== "100755") {
        throw new Error("public payload is not one regular tracked Git file");
      }
      if (process.platform !== "win32" && gitMode !== file.mode) {
        throw new Error("public payload Git mode mismatch");
      }
      file.mode = gitMode;
    }
  }
  return sortedFiles;
}

function validateIdentity(identity) {
  if (!hasExactKeys(identity, [
    "schema",
    "publicRepository",
    "sourceRepository",
    "sourceCommit",
    "history",
    "trustedAncestor",
    "binaryRelease",
    "physicalAcceptance",
    "payloadExcludes",
    "payload",
  ])) {
    throw new Error("public release identity has unexpected fields");
  }
  if (
    identity.schema !== "ume.public-release-identity.v2"
    || identity.publicRepository !== "UMEBOSHIISAN/ume-presence"
    || identity.sourceRepository !== "UMEBOSHIISAN/persona-private"
    || !/^[0-9a-f]{40}$/.test(identity.sourceCommit)
    || identity.history !== "fresh-public-snapshot"
    || identity.trustedAncestor !== TRUSTED_ANCESTOR
    || identity.binaryRelease !== "HOLD"
    || identity.physicalAcceptance !== "NOT_RUN"
    || JSON.stringify(identity.payloadExcludes) !== JSON.stringify(EXPECTED_EXCLUDES)
  ) {
    throw new Error("public release identity metadata is invalid");
  }
  if (!hasExactKeys(identity.payload, ["fileCount", "rootSha256", "files"])) {
    throw new Error("public release payload identity is invalid");
  }
  if (
    !Number.isSafeInteger(identity.payload.fileCount)
    || identity.payload.fileCount < 1
    || !/^[0-9a-f]{64}$/.test(identity.payload.rootSha256)
    || !Array.isArray(identity.payload.files)
  ) {
    throw new Error("public release payload identity is invalid");
  }
}

function verifyPublicReleaseIdentity(root = path.join(__dirname, "..")) {
  const resolvedRoot = path.resolve(root);
  let identityBytes;
  try {
    identityBytes = readStableRegularFile(resolvedRoot, IDENTITY_FILE);
  } catch {
    throw new Error("release identity must be a regular non-symbolic-link file");
  }
  const identity = JSON.parse(identityBytes.toString("utf8"));
  validateIdentity(identity);
  const files = collectPayload(resolvedRoot);
  const rootSha256 = sha256(JSON.stringify(files));
  if (
    files.length !== identity.payload.fileCount
    || rootSha256 !== identity.payload.rootSha256
    || JSON.stringify(files) !== JSON.stringify(identity.payload.files)
  ) {
    throw new Error("public payload identity mismatch");
  }
  return Object.freeze({
    schema: "ume.public-release-identity.verify.v2",
    status: "passed",
    fileCount: files.length,
    rootSha256,
    sourceCommit: identity.sourceCommit,
    trustedAncestor: identity.trustedAncestor,
    binaryRelease: identity.binaryRelease,
    physicalAcceptance: identity.physicalAcceptance,
  });
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(verifyPublicReleaseIdentity())}\n`);
  } catch {
    process.stderr.write("UME_PRESENCE_PUBLIC_RELEASE_IDENTITY_FAILED\n");
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  cleanGitEnvironment,
  EXPECTED_EXCLUDES,
  parseGitIndexModes,
  pathsAreEquivalent,
  pathsReferToSameEntry,
  readStableRegularFile,
  verifyPublicReleaseIdentity,
});
