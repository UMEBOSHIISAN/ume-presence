"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const {
  MAX_EVENT_BYTES,
  PERSONA_MCP_URL,
  callPersonaSpeech,
  dispatchSpeechWorker,
  forwardCodexNotification,
  main,
  readBoundedStdin,
  runAntigravityMode,
  runClaudeMode,
  runCli,
  runCodexMode,
  runWorkerMode,
  selectAntigravitySpeech,
  selectClaudeSpeech,
  selectCodexSpeech,
} = require("./persona-auto-speech-hook.cjs");

const answer = "自動発話の接続が完了しました。次回から短く話します。";
const clientExecutable = "/fixed/ExampleComputerUseClient";
const codexPayload = JSON.stringify({
  type: "agent-turn-complete",
  "last-assistant-message": answer,
});
const claudePayload = JSON.stringify({
  hook_event_name: "Stop",
  last_assistant_message: answer,
  transcript_path: "/must/not/be/read",
});

function responseJson(value, init) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function successfulMcpResult(overrides = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "ok" }] },
    ...overrides,
  };
}

function createChild() {
  const child = new EventEmitter();
  child.disconnect = () => {};
  child.unref = () => {};
  return child;
}

function createWorkerProcess(onDisconnect = () => {}) {
  const processImpl = new EventEmitter();
  processImpl.connected = true;
  processImpl.disconnect = () => {
    onDisconnect();
    processImpl.connected = false;
    processImpl.emit("disconnect");
  };
  return processImpl;
}

test("client selectors choose the same safe final assistant message", () => {
  assert.equal(selectCodexSpeech(codexPayload), answer);
  assert.equal(selectClaudeSpeech(claudePayload), answer);
});

test("client selectors fail closed for malformed, oversized, unknown, missing, unsafe, or array inputs", () => {
  const oversizedMessage = "あ".repeat(MAX_EVENT_BYTES);
  const cases = [
    [selectCodexSpeech, "{"],
    [selectCodexSpeech, JSON.stringify({ type: "other", "last-assistant-message": answer })],
    [selectCodexSpeech, JSON.stringify({ type: "agent-turn-complete" })],
    [selectCodexSpeech, JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "保存先は /private/file です。" })],
    [selectCodexSpeech, JSON.stringify([])],
    [selectCodexSpeech, JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": oversizedMessage })],
    [selectClaudeSpeech, "{"],
    [selectClaudeSpeech, JSON.stringify({ hook_event_name: "PreToolUse", last_assistant_message: answer })],
    [selectClaudeSpeech, JSON.stringify({ hook_event_name: "Stop" })],
    [selectClaudeSpeech, JSON.stringify({ hook_event_name: "Stop", last_assistant_message: "`npm test` を実行しました。" })],
    [selectClaudeSpeech, JSON.stringify([])],
    [selectClaudeSpeech, JSON.stringify({ hook_event_name: "Stop", last_assistant_message: oversizedMessage })],
  ];

  for (const [selector, payload] of cases) {
    assert.equal(selector(payload), null, payload.slice(0, 80));
  }
});

test("Claude transcript_path values have no effect on selected speech", () => {
  const changedPath = JSON.stringify({
    hook_event_name: "Stop",
    last_assistant_message: answer,
    transcript_path: "/different/nonexistent/transcript",
  });

  assert.equal(selectClaudeSpeech(claudePayload), answer);
  assert.equal(selectClaudeSpeech(changedPath), answer);
});

