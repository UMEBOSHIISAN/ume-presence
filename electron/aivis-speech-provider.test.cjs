"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAX_AUDIO_QUERY_BYTES,
  MAX_WAV_BYTES,
  createAivisSpeechProvider,
  synthesizeAivisSpeech,
} = require("./aivis-speech-provider.cjs");

const CLOSED_ERROR = Object.freeze({
  code: "AIVIS_PROVIDER_FAILED",
  message: "AivisSpeech request failed.",
});

function validProfile(overrides = {}) {
  return {
    styleId: 321,
    speedScale: 1.1,
    tempoDynamicsScale: 0.8,
    pitchScale: 0.02,
    volumeScale: 0.9,
    ...overrides,
  };
}

function createProvider(options = {}) {
  return createAivisSpeechProvider({
    profile: validProfile(),
    createTimeoutSignal: () => undefined,
    ...options,
  });
}

function streamedResponse(chunks, {
  contentType,
  declaredLength,
  ok = true,
  redirected = false,
  onRead,
  onCancel = () => {},
  onRelease = () => {},
} = {}) {
  const headers = new Headers();
  if (contentType !== undefined) headers.set("content-type", contentType);
  if (declaredLength !== undefined) headers.set("content-length", String(declaredLength));
  const values = Array.isArray(chunks) ? chunks : [chunks];
  let index = 0;
  return {
    ok,
    redirected,
    headers,
    body: {
      getReader: () => ({
        read: async () => {
          onRead?.(index);
          return index < values.length
            ? { done: false, value: values[index++] }
            : { done: true, value: undefined };
        },
        cancel: async () => onCancel(),
        releaseLock: () => onRelease(),
      }),
    },
  };
}

function jsonResponse(value, options = {}) {
  return streamedResponse(
    new TextEncoder().encode(JSON.stringify(value)),
    { contentType: "application/json", ...options },
  );
}

function rawJsonResponse(text, options = {}) {
  return streamedResponse(
    new TextEncoder().encode(text),
    { contentType: "application/json", ...options },
  );
}

function wavResponse(bytes, options = {}) {
  return streamedResponse(
    Uint8Array.from(bytes),
    { contentType: "audio/wav", ...options },
  );
}

async function assertClosedFailure(promise, forbidden = []) {
  await assert.rejects(promise, (error) => {
    assert.equal(error?.code, CLOSED_ERROR.code);
    assert.equal(error?.message, CLOSED_ERROR.message);
    for (const text of forbidden) assert.equal(error.message.includes(text), false);
    return true;
  });
}

test("injects either selected profile into two fixed loopback POST requests", async () => {
  const cases = [
    validProfile(),
    validProfile({
      styleId: 654,
      speedScale: 0.7,
      tempoDynamicsScale: 1.4,
      pitchScale: -0.03,
      volumeScale: 1.2,
    }),
  ];

  for (const expectedProfile of cases) {
    const calls = [];
    const responses = [
      jsonResponse({
        speedScale: 1,
        tempoDynamicsScale: 1,
        pitchScale: 0,
        volumeScale: 1,
        untouched: "keep",
      }),
      wavResponse([82, 73, 70, 70]),
    ];
    const inputProfile = { ...expectedProfile };
    const provider = createProvider({
      profile: inputProfile,
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return responses.shift();
      },
    });
    inputProfile.styleId = 999;
    inputProfile.speedScale = 2;

    const audio = await provider.synthesize(" 発送は三件です。 ");

    assert.deepEqual([...audio], [82, 73, 70, 70]);
    assert.equal(calls.length, 2);
    assert.equal(new URL(calls[0].url).origin, "http://127.0.0.1:10101");
    assert.equal(new URL(calls[1].url).origin, "http://127.0.0.1:10101");
    assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:10101\/audio_query\?text=/);
    assert.match(calls[0].url, new RegExp(`speaker=${expectedProfile.styleId}`));
    assert.equal(
      calls[1].url,
      `http://127.0.0.1:10101/synthesis?speaker=${expectedProfile.styleId}`,
    );
    assert.deepEqual(calls.map(({ options }) => options.method), ["POST", "POST"]);
    assert.deepEqual(calls.map(({ options }) => options.redirect), ["error", "error"]);
    const query = JSON.parse(calls[1].options.body);
    assert.equal(query.speedScale, expectedProfile.speedScale);
    assert.equal(query.tempoDynamicsScale, expectedProfile.tempoDynamicsScale);
    assert.equal(query.pitchScale, expectedProfile.pitchScale);
    assert.equal(query.volumeScale, expectedProfile.volumeScale);
    assert.equal(query.untouched, "keep");
  }

  const privateProfileExport = ["UME", "KO_AIVIS_PROFILE"].join("");
  assert.equal(
    Object.hasOwn(require("./aivis-speech-provider.cjs"), privateProfileExport),
    false,
  );
});

