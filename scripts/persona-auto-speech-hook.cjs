"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork, spawn } = require("node:child_process");
const {
  selectAutomaticSpeechText,
} = require("./persona-auto-speech-selection.cjs");

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PERSONA_MCP_URL = "http://127.0.0.1:47831/mcp";
const PERSONA_TIMEOUT_MS = 2_000;
const WORKER_HANDSHAKE_TIMEOUT_MS = 1_000;
const MUTE_FILE_PATH = path.join(os.homedir(), ".persona_mute");
const MAX_TRANSCRIPT_TAIL_BYTES = 64 * 1024;

function readTranscriptTail(fsImpl, transcriptPath) {
  if (
    typeof fsImpl.statSync !== "function"
    || typeof fsImpl.openSync !== "function"
    || typeof fsImpl.readSync !== "function"
    || typeof fsImpl.closeSync !== "function"
  ) {
    return fsImpl.readFileSync(transcriptPath, "utf8");
  }
  const size = fsImpl.statSync(transcriptPath).size;
  const bytes = Math.min(size, MAX_TRANSCRIPT_TAIL_BYTES);
  const buffer = Buffer.alloc(bytes);
  const fd = fsImpl.openSync(transcriptPath, "r");
  try {
    let bytesRead = 0;
    while (bytesRead < bytes) {
      const count = fsImpl.readSync(
        fd,
        buffer,
        bytesRead,
        bytes - bytesRead,
        size - bytes + bytesRead,
      );
      if (!Number.isSafeInteger(count) || count < 0 || count > bytes - bytesRead) return "";
      if (count === 0) return "";
      bytesRead += count;
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return buffer.toString("utf8");
}

function selectClientSpeech(rawPayload, discriminator, eventName, messageField) {
  if (
    typeof rawPayload !== "string"
    || Buffer.byteLength(rawPayload, "utf8") > MAX_EVENT_BYTES
  ) {
    return null;
  }

  try {
    const event = JSON.parse(rawPayload);
    if (
      event === null
      || typeof event !== "object"
      || Array.isArray(event)
      || event[discriminator] !== eventName
    ) {
      return null;
    }
    return selectAutomaticSpeechText(event[messageField]);
  } catch {
    return null;
  }
}

function selectCodexSpeech(rawPayload) {
  return selectClientSpeech(
    rawPayload,
    "type",
    "agent-turn-complete",
    "last-assistant-message",
  );
}

function selectClaudeSpeech(rawPayload) {
  return selectClientSpeech(
    rawPayload,
    "hook_event_name",
    "Stop",
    "last_assistant_message",
  );
}

function selectAntigravitySpeech(rawPayload, deps = {}) {
  if (
    typeof rawPayload !== "string"
    || Buffer.byteLength(rawPayload, "utf8") > MAX_EVENT_BYTES
  ) {
    return null;
  }

  try {
    const event = JSON.parse(rawPayload);
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      return null;
    }

    const directMessage = event.last_assistant_message
      ?? event.lastAssistantMessage
      ?? event.message;
    if (typeof directMessage === "string" && directMessage.trim() !== "") {
      return selectAutomaticSpeechText(directMessage);
    }

    const transcriptPath = event.transcriptPath;
    if (typeof transcriptPath === "string" && transcriptPath !== "") {
      const fsImpl = deps.fsImpl ?? fs;
      if (fsImpl.existsSync(transcriptPath)) {
        const lines = readTranscriptTail(fsImpl, transcriptPath).trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          try {
            const step = JSON.parse(lines[i]);
            if (
              step !== null
              && typeof step === "object"
              && step.source === "MODEL"
              && (step.type === "PLANNER_RESPONSE" || typeof step.content === "string")
              && typeof step.content === "string"
              && step.content.trim() !== ""
            ) {
              const speech = selectAutomaticSpeechText(step.content);
              if (speech !== null) return speech;
            }
          } catch {
            // ignore invalid line
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function readBoundedResponse(response) {
  const declaredLength = response.headers?.get?.("content-length");
  if (
    declaredLength !== null
    && declaredLength !== undefined
    && /^\d+$/.test(declaredLength)
    && Number(declaredLength) > MAX_RESPONSE_BYTES
  ) {
    try {
      const cancellation = response.body?.cancel?.();
      cancellation?.catch?.(() => {});
    } catch {
      // The response is already rejected; cancellation is best effort.
    }
    return null;
  }

  const reader = response.body?.getReader?.();
  if (reader === undefined) return null;

  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) return null;
    byteLength += value.byteLength;
    if (byteLength > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function callPersonaSpeech(text, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const AbortControllerImpl = deps.AbortControllerImpl ?? globalThis.AbortController;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;
  const controller = new AbortControllerImpl();
  const timeout = setTimeoutImpl(() => controller.abort(), PERSONA_TIMEOUT_MS);

  try {
    const response = await fetchImpl(PERSONA_MCP_URL, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "speak_text",
          arguments: { text },
        },
      }),
      signal: controller.signal,
    });
    if (!response?.ok || response.redirected) return false;

    const body = await readBoundedResponse(response);
    if (body === null) return false;

    const parsed = JSON.parse(body);
    return parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && parsed.jsonrpc === "2.0"
      && parsed.id === 1
      && !Object.hasOwn(parsed, "error")
      && Object.hasOwn(parsed, "result")
      && parsed.result !== null
      && typeof parsed.result === "object"
      && !Array.isArray(parsed.result)
      && parsed.result.isError !== true;
  } catch {
    return false;
  } finally {
    clearTimeoutImpl(timeout);
  }
}

function forwardCodexNotification(executable, args, deps = {}) {
  const spawnImpl = deps.spawnImpl ?? spawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(executable, args, {
        shell: false,
        stdio: "ignore",
      });
    } catch {
      resolve(1);
      return;
    }

    let settled = false;
    const settle = (status) => {
      if (settled) return;
      settled = true;
      resolve(status);
    };
    child.once("error", () => settle(1));
    child.once("exit", (status, signal) => {
      settle(signal === null && Number.isInteger(status) ? status : 1);
    });
  });
}