test("callPersonaSpeech makes exactly one fixed one-shot MCP request", async () => {
  let calls = 0;
  let timerDelay;
  let clearedTimer;
  const timerToken = {};
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, "http://127.0.0.1:47831/mcp");
    assert.equal(url, PERSONA_MCP_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    assert.deepEqual(JSON.parse(options.body), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "speak_text",
        arguments: { text: answer },
      },
    });
    assert.equal(options.signal instanceof AbortSignal, true);
    return responseJson(successfulMcpResult());
  };

  const result = await callPersonaSpeech(answer, {
    fetchImpl,
    setTimeoutImpl(callback, delay) {
      assert.equal(typeof callback, "function");
      timerDelay = delay;
      return timerToken;
    },
    clearTimeoutImpl(token) {
      clearedTimer = token;
    },
  });

  assert.equal(result, true);
  assert.equal(calls, 1);
  assert.equal(timerDelay, 2_000);
  assert.equal(clearedTimer, timerToken);
});

test("callPersonaSpeech times out by aborting its only request", async () => {
  let calls = 0;
  let scheduledDelay;
  const fetchImpl = async (_url, { signal }) => {
    calls += 1;
    await new Promise((resolve) => queueMicrotask(resolve));
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    throw new Error("abort signal was not delivered");
  };

  const result = await callPersonaSpeech(answer, {
    fetchImpl,
    setTimeoutImpl(callback, delay) {
      scheduledDelay = delay;
      queueMicrotask(callback);
      return 1;
    },
    clearTimeoutImpl() {},
  });

  assert.equal(result, false);
  assert.equal(calls, 1);
  assert.equal(scheduledDelay, 2_000);
});

test("callPersonaSpeech cancels a body whose declared length exceeds the response cap", async () => {
  let cancelCalls = 0;
  let readerCalls = 0;
  const response = {
    ok: true,
    redirected: false,
    headers: new Headers({ "content-length": String((64 * 1024) + 1) }),
    body: {
      cancel() {
        cancelCalls += 1;
        return Promise.resolve();
      },
      getReader() {
        readerCalls += 1;
        throw new Error("oversized body must not be read");
      },
    },
  };

  assert.equal(await callPersonaSpeech(answer, {
    fetchImpl: async () => response,
  }), false);
  assert.equal(cancelCalls, 1);
  assert.equal(readerCalls, 0);
});

test("callPersonaSpeech fails closed after one attempt for every invalid response class", async (t) => {
  const oversizedBody = " ".repeat((64 * 1024) + 1);
  const cases = [
    ["connection error", async () => { throw new Error("connection refused"); }],
    ["non-2xx response", async () => responseJson(successfulMcpResult(), { status: 503 })],
    ["redirect response", async () => ({
      ok: true,
      redirected: true,
      headers: new Headers(),
      body: responseJson(successfulMcpResult()).body,
    })],
    ["oversized response", async () => new Response(oversizedBody)],
    ["malformed JSON", async () => new Response("{")],
    ["JSON-RPC error", async () => responseJson({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "failed" } })],
    ["mismatched id", async () => responseJson(successfulMcpResult({ id: 2 }))],
    ["missing result", async () => responseJson({ jsonrpc: "2.0", id: 1 })],
    ["Persona result error", async () => responseJson(successfulMcpResult({ result: { isError: true, content: [] } }))],
  ];

  for (const [name, responder] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const result = await callPersonaSpeech(answer, {
        fetchImpl: async (...args) => {
          calls += 1;
          return responder(...args);
        },
      });
      assert.equal(result, false);
      assert.equal(calls, 1);
    });
  }
});

test("callPersonaSpeech never emits selected text on request failure", async () => {
  const writes = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    assert.equal(await callPersonaSpeech(answer, {
      fetchImpl: async () => { throw new Error("connection failed"); },
    }), false);
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  assert.equal(writes.some((chunk) => chunk.includes(answer)), false);
});

test("forwardCodexNotification preserves the client executable, fixed argument, payload, and integer status", async () => {
  let calls = 0;
  const originalRawPayload = "{ original payload bytes }";
  const spawnImpl = (executable, args, options) => {
    calls += 1;
    assert.equal(executable, clientExecutable);
    assert.deepEqual(args, ["turn-ended", originalRawPayload]);
    assert.deepEqual(options, { shell: false, stdio: "ignore" });
    const child = createChild();
    queueMicrotask(() => child.emit("exit", 23, null));
    return child;
  };

  assert.equal(
    await forwardCodexNotification(
      clientExecutable,
      ["turn-ended", originalRawPayload],
      { spawnImpl },
    ),
    23,
  );
  assert.equal(calls, 1);
});

