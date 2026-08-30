"use strict";

const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createCharacterPackStore,
} = require("./character-pack-store.cjs");

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function pngBytes(width = 16, height = 16) {
  const bytes = Buffer.alloc(33);
  PNG_SIGNATURE.copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function avatarSha256(avatarBytes) {
  return nodeCrypto.createHash("sha256").update(avatarBytes).digest("hex");
}

function validManifest(id, displayName, avatarBytes) {
  return {
    schemaVersion: 1,
    id,
    displayName,
    avatar: {
      type: "image2d",
      file: "avatar.png",
      sha256: avatarSha256(avatarBytes),
      accessibleLabel: displayName,
      backgroundMode: "transparent",
      mouth: {
        xPercent: 50,
        yPercent: 20,
        small: { widthPercent: 1.2, heightPercent: 0.3 },
        open: { widthPercent: 1.7, heightPercent: 0.7 },
      },
    },
    speech: {
      provider: "aivis",
      profile: {
        styleId: 123,
        speedScale: 1,
        tempoDynamicsScale: 1,
        pitchScale: 0,
        volumeScale: 1,
      },
    },
    distributionAllowed: false,
  };
}

function temporaryRoot(context) {
  // macOS exposes /var as a symlink to /private/var. Canonicalizing the
  // fixture ancestor keeps the production lexical-versus-realpath check real.
  const temporaryBase = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryBase, "persona-pack-store-"));
  const canonicalRoot = fs.realpathSync(root);
  context.after(() => fs.rmSync(canonicalRoot, { recursive: true, force: true }));
  return canonicalRoot;
}

function writePack(userDataPath, id, displayName = id) {
  const avatarBytes = pngBytes();
  const packDirectory = path.join(userDataPath, "characters", id);
  fs.mkdirSync(packDirectory, { recursive: true });
  fs.writeFileSync(path.join(packDirectory, "avatar.png"), avatarBytes);
  fs.writeFileSync(
    path.join(packDirectory, "character.json"),
    `${JSON.stringify(validManifest(id, displayName, avatarBytes))}\n`,
  );
  return packDirectory;
}

function selectionPath(userDataPath) {
  return path.join(userDataPath, "character-selection.json");
}

function writeSelection(userDataPath, id, extra = {}) {
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.writeFileSync(
    selectionPath(userDataPath),
    `${JSON.stringify({ schemaVersion: 1, activeCharacterId: id, ...extra })}\n`,
  );
}

function directorySymlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

test("lists valid packs deterministically and manages the active selection", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "beta", "Beta Character");
  writePack(userDataPath, "alpha", "Alpha Character");
  const store = createCharacterPackStore({ userDataPath });

  assert.deepEqual(store.list(), [
    { id: "alpha", displayName: "Alpha Character", valid: true },
    { id: "beta", displayName: "Beta Character", valid: true },
  ]);
  assert.deepEqual(store.status(), {
    activeCharacterId: null,
    available: false,
  });

  assert.deepEqual(store.select("beta"), {
    activeCharacterId: "beta",
    restartRequired: true,
  });
  assert.deepEqual(store.status(), {
    activeCharacterId: "beta",
    available: true,
  });
  assert.equal(store.getActive().manifest.id, "beta");
  assert.equal(
    fs.readFileSync(selectionPath(userDataPath), "utf8"),
    `${JSON.stringify({ schemaVersion: 1, activeCharacterId: "beta" })}\n`,
  );
});

test("list, status, and validate perform no writes", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writeSelection(userDataPath, "alpha");

  const fsImpl = Object.create(fs);
  const writeCalls = [];
  for (const method of [
    "appendFileSync",
    "chmodSync",
    "copyFileSync",
    "mkdirSync",
    "renameSync",
    "rmSync",
    "truncateSync",
    "unlinkSync",
    "writeFileSync",
  ]) {
    fsImpl[method] = (...args) => {
      writeCalls.push([method, ...args]);
      throw new Error(`unexpected write through ${method}`);
    };
  }

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.deepEqual(store.list().map(({ id }) => id), ["alpha"]);
  assert.deepEqual(store.status(), {
    activeCharacterId: "alpha",
    available: true,
  });
  assert.equal(store.validate("alpha").manifest.id, "alpha");
  assert.deepEqual(writeCalls, []);
});