function dispatchSpeechWorker(text, deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  const muteFilePath = deps.muteFilePath ?? MUTE_FILE_PATH;
  try {
    if (fsImpl.existsSync(muteFilePath)) {
      return Promise.resolve(false);
    }
  } catch {
    // Best effort check
  }

  const forkImpl = deps.forkImpl ?? fork;
  const scriptPath = deps.scriptPath ?? __filename;
  const setTimeoutImpl = deps.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? clearTimeout;

  return new Promise((resolve) => {
    let child;
    try {
      child = forkImpl(scriptPath, ["worker"], {
        detached: true,
        env: {},
        execArgv: [],
        serialization: "json",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    let timeout;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timeout);
      try {
        child.disconnect();
      } catch {
        // The handoff result is already final; cleanup is best effort.
      }
      try {
        child.unref();
      } catch {
        // The handoff result is already final; cleanup is best effort.
      }
      resolve(result);
    };

    timeout = setTimeoutImpl(
      () => settle(false),
      WORKER_HANDSHAKE_TIMEOUT_MS,
    );
    child.once("error", () => settle(false));
    child.once("spawn", () => {
      if (settled) return;
      try {
        child.send({ type: "speak", text }, (error) => settle(error == null));
      } catch {
        settle(false);
      }
    });
  });
}

async function runCodexMode(executable, args, deps = {}) {
  const forwardImpl = deps.forwardImpl
    ?? ((target, targetArgs) => forwardCodexNotification(target, targetArgs, deps));
  const dispatchImpl = deps.dispatchImpl
    ?? ((text) => dispatchSpeechWorker(text, deps));

  let forwardPromise;
  try {
    forwardPromise = Promise.resolve(forwardImpl(executable, args));
  } catch {
    forwardPromise = Promise.resolve(1);
  }

  const speech = Array.isArray(args) ? selectCodexSpeech(args[1]) : null;
  let dispatchPromise = Promise.resolve(false);
  if (speech !== null) {
    try {
      dispatchPromise = Promise.resolve(dispatchImpl(speech));
    } catch {
      dispatchPromise = Promise.resolve(false);
    }
  }

  const [status] = await Promise.all([
    forwardPromise.catch(() => 1),
    dispatchPromise.catch(() => false),
  ]);
  return Number.isInteger(status) ? status : 1;
}

async function runClaudeMode(rawPayload, deps = {}) {
  const dispatchImpl = deps.dispatchImpl
    ?? ((text) => dispatchSpeechWorker(text, deps));
  const speech = selectClaudeSpeech(rawPayload);
  if (speech !== null) {
    try {
      await dispatchImpl(speech);
    } catch {
      // Optional speech must not fail Claude's Stop hook.
    }
  }
  return 0;
}

async function runAntigravityMode(rawPayload, deps = {}) {
  const dispatchImpl = deps.dispatchImpl
    ?? ((text) => dispatchSpeechWorker(text, deps));
  const speech = selectAntigravitySpeech(rawPayload, deps);
  if (speech !== null) {
    try {
      await dispatchImpl(speech);
    } catch {
      // Optional speech must not fail Stop hook.
    }
  }
  const processImpl = deps.processImpl ?? process;
  try {
    processImpl.stdout.write(JSON.stringify({}) + "\n");
  } catch {
    // Stdout write is best effort.
  }
  return 0;
}

async function readBoundedStdin(stream) {
  const chunks = [];
  let byteLength = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_EVENT_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, byteLength).toString("utf8");
}