test("rejects missing and extra profile fields before fetch", () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    throw new Error("fetch must not run");
  };
  const missingField = validProfile();
  delete missingField.volumeScale;

  for (const profile of [missingField, { ...validProfile(), command: "unsafe" }]) {
    assert.throws(() => createAivisSpeechProvider({ profile, fetchImpl }), Error);
  }
  assert.equal(fetchCalls, 0);
});

test("keeps startup callable but rejects unprofiled speech before fetch", async () => {
  let fetchCalls = 0;

  assert.equal(typeof synthesizeAivisSpeech, "function");
  await assert.rejects(
    synthesizeAivisSpeech("おかえり。", {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run");
      },
    }),
    /profile/i,
  );
  assert.equal(fetchCalls, 0);
});

test("rejects invalid query top-level shapes with the one closed provider error", async () => {
  for (const query of [null, [], "not-an-object", 1, true]) {
    let fetchCalls = 0;
    const provider = createProvider({
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(query);
      },
    });
    await assertClosedFailure(provider.synthesize("おかえり。"), ["not-an-object"]);
    assert.equal(fetchCalls, 1);
  }
});

test("rejects redirected responses for both synthesis POSTs", async () => {
  const queryRedirect = createProvider({
    fetchImpl: async () => jsonResponse({}, { redirected: true }),
  });
  await assertClosedFailure(queryRedirect.synthesize("おかえり。"));

  let fetchCalls = 0;
  const responses = [jsonResponse({}), wavResponse([82], { redirected: true })];
  const synthesisRedirect = createProvider({
    fetchImpl: async () => {
      fetchCalls += 1;
      return responses.shift();
    },
  });
  await assertClosedFailure(synthesisRedirect.synthesize("おかえり。"));
  assert.equal(fetchCalls, 2);
});

test("rejects malformed and oversized declared audio-query lengths without retry", async () => {
  for (const declaredLength of [
    "-1",
    "1.5",
    "invalid-length",
    "9007199254740992",
    String(MAX_AUDIO_QUERY_BYTES + 1),
  ]) {
    let fetchCalls = 0;
    const provider = createProvider({
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse({}, { declaredLength });
      },
    });
    await assertClosedFailure(provider.synthesize("おかえり。"), [declaredLength]);
    assert.equal(fetchCalls, 1);
  }
});

