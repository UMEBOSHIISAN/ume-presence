"use strict";

const { createHash, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { listPackage } = require("@electron/asar");

const ERROR_TOKEN = "UME_PERSONA_PACKAGE_INSPECTION_FAILED";
const SUCCESS_TOKEN = "UME_PERSONA_PACKAGE_INSPECTION_OK";
const PRODUCT = "UME Presence";
const APPLICATION_BASENAME = "UME Presence.app";
const MANIFEST_SCHEMA = "ume-persona-package-manifest.v1";
const MAX_ENTRIES = 100_000;
const MAX_ENTRY_LENGTH = 4_096;

const REQUIRED_ASAR_ENTRIES = Object.freeze([
  "/LICENSE",
  "/NOTICE",
  "/dist/index.html",
  "/package.json",
]);
const REQUIRED_RESOURCE_ENTRIES = Object.freeze([
  "app.asar",
  "integrations/persona-auto-speech-hook.cjs",
  "integrations/persona-auto-speech-selection.cjs",
  "native/darwin/persona-audio-listener",
]);
const CRITICAL_HASH_ENTRIES = Object.freeze([
  "app.asar",
  "integrations/persona-auto-speech-hook.cjs",
  "integrations/persona-auto-speech-selection.cjs",
  "native/darwin/persona-audio-listener",
]);
const PRIVATE_CHARACTER_MEDIA_EXTENSIONS = new Set([
  ".aac",
  ".aiff",
  ".aivm",
  ".bin",
  ".bmp",
  ".ckpt",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".ogg",
  ".onnx",
  ".png",
  ".pth",
  ".safetensors",
  ".svg",
  ".vrm",
  ".vrma",
  ".wav",
  ".webp",
]);
const ALLOWED_ASAR_MEDIA_ENTRIES = new Set([
  "/build/icon.png",
]);

function closedError() {
  return new Error(ERROR_TOKEN);
}

function canonicalizeAsarEntries(entries, separator) {
  if (
    !Array.isArray(entries)
    || entries.length > MAX_ENTRIES
    || (separator !== "/" && separator !== "\\")
  ) {
    throw closedError();
  }
  return entries.map((entry) => {
    if (typeof entry !== "string") throw closedError();
    return separator === "\\" ? entry.replaceAll("\\", "/") : entry;
  });
}

function validateEntryList(entries, { asar }) {
  if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw closedError();
  const unique = new Set();
  for (const entry of entries) {
    if (
      typeof entry !== "string"
      || entry.length === 0
      || entry.length > MAX_ENTRY_LENGTH
      || entry.includes("\0")
      || entry.includes("\\")
    ) {
      throw closedError();
    }
    const normalized = path.posix.normalize(entry);
    if (normalized !== entry) throw closedError();
    if (asar) {
      if (!entry.startsWith("/") || entry.startsWith("//")) throw closedError();
    } else if (entry.startsWith("/") || entry === ".") {
      throw closedError();
    }
    if (entry.split("/").some((component) => component === "..")) throw closedError();
    if (unique.has(entry)) throw closedError();
    unique.add(entry);
  }
  return unique;
}

function rejectsCharacterMedia(entry, { asar }) {
  const lower = entry.toLowerCase();
  const components = lower.split("/").filter(Boolean);
  const basename = components.at(-1) ?? "";
  const extension = path.posix.extname(basename);
  if (extension === ".vrm" || extension === ".vrma") return true;
  if (components.includes("local-character")) return true;
  if (basename === "character.json") return true;
  if (!PRIVATE_CHARACTER_MEDIA_EXTENSIONS.has(extension)) return false;
  return !asar || !ALLOWED_ASAR_MEDIA_ENTRIES.has(entry);
}

function validatePackageInventory({ asarEntries, resourceEntries } = {}) {
  const asarSet = validateEntryList(asarEntries, { asar: true });
  const resourceSet = validateEntryList(resourceEntries, { asar: false });
  if (
    asarEntries.some((entry) => rejectsCharacterMedia(entry, { asar: true }))
    || resourceEntries.some((entry) => rejectsCharacterMedia(entry, { asar: false }))
  ) {
    throw closedError();
  }
  for (const required of REQUIRED_ASAR_ENTRIES) {
    if (!asarSet.has(required)) throw closedError();
  }
  for (const required of REQUIRED_RESOURCE_ENTRIES) {
    if (!resourceSet.has(required)) throw closedError();
  }
  return Object.freeze({
    product: PRODUCT,
    asarEntryCount: asarEntries.length,
    resourceEntryCount: resourceEntries.length,
  });
}

function validateHashes(hashes) {
  if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)) {
    throw closedError();
  }
  if (
    Object.keys(hashes).length !== CRITICAL_HASH_ENTRIES.length
    || CRITICAL_HASH_ENTRIES.some(
      (entry) => !/^[0-9a-f]{64}$/.test(hashes[entry] ?? ""),
    )
  ) {
    throw closedError();
  }
  return Object.freeze(
    Object.fromEntries(CRITICAL_HASH_ENTRIES.map((entry) => [entry, hashes[entry]])),
  );
}

