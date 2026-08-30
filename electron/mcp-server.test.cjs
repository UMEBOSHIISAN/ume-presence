"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { createBridgeServer } = require("./bridge-server.cjs");
const {
  ANIMATION_NAMES,
  RITUAL_NAMES,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createPersonaMcpHandler,
  projectPersonaStatus,
} = require("./mcp-server.cjs");

const EXPECTED_SERVER_INSTRUCTIONS = [
  "Persona controls the installed local desktop character.",
  "Use play_animation when the user asks for a visual reaction or it clearly supports their request.",
  "Use play_ritual only for an explicit visual work ritual; rituals never speak.",
  "Use control_window to show, hide, or toggle Persona.",
  "Normal eligible final replies are spoken by the automatic completion hook; do not call speak_text for those replies.",
  "Use speak_text only when the user explicitly asks for spoken playback or a non-final alert must be heard immediately.",
  "Write the installed character's spoken text in natural standard Japanese.",
  "Do not speak code, commands, logs, paths, hashes, long lists, internal reasoning, or routine progress unless the user explicitly asks.",
  "get_status is read-only.",
].join(" ");

test("Persona MCP exposes and executes the local character tools", async (context) => {
  const animations = [];
  const rituals = [];
  const spoken = [];
  const windowActions = [];
  let windowVisible = false;
  const voiceState = {
    activity: "listening",
    microphoneMuted: false,
    outputMuted: false,
    phase: "active",
  };
  const listener = {
    available: true,
    capturing: false,
    monitoring: true,
    source: null,
  };
  const mcpHandler = createPersonaMcpHandler({
    onAnimation: (animation) => animations.push(animation),
    onRitual: (ritual) => {
      rituals.push(ritual);
      return { status: "started", ritual };
    },
    onSpeech: async (text) => {
      spoken.push(text);
      return { codePoints: [...text.trim()].length };
    },
    onWindowAction: (action) => {
      windowActions.push(action);
      if (action === "show") windowVisible = true;
      else if (action === "hide") windowVisible = false;
      else windowVisible = !windowVisible;
      return windowVisible;
    },
    getStatus: () => ({
      windowVisible,
      voiceState,
      listener,
      speechEngine: {
        state: "ready-owned",
        ownership: "owned",
        attempts: 12,
        errorCode: "PRIVATE_ERROR",
        executablePath: "/private/engine",
        pid: 9876,
        profile: { secret: true },
      },
      privateTopLevel: true,
    }),
  });
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler,
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await client.connect(transport);
  const tools = await client.listTools();

  assert.deepEqual(
    tools.tools.map((tool) => tool.name),
    ["play_animation", "play_ritual", "control_window", "speak_text", "get_status"],
  );
  assert.equal(SERVER_INSTRUCTIONS, EXPECTED_SERVER_INSTRUCTIONS);
  assert.equal(client.getInstructions(), EXPECTED_SERVER_INSTRUCTIONS);
  assert.equal(SERVER_INSTRUCTIONS.includes("Private Character"), false);
  assert.match(SERVER_INSTRUCTIONS, /standard Japanese/i);
  assert.match(SERVER_INSTRUCTIONS, /automatic completion hook/i);
  assert.match(SERVER_INSTRUCTIONS, /explicitly asks/i);
  assert.match(SERVER_INSTRUCTIONS, /non-final alert/i);
  const speechTool = tools.tools.find((tool) => tool.name === "speak_text");
  assert.match(speechTool.description, /explicit user request/i);
  assert.match(speechTool.description, /non-final alert/i);
  assert.deepEqual(
    tools.tools
      .find((tool) => tool.name === "play_animation")
      .inputSchema.properties.animation.enum,
    ANIMATION_NAMES,
  );
  assert.deepEqual(
    tools.tools
      .find((tool) => tool.name === "play_ritual")
      .inputSchema.properties.ritual.enum,
    RITUAL_NAMES,
  );
  assert.deepEqual(
    tools.tools
      .find((tool) => tool.name === "control_window")
      .inputSchema.properties.action.enum,
    WINDOW_ACTIONS,
  );

  const animationResult = await client.callTool({
    name: "play_animation",
    arguments: { animation: "dance" },
  });
  const extraFieldResult = await client.callTool({
    name: "play_ritual",
    arguments: { ritual: "greeting", text: "must-be-rejected" },
  });
  assert.equal(extraFieldResult.isError, true);
  assert.deepEqual(rituals, []);
  const ritualResult = await client.callTool({
    name: "play_ritual",
    arguments: { ritual: "work_complete" },
  });
  const windowResult = await client.callTool({
    name: "control_window",
    arguments: { action: "show" },
  });
  const statusResult = await client.callTool({
    name: "get_status",
    arguments: {},
  });
  const speechResult = await client.callTool({
    name: "speak_text",
    arguments: { text: "発送は三件です。" },
  });

  assert.deepEqual(animations, ["dance"]);
  assert.deepEqual(rituals, ["work_complete"]);
  assert.deepEqual(windowActions, ["show"]);
  assert.deepEqual(spoken, ["発送は三件です。"]);
  assert.match(animationResult.content[0].text, /dance animation/);
  assert.equal(ritualResult.content[0].text, "Persona started the work_complete ritual.");
  assert.match(windowResult.content[0].text, /now visible/);
  assert.deepEqual(JSON.parse(statusResult.content[0].text), {
    windowVisible: true,
    voiceState,
    listener,
    speechEngine: { state: "ready" },
  });
  assert.equal(
    speechResult.content[0].text,
    "The installed character finished speaking locally (8 characters).",
  );
  assert.equal(speechResult.content[0].text.includes("発送は三件です。"), false);
});