test("status validates only the selected pack", (context) => {
  const userDataPath = temporaryRoot(context);
  for (const id of ["alpha", "beta", "gamma"]) {
    fs.mkdirSync(path.join(userDataPath, "characters", id), {
      recursive: true,
    });
  }
  writeSelection(userDataPath, "beta");
  const loadedIds = [];
  const loadPack = (packDirectory) => {
    const id = path.basename(packDirectory);
    loadedIds.push(id);
    if (id !== "beta") throw new Error("unselected pack must not be loaded");
    return { manifest: { id, displayName: "Beta Character" } };
  };

  const store = createCharacterPackStore({ userDataPath, loadPack });
  assert.deepEqual(store.status(), {
    activeCharacterId: "beta",
    available: true,
  });
  assert.deepEqual(loadedIds, ["beta"]);
});

test("list returns a stable closed summary for an individually malformed pack", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  fs.mkdirSync(path.join(userDataPath, "characters", "broken"), {
    recursive: true,
  });

  const summaries = createCharacterPackStore({ userDataPath }).list();
  assert.deepEqual(summaries, [
    { id: "alpha", displayName: "Alpha Character", valid: true },
    {
      id: "broken",
      displayName: null,
      valid: false,
      errorCode: "INVALID_PACK",
    },
  ]);
  assert.equal(Object.hasOwn(summaries[1], "error"), false);
  assert.equal(Object.hasOwn(summaries[1], "manifest"), false);
});

test("list fails closed on unsafe or non-directory entries", (context) => {
  const unsafeUserData = temporaryRoot(context);
  fs.mkdirSync(path.join(unsafeUserData, "characters", "Bad ID"), {
    recursive: true,
  });
  assert.throws(
    () => createCharacterPackStore({ userDataPath: unsafeUserData }).list(),
    /entry|unsafe/i,
  );

  const fileUserData = temporaryRoot(context);
  fs.mkdirSync(path.join(fileUserData, "characters"), { recursive: true });
  fs.writeFileSync(path.join(fileUserData, "characters", "alpha"), "not a pack");
  assert.throws(
    () => createCharacterPackStore({ userDataPath: fileUserData }).list(),
    /entry|directory/i,
  );
});

test("rejects a symlinked characters root", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const backingUserData = path.join(fixtureRoot, "backing");
  const userDataPath = path.join(fixtureRoot, "user-data");
  writePack(backingUserData, "alpha", "Alpha Character");
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.symlinkSync(
    path.join(backingUserData, "characters"),
    path.join(userDataPath, "characters"),
    directorySymlinkType(),
  );

  const store = createCharacterPackStore({ userDataPath });
  assert.throws(() => store.list(), /root|symlink/i);
  assert.throws(() => store.validate("alpha"), /root|symlink/i);
});

test("rejects a characters root reached through a symlinked ancestor", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const realParent = path.join(fixtureRoot, "real-parent");
  const realUserData = path.join(realParent, "user-data");
  const linkedParent = path.join(fixtureRoot, "linked-parent");
  writePack(realUserData, "alpha", "Alpha Character");
  fs.symlinkSync(realParent, linkedParent, directorySymlinkType());

  const userDataPath = path.join(linkedParent, "user-data");
  const store = createCharacterPackStore({ userDataPath });
  assert.throws(() => store.list(), /root|real path/i);
  assert.throws(() => store.validate("alpha"), /root|real path/i);
});

test("rejects symlinked pack entries before loading them", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const userDataPath = path.join(fixtureRoot, "user-data");
  const backingUserData = path.join(fixtureRoot, "backing");
  const targetPack = writePack(backingUserData, "alpha", "Alpha Character");
  fs.mkdirSync(path.join(userDataPath, "characters"), { recursive: true });
  fs.symlinkSync(
    targetPack,
    path.join(userDataPath, "characters", "alpha"),
    directorySymlinkType(),
  );

  const store = createCharacterPackStore({ userDataPath });
  assert.throws(() => store.list(), /entry|symlink/i);
  assert.throws(() => store.validate("alpha"), /pack|symlink/i);
});

test("list fails closed on duplicate loaded manifest IDs", (context) => {
  const userDataPath = temporaryRoot(context);
  for (const id of ["alpha", "beta"]) {
    fs.mkdirSync(path.join(userDataPath, "characters", id), {
      recursive: true,
    });
  }
  const loadPack = () => ({
    manifest: { id: "duplicate", displayName: "Duplicate Character" },
  });

  assert.throws(
    () => createCharacterPackStore({ userDataPath, loadPack }).list(),
    /duplicate/i,
  );
});

