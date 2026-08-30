"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { validateCharacterManifest } = require("../electron/character-pack.cjs");

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 4_096;
const MAX_PATH_BYTES = 1_024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ERROR_TOKEN = "PRIVATE_CHARACTER_LEAK_CHECK_ERROR";

function closedError() {
  return new Error(ERROR_TOKEN);
}

function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  throw closedError();
}

function containsUnsafePathCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x061c
      || (codePoint >= 0x200e && codePoint <= 0x200f)
      || (codePoint >= 0x2028 && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}

function validateTrackedName(name) {
  if (
    typeof name !== "string"
    || name === ""
    || Buffer.byteLength(name, "utf8") > MAX_PATH_BYTES
    || containsUnsafePathCharacter(name)
    || name.includes("\\")
    || path.posix.isAbsolute(name)
    || path.posix.normalize(name) !== name
  ) {
    throw closedError();
  }

  const segments = name.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw closedError();
  }
  return name;
}

function validateTrackedNames(names) {
  if (!Array.isArray(names) || names.length > MAX_FILES) throw closedError();

  const seen = new Set();
  return names.map((name) => {
    const validName = validateTrackedName(name);
    if (seen.has(validName)) throw closedError();
    seen.add(validName);
    return validName;
  });
}

function parseTrackedFileList(input) {
  const bytes = asBuffer(input);
  if (bytes.byteLength > MAX_STDIN_BYTES) throw closedError();
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== 0) throw closedError();

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = [];
  let start = 0;
  try {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0) continue;
      const segment = bytes.subarray(start, index);
      if (segment.byteLength === 0 || segment.byteLength > MAX_PATH_BYTES) {
        throw closedError();
      }
      names.push(decoder.decode(segment));
      if (names.length > MAX_FILES) throw closedError();
      start = index + 1;
    }
  } catch {
    throw closedError();
  }
  if (start !== bytes.byteLength) throw closedError();
  return validateTrackedNames(names);
}

function derivePrivateLiterals(manifestBytes) {
  const bytes = asBuffer(manifestBytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MANIFEST_BYTES) {
    throw closedError();
  }

  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const manifest = validateCharacterManifest(JSON.parse(source));
    if (manifest.distributionAllowed !== false) throw closedError();

    const mediaSha256 = manifest.avatar.sha256;
    const styleId = manifest.speech.profile.styleId;
    if (
      typeof mediaSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(mediaSha256)
      || !Number.isSafeInteger(styleId)
      || styleId < 0
    ) {
      throw closedError();
    }
    return { mediaSha256, styleId };
  } catch {
    throw closedError();
  }
}

function findPrivateCharacterLeaks({ manifestBytes, listFiles, readFile }) {
  if (typeof listFiles !== "function" || typeof readFile !== "function") {
    throw closedError();
  }

  const { mediaSha256, styleId } = derivePrivateLiterals(manifestBytes);
  let names;
  try {
    names = validateTrackedNames(listFiles());
  } catch {
    throw closedError();
  }

  const hashPattern = new RegExp(mediaSha256, "i");
  const stylePattern = new RegExp(`(?:^|[^0-9])${String(styleId)}(?:[^0-9]|$)`);
  if (names.some((name) => hashPattern.test(name) || stylePattern.test(name))) {
    throw closedError();
  }

  const findings = new Set();
  let totalBytes = 0;

  for (const name of names) {
    let bytes;
    try {
      bytes = asBuffer(readFile(name));
    } catch {
      throw closedError();
    }
    if (bytes.byteLength > MAX_FILE_BYTES) throw closedError();
    if (totalBytes > MAX_TOTAL_BYTES - bytes.byteLength) throw closedError();
    totalBytes += bytes.byteLength;

    const rawText = bytes.toString("latin1");
    if (hashPattern.test(rawText) || stylePattern.test(rawText)) findings.add(name);
  }

  return [...findings].sort();
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function requireDirectoryStats(stats) {
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw closedError();
}

function requireRegularStats(stats, maximumBytes) {
  if (stats.isSymbolicLink() || !stats.isFile()) throw closedError();
  if (
    !Number.isSafeInteger(stats.size)
    || stats.size < 0
    || stats.size > maximumBytes
  ) {
    throw closedError();
  }
}

function lstatClosed(fsImpl, targetPath) {
  try {
    return fsImpl.lstatSync(targetPath);
  } catch {
    throw closedError();
  }
}

function captureDirectoryChain(fsImpl, basePath, relativeSegments) {
  const chain = [];
  let currentPath = basePath;
  const baseStats = lstatClosed(fsImpl, currentPath);
  requireDirectoryStats(baseStats);
  chain.push([currentPath, baseStats]);

  for (const segment of relativeSegments) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatClosed(fsImpl, currentPath);
    requireDirectoryStats(stats);
    chain.push([currentPath, stats]);
  }
  return chain;
}

function verifyDirectoryChain(fsImpl, chain) {
  for (const [directoryPath, expectedStats] of chain) {
    const currentStats = lstatClosed(fsImpl, directoryPath);
    requireDirectoryStats(currentStats);
    if (!sameIdentity(expectedStats, currentStats)) throw closedError();
  }
}

