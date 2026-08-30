"use strict";

const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const z = require("zod/v4");
const { getProvider } = require("./provider-registry.cjs");

const CHARACTER_SCHEMA_VERSION = 1;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_AVATAR_BYTES = 16 * 1024 * 1024;
const MAX_AVATAR_DIMENSION = 8192;
const MAX_AVATAR_PIXELS = 16 * 1024 * 1024;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const Percent = z.number().finite().min(0).max(100);
const SizePercent = z.number().finite().positive().max(25);
function containsUnsafeLabelCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069);
  });
}

const SafeLabel = z.string()
  .refine((value) => !containsUnsafeLabelCharacter(value))
  .transform((value) => value.trim())
  .refine(
    (value) =>
      value.normalize("NFC") === value
    && [...value].length >= 1
    && [...value].length <= 120
  );
const MouthSize = z.strictObject({
  widthPercent: SizePercent,
  heightPercent: SizePercent,
});
const CharacterManifestSchema = z.strictObject({
  schemaVersion: z.literal(CHARACTER_SCHEMA_VERSION),
  id: z.string().regex(ID_PATTERN),
  displayName: SafeLabel.refine((value) => [...value].length <= 80),
  avatar: z.strictObject({
    type: z.literal("image2d"),
    file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|webp)$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    accessibleLabel: SafeLabel,
    backgroundMode: z.enum(["transparent", "edge-connected"]),
    mouth: z.strictObject({
      xPercent: Percent,
      yPercent: Percent,
      small: MouthSize,
      open: MouthSize,
    }),
  }),
  speech: z.strictObject({
    provider: z.string().regex(ID_PATTERN),
    profile: z.unknown(),
  }),
  distributionAllowed: z.boolean(),
});

function validateCharacterId(value) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new TypeError("Character ID is invalid.");
  }
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if ((!Array.isArray(value) && !isPlainObject(value)) || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateCharacterManifest(value) {
  const manifest = CharacterManifestSchema.parse(value);
  validateCharacterId(manifest.id);
  const provider = getProvider(manifest.speech.provider);
  const profile = provider.validateProfile(manifest.speech.profile);

  return deepFreeze({
    ...manifest,
    speech: {
      ...manifest.speech,
      profile,
    },
  });
}

function requireDirectory(fsImpl, directoryPath, label) {
  const stats = fsImpl.lstatSync(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  return stats;
}

function requireRegularFileStats(stats, label) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
}

function requireRegularFile(fsImpl, filePath, label) {
  const stats = fsImpl.lstatSync(filePath);
  requireRegularFileStats(stats, label);
  return stats;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireBoundedSize(stats, maximumBytes, label, { allowEmpty }) {
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > maximumBytes) {
    throw new Error(`${label} is too large.`);
  }
  if (!allowEmpty && stats.size === 0) throw new Error(`${label} cannot be empty.`);
}

function openReadOnlyNoFollow(fsImpl, filePath, label) {
  const constants = fsImpl.constants ?? fs.constants;
  let flags = constants.O_RDONLY;
  if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;

  try {
    return fsImpl.openSync(filePath, flags);
  } catch {
    throw new Error(`${label} changed or is a symlink.`);
  }
}

function readBoundedDescriptor(
  fsImpl,
  descriptor,
  expectedSize,
  maximumBytes,
  label,
  { allowEmpty },
) {
  const bytes = Buffer.allocUnsafe(Math.min(expectedSize + 1, maximumBytes + 1));
  let totalBytes = 0;

  while (totalBytes < bytes.length) {
    const bytesRead = fsImpl.readSync(
      descriptor,
      bytes,
      totalBytes,
      bytes.length - totalBytes,
      null,
    );
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - totalBytes) {
      throw new Error(`${label} returned an invalid byte count.`);
    }
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
  }

  if (totalBytes !== expectedSize) throw new Error(`${label} changed while being read.`);
  if (!allowEmpty && totalBytes === 0) throw new Error(`${label} cannot be empty.`);
  return bytes.subarray(0, totalBytes);
}