test("enumerates at most 64 entries and checks the cap before loading", (context) => {
  const userDataPath = temporaryRoot(context);
  const charactersRoot = path.join(userDataPath, "characters");
  for (let index = 63; index >= 0; index -= 1) {
    fs.mkdirSync(path.join(charactersRoot, `pack-${String(index).padStart(2, "0")}`), {
      recursive: true,
    });
  }

  let loadCalls = 0;
  const loadPack = (packDirectory) => {
    loadCalls += 1;
    const id = path.basename(packDirectory);
    return { manifest: { id, displayName: id } };
  };
  const store = createCharacterPackStore({ userDataPath, loadPack });
  const summaries = store.list();
  assert.equal(summaries.length, 64);
  assert.equal(summaries[0].id, "pack-00");
  assert.equal(summaries[63].id, "pack-63");
  assert.equal(loadCalls, 64);

  fs.mkdirSync(path.join(charactersRoot, "pack-64"));
  assert.throws(() => store.list(), /64|entries|many/i);
  assert.equal(loadCalls, 64);
});

test("bounded enumeration stops on the 65th streamed entry", (context) => {
  const userDataPath = temporaryRoot(context);
  fs.mkdirSync(path.join(userDataPath, "characters"));
  const fsImpl = Object.create(fs);
  let readCalls = 0;
  let closeCalls = 0;
  fsImpl.readdirSync = () => {
    throw new Error("unbounded directory materialization is forbidden");
  };
  fsImpl.opendirSync = () => ({
    readSync: () => {
      readCalls += 1;
      if (readCalls > 65) throw new Error("read past the bounded sentinel");
      return {
        name: `pack-${String(readCalls).padStart(2, "0")}`,
        isSymbolicLink: () => false,
        isDirectory: () => true,
      };
    },
    closeSync: () => {
      closeCalls += 1;
    },
  });

  const store = createCharacterPackStore({
    userDataPath,
    fsImpl,
    loadPack: () => {
      throw new Error("pack loading must not start above the cap");
    },
  });
  assert.throws(() => store.list(), /64|entries|many/i);
  assert.equal(readCalls, 65);
  assert.equal(closeCalls, 1);
});

test("selection parsing rejects malformed values and unknown keys", (context) => {
  const userDataPath = temporaryRoot(context);
  const store = createCharacterPackStore({ userDataPath });
  const malformedSelections = [
    "null",
    "[]",
    "{}",
    JSON.stringify({ schemaVersion: 1 }),
    JSON.stringify({ activeCharacterId: "alpha" }),
    JSON.stringify({ schemaVersion: 2, activeCharacterId: "alpha" }),
    JSON.stringify({ schemaVersion: 1, activeCharacterId: "../alpha" }),
    JSON.stringify({
      schemaVersion: 1,
      activeCharacterId: "alpha",
      unknown: true,
    }),
  ];

  for (const contents of malformedSelections) {
    fs.writeFileSync(selectionPath(userDataPath), contents);
    assert.throws(
      () => store.status(),
      /selection/i,
      `${contents} must be rejected`,
    );
  }
});

test("selection parsing rejects oversized and symlinked files", (context) => {
  const oversizedUserData = temporaryRoot(context);
  fs.writeFileSync(selectionPath(oversizedUserData), Buffer.alloc(4097, 0x20));
  assert.throws(
    () => createCharacterPackStore({ userDataPath: oversizedUserData }).status(),
    /selection|large/i,
  );

  const linkedUserData = temporaryRoot(context);
  const targetPath = path.join(linkedUserData, "selection-target.json");
  fs.writeFileSync(
    targetPath,
    JSON.stringify({ schemaVersion: 1, activeCharacterId: "alpha" }),
  );
  fs.symlinkSync(targetPath, selectionPath(linkedUserData), "file");
  const linkedStore = createCharacterPackStore({ userDataPath: linkedUserData });
  assert.throws(() => linkedStore.status(), /selection|symlink/i);
  assert.throws(() => linkedStore.getActive(), /selection|symlink/i);
});