test("forwardCodexNotification returns 1 for spawn errors and signal termination", async (t) => {
  await t.test("synchronous spawn error", async () => {
    let calls = 0;
    const status = await forwardCodexNotification(clientExecutable, ["turn-ended", codexPayload], {
      spawnImpl() {
        calls += 1;
        throw new Error("spawn failed");
      },
    });
    assert.equal(status, 1);
    assert.equal(calls, 1);
  });

  await t.test("asynchronous spawn error", async () => {
    const child = createChild();
    const statusPromise = forwardCodexNotification(clientExecutable, ["turn-ended", codexPayload], {
      spawnImpl() {
        queueMicrotask(() => child.emit("error", new Error("spawn failed")));
        return child;
      },
    });
    assert.equal(await statusPromise, 1);
  });

  await t.test("signal termination", async () => {
    const child = createChild();
    const statusPromise = forwardCodexNotification(clientExecutable, ["turn-ended", codexPayload], {
      spawnImpl() {
        queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
        return child;
      },
    });
    assert.equal(await statusPromise, 1);
  });
});

test("dispatchSpeechWorker sends selected text once over detached IPC and nowhere else", async () => {
  const child = createChild();
  const forkCalls = [];
  const sent = [];
  let disconnects = 0;
  let unrefs = 0;
  let clearedTimer;
  const timerToken = {};
  child.disconnect = () => { disconnects += 1; };
  child.unref = () => { unrefs += 1; };
  child.send = (message, callback) => {
    sent.push(message);
    queueMicrotask(() => callback(null));
  };

  const resultPromise = dispatchSpeechWorker(answer, {
    scriptPath: "/fixed/persona-auto-speech-hook.cjs",
    forkImpl(...args) {
      forkCalls.push(args);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    setTimeoutImpl(callback, delay) {
      assert.equal(typeof callback, "function");
      assert.equal(delay, 1_000);
      return timerToken;
    },
    clearTimeoutImpl(token) {
      clearedTimer = token;
    },
  });

  assert.equal(await resultPromise, true);
  assert.deepEqual(forkCalls, [[
    "/fixed/persona-auto-speech-hook.cjs",
    ["worker"],
    {
      detached: true,
      env: {},
      execArgv: [],
      serialization: "json",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  ]]);
  assert.equal(JSON.stringify(forkCalls).includes(answer), false);
  assert.deepEqual(sent, [{ type: "speak", text: answer }]);
  assert.equal(disconnects, 1);
  assert.equal(unrefs, 1);
  assert.equal(clearedTimer, timerToken);
});

test("dispatchSpeechWorker has one bounded handoff attempt and no retry", async (t) => {
  const cases = [
    ["fork failure", ({ countFork }) => ({
      forkImpl() {
        countFork();
        throw new Error("fork failed");
      },
    })],
    ["spawn failure", ({ child, countFork }) => ({
      forkImpl() {
        countFork();
        queueMicrotask(() => child.emit("error", new Error("spawn failed")));
        return child;
      },
    })],
    ["send failure", ({ child, countFork, countSend }) => ({
      forkImpl() {
        countFork();
        child.send = (_message, callback) => {
          countSend();
          queueMicrotask(() => callback(new Error("send failed")));
        };
        queueMicrotask(() => child.emit("spawn"));
        return child;
      },
    })],
    ["handshake timeout", ({ child, countFork }) => ({
      forkImpl() {
        countFork();
        return child;
      },
      setTimeoutImpl(callback, delay) {
        assert.equal(delay, 1_000);
        queueMicrotask(callback);
        return 1;
      },
    })],
  ];

  for (const [name, buildDeps] of cases) {
    await t.test(name, async () => {
      const child = createChild();
      let forkCalls = 0;
      let sendCalls = 0;
      const deps = buildDeps({
        child,
        countFork() { forkCalls += 1; },
        countSend() { sendCalls += 1; },
      });
      assert.equal(await dispatchSpeechWorker(answer, {
        clearTimeoutImpl() {},
        ...deps,
      }), false);
      assert.equal(forkCalls, 1);
      assert.ok(sendCalls <= 1);
    });
  }
});

test("dispatchSpeechWorker never sends after its handshake timeout", async () => {
  const child = createChild();
  let sendCalls = 0;
  let expireHandshake;
  child.send = () => { sendCalls += 1; };

  const resultPromise = dispatchSpeechWorker(answer, {
    forkImpl() {
      return child;
    },
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 1_000);
      expireHandshake = callback;
      return 1;
    },
    clearTimeoutImpl() {},
  });
  expireHandshake();
  assert.equal(await resultPromise, false);

  child.emit("spawn");
  assert.equal(sendCalls, 0);
});