function readBoundedFile(fsImpl, filePath, maximumBytes, label, options) {
  const pathStatsBefore = requireRegularFile(fsImpl, filePath, label);
  requireBoundedSize(pathStatsBefore, maximumBytes, label, options);

  let descriptor;
  try {
    descriptor = openReadOnlyNoFollow(fsImpl, filePath, label);
    const descriptorStatsBefore = fsImpl.fstatSync(descriptor);
    requireRegularFileStats(descriptorStatsBefore, label);
    requireBoundedSize(descriptorStatsBefore, maximumBytes, label, options);
    if (!sameFileIdentity(pathStatsBefore, descriptorStatsBefore)) {
      throw new Error(`${label} identity changed before opening.`);
    }

    const bytes = readBoundedDescriptor(
      fsImpl,
      descriptor,
      descriptorStatsBefore.size,
      maximumBytes,
      label,
      options,
    );
    const descriptorStatsAfter = fsImpl.fstatSync(descriptor);
    if (
      !sameFileIdentity(descriptorStatsBefore, descriptorStatsAfter)
      || descriptorStatsBefore.size !== descriptorStatsAfter.size
      || descriptorStatsBefore.mtimeMs !== descriptorStatsAfter.mtimeMs
      || descriptorStatsBefore.ctimeMs !== descriptorStatsAfter.ctimeMs
    ) {
      throw new Error(`${label} changed while being read.`);
    }

    const pathStatsAfter = requireRegularFile(fsImpl, filePath, label);
    if (!sameFileIdentity(descriptorStatsAfter, pathStatsAfter)) {
      throw new Error(`${label} identity changed while being read.`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }
}

function requireStableDirectory(fsImpl, directoryPath, expectedStats, label) {
  let currentStats;
  try {
    currentStats = requireDirectory(fsImpl, directoryPath, label);
  } catch {
    throw new Error(`${label} identity changed during character-pack loading.`);
  }
  if (!sameFileIdentity(expectedStats, currentStats)) {
    throw new Error(`${label} identity changed during character-pack loading.`);
  }
}

function validateImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("Avatar image dimensions are invalid.");
  }
  if (width > MAX_AVATAR_DIMENSION || height > MAX_AVATAR_DIMENSION) {
    throw new Error("Avatar image dimensions are too large.");
  }
  if (width > Math.floor(MAX_AVATAR_PIXELS / height)) {
    throw new Error("Avatar image pixel count is too large.");
  }
}

function parsePngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Avatar PNG signature or header is invalid.");
  }
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Avatar PNG IHDR is invalid.");
  }

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  validateImageDimensions(width, height);
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function parseWebpDimensions(bytes) {
  if (
    bytes.length < 20
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WEBP"
  ) {
    throw new Error("Avatar WebP signature or header is invalid.");
  }

  const riffEnd = bytes.readUInt32LE(4) + 8;
  if (riffEnd !== bytes.length) throw new Error("Avatar WebP container is truncated.");

  const kind = bytes.toString("ascii", 12, 16);
  const chunkLength = bytes.readUInt32LE(16);
  const chunkEnd = 20 + chunkLength;
  const paddedChunkEnd = chunkEnd + (chunkLength % 2);
  if (chunkEnd > bytes.length || paddedChunkEnd > riffEnd) {
    throw new Error("Avatar WebP header is truncated.");
  }

  let width;
  let height;
  if (kind === "VP8 ") {
    if (
      chunkLength < 10
      || (bytes[20] & 1) !== 0
      || bytes[23] !== 0x9d
      || bytes[24] !== 0x01
      || bytes[25] !== 0x2a
    ) {
      throw new Error("Avatar WebP VP8 header is invalid.");
    }
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  } else if (kind === "VP8L") {
    if (chunkLength < 5 || bytes[20] !== 0x2f) {
      throw new Error("Avatar WebP VP8L header is invalid.");
    }
    const dimensions = bytes.readUInt32LE(21);
    width = (dimensions & 0x3fff) + 1;
    height = ((dimensions >>> 14) & 0x3fff) + 1;
  } else if (kind === "VP8X") {
    if (chunkLength < 10) throw new Error("Avatar WebP VP8X header is invalid.");
    width = readUInt24LE(bytes, 24) + 1;
    height = readUInt24LE(bytes, 27) + 1;
  } else {
    throw new Error("Avatar WebP chunk kind is unsupported.");
  }

  validateImageDimensions(width, height);
}

