"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const z = require("zod/v4");
const { version } = require("../package.json");

const MCP_PATH = "/mcp";
const MAX_SPEECH_CODE_POINTS = 240;
const MAX_LISTENER_SOURCE_CODE_POINTS = 160;
const ANIMATION_NAMES = ["idle", "greeting", "talk", "celebrate", "dance"];
const RITUAL_NAMES = ["greeting", "work_complete", "break"];
const WINDOW_ACTIONS = ["show", "hide", "toggle"];
const SERVER_INSTRUCTIONS = [
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

function projectSpeechEngineState(snapshot) {
  const state = snapshot?.state;
  if (state === "idle" || state === "stopped") return "idle";
  if (state === "probing" || state === "starting" || state === "waiting" || state === "stopping") {
    return "starting";
  }
  if (state === "ready" || state === "ready-existing" || state === "ready-owned") return "ready";
  if (state === "requires-setup") return "requires-setup";
  return "failed";
}

function isSafeListenerSource(source) {
  if (typeof source !== "string") return false;
  const codePointLength = [...source].length;
  return codePointLength > 0
    && codePointLength <= MAX_LISTENER_SOURCE_CODE_POINTS
    && source.trim().length > 0
    && !source.includes("/")
    && !source.includes("\\")
    && !source.includes(":")
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(source);
}

function projectListenerStatus(listener) {
  if (listener === null || typeof listener !== "object" || Array.isArray(listener)) return null;
  if (typeof listener.available !== "boolean"
    || typeof listener.capturing !== "boolean"
    || typeof listener.monitoring !== "boolean") return null;
  const source = isSafeListenerSource(listener.source) ? listener.source : null;
  return {
    available: listener.available,
    capturing: listener.capturing,
    monitoring: listener.monitoring,
    source,
  };
}

function projectPersonaStatus(status) {
  return {
    windowVisible: status?.windowVisible === true,
    voiceState: status?.voiceState ?? null,
    listener: projectListenerStatus(status?.listener),
    speechEngine: { state: projectSpeechEngineState(status?.speechEngine) },
  };
}

function textResult(text) {
  return {
    content: [{ type: "text", text }],
  };
}

function createPersonaMcpServer({ onAnimation, onRitual, onWindowAction, onSpeech, getStatus }) {
  const server = new McpServer(
    {
      name: "Persona",
      version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "play_animation",
    {
      title: "Play Persona animation",
      description:
        "Play one of Persona's installed character animations in the desktop window. This also shows Persona.",
      inputSchema: {
        animation: z
          .enum(ANIMATION_NAMES)
          .describe("The character animation to play."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ animation }) => {
      await onAnimation(animation);
      return textResult(`Persona is playing the ${animation} animation.`);
    },
  );

  server.registerTool(
    "play_ritual",
    {
      title: "Play Persona ritual",
      description:
        "Play one of Persona's installed visual work rituals in the desktop window. This also shows Persona.",
      inputSchema: z.object({
        ritual: z.enum(RITUAL_NAMES).describe("The visual work ritual to play."),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ ritual }) => {
      const result = await onRitual(ritual);
      if (result.status === "busy") {
        return {
          isError: true,
          content: [{ type: "text", text: "Persona ritual is busy." }],
        };
      }
      return textResult(`Persona started the ${ritual} ritual.`);
    },
  );

  server.registerTool(
    "control_window",
    {
      title: "Control Persona window",
      description:
        "Show, hide, or toggle the local Persona window. Hiding the window does not quit Persona.",
      inputSchema: {
        action: z.enum(WINDOW_ACTIONS).describe("The window action to perform."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ action }) => {
      const visible = await onWindowAction(action);
      return textResult(`Persona's window is now ${visible ? "visible" : "hidden"}.`);
    },
  );

  server.registerTool(
    "speak_text",
    {
      title: "Speak through Persona",
      description:
        "Speak through the installed private local voice only for an explicit user request for spoken playback or a non-final alert that must be heard immediately.",
      inputSchema: z
        .object({
          text: z
            .string()
            .trim()
            .min(1)
            .refine((text) => [...text].length <= MAX_SPEECH_CODE_POINTS, {
              message: `Text cannot exceed ${MAX_SPEECH_CODE_POINTS} characters.`,
            }),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text }) => {
      try {
        const result = await onSpeech(text);
        return textResult(
          `The installed character finished speaking locally (${result.codePoints} characters).`,
        );
      } catch (error) {
        const message =
          error?.code === "SPEECH_BUSY"
            ? "Character speech is busy."
            : "Character speech could not be played locally.";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );

  server.registerTool(
    "get_status",
    {
      title: "Get Persona status",
      description:
        "Read Persona's window visibility, voice state, and local listener status.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult(JSON.stringify(projectPersonaStatus(await getStatus()))),
  );

  return server;
}

function createPersonaMcpHandler(controller) {
  return async (request, response, parsedBody) => {
    const server = createPersonaMcpServer(controller);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      }
      throw error;
    } finally {
      await transport.close();
      await server.close();
    }
  };
}

module.exports = {
  ANIMATION_NAMES,
  MCP_PATH,
  RITUAL_NAMES,
  SERVER_INSTRUCTIONS,
  WINDOW_ACTIONS,
  createPersonaMcpHandler,
  createPersonaMcpServer,
  projectPersonaStatus,
};