test("runCodexMode forwards malformed and ineligible notifications without speech", async () => {
  for (const rawPayload of ["{", JSON.stringify({
    type: "agent-turn-complete",
    "last-assistant-message": "plain English",
  })]) {
    const forwards = [];
    let dispatches = 0;
    const status = await runCodexMode(
      clientExecutable,
      ["turn-ended", rawPayload],
      {
        async forwardImpl(executable, args) {
          forwards.push([executable, args]);
          return 17;
        },
        async dispatchImpl() {
          dispatches += 1;
          return true;
        },
      },
    );
    assert.equal(status, 17);
    assert.deepEqual(forwards, [[clientExecutable, ["turn-ended", rawPayload]]]);
    assert.equal(dispatches, 0);
  }
});

test("runCodexMode starts forwarding and speech independently and preserves client status", async () => {
  let resolveForward;
  let resolveDispatch;
  const started = [];
  const statusPromise = runCodexMode(
    clientExecutable,
    ["turn-ended", codexPayload],
    {
      forwardImpl() {
        started.push("forward");
        return new Promise((resolve) => { resolveForward = resolve; });
      },
      dispatchImpl(text) {
        started.push(["dispatch", text]);
        return new Promise((resolve) => { resolveDispatch = resolve; });
      },
    },
  );

  assert.deepEqual(started, ["forward", ["dispatch", answer]]);
  resolveDispatch(false);
  resolveForward(29);
  assert.equal(await statusPromise, 29);

  assert.equal(await runCodexMode(
    clientExecutable,
    ["turn-ended", codexPayload],
    {
      async forwardImpl() { return 31; },
      async dispatchImpl() { throw new Error("handoff failed"); },
    },
  ), 31);
});

test("runClaudeMode always returns 0 and isolates malformed input or dispatch failure", async () => {
  let dispatches = 0;
  assert.equal(await runClaudeMode("{", {
    async dispatchImpl() {
      dispatches += 1;
      return true;
    },
  }), 0);
  assert.equal(dispatches, 0);

  assert.equal(await runClaudeMode(claudePayload, {
    async dispatchImpl(text) {
      dispatches += 1;
      assert.equal(text, answer);
      throw new Error("handoff failed");
    },
  }), 0);
  assert.equal(dispatches, 1);
});

test("runAntigravityMode always returns 0, writes empty JSON, and isolates malformed input or dispatch failure", async () => {
  let dispatches = 0;
  let written = "";
  const processImpl = {
    stdout: {
      write(chunk) { written += chunk; },
    },
  };

  assert.equal(await runAntigravityMode("{", {
    processImpl,
    async dispatchImpl() {
      dispatches += 1;
      return true;
    },
  }), 0);
  assert.equal(dispatches, 0);
  assert.equal(written, "{}\n");

  const antigravityPayload = JSON.stringify({
    executionNum: 1,
    terminationReason: "model_stop",
    lastAssistantMessage: answer,
  });

  written = "";
  assert.equal(await runAntigravityMode(antigravityPayload, {
    processImpl,
    async dispatchImpl(text) {
      dispatches += 1;
      assert.equal(text, answer);
      throw new Error("handoff failed");
    },
  }), 0);
  assert.equal(dispatches, 1);
  assert.equal(written, "{}\n");
});