function validateAvatarImage(bytes, avatarFile) {
  const extension = path.extname(avatarFile);
  if (extension === ".png") {
    parsePngDimensions(bytes);
    return "image/png";
  }
  if (extension === ".webp") {
    parseWebpDimensions(bytes);
    return "image/webp";
  }
  throw new Error("Avatar image format is unsupported.");
}

function verifyAvatarHash(bytes, expectedHex) {
  const actual = nodeCrypto.createHash("sha256").update(bytes).digest();
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length || !nodeCrypto.timingSafeEqual(actual, expected)) {
    throw new Error("Avatar SHA-256 digest does not match the manifest.");
  }
}

function createLoadedPack(manifest, avatarBytes, avatarMimeType) {
  const privateAvatarBytes = Buffer.from(avatarBytes);
  const pack = {
    manifest,
    avatarMimeType,
  };
  Object.defineProperty(pack, "avatarBytes", {
    enumerable: true,
    configurable: false,
    get: () => Buffer.from(privateAvatarBytes),
  });
  return Object.freeze(pack);
}

function loadCharacterPack(packDirectory, deps = {}) {
  if (typeof packDirectory !== "string" || !packDirectory) {
    throw new TypeError("Character pack directory is required.");
  }
  const fsImpl = deps.fsImpl ?? fs;
  const resolvedPackDirectory = path.resolve(packDirectory);
  const charactersRoot = path.dirname(resolvedPackDirectory);
  const charactersRootStats = requireDirectory(fsImpl, charactersRoot, "Characters root");
  const packDirectoryStats = requireDirectory(fsImpl, resolvedPackDirectory, "Character pack");

  function requireStableDirectories() {
    requireStableDirectory(fsImpl, charactersRoot, charactersRootStats, "Characters root");
    requireStableDirectory(fsImpl, resolvedPackDirectory, packDirectoryStats, "Character pack");
  }

  const manifestPath = path.join(resolvedPackDirectory, "character.json");
  const manifestBytes = readBoundedFile(
    fsImpl,
    manifestPath,
    MAX_MANIFEST_BYTES,
    "Character manifest",
    { allowEmpty: true },
  );
  requireStableDirectories();

  let value;
  try {
    value = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Character manifest contains invalid JSON.");
  }
  const manifest = validateCharacterManifest(value);
  if (manifest.id !== path.basename(resolvedPackDirectory)) {
    throw new Error("Character manifest ID must match its pack directory.");
  }
  if (path.basename(manifest.avatar.file) !== manifest.avatar.file) {
    throw new Error("Avatar file must be a direct pack child.");
  }

  const avatarPath = path.join(resolvedPackDirectory, manifest.avatar.file);
  const avatarBytes = readBoundedFile(
    fsImpl,
    avatarPath,
    MAX_AVATAR_BYTES,
    "Character avatar",
    { allowEmpty: false },
  );
  requireStableDirectories();
  const avatarMimeType = validateAvatarImage(avatarBytes, manifest.avatar.file);
  verifyAvatarHash(avatarBytes, manifest.avatar.sha256);

  return createLoadedPack(manifest, avatarBytes, avatarMimeType);
}

module.exports = {
  CHARACTER_SCHEMA_VERSION,
  MAX_AVATAR_BYTES,
  loadCharacterPack,
  validateCharacterId,
  validateCharacterManifest,
};
