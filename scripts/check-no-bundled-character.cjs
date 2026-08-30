"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MAX_BUNDLED_ENTRIES = 256;
const MAX_RELATIVE_PATH_BYTES = 1_024;
const MAX_ERROR_BYTES = 2_048;
const CLOSED_ERROR_MESSAGE = "Unable to verify bundled character exclusion.";
const BUNDLED_CHARACTER_TOKEN = "BUNDLED_CHARACTER_FOUND\n";
const CHECK_FAILED_TOKEN = "BUNDLED_CHARACTER_CHECK_FAILED\n";
const FIXED_PUBLIC_ROOT = path.join(__dirname, "..", "public");

function closedError() {
  return new Error(CLOSED_ERROR_MESSAGE);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireSafeName(name) {
  if (
    typeof name !== "string"
    || name === ""
    || name === "."
    || name === ".."
    || name.includes("/")
    || name.includes("\\")
    || [...name].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    })
  ) {
    throw closedError();
  }
}

function relativeName(segments) {
  const name = segments.join("/");
  if (Buffer.byteLength(name, "utf8") > MAX_RELATIVE_PATH_BYTES) {
    throw closedError();
  }
  return name;
}

function lstatClosed(fsImpl, entryPath) {
  try {
    return fsImpl.lstatSync(entryPath);
  } catch {
    throw closedError();
  }
}

function requireStableDirectory(fsImpl, directoryPath, expectedStats) {
  const currentStats = lstatClosed(fsImpl, directoryPath);
  if (
    currentStats.isSymbolicLink()
    || !currentStats.isDirectory()
    || !sameIdentity(expectedStats, currentStats)
  ) {
    throw closedError();
  }

  try {
    if (fsImpl.realpathSync(directoryPath) !== directoryPath) throw closedError();
  } catch {
    throw closedError();
  }
}

function findBundledCharacterFiles(publicRoot, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  if (typeof publicRoot !== "string" || publicRoot === "") throw closedError();

  const resolvedPublicRoot = path.resolve(publicRoot);
  const publicRootStats = lstatClosed(fsImpl, resolvedPublicRoot);
  requireStableDirectory(fsImpl, resolvedPublicRoot, publicRootStats);

  const localRoot = path.join(resolvedPublicRoot, "local-character");
  let localRootStats;
  try {
    localRootStats = fsImpl.lstatSync(localRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      requireStableDirectory(fsImpl, resolvedPublicRoot, publicRootStats);
      return [];
    }
    throw closedError();
  }

  if (localRootStats.isSymbolicLink() || !localRootStats.isDirectory()) {
    requireStableDirectory(fsImpl, resolvedPublicRoot, publicRootStats);
    return ["local-character"];
  }
  requireStableDirectory(fsImpl, localRoot, localRootStats);

  const findings = [];
  let entryCount = 0;
  let directory;
  let failed = false;
  try {
    directory = fsImpl.opendirSync(localRoot);
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      requireSafeName(entry?.name);
      entryCount += 1;
      if (entryCount > MAX_BUNDLED_ENTRIES) throw closedError();
      findings.push(relativeName(["local-character", entry.name]));
    }
  } catch {
    failed = true;
  }
  if (directory !== undefined) {
    try {
      directory.closeSync();
    } catch {
      failed = true;
    }
  }
  if (failed) throw closedError();

  requireStableDirectory(fsImpl, localRoot, localRootStats);
  requireStableDirectory(fsImpl, resolvedPublicRoot, publicRootStats);
  return findings.sort((left, right) => left.localeCompare(right));
}

function assertNoBundledCharacter(publicRoot, deps = {}) {
  const findings = findBundledCharacterFiles(publicRoot, deps);
  if (findings.length === 0) return;

  let message = "Bundled character content is not allowed:";
  let included = 0;
  for (const finding of findings) {
    const candidate = `${message}${included === 0 ? " " : ", "}${finding}`;
    if (Buffer.byteLength(`${candidate}, ...`, "utf8") > MAX_ERROR_BYTES) break;
    message = candidate;
    included += 1;
  }
  if (included < findings.length) message += `${included === 0 ? " " : ", "}...`;
  throw new Error(message);
}

function writeClosed(stream, token) {
  try {
    stream.write(token);
  } catch {
    // The exit status remains the closed machine-readable result.
  }
}

function main(argv, deps = {}) {
  const stderr = deps.stderr ?? process.stderr;
  if (!Array.isArray(argv) || argv.length !== 0) {
    writeClosed(stderr, CHECK_FAILED_TOKEN);
    return 2;
  }

  try {
    const scan = deps.scan ?? findBundledCharacterFiles;
    if (typeof scan !== "function") throw closedError();
    const findings = scan(FIXED_PUBLIC_ROOT);
    if (!Array.isArray(findings)) throw closedError();
    if (findings.length === 0) return 0;
    writeClosed(stderr, BUNDLED_CHARACTER_TOKEN);
    return 1;
  } catch {
    writeClosed(stderr, CHECK_FAILED_TOKEN);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  MAX_BUNDLED_ENTRIES,
  assertNoBundledCharacter,
  findBundledCharacterFiles,
  main,
};