function createPackageManifest({ appPath, asarEntries, resourceEntries, hashes } = {}) {
  validatePackageInventory({ asarEntries, resourceEntries });
  if (path.basename(appPath ?? "") !== APPLICATION_BASENAME) throw closedError();
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA,
    product: PRODUCT,
    application: APPLICATION_BASENAME,
    sha256: validateHashes(hashes),
    asarEntries: Object.freeze([...asarEntries].sort()),
    resourceEntries: Object.freeze([...resourceEntries].sort()),
  };
  return Object.freeze(manifest);
}

async function requireNode(targetPath, type) {
  const stat = await fs.promises.lstat(targetPath);
  if (stat.isSymbolicLink()) throw closedError();
  if (type === "directory" && !stat.isDirectory()) throw closedError();
  if (type === "file" && !stat.isFile()) throw closedError();
  return stat;
}

async function listResourceFiles(resourcesPath) {
  const files = [];
  const pending = [""];
  let visited = 0;
  while (pending.length > 0) {
    const relativeDirectory = pending.pop();
    const absoluteDirectory = relativeDirectory
      ? path.join(resourcesPath, ...relativeDirectory.split("/"))
      : resourcesPath;
    const names = await fs.promises.readdir(absoluteDirectory);
    names.sort();
    for (const name of names) {
      visited += 1;
      if (visited > MAX_ENTRIES) throw closedError();
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      validateEntryList([relativePath], { asar: false });
      const absolutePath = path.join(resourcesPath, ...relativePath.split("/"));
      const stat = await fs.promises.lstat(absolutePath);
      if (stat.isSymbolicLink()) throw closedError();
      if (stat.isDirectory()) {
        pending.push(relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        throw closedError();
      }
    }
  }
  return files.sort();
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function inspectMacApp({ appPath, outputPath } = {}) {
  try {
    if (
      typeof appPath !== "string"
      || typeof outputPath !== "string"
      || !path.isAbsolute(appPath)
      || !path.isAbsolute(outputPath)
      || path.basename(appPath) !== APPLICATION_BASENAME
    ) {
      throw closedError();
    }
    await requireNode(appPath, "directory");
    const resourcesPath = path.join(appPath, "Contents", "Resources");
    await requireNode(resourcesPath, "directory");
    const asarPath = path.join(resourcesPath, "app.asar");
    await requireNode(asarPath, "file");

    const asarEntries = canonicalizeAsarEntries(listPackage(asarPath), path.sep);
    const resourceEntries = await listResourceFiles(resourcesPath);
    validatePackageInventory({ asarEntries, resourceEntries });

    const hashes = {};
    for (const relativePath of CRITICAL_HASH_ENTRIES) {
      const absolutePath = path.join(resourcesPath, ...relativePath.split("/"));
      await requireNode(absolutePath, "file");
      hashes[relativePath] = await sha256File(absolutePath);
    }
    const manifest = createPackageManifest({
      appPath,
      asarEntries,
      resourceEntries,
      hashes,
    });
    const parentPath = path.dirname(outputPath);
    await requireNode(parentPath, "directory");
    const temporaryPath = path.join(
      parentPath,
      `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      await fs.promises.writeFile(
        temporaryPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      await fs.promises.rename(temporaryPath, outputPath);
    } finally {
      await fs.promises.rm(temporaryPath, { force: true });
    }
    return manifest;
  } catch {
    throw closedError();
  }
}

function parseCliArgs(argv) {
  if (
    argv.length !== 4
    || argv[0] !== "--app"
    || argv[2] !== "--output"
  ) {
    throw closedError();
  }
  return { appPath: argv[1], outputPath: argv[3] };
}

async function runCli() {
  try {
    await inspectMacApp(parseCliArgs(process.argv.slice(2)));
    process.stdout.write(`${SUCCESS_TOKEN}\n`);
  } catch {
    process.stderr.write(`${ERROR_TOKEN}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void runCli();
}

module.exports = {
  ERROR_TOKEN,
  SUCCESS_TOKEN,
  canonicalizeAsarEntries,
  createPackageManifest,
  inspectMacApp,
  validatePackageInventory,
};