test("accepts an exact-cap streamed query and cancels immediately on byte one over", async () => {
  const exactBytes = new TextEncoder().encode(`{}${" ".repeat(MAX_AUDIO_QUERY_BYTES - 2)}`);
  assert.equal(exactBytes.byteLength, MAX_AUDIO_QUERY_BYTES);
  const exactResponses = [
    streamedResponse(exactBytes, {
      contentType: "application/json",
      declaredLength: MAX_AUDIO_QUERY_BYTES,
    }),
    wavResponse([82]),
  ];
  const exact = createProvider({ fetchImpl: async () => exactResponses.shift() });
  assert.deepEqual([...await exact.synthesize("おかえり。")], [82]);

  let cancelled = 0;
  let released = 0;
  const over = createProvider({
    fetchImpl: async () => streamedResponse(
      [exactBytes, new Uint8Array([32]), new Uint8Array([32])],
      {
        contentType: "application/json",
        onCancel: () => { cancelled += 1; },
        onRelease: () => { released += 1; },
      },
    ),
  });
  await assertClosedFailure(over.synthesize("おかえり。"));
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test("closes invalid query streams, UTF-8, JSON, and reader lifecycle failures", async () => {
  const missingReader = jsonResponse({});
  missingReader.body = {};
  const invalidChunk = streamedResponse("not bytes", { contentType: "application/json" });
  const invalidUtf8 = streamedResponse(new Uint8Array([0xff]), { contentType: "application/json" });
  const invalidJson = rawJsonResponse("{private-response-text");
  const readFailure = jsonResponse({});
  readFailure.body.getReader = () => ({
    read: async () => { throw new Error("private read detail"); },
    releaseLock: () => {},
  });
  const releaseFailure = jsonResponse({}, {
    onRelease: () => { throw new Error("private release detail"); },
  });
  const cancelFailure = streamedResponse(
    [new Uint8Array(MAX_AUDIO_QUERY_BYTES), new Uint8Array([1])],
    {
      contentType: "application/json",
      onCancel: () => { throw new Error("private cancel detail"); },
    },
  );

  for (const response of [
    missingReader,
    invalidChunk,
    invalidUtf8,
    invalidJson,
    readFailure,
    releaseFailure,
    cancelFailure,
  ]) {
    const provider = createProvider({ fetchImpl: async () => response });
    await assertClosedFailure(provider.synthesize("selected private speech"), [
      "private-response-text",
      "private read detail",
      "private release detail",
      "private cancel detail",
      "selected private speech",
    ]);
  }
});

test("rejects a serialized tuned synthesis body that exceeds the query cap", async () => {
  const paddingLength = MAX_AUDIO_QUERY_BYTES - 30;
  const queryBytes = new TextEncoder().encode(JSON.stringify({
    padding: "x".repeat(paddingLength),
  }));
  assert.ok(queryBytes.byteLength <= MAX_AUDIO_QUERY_BYTES);
  const response = streamedResponse(queryBytes, { contentType: "application/json" });
  let fetchCalls = 0;
  const provider = createProvider({
    fetchImpl: async () => {
      fetchCalls += 1;
      return response;
    },
  });

  await assertClosedFailure(provider.synthesize("おかえり。"));
  assert.equal(fetchCalls, 1);
});

test("rejects malformed and oversized declared WAV lengths", async () => {
  for (const declaredLength of [
    "-1",
    "1.5",
    "invalid-length",
    "9007199254740992",
    String(MAX_WAV_BYTES + 1),
  ]) {
    const responses = [jsonResponse({}), wavResponse([1], { declaredLength })];
    let fetchCalls = 0;
    const provider = createProvider({
      fetchImpl: async () => {
        fetchCalls += 1;
        return responses.shift();
      },
    });
    await assertClosedFailure(provider.synthesize("おかえり。"), [declaredLength]);
    assert.equal(fetchCalls, 2);
  }
});

test("accepts exact-cap WAV and cancels and releases immediately on byte one over", async () => {
  const exactResponses = [jsonResponse({}), wavResponse(new Uint8Array(MAX_WAV_BYTES), {
    declaredLength: MAX_WAV_BYTES,
  })];
  const exact = createProvider({ fetchImpl: async () => exactResponses.shift() });
  assert.equal((await exact.synthesize("おかえり。")).byteLength, MAX_WAV_BYTES);

  let cancelled = 0;
  let released = 0;
  const overResponses = [
    jsonResponse({}),
    streamedResponse(
      [new Uint8Array(MAX_WAV_BYTES), new Uint8Array([1]), new Uint8Array([2])],
      {
        contentType: "audio/wav",
        onCancel: () => { cancelled += 1; },
        onRelease: () => { released += 1; },
      },
    ),
  ];
  const over = createProvider({ fetchImpl: async () => overResponses.shift() });
  await assertClosedFailure(over.synthesize("おかえり。"));
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
});

test("closes invalid WAV streams and reader lifecycle failures", async () => {
  const missingReader = wavResponse([1]);
  missingReader.body = null;
  const invalidChunk = streamedResponse("not bytes", { contentType: "audio/wav" });
  const readFailure = wavResponse([1]);
  readFailure.body.getReader = () => ({
    read: async () => { throw new Error("private wav read"); },
    releaseLock: () => {},
  });
  const releaseFailure = wavResponse([1], {
    onRelease: () => { throw new Error("private wav release"); },
  });
  const cancelFailure = streamedResponse(
    [new Uint8Array(MAX_WAV_BYTES), new Uint8Array([1])],
    {
      contentType: "audio/wav",
      onCancel: () => { throw new Error("private wav cancel"); },
    },
  );

  for (const wav of [missingReader, invalidChunk, readFailure, releaseFailure, cancelFailure]) {
    const responses = [jsonResponse({}), wav];
    const provider = createProvider({ fetchImpl: async () => responses.shift() });
    await assertClosedFailure(provider.synthesize("private speech"), [
      "private wav read",
      "private wav release",
      "private wav cancel",
      "private speech",
    ]);
  }
});

test("closes HTTP, content-type, and response failures without leaking bodies", async () => {
  const queryCases = [
    jsonResponse({}, { ok: false }),
    rawJsonResponse("private query body", { contentType: "text/plain" }),
  ];
  for (const queryResponse of queryCases) {
    let fetchCalls = 0;
    const provider = createProvider({
      fetchImpl: async () => { fetchCalls += 1; return queryResponse; },
    });
    await assertClosedFailure(provider.synthesize("おかえり。"), ["private query body"]);
    assert.equal(fetchCalls, 1);
  }

  const synthesisCases = [
    wavResponse([1], { ok: false }),
    streamedResponse(new TextEncoder().encode("private wav body"), {
      contentType: "text/plain",
    }),
  ];
  for (const synthesisResponse of synthesisCases) {
    const responses = [jsonResponse({}), synthesisResponse];
    let fetchCalls = 0;
    const provider = createProvider({
      fetchImpl: async () => { fetchCalls += 1; return responses.shift(); },
    });
    await assertClosedFailure(provider.synthesize("おかえり。"), ["private wav body"]);
    assert.equal(fetchCalls, 2);
  }
});

test("closes raw fetch failures with exactly one call at the failing request", async () => {
  let queryCalls = 0;
  const queryFailure = createProvider({
    fetchImpl: async () => {
      queryCalls += 1;
      throw new Error("private query fetch text");
    },
  });
  await assertClosedFailure(queryFailure.synthesize("private selected speech"), [
    "private query fetch text",
    "private selected speech",
  ]);
  assert.equal(queryCalls, 1);

  let synthesisCalls = 0;
  const synthesisFailure = createProvider({
    fetchImpl: async () => {
      synthesisCalls += 1;
      if (synthesisCalls === 1) return jsonResponse({});
      throw new Error("private synthesis fetch text");
    },
  });
  await assertClosedFailure(synthesisFailure.synthesize("private selected speech"), [
    "private synthesis fetch text",
    "private selected speech",
  ]);
  assert.equal(synthesisCalls, 2);
});

test("creates one 15-second timeout signal per POST", async () => {
  const timeoutCalls = [];
  const signals = [{ name: "query" }, { name: "synthesis" }];
  const responses = [jsonResponse({}), wavResponse([82, 73, 70, 70])];
  const requestSignals = [];

  const provider = createProvider({
    createTimeoutSignal: (timeoutMs) => {
      timeoutCalls.push(timeoutMs);
      return signals[timeoutCalls.length - 1];
    },
    fetchImpl: async (_url, options) => {
      requestSignals.push(options.signal);
      return responses.shift();
    },
  });
  await provider.synthesize("おかえり。");

  assert.deepEqual(timeoutCalls, [15_000, 15_000]);
  assert.deepEqual(requestSignals, signals);
});

test("rejects a caller-controlled POST timeout override before creating a signal", () => {
  let timeoutCalls = 0;

  assert.throws(
    () => createAivisSpeechProvider({
      profile: validProfile(),
      fetchImpl: async () => { throw new Error("fetch must not run"); },
      createTimeoutSignal: () => { timeoutCalls += 1; return undefined; },
      timeoutMs: 1,
    }),
    TypeError,
  );
  assert.equal(timeoutCalls, 0);
});
