"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

let adapterModule;
try {
  adapterModule = require("./aivis-engine-adapter.cjs");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
}

if (!adapterModule) {
  test("the fixed local Aivis engine adapter is available", () => {
    assert.fail("aivis-engine-adapter.cjs is absent");
  });
} else {
  const { createAivisEngineAdapter } = adapterModule;

  const HOME = "/Users/persona-test";
  const SUFFIX = "Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run";
  const USER_EXECUTABLE = `/${path.posix.join(HOME, SUFFIX).replace(/^\/+/, "")}`;
  const SYSTEM_EXECUTABLE = `/${path.posix.join("/Applications", "AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run").replace(/^\/+/, "")}`;

  function fsError(code, message = "private filesystem detail") {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function createFs({
    user = "valid",
    system = "missing",
    realpaths = {},
  } = {}) {
    const calls = [];
    const states = new Map([
      [USER_EXECUTABLE, user],
      [SYSTEM_EXECUTABLE, system],
    ]);
    const fsImpl = {
      constants: { X_OK: 1 },
      lstatSync(candidate) {
        calls.push({ method: "lstatSync", candidate });
        const state = states.get(candidate);
        if (state instanceof Error) throw state;
        if (state === "missing" || state === undefined) throw fsError("ENOENT");
        if (state === "symlink") {
          return { isFile: () => true, isSymbolicLink: () => true };
        }
        if (state === "directory") {
          return { isFile: () => false, isSymbolicLink: () => false };
        }
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      realpathSync(candidate) {
        calls.push({ method: "realpathSync", candidate });
        return realpaths[candidate] ?? candidate;
      },
      accessSync(candidate, mode) {
        calls.push({ method: "accessSync", candidate, mode });
        const state = states.get(candidate);
        if (state === "not-executable") throw fsError("EACCES");
      },
    };
    return { calls, fsImpl, states };
  }

  function createAdapter(overrides = {}) {
    const { fsImpl } = createFs();
    return createAivisEngineAdapter({
      homeDirectory: HOME,
      fsImpl,
      fetchImpl: async () => { throw new Error("unused fetch"); },
      spawnImpl: () => { throw new Error("unused spawn"); },
      createTimeoutSignal: () => undefined,
      platform: "darwin",
      ...overrides,
    });
  }

  function byteStreamResponse(bytes, {
    contentType = "application/json",
    declaredLength,
    ok = true,
    redirected = false,
    onCancel = () => {},
    onRelease = () => {},
  } = {}) {
    const headers = new Headers({ "content-type": contentType });
    if (declaredLength !== undefined) headers.set("content-length", String(declaredLength));
    const chunks = Array.isArray(bytes) ? bytes : [bytes];
    let index = 0;
    return {
      ok,
      redirected,
      headers,
      body: {
        getReader: () => ({
          read: async () => index < chunks.length
            ? { done: false, value: chunks[index++] }
            : { done: true, value: undefined },
          cancel: async () => onCancel(),
          releaseLock: () => onRelease(),
        }),
      },
    };
  }

  function jsonBytes(value, trailingSpaces = 0) {
    return new TextEncoder().encode(`${JSON.stringify(value)}${" ".repeat(trailingSpaces)}`);
  }

  test("construction is pure and returns only the frozen reviewed interface", () => {
    const { calls, fsImpl } = createFs();
    const adapter = createAivisEngineAdapter({
      homeDirectory: HOME,
      fsImpl,
      fetchImpl: async () => {},
      spawnImpl: () => {},
      createTimeoutSignal: () => undefined,
      platform: "darwin",
    });

    assert.deepEqual(Object.keys(adapter), [
      "id",
      "resolveInstalledExecutable",
      "probeReadiness",
      "spawnOnce",
    ]);
    assert.equal(adapter.id, "aivis");
    assert.equal(Object.isFrozen(adapter), true);
    assert.deepEqual(calls, []);
  });

  test("rejects unknown constructor options before any filesystem operation", () => {
    const { calls, fsImpl } = createFs();
    assert.throws(
      () => createAivisEngineAdapter({
        homeDirectory: HOME,
        fsImpl,
        fetchImpl: async () => {},
        spawnImpl: () => {},
        createTimeoutSignal: () => undefined,
        platform: "darwin",
        executable: "/tmp/unsafe",
      }),
      TypeError,
    );
    assert.deepEqual(calls, []);
  });

  test("prefers the one fixed user executable and does not inspect another location", () => {
    const { calls, fsImpl } = createFs({ user: "valid", system: "valid" });
    const resolved = createAdapter({ fsImpl }).resolveInstalledExecutable();

    assert.equal(resolved, USER_EXECUTABLE);
    assert.deepEqual(calls.map((call) => call.candidate), [
      USER_EXECUTABLE,
      USER_EXECUTABLE,
      USER_EXECUTABLE,
    ]);
  });

  test("falls back to the fixed system executable only when the user executable is absent", () => {
    const { calls, fsImpl } = createFs({ user: "missing", system: "valid" });
    assert.equal(createAdapter({ fsImpl }).resolveInstalledExecutable(), SYSTEM_EXECUTABLE);
    assert.deepEqual(calls.map((call) => call.candidate), [
      USER_EXECUTABLE,
      SYSTEM_EXECUTABLE,
      SYSTEM_EXECUTABLE,
      SYSTEM_EXECUTABLE,
    ]);
  });

  test("maps two absent fixed candidates to the closed missing error", () => {
    const { calls, fsImpl } = createFs({ user: "missing", system: "missing" });
    assert.throws(
      () => createAdapter({ fsImpl }).resolveInstalledExecutable(),
      (error) => error.code === "ENGINE_EXECUTABLE_MISSING"
        && !error.message.includes(HOME)
        && !error.message.includes("private filesystem detail"),
    );
    assert.deepEqual(calls.map((call) => call.candidate), [USER_EXECUTABLE, SYSTEM_EXECUTABLE]);
  });

  test("does not fall back for a present-invalid user candidate or unexpected user I/O error", () => {
    for (const user of [
      "symlink",
      "directory",
      "not-executable",
      fsError("EACCES"),
      fsError("ENOTDIR"),
      fsError("EIO"),
    ]) {
      const { calls, fsImpl } = createFs({ user, system: "valid" });
      assert.throws(
        () => createAdapter({ fsImpl }).resolveInstalledExecutable(),
        (error) => error.code === "ENGINE_EXECUTABLE_INVALID"
          && !error.message.includes(HOME)
          && !error.message.includes("private filesystem detail"),
      );
      assert.equal(calls.some((call) => call.candidate === SYSTEM_EXECUTABLE), false);
    }
  });

  test("rejects symlinked ancestors and sibling-prefix realpath escapes", () => {
    for (const escapedRealpath of [
      "/private/Users/persona-test/Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run",
      "/Users/persona-test-evil/Applications/AivisSpeech.app/Contents/Resources/AivisSpeech-Engine/run",
    ]) {
      const { fsImpl } = createFs({
        user: "valid",
        system: "valid",
        realpaths: { [USER_EXECUTABLE]: escapedRealpath },
      });
      assert.throws(
        () => createAdapter({ fsImpl }).resolveInstalledExecutable(),
        (error) => error.code === "ENGINE_EXECUTABLE_INVALID",
      );
    }
  });

  test("rejects invalid fixed system candidates after the user candidate is absent", () => {
    for (const system of ["symlink", "directory", "not-executable", fsError("EACCES")]) {
      const { fsImpl } = createFs({ user: "missing", system });
      assert.throws(
        () => createAdapter({ fsImpl }).resolveInstalledExecutable(),
        (error) => error.code === "ENGINE_EXECUTABLE_INVALID",
      );
    }
  });

  test("resolve does not cache an executable across filesystem changes", () => {
    const { fsImpl, states } = createFs({ user: "valid", system: "missing" });
    const adapter = createAdapter({ fsImpl });
    assert.equal(adapter.resolveInstalledExecutable(), USER_EXECUTABLE);
    states.set(USER_EXECUTABLE, "missing");
    assert.throws(
      () => adapter.resolveInstalledExecutable(),
      (error) => error.code === "ENGINE_EXECUTABLE_MISSING",
    );
  });

  test("resolve and spawn fail off Darwin before filesystem or spawn I/O", () => {
    const { calls, fsImpl } = createFs();
    let spawnCalls = 0;
    const adapter = createAdapter({
      fsImpl,
      platform: "linux",
      spawnImpl: () => { spawnCalls += 1; },
    });

    for (const operation of [adapter.resolveInstalledExecutable, adapter.spawnOnce]) {
      assert.throws(operation, (error) => error.code === "ENGINE_PLATFORM_UNSUPPORTED");
    }
    assert.deepEqual(calls, []);
    assert.equal(spawnCalls, 0);
  });

  test("spawns once with exact closed options after fresh full validation and returns child identity", () => {
    const { calls, fsImpl } = createFs({ user: "valid" });
    const spawnCalls = [];
    let childPropertyReads = 0;
    const child = new Proxy({}, {
      get(target, property, receiver) {
        childPropertyReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const adapter = createAdapter({
      fsImpl,
      spawnImpl: (file, args, options) => {
        spawnCalls.push({ file, args, options });
        return child;
      },
    });

    assert.equal(adapter.spawnOnce(), child);
    assert.deepEqual(spawnCalls[0], {
      file: USER_EXECUTABLE,
      args: [],
      options: {
        cwd: path.posix.dirname(USER_EXECUTABLE),
        detached: false,
        shell: false,
        stdio: "ignore",
      },
    });
    assert.equal(Object.hasOwn(spawnCalls[0].options, "env"), false);
    assert.equal(childPropertyReads, 0);
    assert.deepEqual(calls.map((call) => call.method), ["lstatSync", "realpathSync", "accessSync"]);
  });

  test("a synchronous spawn failure is closed and is never retried", () => {
    const { fsImpl } = createFs();
    let spawnCalls = 0;
    const adapter = createAdapter({
      fsImpl,
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error("private spawn detail");
      },
    });
    assert.throws(
      () => adapter.spawnOnce(),
      (error) => error.code === "ENGINE_SPAWN_FAILED"
        && !error.message.includes("private spawn detail")
        && !error.message.includes(HOME),
    );
    assert.equal(spawnCalls, 1);
  });

  test("probe performs one closed loopback version request with one two-second signal", async () => {
    const timeoutCalls = [];
    const fetchCalls = [];
    const signal = { name: "probe" };
    const adapter = createAdapter({
      createTimeoutSignal: (duration) => {
        timeoutCalls.push(duration);
        return signal;
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, options });
        return byteStreamResponse(jsonBytes("1.2.3"), {
          contentType: " Application/JSON ; charset=utf-8 ",
        });
      },
    });

    assert.equal(await adapter.probeReadiness(), true);
    assert.deepEqual(timeoutCalls, [2_000]);
    assert.deepEqual(fetchCalls, [{
      url: "http://127.0.0.1:10101/version",
      options: { method: "GET", redirect: "error", signal },
    }]);
  });

  test("probe accepts exactly 128 streamed bytes and rejects byte 129 with cancellation", async () => {
    let cancelled = 0;
    const exact = createAdapter({
      fetchImpl: async () => byteStreamResponse(jsonBytes("1", 125)),
    });
    const over = createAdapter({
      fetchImpl: async () => byteStreamResponse(
        [jsonBytes("1", 125), new Uint8Array([32])],
        { onCancel: () => { cancelled += 1; } },
      ),
    });

    assert.equal(await exact.probeReadiness(), true);
    assert.equal(await over.probeReadiness(), false);
    assert.equal(cancelled, 1);
  });

  test("probe rejects malformed declared lengths without retrying", async () => {
    for (const declaredLength of ["-1", "1.5", "unsafe", "9007199254740992", "129"]) {
      let fetchCalls = 0;
      const adapter = createAdapter({
        fetchImpl: async () => {
          fetchCalls += 1;
          return byteStreamResponse(jsonBytes("1"), { declaredLength });
        },
      });
      assert.equal(await adapter.probeReadiness(), false, declaredLength);
      assert.equal(fetchCalls, 1);
    }

    const exact = createAdapter({
      fetchImpl: async () => byteStreamResponse(jsonBytes("1"), { declaredLength: "128" }),
    });
    assert.equal(await exact.probeReadiness(), true);
  });

  test("probe rejects status, redirect, media type, JSON shape, and version grammar failures", async () => {
    const cases = [
      byteStreamResponse(jsonBytes("1"), { ok: false }),
      byteStreamResponse(jsonBytes("1"), { redirected: true }),
      byteStreamResponse(new TextEncoder().encode("<html>ok</html>"), { contentType: "text/html" }),
      byteStreamResponse(new TextEncoder().encode("1.2.3"), { contentType: "text/plain" }),
      byteStreamResponse(jsonBytes({ version: "1" })),
      byteStreamResponse(jsonBytes("1\n")),
      byteStreamResponse(jsonBytes("a".repeat(65))),
      byteStreamResponse(jsonBytes("-1")),
    ];

    for (const response of cases) {
      let fetchCalls = 0;
      const adapter = createAdapter({
        fetchImpl: async () => { fetchCalls += 1; return response; },
      });
      assert.equal(await adapter.probeReadiness(), false);
      assert.equal(fetchCalls, 1);
    }
  });

  test("probe closes missing readers, invalid chunks, invalid UTF-8, and stream failures", async () => {
    const invalidReader = byteStreamResponse(jsonBytes("1"));
    invalidReader.body = {};
    const readFailure = byteStreamResponse(jsonBytes("1"));
    readFailure.body.getReader = () => ({
      read: async () => { throw new Error("raw read detail"); },
      releaseLock: () => {},
    });
    const invalidChunk = byteStreamResponse(["not-bytes"]);
    const invalidUtf8 = byteStreamResponse(new Uint8Array([0xff]));
    const releaseFailure = byteStreamResponse(jsonBytes("1"), {
      onRelease: () => { throw new Error("raw release detail"); },
    });
    const cancelFailure = byteStreamResponse(
      [jsonBytes("1", 125), new Uint8Array([32])],
      { onCancel: () => { throw new Error("raw cancel detail"); } },
    );

    for (const response of [
      invalidReader,
      readFailure,
      invalidChunk,
      invalidUtf8,
      releaseFailure,
      cancelFailure,
    ]) {
      const adapter = createAdapter({ fetchImpl: async () => response });
      assert.equal(await adapter.probeReadiness(), false);
    }
  });

  test("probe returns false for bounded operational failures without retries or leaks", async () => {
    let timeoutCalls = 0;
    let fetchCalls = 0;
    const timeoutFailure = createAdapter({
      createTimeoutSignal: () => {
        timeoutCalls += 1;
        throw new Error("private timeout detail");
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return byteStreamResponse(jsonBytes("1"));
      },
    });
    assert.equal(await timeoutFailure.probeReadiness(), false);
    assert.equal(timeoutCalls, 1);
    assert.equal(fetchCalls, 0);

    timeoutCalls = 0;
    fetchCalls = 0;
    const fetchFailure = createAdapter({
      createTimeoutSignal: () => { timeoutCalls += 1; return undefined; },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("private fetch detail");
      },
    });
    assert.equal(await fetchFailure.probeReadiness(), false);
    assert.equal(timeoutCalls, 1);
    assert.equal(fetchCalls, 1);
  });
}