test("selection reads reject a file swapped to a symlink before opening", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writeSelection(userDataPath, "alpha");
  const selectedPath = selectionPath(userDataPath);
  const targetPath = path.join(userDataPath, "replacement-selection.json");
  fs.writeFileSync(
    targetPath,
    JSON.stringify({ schemaVersion: 1, activeCharacterId: "alpha" }),
  );

  const fsImpl = Object.create(fs);
  let swapped = false;
  fsImpl.openSync = (candidatePath, ...args) => {
    if (!swapped && path.resolve(candidatePath) === path.resolve(selectedPath)) {
      swapped = true;
      fs.renameSync(selectedPath, path.join(userDataPath, "original-selection.json"));
      fs.symlinkSync(targetPath, selectedPath, "file");
    }
    return fs.openSync(candidatePath, ...args);
  };

  assert.throws(
    () => createCharacterPackStore({ userDataPath, fsImpl }).status(),
    /selection|changed|symlink/i,
  );
});

test("status reports a missing selected pack and getActive fails closed", (context) => {
  const userDataPath = temporaryRoot(context);
  const store = createCharacterPackStore({ userDataPath });
  assert.deepEqual(store.status(), {
    activeCharacterId: null,
    available: false,
  });
  assert.throws(() => store.getActive(), /selection|active/i);

  writeSelection(userDataPath, "missing");
  assert.deepEqual(store.status(), {
    activeCharacterId: "missing",
    available: false,
  });
  assert.throws(() => store.getActive(), /pack|available|missing/i);
});

test("select rejects invalid, unknown, and malformed packs without changing selection", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  fs.mkdirSync(path.join(userDataPath, "characters", "broken"), {
    recursive: true,
  });
  const store = createCharacterPackStore({ userDataPath });
  store.select("alpha");
  const originalSelection = fs.readFileSync(selectionPath(userDataPath));

  for (const id of ["../alpha", "missing", "broken"]) {
    assert.throws(() => store.select(id), Error, `${id} must be rejected`);
    assert.deepEqual(
      fs.readFileSync(selectionPath(userDataPath)),
      originalSelection,
      `${id} must not replace the old selection`,
    );
  }
});

test("select rejects a symlinked selection without writing or replacing it", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  const targetPath = path.join(userDataPath, "selection-target.json");
  const targetContents = JSON.stringify({
    schemaVersion: 1,
    activeCharacterId: "alpha",
  });
  fs.writeFileSync(targetPath, targetContents);
  fs.symlinkSync(targetPath, selectionPath(userDataPath), "file");

  const fsImpl = Object.create(fs);
  let openCalls = 0;
  let writeCalls = 0;
  let renameCalls = 0;
  let unlinkCalls = 0;
  fsImpl.openSync = (...args) => {
    openCalls += 1;
    return fs.openSync(...args);
  };
  fsImpl.writeFileSync = (...args) => {
    writeCalls += 1;
    return fs.writeFileSync(...args);
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };
  fsImpl.unlinkSync = (...args) => {
    unlinkCalls += 1;
    return fs.unlinkSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("alpha"), /selection|symlink/i);
  assert.equal(openCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(renameCalls, 0);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.lstatSync(selectionPath(userDataPath)).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), targetContents);
});

test("rename failure leaves a replacement swapped onto the temporary path", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  const displacedTemporary = path.join(userDataPath, "displaced-temporary");
  const replacementContents = "owned by another invocation";
  const fsImpl = Object.create(fs);
  const renameError = new Error("injected rename failure after temp swap");
  let renameCalls = 0;
  const unlinkCalls = [];
  fsImpl.renameSync = (sourcePath) => {
    renameCalls += 1;
    fs.renameSync(sourcePath, displacedTemporary);
    fs.writeFileSync(sourcePath, replacementContents);
    throw renameError;
  };
  fsImpl.unlinkSync = (...args) => {
    unlinkCalls.push(args);
    return fs.unlinkSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), (error) => error === renameError);

  assert.equal(renameCalls, 1);
  assert.deepEqual(unlinkCalls, []);
  assert.equal(fs.readFileSync(temporary, "utf8"), replacementContents);
  assert.equal(fs.existsSync(displacedTemporary), true);
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});

test("select rejects its temporary removed after the descriptor closes", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  const displacedTemporary = path.join(userDataPath, "displaced-temporary");
  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  fsImpl.closeSync = (descriptor) => {
    fs.closeSync(descriptor);
    fs.renameSync(temporary, displacedTemporary);
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /selection|ENOENT/i);

  assert.equal(renameCalls, 0);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(displacedTemporary), true);
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});

