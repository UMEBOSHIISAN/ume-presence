"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createEngineAdapter,
  createSpeechProvider,
  getProvider,
  providerRegistry,
} = require("./provider-registry.cjs");

function validProfile() {
  return {
    styleId: 123,
    speedScale: 1,
    tempoDynamicsScale: 1,
    pitchScale: 0,
    volumeScale: 1,
  };
}

function streamedResponse(value, contentType) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let consumed = false;
  return {
    ok: true,
    redirected: false,
    headers: new Headers({ "content-type": contentType }),
    body: {
      getReader: () => ({
        read: async () => {
          if (consumed) return { done: true, value: undefined };
          consumed = true;
          return { done: false, value: bytes };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

test("exposes only the frozen code-owned Aivis provider entry", () => {
  assert.deepEqual(Object.keys(providerRegistry), ["aivis"]);
  assert.equal(Object.getPrototypeOf(providerRegistry), null);
  assert.equal(Object.isFrozen(providerRegistry), true);
  assert.equal(Object.isFrozen(providerRegistry.aivis), true);
  assert.equal(getProvider("aivis"), providerRegistry.aivis);
  assert.equal(typeof providerRegistry.aivis.validateProfile, "function");
  assert.equal(typeof providerRegistry.aivis.createSpeechProvider, "function");
  assert.equal(typeof providerRegistry.aivis.createEngineAdapter, "function");
});

test("the same frozen Aivis entry validates profiles and constructs providers", () => {
  const input = validProfile();
  const entry = getProvider("aivis");
  const profile = entry.validateProfile(input);
  const provider = entry.createSpeechProvider(profile, {
    fetchImpl: async () => {
      throw new Error("not called during construction");
    },
  });

  assert.deepEqual(profile, input);
  assert.notEqual(profile, input);
  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(provider), true);
  assert.equal(typeof provider.synthesize, "function");
});

test("the frozen Aivis descriptor constructs only the reviewed engine adapter", () => {
  const entry = getProvider("aivis");
  const adapter = entry.createEngineAdapter({
    homeDirectory: "/Users/persona-test",
    fsImpl: {
      constants: { X_OK: 1 },
      lstatSync: () => { throw new Error("not called during construction"); },
      realpathSync: () => { throw new Error("not called during construction"); },
      accessSync: () => { throw new Error("not called during construction"); },
    },
    fetchImpl: async () => { throw new Error("not called during construction"); },
    spawnImpl: () => { throw new Error("not called during construction"); },
    createTimeoutSignal: () => undefined,
    platform: "darwin",
  });

  assert.equal(adapter.id, "aivis");
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(Object.keys(adapter), [
    "id",
    "resolveInstalledExecutable",
    "probeReadiness",
    "spawnOnce",
  ]);
});

test("module dispatcher resolves the same frozen Aivis engine factory", () => {
  const deps = {
    homeDirectory: "/Users/persona-test",
    fsImpl: {
      constants: { X_OK: 1 },
      lstatSync: () => { throw new Error("not called during construction"); },
      realpathSync: () => { throw new Error("not called during construction"); },
      accessSync: () => { throw new Error("not called during construction"); },
    },
    fetchImpl: async () => {},
    spawnImpl: () => {},
    createTimeoutSignal: () => undefined,
    platform: "darwin",
  };
  const direct = getProvider("aivis").createEngineAdapter(deps);
  const dispatched = createEngineAdapter("aivis", deps);

  assert.equal(direct.id, "aivis");
  assert.equal(dispatched.id, "aivis");
  assert.notEqual(direct, dispatched);
});

test("engine dispatcher fails closed for unknown and prototype-shaped provider IDs", () => {
  for (const providerId of [
    "unknown",
    "__proto__",
    "constructor",
    "toString",
    "",
    null,
  ]) {
    assert.throws(
      () => createEngineAdapter(providerId, {}),
      (error) => error.code === "ENGINE_ADAPTER_UNAVAILABLE",
      `${String(providerId)} must not resolve an engine adapter`,
    );
  }
});

test("pack-shaped injected fields cannot add or replace an engine registry entry", () => {
  const maliciousFactory = () => ({ id: "malicious" });
  assert.throws(
    () => createEngineAdapter("pack-provider", {
      createEngineAdapter: maliciousFactory,
      providers: { "pack-provider": maliciousFactory },
    }),
    (error) => error.code === "ENGINE_ADAPTER_UNAVAILABLE",
  );
  assert.throws(
    () => createEngineAdapter("aivis", {
      homeDirectory: "/Users/persona-test",
      createEngineAdapter: maliciousFactory,
    }),
    TypeError,
  );
  assert.deepEqual(Object.keys(providerRegistry), ["aivis"]);
});

test("createSpeechProvider validates and injects the selected Aivis profile", async () => {
  const calls = [];
  const responses = [
    streamedResponse({}, "application/json"),
    {
      ok: true,
      redirected: false,
      headers: new Headers({ "content-type": "audio/wav" }),
      body: new Blob([Buffer.from("RIFF")]).stream(),
    },
  ];
  const provider = createSpeechProvider("aivis", validProfile(), {
    createTimeoutSignal: () => undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return responses.shift();
    },
  });

  await provider.synthesize("おかえり。");

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /speaker=123/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    speedScale: 1,
    tempoDynamicsScale: 1,
    pitchScale: 0,
    volumeScale: 1,
  });
});

test("createSpeechProvider rejects invalid profiles before fetch", () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const missingField = validProfile();
  delete missingField.speedScale;

  for (const profile of [missingField, { ...validProfile(), url: "unsafe" }]) {
    assert.throws(
      () => createSpeechProvider("aivis", profile, { fetchImpl }),
      Error,
    );
  }
  assert.equal(fetchCalls, 0);
});

test("rejects unsupported and prototype-shaped provider IDs", () => {
  for (const providerId of [
    "unknown",
    "__proto__",
    "constructor",
    "toString",
    "https://provider.invalid",
    "",
    null,
  ]) {
    assert.throws(
      () => getProvider(providerId),
      /unsupported/i,
      `${String(providerId)} must be rejected`,
    );
    assert.throws(
      () => createSpeechProvider(providerId, validProfile()),
      /unsupported/i,
      `${String(providerId)} must not construct a provider`,
    );
  }
});