test("selectAntigravitySpeech reads from direct message or transcriptPath", () => {
  assert.equal(
    selectAntigravitySpeech(JSON.stringify({ lastAssistantMessage: answer })),
    answer,
  );
  assert.equal(
    selectAntigravitySpeech(JSON.stringify({ last_assistant_message: answer })),
    answer,
  );

  const fakeFs = {
    existsSync() { return true; },
    readFileSync() {
      return [
        JSON.stringify({ source: "USER", content: "hello" }),
        JSON.stringify({ source: "MODEL", type: "PLANNER_RESPONSE", content: answer }),
      ].join("\n");
    },
  };

  assert.equal(
    selectAntigravitySpeech(
      JSON.stringify({ transcriptPath: "/path/to/transcript.jsonl" }),
      { fsImpl: fakeFs },
    ),
    answer,
  );
});

test("selectAntigravitySpeech reads only a bounded transcript tail", () => {
  let readOptions;
  const fakeFs = {
    existsSync() { return true; },
    statSync() { return { size: 100_000 }; },
    openSync() { return 1; },
    readSync(_fd, buffer, offset, length, position) {
      readOptions = { bytes: length, position };
      const latest = Buffer.from(`${JSON.stringify({ source: "MODEL", content: answer })}\n`);
      buffer.fill(0x0a, offset, offset + length);
      latest.copy(buffer, offset + length - latest.length);
      return length;
    },
    closeSync() {},
  };

  assert.equal(
    selectAntigravitySpeech(
      JSON.stringify({ transcriptPath: "/path/to/large-transcript.jsonl" }),
      { fsImpl: fakeFs },
    ),
    answer,
  );
  assert.ok(readOptions.bytes < 100_000);
  assert.equal(readOptions.position, 100_000 - readOptions.bytes);
});

test("selectAntigravitySpeech fails closed on a shortened transcript read", () => {
  const older = "古い応答は完了しました。";
  const latest = "新しい応答は完了しました。";
  const readable = Buffer.from([
    JSON.stringify({ source: "MODEL", content: older }),
    JSON.stringify({ source: "MODEL", content: latest }),
  ].join("\n"));
  let readCalls = 0;
  const fakeFs = {
    existsSync() { return true; },
    statSync() { return { size: readable.length + 128 }; },
    openSync() { return 1; },
    readSync(_fd, buffer, offset) {
      readCalls += 1;
      if (readCalls > 1) return 0;
      readable.copy(buffer, offset);
      return readable.length;
    },
    closeSync() {},
  };

  assert.equal(
    selectAntigravitySpeech(
      JSON.stringify({ transcriptPath: "/path/to/shortened-transcript.jsonl" }),
      { fsImpl: fakeFs },
    ),
    null,
  );
  assert.equal(readCalls, 2);
});

test("readBoundedStdin accepts the exact cap and rejects one byte over it", async () => {
  const exact = Buffer.alloc(MAX_EVENT_BYTES, 0x61);
  assert.equal(
    await readBoundedStdin(Readable.from([exact])),
    exact.toString("utf8"),
  );
  assert.equal(
    await readBoundedStdin(Readable.from([exact, Buffer.from("b")])),
    null,
  );
});

test("runWorkerMode closes against messages that arrive after parent disconnect", async () => {
  const processImpl = createWorkerProcess();
  let speechCalls = 0;
  const statusPromise = runWorkerMode({
    processImpl,
    async callPersonaSpeechImpl() {
      speechCalls += 1;
      return true;
    },
  });

  processImpl.emit("disconnect");
  assert.equal(await statusPromise, 0);
  processImpl.emit("message", { type: "speak", text: answer });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(speechCalls, 0);
});