test("select rejects its temporary replaced by another file after close", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  const displacedTemporary = path.join(userDataPath, "displaced-temporary");
  const replacementContents = "concurrent temporary replacement";
  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  fsImpl.closeSync = (descriptor) => {
    fs.closeSync(descriptor);
    fs.renameSync(temporary, displacedTemporary);
    fs.writeFileSync(temporary, replacementContents);
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /selection|changed/i);

  assert.equal(renameCalls, 0);
  assert.equal(fs.readFileSync(temporary, "utf8"), replacementContents);
  assert.equal(fs.existsSync(displacedTemporary), true);
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});

test("select rejects its temporary replaced by a symlink after close", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  const displacedTemporary = path.join(userDataPath, "displaced-temporary");
  const targetPath = path.join(userDataPath, "concurrent-temporary-target");
  const targetContents = "concurrent temporary symlink target";
  fs.writeFileSync(targetPath, targetContents);
  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  fsImpl.closeSync = (descriptor) => {
    fs.closeSync(descriptor);
    fs.renameSync(temporary, displacedTemporary);
    fs.symlinkSync(targetPath, temporary, "file");
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /selection|changed|symlink/i);

  assert.equal(renameCalls, 0);
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), targetContents);
  assert.equal(fs.existsSync(displacedTemporary), true);
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});

test("select rejects its user data directory replaced by a symlink", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const userDataPath = path.join(fixtureRoot, "user-data");
  const displacedUserData = path.join(fixtureRoot, "displaced-user-data");
  const replacementUserData = path.join(fixtureRoot, "replacement-user-data");
  writePack(userDataPath, "alpha", "Alpha Character");
  fs.mkdirSync(replacementUserData);

  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  let swapped = false;
  fsImpl.mkdirSync = (...args) => {
    const result = fs.mkdirSync(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(userDataPath, displacedUserData);
      fs.symlinkSync(replacementUserData, userDataPath, directorySymlinkType());
    }
    return result;
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("alpha"), /selection|data|root|changed/i);

  const temporary = path.join(
    replacementUserData,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(renameCalls, 0);
  assert.equal(fs.lstatSync(userDataPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(selectionPath(replacementUserData)), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(selectionPath(displacedUserData)), false);
});

test("select rejects its user data directory replaced by another directory", (context) => {
  const fixtureRoot = temporaryRoot(context);
  const userDataPath = path.join(fixtureRoot, "user-data");
  const displacedUserData = path.join(fixtureRoot, "displaced-user-data");
  const replacementUserData = path.join(fixtureRoot, "replacement-user-data");
  writePack(userDataPath, "alpha", "Alpha Character");
  fs.mkdirSync(replacementUserData);

  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  let swapped = false;
  fsImpl.mkdirSync = (...args) => {
    const result = fs.mkdirSync(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(userDataPath, displacedUserData);
      fs.renameSync(replacementUserData, userDataPath);
    }
    return result;
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("alpha"), /selection|data|root|changed/i);

  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(renameCalls, 0);
  assert.equal(fs.lstatSync(userDataPath).isDirectory(), true);
  assert.equal(fs.existsSync(selectionPath(userDataPath)), false);
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(fs.existsSync(selectionPath(displacedUserData)), false);
});

test("select rejects a missing destination replaced by a symlink before rename", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  const selectedPath = selectionPath(userDataPath);
  const targetPath = path.join(userDataPath, "concurrent-selection-target.json");
  const targetContents = "concurrent target contents";
  fs.writeFileSync(targetPath, targetContents);

  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  let swapped = false;
  fsImpl.mkdirSync = (...args) => {
    const result = fs.mkdirSync(...args);
    if (!swapped) {
      swapped = true;
      fs.symlinkSync(targetPath, selectedPath, "file");
    }
    return result;
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("alpha"), /selection|changed|symlink/i);

  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(renameCalls, 0);
  assert.equal(fs.lstatSync(selectedPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), targetContents);
  assert.equal(fs.existsSync(temporary), false);
});