test("Persona MCP returns exact neutral copy for a busy ritual controller", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => {},
      onRitual: () => ({ status: "busy", ritual: "greeting", private: "/private/path" }),
      onSpeech: async () => ({ codePoints: 0 }),
      onWindowAction: () => false,
      getStatus: () => ({ windowVisible: false, voiceState: null, listener: null }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await client.connect(transport);

  const result = await client.callTool({
    name: "play_ritual",
    arguments: { ritual: "break" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Persona ritual is busy.");
  assert.equal(JSON.stringify(result).includes("/private/path"), false);
});

test("status projector preserves the closed app status and emits only a valid generic engine state", () => {
  const voiceState = Object.freeze({ phase: "active" });
  const listener = Object.freeze({
    available: true,
    capturing: false,
    monitoring: true,
    source: "Supported voice app",
  });
  for (const [inputState, expectedState] of [
    ["idle", "idle"],
    ["probing", "starting"],
    ["starting", "starting"],
    ["waiting", "starting"],
    ["stopping", "starting"],
    ["ready-existing", "ready"],
    ["ready-owned", "ready"],
    ["requires-setup", "requires-setup"],
    ["failed", "failed"],
    ["unknown-private-state", "failed"],
  ]) {
    const projected = projectPersonaStatus({
      windowVisible: true,
      voiceState,
      listener,
      speechEngine: {
        state: inputState,
        ownership: "owned",
        attempts: 99,
        errorCode: "PRIVATE",
        path: "/private/path",
        pid: 123,
        profile: { private: true },
        unknown: true,
      },
      unknownTopLevel: true,
    });
    assert.deepEqual(projected, {
      windowVisible: true,
      voiceState,
      listener,
      speechEngine: { state: expectedState },
    });
    assert.deepEqual(Object.keys(projected), [
      "windowVisible",
      "voiceState",
      "listener",
      "speechEngine",
    ]);
    assert.deepEqual(Object.keys(projected.speechEngine), ["state"]);
  }
});

test("status projector closes listener errors, paths, unknown fields, and unbounded sources", () => {
  const projected = projectPersonaStatus({
    windowVisible: false,
    voiceState: null,
    listener: {
      available: false,
      capturing: false,
      monitoring: true,
      source: "x".repeat(500),
      error: "Native listener is missing: /private/helper/path",
      helperPath: "/private/helper/path",
      unknown: { private: true },
    },
    speechEngine: { state: "idle" },
  });

  assert.deepEqual(projected.listener, {
    available: false,
    capturing: false,
    monitoring: true,
    source: null,
  });
  assert.deepEqual(Object.keys(projected.listener), [
    "available",
    "capturing",
    "monitoring",
    "source",
  ]);
  assert.equal(JSON.stringify(projected).includes("private"), false);

  assert.equal(projectPersonaStatus({ listener: "invalid" }).listener, null);
  assert.equal(projectPersonaStatus({
    listener: { available: true, capturing: 1, monitoring: true, source: null },
  }).listener, null);
});

test("status projector rejects short path, URL, control, and bidi listener sources", () => {
  const unsafeSources = [
    "/Users/private/listener-helper",
    "C:\\private\\listener-helper.exe",
    "https://private.example/listener",
    "Supported\u0000voice app",
    "Supported\u202Evoice app",
  ];

  assert.deepEqual(unsafeSources.map((source) => projectPersonaStatus({
    listener: {
      available: true,
      capturing: false,
      monitoring: true,
      source,
    },
  }).listener.source), [null, null, null, null, null]);
});

test("Persona MCP rejects unknown animation names before invoking the app", async (context) => {
  const animations = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: (animation) => animations.push(animation),
      onSpeech: async () => ({ codePoints: 0 }),
      onWindowAction: () => false,
      getStatus: () => ({
        windowVisible: false,
        voiceState: null,
        listener: null,
      }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });

  await client.connect(transport);
  const result = await client.callTool({
    name: "play_animation",
    arguments: { animation: "download_from_the_internet" },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(animations, []);
});

test("Persona MCP validates speech input before invoking the controller", async (context) => {
  const spoken = [];
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => {},
      onWindowAction: () => false,
      onSpeech: async (text) => {
        spoken.push(text);
        return { codePoints: [...text.trim()].length };
      },
      getStatus: () => ({ windowVisible: false, voiceState: null, listener: null }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await client.connect(transport);

  for (const argumentsValue of [
    { text: "   " },
    { text: "おかえり。", extra: true },
    { text: "😀".repeat(241) },
  ]) {
    const result = await client.callTool({
      name: "speak_text",
      arguments: argumentsValue,
    });
    assert.equal(result.isError, true);
  }
  assert.deepEqual(spoken, []);
});

test("Persona MCP returns exact neutral copy for a busy speech controller", async (context) => {
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => {},
      onWindowAction: () => false,
      onSpeech: async () => {
        const error = new Error("Private Character is already speaking");
        error.code = "SPEECH_BUSY";
        throw error;
      },
      getStatus: () => ({ windowVisible: false, voiceState: null, listener: null }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await client.connect(transport);

  const result = await client.callTool({
    name: "speak_text",
    arguments: { text: "秘密の入力" },
  });

  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Character speech is busy.");
});

test("Persona MCP bounds speech controller failures without reflecting text", async (context) => {
  const secretText = "読み上げ内容をエラーへ出さない";
  const bridge = createBridgeServer({
    port: 0,
    onEvent: () => {},
    mcpHandler: createPersonaMcpHandler({
      onAnimation: () => {},
      onWindowAction: () => false,
      onSpeech: async () => {
        const error = new Error(`${secretText}${"x".repeat(500)}`);
        error.code = "PROVIDER_FAILED";
        throw error;
      },
      getStatus: () => ({ windowVisible: false, voiceState: null, listener: null }),
    }),
  });
  const address = await bridge.listen();
  const client = new Client({ name: "persona-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  context.after(async () => {
    await client.close();
    await bridge.close();
  });
  await client.connect(transport);

  const result = await client.callTool({
    name: "speak_text",
    arguments: { text: secretText },
  });

  assert.equal(result.isError, true);
  assert.equal(
    result.content[0].text,
    "Character speech could not be played locally.",
  );
  assert.equal(result.content[0].text.includes(secretText), false);
});