test("runWorkerMode completes one validated request before disconnecting", async () => {
  const order = [];
  let finishSpeech;
  const processImpl = createWorkerProcess(() => order.push("disconnect"));
  const statusPromise = runWorkerMode({
    processImpl,
    callPersonaSpeechImpl(text) {
      assert.equal(text, answer);
      order.push("speech");
      return new Promise((resolve) => { finishSpeech = resolve; });
    },
  });

  processImpl.emit("message", { type: "speak", text: answer });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(order, ["speech"]);
  finishSpeech(true);
  assert.equal(await statusPromise, 0);
  assert.deepEqual(order, ["speech", "disconnect"]);

  processImpl.emit("message", { type: "speak", text: answer });
  assert.deepEqual(order, ["speech", "disconnect"]);
});

test("runWorkerMode finishes an accepted request after the parent IPC disconnects", async () => {
  let finishSpeech;
  let workerSettled = false;
  const processImpl = createWorkerProcess();
  const statusPromise = runWorkerMode({
    processImpl,
    callPersonaSpeechImpl() {
      return new Promise((resolve) => { finishSpeech = resolve; });
    },
  });
  statusPromise.then(() => { workerSettled = true; });

  processImpl.emit("message", { type: "speak", text: answer });
  await new Promise((resolve) => queueMicrotask(resolve));
  processImpl.connected = false;
  processImpl.emit("disconnect");
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(workerSettled, false);

  finishSpeech(true);
  assert.equal(await statusPromise, 0);
});

test("runWorkerMode rejects malformed or non-exact speech messages without a Persona call", async () => {
  const messages = [
    null,
    [],
    { type: "other", text: answer },
    { type: "speak" },
    { type: "speak", text: "plain English" },
    { type: "speak", text: `  ${answer}  ` },
  ];

  for (const message of messages) {
    let speechCalls = 0;
    let disconnects = 0;
    const processImpl = createWorkerProcess(() => { disconnects += 1; });
    const statusPromise = runWorkerMode({
      processImpl,
      async callPersonaSpeechImpl() {
        speechCalls += 1;
        return true;
      },
    });
    processImpl.emit("message", message);
    assert.equal(await statusPromise, 0);
    assert.equal(speechCalls, 0);
    assert.equal(disconnects, 1);
  }
});

test("runCli accepts only the three documented exact command forms", async () => {
  const calls = [];
  const deps = {
    stdin: Readable.from([claudePayload]),
    async readBoundedStdinImpl(stream) {
      assert.equal(stream, deps.stdin);
      calls.push("stdin");
      return claudePayload;
    },
    async runCodexModeImpl(executable, args) {
      calls.push(["codex", executable, args]);
      return 41;
    },
    async runClaudeModeImpl(rawPayload) {
      calls.push(["claude", rawPayload]);
      return 0;
    },
    async runAntigravityModeImpl(rawPayload) {
      calls.push(["antigravity", rawPayload]);
      return 0;
    },
    async runWorkerModeImpl() {
      calls.push("worker");
      return 0;
    },
  };

  assert.equal(await runCli(
    ["codex", clientExecutable, "turn-ended", codexPayload],
    deps,
  ), 41);
  assert.equal(await runCli(["claude"], deps), 0);
  assert.equal(await runCli(["antigravity"], deps), 0);
  assert.equal(await runCli(["worker"], deps), 0);
  assert.deepEqual(calls, [
    ["codex", clientExecutable, ["turn-ended", codexPayload]],
    "stdin",
    ["claude", claudePayload],
    "stdin",
    ["antigravity", claudePayload],
    "worker",
  ]);

  for (const invalidArgv of [
    [],
    ["unknown"],
    ["codex", clientExecutable, "turn-ended"],
    ["codex", clientExecutable, "turn-ended", codexPayload, "extra"],
    ["claude", "extra"],
    ["antigravity", "extra"],
    ["worker", "extra"],
  ]) {
    assert.equal(await runCli(invalidArgv, {
      async runCodexModeImpl() { throw new Error("must not run"); },
      async runClaudeModeImpl() { throw new Error("must not run"); },
      async runAntigravityModeImpl() { throw new Error("must not run"); },
      async runWorkerModeImpl() { throw new Error("must not run"); },
    }), 1, invalidArgv.join(" "));
  }
});