test("select rejects a regular destination replaced by another file before rename", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const selectedPath = selectionPath(userDataPath);
  const displacedSelection = path.join(userDataPath, "displaced-selection.json");
  const replacementContents = "concurrent regular selection";

  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  let swapped = false;
  fsImpl.mkdirSync = (...args) => {
    const result = fs.mkdirSync(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(selectedPath, displacedSelection);
      fs.writeFileSync(selectedPath, replacementContents);
    }
    return result;
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /selection|changed/i);

  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(renameCalls, 0);
  assert.equal(fs.readFileSync(selectedPath, "utf8"), replacementContents);
  assert.equal(fs.existsSync(displacedSelection), true);
  assert.equal(fs.existsSync(temporary), false);
});

test("select rejects a regular destination replaced by a symlink before rename", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const selectedPath = selectionPath(userDataPath);
  const displacedSelection = path.join(userDataPath, "displaced-selection.json");
  const targetPath = path.join(userDataPath, "concurrent-selection-target.json");
  const targetContents = "concurrent symlink target";
  fs.writeFileSync(targetPath, targetContents);

  const fsImpl = Object.create(fs);
  let renameCalls = 0;
  let swapped = false;
  fsImpl.mkdirSync = (...args) => {
    const result = fs.mkdirSync(...args);
    if (!swapped) {
      swapped = true;
      fs.renameSync(selectedPath, displacedSelection);
      fs.symlinkSync(targetPath, selectedPath, "file");
    }
    return result;
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /selection|changed|symlink/i);

  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(renameCalls, 0);
  assert.equal(fs.lstatSync(selectedPath).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(targetPath, "utf8"), targetContents);
  assert.equal(fs.existsSync(displacedSelection), true);
  assert.equal(fs.existsSync(temporary), false);
});

test("select opens one same-directory mode-0600 wx temporary, writes it, and renames once", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  const fsImpl = Object.create(fs);
  const mkdirCalls = [];
  const events = [];
  const openCalls = [];
  const fstatCalls = [];
  const writeCalls = [];
  const closeCalls = [];
  const renameCalls = [];
  const unlinkCalls = [];
  let temporaryDescriptor;
  let recordWriteSequence = false;
  fsImpl.lstatSync = (candidatePath, ...args) => {
    if (recordWriteSequence) {
      if (candidatePath === userDataPath) events.push("user-data-lstat");
      if (candidatePath === selectionPath(userDataPath)) {
        events.push("selection-lstat");
      }
      if (candidatePath === path.join(
        userDataPath,
        `.character-selection.${process.pid}.tmp`,
      )) {
        events.push("temporary-lstat");
      }
    }
    return fs.lstatSync(candidatePath, ...args);
  };
  fsImpl.realpathSync = (candidatePath, ...args) => {
    if (recordWriteSequence && candidatePath === userDataPath) {
      events.push("user-data-realpath");
    }
    return fs.realpathSync(candidatePath, ...args);
  };
  fsImpl.mkdirSync = (...args) => {
    mkdirCalls.push(args);
    events.push("mkdir");
    recordWriteSequence = true;
    return fs.mkdirSync(...args);
  };
  fsImpl.openSync = (...args) => {
    openCalls.push(args);
    events.push("open");
    temporaryDescriptor = fs.openSync(...args);
    return temporaryDescriptor;
  };
  fsImpl.fstatSync = (...args) => {
    fstatCalls.push(args);
    events.push("fstat");
    return fs.fstatSync(...args);
  };
  fsImpl.writeFileSync = (...args) => {
    writeCalls.push(args);
    events.push("write");
    return fs.writeFileSync(...args);
  };
  fsImpl.closeSync = (...args) => {
    closeCalls.push(args);
    events.push("close");
    return fs.closeSync(...args);
  };
  fsImpl.renameSync = (...args) => {
    renameCalls.push(args);
    events.push("rename");
    return fs.renameSync(...args);
  };
  fsImpl.unlinkSync = (...args) => {
    unlinkCalls.push(args);
    events.push("unlink");
    return fs.unlinkSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  store.select("alpha");

  const expectedTemporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.deepEqual(mkdirCalls, [[
    userDataPath,
    { recursive: true, mode: 0o700 },
  ]]);
  assert.deepEqual(openCalls, [[expectedTemporary, "wx", 0o600]]);
  assert.deepEqual(fstatCalls, [[temporaryDescriptor]]);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0][0], temporaryDescriptor);
  assert.equal(
    writeCalls[0][1],
    `${JSON.stringify({ schemaVersion: 1, activeCharacterId: "alpha" })}\n`,
  );
  assert.deepEqual(writeCalls[0][2], { encoding: "utf8" });
  assert.deepEqual(closeCalls, [[temporaryDescriptor]]);
  assert.deepEqual(renameCalls, [[expectedTemporary, selectionPath(userDataPath)]]);
  assert.deepEqual(unlinkCalls, []);
  assert.deepEqual(events, [
    "mkdir",
    "user-data-lstat",
    "user-data-realpath",
    "open",
    "fstat",
    "write",
    "close",
    "temporary-lstat",
    "user-data-lstat",
    "user-data-realpath",
    "selection-lstat",
    "rename",
  ]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(selectionPath(userDataPath)).mode & 0o777, 0o600);
  }
});

