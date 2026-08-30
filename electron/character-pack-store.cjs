"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  loadCharacterPack,
  validateCharacterId,
} = require("./character-pack.cjs");

const MAX_PACK_ENTRIES = 64;
const MAX_SELECTION_BYTES = 4 * 1024;
const SELECTION_SCHEMA_VERSION = 1;

function isMissing(error) {
  return error !== null
    && typeof error === "object"
    && error.code === "ENOENT";
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function compareIds(left, right) {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function readPackEntries(fsImpl, charactersRoot) {
  let directory;
  try {
    directory = fsImpl.opendirSync(charactersRoot);
  } catch {
    throw new Error("Character pack entries are unavailable.");
  }

  const entries = [];
  let readFailed = false;
  let closeFailed = false;
  let tooMany = false;
  let complete = false;
  while (!complete && !readFailed && !tooMany) {
    let entry;
    try {
      entry = directory.readSync();
    } catch {
      readFailed = true;
      continue;
    }
    if (entry === null) {
      complete = true;
    } else if (entries.length === MAX_PACK_ENTRIES) {
      tooMany = true;
    } else {
      entries.push(entry);
    }
  }

  try {
    directory.closeSync();
  } catch {
    closeFailed = true;
  }
  if (tooMany) {
    throw new Error("Character pack entries exceed the 64-entry limit.");
  }
  if (readFailed || closeFailed) {
    throw new Error("Character pack entries are unavailable.");
  }
  return entries;
}

function selectionError() {
  return new Error("Character selection is invalid.");
}

function readSelectionBytes(fsImpl, filePath) {
  let pathStatsBefore;
  try {
    pathStatsBefore = fsImpl.lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw selectionError();
  }
  if (
    pathStatsBefore.isSymbolicLink()
    || !pathStatsBefore.isFile()
    || !Number.isSafeInteger(pathStatsBefore.size)
    || pathStatsBefore.size < 0
    || pathStatsBefore.size > MAX_SELECTION_BYTES
  ) {
    throw selectionError();
  }

  const constants = fsImpl.constants ?? fs.constants;
  let flags = constants.O_RDONLY;
  if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;

  let descriptor;
  let bytes;
  let failed = false;
  try {
    descriptor = fsImpl.openSync(filePath, flags);
    const descriptorStatsBefore = fsImpl.fstatSync(descriptor);
    if (
      !descriptorStatsBefore.isFile()
      || !sameFileIdentity(pathStatsBefore, descriptorStatsBefore)
      || !Number.isSafeInteger(descriptorStatsBefore.size)
      || descriptorStatsBefore.size < 0
      || descriptorStatsBefore.size > MAX_SELECTION_BYTES
    ) {
      throw selectionError();
    }

    const buffer = Buffer.alloc(descriptorStatsBefore.size + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const bytesRead = fsImpl.readSync(
        descriptor,
        buffer,
        totalBytes,
        buffer.length - totalBytes,
        null,
      );
      if (
        !Number.isSafeInteger(bytesRead)
        || bytesRead < 0
        || bytesRead > buffer.length - totalBytes
      ) {
        throw selectionError();
      }
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    if (totalBytes !== descriptorStatsBefore.size) throw selectionError();

    const descriptorStatsAfter = fsImpl.fstatSync(descriptor);
    const pathStatsAfter = fsImpl.lstatSync(filePath);
    if (
      !sameFileIdentity(descriptorStatsBefore, descriptorStatsAfter)
      || !sameFileIdentity(descriptorStatsAfter, pathStatsAfter)
      || descriptorStatsBefore.size !== descriptorStatsAfter.size
      || descriptorStatsBefore.mtimeMs !== descriptorStatsAfter.mtimeMs
      || descriptorStatsBefore.ctimeMs !== descriptorStatsAfter.ctimeMs
      || pathStatsAfter.isSymbolicLink()
      || !pathStatsAfter.isFile()
    ) {
      throw selectionError();
    }
    bytes = buffer.subarray(0, totalBytes);
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
  if (failed) throw selectionError();
  return bytes;
}

function parseSelection(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw selectionError();
  }

  if (!isPlainObject(value)) throw selectionError();
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 2
    || keys[0] !== "activeCharacterId"
    || keys[1] !== "schemaVersion"
    || value.schemaVersion !== SELECTION_SCHEMA_VERSION
  ) {
    throw selectionError();
  }
  try {
    validateCharacterId(value.activeCharacterId);
  } catch {
    throw selectionError();
  }
  return Object.freeze({
    schemaVersion: SELECTION_SCHEMA_VERSION,
    activeCharacterId: value.activeCharacterId,
  });
}

function createCharacterPackStore({
  userDataPath,
  fsImpl = fs,
  loadPack = loadCharacterPack,
}) {
  if (typeof userDataPath !== "string" || !userDataPath) {
    throw new TypeError("Electron user data path is required.");
  }
  if (fsImpl === null || typeof fsImpl !== "object") {
    throw new TypeError("Filesystem implementation is required.");
  }
  if (typeof loadPack !== "function") {
    throw new TypeError("Character pack loader is required.");
  }

  const resolvedUserDataPath = path.resolve(userDataPath);
  const charactersRoot = path.join(resolvedUserDataPath, "characters");
  const selectedCharacterPath = path.join(
    resolvedUserDataPath,
    "character-selection.json",
  );

  function inspectCharactersRoot({ allowMissing }) {
    let stats;
    try {
      stats = fsImpl.lstatSync(charactersRoot);
    } catch (error) {
      if (allowMissing && isMissing(error)) return null;
      throw new Error("Characters root is unavailable.", { cause: error });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Characters root must be a non-symlink directory.");
    }

    let realRoot;
    try {
      realRoot = fsImpl.realpathSync(charactersRoot);
    } catch {
      throw new Error("Characters root real path is unavailable.");
    }
    if (realRoot !== charactersRoot) {
      throw new Error("Characters root real path must match its lexical path.");
    }
    return Object.freeze({ stats });
  }

  function requireStableCharactersRoot(expected) {
    let current;
    try {
      current = fsImpl.lstatSync(charactersRoot);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameFileIdentity(expected.stats, current)
        || fsImpl.realpathSync(charactersRoot) !== charactersRoot
      ) {
        throw new Error("changed");
      }
    } catch {
      throw new Error("Characters root changed during inspection.");
    }
  }

  function inspectPackEntry(id, expectedRoot) {
    const packDirectory = path.join(charactersRoot, id);
    let stats;
    try {
      stats = fsImpl.lstatSync(packDirectory);
    } catch {
      throw new Error("Character pack is unavailable.");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Character pack must be a non-symlink directory.");
    }
    let realPackDirectory;
    try {
      realPackDirectory = fsImpl.realpathSync(packDirectory);
    } catch {
      throw new Error("Character pack is unavailable.");
    }
    if (realPackDirectory !== packDirectory) {
      throw new Error("Character pack real path must match its lexical path.");
    }
    requireStableCharactersRoot(expectedRoot);
    return Object.freeze({ packDirectory, stats });
  }

  function requireStablePackEntry(entry, expectedRoot) {
    let current;
    try {
      current = fsImpl.lstatSync(entry.packDirectory);
      if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || !sameFileIdentity(entry.stats, current)
        || fsImpl.realpathSync(entry.packDirectory) !== entry.packDirectory
      ) {
        throw new Error("changed");
      }
    } catch {
      throw new Error("Character pack changed during inspection.");
    }
    requireStableCharactersRoot(expectedRoot);
  }

  function readSelection() {
    const bytes = readSelectionBytes(fsImpl, selectedCharacterPath);
    return bytes === null ? null : parseSelection(bytes);
  }

  function inspectUserDataRoot() {
    let stats;
    let realRoot;
    try {
      stats = fsImpl.lstatSync(resolvedUserDataPath);
      realRoot = fsImpl.realpathSync(resolvedUserDataPath);
    } catch {
      throw selectionError();
    }
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || realRoot !== resolvedUserDataPath
    ) {
      throw selectionError();
    }
    return Object.freeze({ dev: stats.dev, ino: stats.ino });
  }

  function requireStableUserDataRoot(expectedIdentity) {
    let current;
    let realRoot;
    try {
      current = fsImpl.lstatSync(resolvedUserDataPath);
      realRoot = fsImpl.realpathSync(resolvedUserDataPath);
    } catch {
      throw selectionError();
    }
    if (
      current.isSymbolicLink()
      || !current.isDirectory()
      || !sameFileIdentity(expectedIdentity, current)
      || realRoot !== resolvedUserDataPath
    ) {
      throw selectionError();
    }
  }

  function inspectSelectionDestination() {
    let stats;
    try {
      stats = fsImpl.lstatSync(selectedCharacterPath);
    } catch (error) {
      if (isMissing(error)) return Object.freeze({ exists: false });
      throw selectionError();
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw selectionError();
    return Object.freeze({
      exists: true,
      identity: Object.freeze({ dev: stats.dev, ino: stats.ino }),
    });
  }

  function requireUnchangedSelectionDestination(expected) {
    let current;
    try {
      current = fsImpl.lstatSync(selectedCharacterPath);
    } catch (error) {
      if (isMissing(error) && !expected.exists) return;
      throw selectionError();
    }
    if (
      !expected.exists
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameFileIdentity(expected.identity, current)
    ) {
      throw selectionError();
    }
  }

  function createTemporarySelection(temporary, payload) {
    if (Buffer.byteLength(payload, "utf8") > MAX_SELECTION_BYTES) {
      throw selectionError();
    }

    let descriptor;
    let identity;
    let failed = false;
    let failure;
    try {
      descriptor = fsImpl.openSync(temporary, "wx", 0o600);
      const stats = fsImpl.fstatSync(descriptor);
      if (!stats.isFile()) throw selectionError();
      identity = Object.freeze({ dev: stats.dev, ino: stats.ino });
      fsImpl.writeFileSync(descriptor, payload, { encoding: "utf8" });
    } catch (error) {
      failed = true;
      failure = error;
    }

    if (descriptor !== undefined) {
      try {
        fsImpl.closeSync(descriptor);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
    if (failed) throw failure;
    return identity;
  }

  function isExpectedRegularFile(stats, expectedIdentity) {
    return !stats.isSymbolicLink()
      && stats.isFile()
      && sameFileIdentity(expectedIdentity, stats);
  }

  function requireOwnedTemporary(temporary, expectedIdentity) {
    let current;
    try {
      current = fsImpl.lstatSync(temporary);
    } catch {
      throw selectionError();
    }
    if (!isExpectedRegularFile(current, expectedIdentity)) {
      throw selectionError();
    }
  }

  function removeOwnedTemporary(temporary, expectedIdentity) {
    try {
      const current = fsImpl.lstatSync(temporary);
      if (!isExpectedRegularFile(current, expectedIdentity)) return;
      fsImpl.unlinkSync(temporary);
    } catch {
      // Preserve the original failure; this store never retries.
    }
  }

  function list() {
    const root = inspectCharactersRoot({ allowMissing: true });
    if (root === null) return Object.freeze([]);

    const entries = readPackEntries(fsImpl, charactersRoot);
    requireStableCharactersRoot(root);
    entries.sort((left, right) => {
      if (left.name < right.name) return -1;
      if (left.name > right.name) return 1;
      return 0;
    });

    const manifestIds = new Set();
    const summaries = [];
    for (const entry of entries) {
      try {
        validateCharacterId(entry.name);
      } catch {
        throw new Error("Character pack entry name is unsafe.");
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error("Character pack entry must be a non-symlink directory.");
      }

      const inspectedEntry = inspectPackEntry(entry.name, root);
      let pack;
      let invalid = false;
      try {
        pack = loadPack(inspectedEntry.packDirectory);
      } catch {
        invalid = true;
      }
      requireStablePackEntry(inspectedEntry, root);

      let id;
      let displayName;
      if (!invalid) {
        try {
          id = validateCharacterId(pack.manifest.id);
          displayName = pack.manifest.displayName;
          if (typeof displayName !== "string") throw new Error("invalid");
        } catch {
          invalid = true;
        }
      }
      if (invalid) {
        summaries.push(Object.freeze({
          id: entry.name,
          displayName: null,
          valid: false,
          errorCode: "INVALID_PACK",
        }));
        continue;
      }
      if (manifestIds.has(id)) {
        throw new Error("Duplicate character manifest ID detected.");
      }
      manifestIds.add(id);
      summaries.push(Object.freeze({ id, displayName, valid: true }));
    }

    requireStableCharactersRoot(root);
    summaries.sort(compareIds);
    return Object.freeze(summaries);
  }

  function status() {
    const selection = readSelection();
    if (selection === null) {
      return Object.freeze({ activeCharacterId: null, available: false });
    }
    let available = false;
    try {
      validate(selection.activeCharacterId);
      available = true;
    } catch {
      // A valid selection can outlive a removed or invalid pack.
    }
    return Object.freeze({
      activeCharacterId: selection.activeCharacterId,
      available,
    });
  }

  function validate(id) {
    validateCharacterId(id);
    const root = inspectCharactersRoot({ allowMissing: false });
    const entry = inspectPackEntry(id, root);
    const pack = loadPack(entry.packDirectory);
    requireStablePackEntry(entry, root);
    return pack;
  }

  function select(id) {
    const userDataRoot = inspectUserDataRoot();
    validate(id);
    requireStableUserDataRoot(userDataRoot);
    const destination = inspectSelectionDestination();
    fsImpl.mkdirSync(resolvedUserDataPath, { recursive: true, mode: 0o700 });
    requireStableUserDataRoot(userDataRoot);
    const temporary = path.join(
      resolvedUserDataPath,
      `.character-selection.${process.pid}.tmp`,
    );
    const payload = `${JSON.stringify({
      schemaVersion: SELECTION_SCHEMA_VERSION,
      activeCharacterId: id,
    })}\n`;

    const temporaryIdentity = createTemporarySelection(temporary, payload);
    try {
      requireOwnedTemporary(temporary, temporaryIdentity);
      requireStableUserDataRoot(userDataRoot);
      requireUnchangedSelectionDestination(destination);
      fsImpl.renameSync(temporary, selectedCharacterPath);
    } catch (error) {
      removeOwnedTemporary(temporary, temporaryIdentity);
      throw error;
    }
    return Object.freeze({ activeCharacterId: id, restartRequired: true });
  }

  function getActive() {
    const selection = readSelection();
    if (selection === null) {
      throw new Error("Active character selection is unavailable.");
    }
    try {
      return validate(selection.activeCharacterId);
    } catch {
      throw new Error("Active character pack is unavailable.");
    }
  }

  return Object.freeze({ list, status, validate, select, getActive });
}

module.exports = {
  createCharacterPackStore,
};