test("runCli contains every mode-boundary failure", async () => {
  assert.equal(await runCli(
    ["codex", clientExecutable, "turn-ended", codexPayload],
    { runCodexModeImpl() { throw new Error("codex boundary"); } },
  ), 1);
  assert.equal(await runCli(["claude"], {
    readBoundedStdinImpl() { throw new Error("stdin boundary"); },
  }), 0);
  assert.equal(await runCli(["claude"], {
    async readBoundedStdinImpl() { return claudePayload; },
    runClaudeModeImpl() { throw new Error("claude boundary"); },
  }), 0);
  assert.equal(await runCli(["antigravity"], {
    readBoundedStdinImpl() { throw new Error("stdin boundary"); },
  }), 0);
  assert.equal(await runCli(["antigravity"], {
    async readBoundedStdinImpl() { return claudePayload; },
    runAntigravityModeImpl() { throw new Error("antigravity boundary"); },
  }), 0);
  assert.equal(await runCli(["worker"], {
    runWorkerModeImpl() { throw new Error("worker boundary"); },
  }), 0);
});

test("dispatchSpeechWorker skips speech when mute file exists", async () => {
  const fakeFs = {
    existsSync(p) { return p === "/custom/mute"; },
  };
  let forked = false;

  assert.equal(await dispatchSpeechWorker(answer, {
    fsImpl: fakeFs,
    muteFilePath: "/custom/mute",
    forkImpl() {
      forked = true;
      return null;
    },
  }), false);
  assert.equal(forked, false);
});

test("dispatchSpeechWorker defaults to the generic hook as its detached worker", async () => {
  const child = createChild();
  child.send = (_message, callback) => queueMicrotask(() => callback(null));
  let workerPath;

  assert.equal(await dispatchSpeechWorker(answer, {
    forkImpl(scriptPath) {
      workerPath = scriptPath;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    setTimeoutImpl() { return 1; },
    clearTimeoutImpl() {},
  }), true);
  assert.equal(
    workerPath,
    path.join(__dirname, "persona-auto-speech-hook.cjs"),
  );
});

test("main awaits runCli and normalizes every result onto the injected process", async () => {
  const calls = [];
  const processImpl = {
    exitCode: undefined,
    exit() { throw new Error("process.exit must not be called"); },
  };

  assert.equal(await main(["mode"], {
    processImpl,
    async runCliImpl(argv) {
      calls.push(argv);
      await new Promise((resolve) => queueMicrotask(resolve));
      return 37;
    },
  }), 37);
  assert.deepEqual(calls, [["mode"]]);
  assert.equal(processImpl.exitCode, 37);

  for (const runCliImpl of [
    async () => undefined,
    async () => { throw new Error("contained"); },
  ]) {
    processImpl.exitCode = undefined;
    assert.equal(await main([], { processImpl, runCliImpl }), 1);
    assert.equal(processImpl.exitCode, 1);
  }
});

test("generic automatic speech production modules contain no character identity token", () => {
  const forbiddenToken = ["ume", "ko"].join("");
  for (const filename of [
    "persona-auto-speech-selection.cjs",
    "persona-auto-speech-hook.cjs",
  ]) {
    const source = fs.readFileSync(path.join(__dirname, filename), "utf8");
    assert.equal(source.toLowerCase().includes(forbiddenToken), false, filename);
  }
});