test("temporary write failure closes its descriptor without rename or cleanup", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  const fsImpl = Object.create(fs);
  const writeError = new Error("injected temporary write failure");
  let temporaryDescriptor;
  let renameCalls = 0;
  let unlinkCalls = 0;
  const closeCalls = [];
  fsImpl.openSync = (...args) => {
    temporaryDescriptor = fs.openSync(...args);
    return temporaryDescriptor;
  };
  fsImpl.writeFileSync = () => {
    throw writeError;
  };
  fsImpl.closeSync = (...args) => {
    closeCalls.push(args);
    return fs.closeSync(...args);
  };
  fsImpl.renameSync = () => {
    renameCalls += 1;
  };
  fsImpl.unlinkSync = () => {
    unlinkCalls += 1;
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("alpha"), (error) => error === writeError);

  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.deepEqual(closeCalls, [[temporaryDescriptor]]);
  assert.equal(renameCalls, 0);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.lstatSync(temporary).isFile(), true);
});

test("rename failure cleans its owned temporary once without retry", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const fsImpl = Object.create(fs);
  const renameError = new Error("injected rename failure");
  let writeCalls = 0;
  let renameCalls = 0;
  const unlinkCalls = [];
  fsImpl.writeFileSync = (...args) => {
    writeCalls += 1;
    return fs.writeFileSync(...args);
  };
  fsImpl.renameSync = () => {
    renameCalls += 1;
    throw renameError;
  };
  fsImpl.unlinkSync = (...args) => {
    unlinkCalls.push(args);
    return fs.unlinkSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), (error) => error === renameError);

  const expectedTemporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  assert.equal(writeCalls, 1);
  assert.equal(renameCalls, 1);
  assert.deepEqual(unlinkCalls, [[expectedTemporary]]);
  assert.equal(fs.existsSync(expectedTemporary), false);
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});

test("wx collision neither deletes an unowned temporary nor retries", (context) => {
  const userDataPath = temporaryRoot(context);
  writePack(userDataPath, "alpha", "Alpha Character");
  writePack(userDataPath, "beta", "Beta Character");
  writeSelection(userDataPath, "alpha");
  const oldSelection = fs.readFileSync(selectionPath(userDataPath));
  const temporary = path.join(
    userDataPath,
    `.character-selection.${process.pid}.tmp`,
  );
  fs.writeFileSync(temporary, "owned by another invocation");

  const fsImpl = Object.create(fs);
  let openCalls = 0;
  let writeCalls = 0;
  let renameCalls = 0;
  let unlinkCalls = 0;
  fsImpl.openSync = (...args) => {
    openCalls += 1;
    return fs.openSync(...args);
  };
  fsImpl.writeFileSync = (...args) => {
    writeCalls += 1;
    return fs.writeFileSync(...args);
  };
  fsImpl.renameSync = (...args) => {
    renameCalls += 1;
    return fs.renameSync(...args);
  };
  fsImpl.unlinkSync = (...args) => {
    unlinkCalls += 1;
    return fs.unlinkSync(...args);
  };

  const store = createCharacterPackStore({ userDataPath, fsImpl });
  assert.throws(() => store.select("beta"), /exist|EEXIST/i);
  assert.equal(openCalls, 1);
  assert.equal(writeCalls, 0);
  assert.equal(renameCalls, 0);
  assert.equal(unlinkCalls, 0);
  assert.equal(fs.readFileSync(temporary, "utf8"), "owned by another invocation");
  assert.deepEqual(fs.readFileSync(selectionPath(userDataPath)), oldSelection);
});