function runWorkerMode(deps = {}) {
  const processImpl = deps.processImpl ?? process;
  const callPersonaSpeechImpl = deps.callPersonaSpeechImpl ?? callPersonaSpeech;
  return new Promise((resolve) => {
    let handling = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      processImpl.removeListener("disconnect", onDisconnect);
      processImpl.removeListener("message", onMessage);
      try {
        if (processImpl.connected) processImpl.disconnect();
      } catch {
        // Worker shutdown is best effort after its single request.
      }
      resolve(0);
    };

    const onDisconnect = () => {
      if (!handling) finish();
    };
    const onMessage = (message) => {
      if (settled || handling) return;
      handling = true;
      void (async () => {
        try {
          if (
            message !== null
            && typeof message === "object"
            && !Array.isArray(message)
            && message.type === "speak"
            && selectAutomaticSpeechText(message.text) === message.text
          ) {
            await callPersonaSpeechImpl(message.text);
          }
        } catch {
          // Optional speech must not escape the detached worker boundary.
        } finally {
          finish();
        }
      })();
    };

    processImpl.once("disconnect", onDisconnect);
    processImpl.once("message", onMessage);
  });
}

async function runCli(argv, deps = {}) {
  const [mode, ...args] = argv;
  if (mode === "codex") {
    try {
      if (args.length !== 3) return 1;
      const [executable, fixedArgument, rawPayload] = args;
      if (
        typeof executable !== "string"
        || executable === ""
        || fixedArgument !== "turn-ended"
        || typeof rawPayload !== "string"
      ) {
        return 1;
      }
      const runCodexModeImpl = deps.runCodexModeImpl ?? runCodexMode;
      return await runCodexModeImpl(
        executable,
        [fixedArgument, rawPayload],
      );
    } catch {
      return 1;
    }
  }

  if (mode === "claude") {
    try {
      if (args.length !== 0) return 1;
      const readBoundedStdinImpl = deps.readBoundedStdinImpl ?? readBoundedStdin;
      const runClaudeModeImpl = deps.runClaudeModeImpl ?? runClaudeMode;
      return await runClaudeModeImpl(
        await readBoundedStdinImpl(deps.stdin ?? process.stdin),
      );
    } catch {
      return 0;
    }
  }

  if (mode === "antigravity" || mode === "agy") {
    try {
      if (args.length !== 0) return 1;
      const readBoundedStdinImpl = deps.readBoundedStdinImpl ?? readBoundedStdin;
      const runAntigravityModeImpl = deps.runAntigravityModeImpl ?? runAntigravityMode;
      return await runAntigravityModeImpl(
        await readBoundedStdinImpl(deps.stdin ?? process.stdin),
        deps,
      );
    } catch {
      return 0;
    }
  }

  if (mode === "worker") {
    try {
      if (args.length !== 0) return 1;
      const runWorkerModeImpl = deps.runWorkerModeImpl ?? runWorkerMode;
      return await runWorkerModeImpl();
    } catch {
      return 0;
    }
  }

  return 1;
}

async function main(argv, deps = {}) {
  const processImpl = deps.processImpl ?? process;
  const runCliImpl = deps.runCliImpl ?? runCli;
  try {
    const status = await runCliImpl(argv, deps);
    const normalizedStatus = Number.isInteger(status) ? status : 1;
    processImpl.exitCode = normalizedStatus;
    return normalizedStatus;
  } catch {
    processImpl.exitCode = 1;
    return 1;
  }
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = {
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
};