function readStableRegularFile(fsImpl, filePath, maximumBytes, directoryChain) {
  let descriptor;
  let result;
  let failed = false;
  try {
    verifyDirectoryChain(fsImpl, directoryChain);
    const pathStatsBefore = lstatClosed(fsImpl, filePath);
    requireRegularStats(pathStatsBefore, maximumBytes);

    const constants = fsImpl.constants ?? fs.constants;
    let flags = constants.O_RDONLY;
    if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
    descriptor = fsImpl.openSync(filePath, flags);

    const descriptorStatsBefore = fsImpl.fstatSync(descriptor);
    requireRegularStats(descriptorStatsBefore, maximumBytes);
    if (!sameIdentity(pathStatsBefore, descriptorStatsBefore)) throw closedError();

    const capacity = Math.min(descriptorStatsBefore.size + 1, maximumBytes + 1);
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
        throw closedError();
      }
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes !== descriptorStatsBefore.size) throw closedError();

    const descriptorStatsAfter = fsImpl.fstatSync(descriptor);
    requireRegularStats(descriptorStatsAfter, maximumBytes);
    if (!sameStableFile(descriptorStatsBefore, descriptorStatsAfter)) {
      throw closedError();
    }

    const pathStatsAfter = lstatClosed(fsImpl, filePath);
    requireRegularStats(pathStatsAfter, maximumBytes);
    if (!sameStableFile(descriptorStatsAfter, pathStatsAfter)) throw closedError();
    verifyDirectoryChain(fsImpl, directoryChain);
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
  if (failed || result === undefined) throw closedError();
  return result;
}

function requireCanonicalRepositoryRoot(fsImpl, repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const stats = lstatClosed(fsImpl, resolvedRoot);
  requireDirectoryStats(stats);
  try {
    if (fsImpl.realpathSync(resolvedRoot) !== resolvedRoot) throw closedError();
  } catch {
    throw closedError();
  }
  return { resolvedRoot, stats };
}

function isWithinRoot(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === ""
    || (
      relative !== ".."
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    );
}

function requireExternalManifestPath(fsImpl, manifestPath, repoRoot) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) {
    throw closedError();
  }
  const resolvedManifest = path.resolve(manifestPath);
  if (resolvedManifest !== manifestPath) throw closedError();

  let canonicalManifest;
  try {
    canonicalManifest = fsImpl.realpathSync(resolvedManifest);
  } catch {
    throw closedError();
  }
  if (
    typeof canonicalManifest !== "string"
    || isWithinRoot(repoRoot, path.resolve(canonicalManifest))
  ) {
    throw closedError();
  }
  return resolvedManifest;
}

function directoryChainForAbsoluteFile(fsImpl, filePath) {
  const parsed = path.parse(filePath);
  const segments = filePath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter((segment) => segment !== "");
  segments.pop();
  return captureDirectoryChain(fsImpl, parsed.root, segments);
}

function resolveTrackedPath(repoRoot, name) {
  const candidate = path.resolve(repoRoot, ...name.split("/"));
  if (!isWithinRoot(repoRoot, candidate) || candidate === repoRoot) throw closedError();
  return candidate;
}

function directoryChainForTrackedFile(fsImpl, repoRoot, rootStats, name) {
  const segments = name.split("/");
  segments.pop();
  const chain = [[repoRoot, rootStats]];
  let currentPath = repoRoot;
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatClosed(fsImpl, currentPath);
    requireDirectoryStats(stats);
    chain.push([currentPath, stats]);
  }
  return chain;
}

function readBoundedStdin(fsImpl) {
  const chunks = [];
  let totalBytes = 0;
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const bytesRead = fsImpl.readSync(0, buffer, 0, buffer.byteLength, null);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > buffer.byteLength) {
        throw closedError();
      }
      if (bytesRead === 0) break;
      if (totalBytes > MAX_STDIN_BYTES - bytesRead) throw closedError();
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    return Buffer.concat(chunks, totalBytes);
  } catch {
    throw closedError();
  }
}

function closedResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

function runCli(argv, deps = {}) {
  try {
    if (
      !Array.isArray(argv)
      || argv.length !== 2
      || argv[0] !== "--manifest"
    ) {
      throw closedError();
    }

    const fsImpl = deps.fsImpl ?? fs;
    const { resolvedRoot: repoRoot, stats: rootStats } = requireCanonicalRepositoryRoot(
      fsImpl,
      deps.repoRoot ?? path.join(__dirname, ".."),
    );
    const manifestPath = requireExternalManifestPath(fsImpl, argv[1], repoRoot);
    const manifestBytes = readStableRegularFile(
      fsImpl,
      manifestPath,
      MAX_MANIFEST_BYTES,
      directoryChainForAbsoluteFile(fsImpl, manifestPath),
    );
    const readStdinImpl = deps.readStdinImpl ?? (() => readBoundedStdin(fsImpl));
    const names = parseTrackedFileList(readStdinImpl());

    const findings = findPrivateCharacterLeaks({
      manifestBytes,
      listFiles: () => names,
      readFile(name) {
        const filePath = resolveTrackedPath(repoRoot, name);
        return readStableRegularFile(
          fsImpl,
          filePath,
          MAX_FILE_BYTES,
          directoryChainForTrackedFile(fsImpl, repoRoot, rootStats, name),
        );
      },
    });
    verifyDirectoryChain(fsImpl, [[repoRoot, rootStats]]);

    if (findings.length === 0) return closedResult(0);
    return closedResult(1, `${findings.join("\n")}\n`);
  } catch {
    return closedResult(2, "", `${ERROR_TOKEN}\n`);
  }
}

function main(argv, deps = {}) {
  const processImpl = deps.processImpl ?? process;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const result = runCli(argv, deps);
  try {
    if (result.stdout !== "") stdout.write(result.stdout);
    if (result.stderr !== "") stderr.write(result.stderr);
    processImpl.exitCode = result.status;
    return result.status;
  } catch {
    processImpl.exitCode = 2;
    return 2;
  }
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = {
  ERROR_TOKEN,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_MANIFEST_BYTES,
  MAX_PATH_BYTES,
  MAX_STDIN_BYTES,
  MAX_TOTAL_BYTES,
  findPrivateCharacterLeaks,
  main,
  parseTrackedFileList,
  runCli,
};
