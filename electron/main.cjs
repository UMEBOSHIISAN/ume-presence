"use strict";

const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} = require("electron");
const { bootstrapPersona } = require("./app-bootstrap.cjs");
const { createBridgeServer, DEFAULT_PORT } = require("./bridge-server.cjs");
const { createPersonaMcpHandler } = require("./mcp-server.cjs");
const {
  configureHyprlandWindow,
  getHyprlandWindowPlacement,
} = require("./hyprland-window.cjs");
const { createAudioListener } = require("./audio-listener.cjs");
const { createAppShutdownCoordinator } = require("./app-shutdown.cjs");
const {
  createCharacterRuntimeBinding,
  createInitializationActionGate,
} = require("./character-runtime.cjs");
const { isAllowedRendererNavigation } = require("./navigation-policy.cjs");
const { readLoginStartupState } = require("./login-startup.cjs");
const { createLoginRuntime } = require("./login-runtime.cjs");
const { createManagedLocalService } = require("./managed-local-service.cjs");
const { parseProtocolUrl, voiceState } = require("./protocol-actions.cjs");
const providerRegistry = require("./provider-registry.cjs");
const { createRendererEventSnapshot } = require("./renderer-event-snapshot.cjs");
const { createRendererSpeechBridge } = require("./renderer-speech-bridge.cjs");
const { createRendererReadiness } = require("./renderer-readiness.cjs");
const { createRitualController } = require("./ritual-controller.cjs");
const { createSpeechVoiceState, routeExternalEvent } = require("./speech-voice-state.cjs");
const { createThinkingCueExpiry } = require("./thinking-cue-expiry.cjs");
const { createTrayStatus } = require("./tray-status.cjs");
const { hasSpeechEngineStart } = require("./speech-engine-command.cjs");
const {
  createActivationRevealPolicy,
  settleAvatarWindowStartup,
} = require("./window-startup-policy.cjs");

const WINDOW_WIDTH = 430;
const WINDOW_HEIGHT = 680;
const PRODUCT_NAME = "UME Presence";
const PRODUCT_APP_ID = "io.github.umeboshiisan.persona";
const COMPAT_USER_DATA_NAME = "Persona";
const protocolScheme = "persona";
const debugEnabled = process.env.PERSONA_DEBUG === "1";
const RITUAL_BY_PRESENCE_CUE = Object.freeze({
  greeting: "greeting",
  complete: "work_complete",
  break: "break",
});

let startInBackground = false;
let avatarWindow = null;
let bridge = null;
let isQuitting = false;
let latestListenerStatus = null;
let latestVoiceState = null;
let audioListener = null;
let tray = null;
let hyprlandConfigured = false;
let hyprlandConfiguring = false;
let hyprlandConfigurationTimer = null;
let hyprlandLastPosition = null;
let rendererLoadHookAttached = false;
let rendererSpeechBridge = null;
let characterRuntimeBinding = null;
let speechVoiceState = null;
let pendingRendererEvents = null;
let rendererSnapshot = null;
let rendererReadiness = null;
let protocolActionGate = null;
let ritualController = null;
let thinkingCueExpiry = null;
let loginRuntime = null;
let trayStatus = null;
let pendingTrayMenu = null;
let shutdownCoordinator = null;
let pendingSpeechEngineStart = false;

function configureProductIdentity(appApi) {
  appApi.setName(PRODUCT_NAME);
  appApi.setPath(
    "userData",
    path.join(appApi.getPath("appData"), COMPAT_USER_DATA_NAME),
  );
}

function debugLog(...values) {
  if (debugEnabled) console.error("[persona]", ...values);
}

function positionWindow(window) {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const bounds = window.getBounds();
  const margin = 24;
  window.setPosition(
    Math.round(display.workArea.x + display.workArea.width - bounds.width - margin),
    Math.round(display.workArea.y + display.workArea.height - bounds.height - margin),
    false,
  );
}

function scheduleHyprlandWindowConfiguration({
  attempt = 0,
  force = false,
  position = null,
  reposition = !hyprlandConfigured,
} = {}) {
  if (
    (hyprlandConfigured && !force) ||
    hyprlandConfiguring ||
    !avatarWindow ||
    avatarWindow.isDestroyed()
  ) {
    return;
  }
  clearTimeout(hyprlandConfigurationTimer);
  const delays = [0, 80, 200, 500, 1000];
  hyprlandConfigurationTimer = setTimeout(async () => {
    hyprlandConfigurationTimer = null;
    if (!avatarWindow || avatarWindow.isDestroyed()) return;
    hyprlandConfiguring = true;
    hyprlandConfigured = await configureHyprlandWindow({
      pid: process.pid,
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      onDebug: debugLog,
      position,
      reposition,
    });
    hyprlandConfiguring = false;
    if (!hyprlandConfigured && attempt + 1 < delays.length) {
      scheduleHyprlandWindowConfiguration({
        attempt: attempt + 1,
        force: true,
        position,
        reposition,
      });
    }
  }, delays[attempt] ?? delays.at(-1));
  hyprlandConfigurationTimer.unref?.();
}

function showOverlay({ focus = false } = {}) {
  const window = createWindow();
  if (window.isMinimized()) window.restore();
  if (focus) {
    if (!window.isVisible()) window.show();
    window.focus();
  } else if (!window.isVisible()) {
    window.showInactive();
  }
  scheduleHyprlandWindowConfiguration();
}

async function hideOverlay() {
  debugLog("hide overlay");
  const placement = await getHyprlandWindowPlacement(process.pid);
  if (placement) {
    hyprlandLastPosition = { x: placement.x, y: placement.y };
  }
  avatarWindow?.hide();
}

function toggleOverlay() {
  if (avatarWindow?.isVisible()) void hideOverlay();
  else showOverlay({ focus: true });
}

function createWindow() {
  if (avatarWindow && !avatarWindow.isDestroyed()) return avatarWindow;

  avatarWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 320,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: "Persona",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The presence is a visual overlay with no native pointer controls. Keep
  // transparent and visible pixels from intercepting the user's desktop input.
  avatarWindow.setIgnoreMouseEvents?.(true);

  avatarWindow.setAlwaysOnTop(true, "floating");
  avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  avatarWindow.setOpacity(1);
  avatarWindow.once("ready-to-show", () => {
    positionWindow(avatarWindow);
    scheduleHyprlandWindowConfiguration();
  });
  avatarWindow.on("show", () => {
    avatarWindow.setAlwaysOnTop(true, "floating");
    avatarWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    avatarWindow.setOpacity(1);
    scheduleHyprlandWindowConfiguration({
      force: true,
      position: hyprlandLastPosition,
      reposition: !hyprlandConfigured || hyprlandLastPosition != null,
    });
  });
  avatarWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    void hideOverlay();
  });
  avatarWindow.on("closed", () => {
    clearTimeout(hyprlandConfigurationTimer);
    hyprlandConfigurationTimer = null;
    hyprlandConfigured = false;
    hyprlandConfiguring = false;
    rendererLoadHookAttached = false;
    rendererReadiness.reset();
    avatarWindow = null;
  });

  const rendererUrl =
    process.env.VITE_DEV_SERVER_URL ||
    pathToFileURL(path.join(__dirname, "..", "dist", "index.html")).href;
  avatarWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  avatarWindow.webContents.on("did-start-loading", () => {
    rendererReadiness.reset();
  });
  avatarWindow.webContents.on("did-finish-load", () => {
    rendererReadiness.markLoaded(avatarWindow.webContents);
  });
  avatarWindow.webContents.on("did-fail-load", () => {
    rendererReadiness.reset();
  });
  avatarWindow.webContents.on("render-process-gone", () => {
    rendererReadiness.reset();
  });
  avatarWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, rendererUrl)) event.preventDefault();
  });
  void avatarWindow.loadURL(rendererUrl);
  return avatarWindow;
}

function flushPendingRendererEvents() {
  rendererLoadHookAttached = false;
  if (!avatarWindow || avatarWindow.isDestroyed() || avatarWindow.webContents.isLoading()) return;
  for (const event of pendingRendererEvents.values()) {
    avatarWindow.webContents.send("persona:event", event);
  }
  pendingRendererEvents.clear();
}

function ensureRendererLoadHook() {
  if (
    rendererLoadHookAttached ||
    !avatarWindow ||
    avatarWindow.isDestroyed() ||
    !avatarWindow.webContents.isLoading()
  ) {
    return;
  }
  rendererLoadHookAttached = true;
  avatarWindow.webContents.once("did-finish-load", flushPendingRendererEvents);
}

function emitToRenderer(event) {
  rendererSnapshot.push(event);
  pendingRendererEvents.set(event.type, event);
  if (!avatarWindow || avatarWindow.isDestroyed()) return;
  if (avatarWindow.webContents.isLoading()) {
    ensureRendererLoadHook();
    return;
  }
  avatarWindow.webContents.send("persona:event", event);
  pendingRendererEvents.delete(event.type);
}

function getRendererSnapshot() {
  return rendererSnapshot.getEvents();
}

function supersedesThinkingCue(event) {
  if (event.type === "presence-cue") return event.cue !== "thinking";
  if (event.type === "animation") return true;
  return event.type === "state" && (
    event.state.phase === "inactive" ||
    (event.state.phase === "active" &&
      event.state.activity === "speaking" &&
      event.state.outputMuted === false)
  );
}

function handleBridgeEvent(event) {
  if (event.type !== "audio-level" || event.level > 0.025) debugLog("event", event);
  if (event.type === "presence-cue" && event.cue === "thinking") {
    thinkingCueExpiry?.start();
  } else if (supersedesThinkingCue(event)) {
    thinkingCueExpiry?.cancel();
  }
  const previousVoiceState = event.type === "state" ? latestVoiceState : null;
  if (event.type === "state") {
    latestVoiceState = event.state;
    if (event.state.phase === "starting" || event.state.phase === "active") {
      showOverlay();
    }
  } else if (event.type === "audio-level" && event.level > 0.025) {
    showOverlay();
  } else if (event.type === "animation") {
    showOverlay();
  } else if (event.type === "presence-cue" && event.cue === "thinking") {
    showOverlay();
  }
  emitToRenderer(event);
  if (event.type === "state") {
    const { activity, outputMuted, phase } = event.state;
    if (phase === "active" && activity === "speaking" && outputMuted === false) {
      ritualController?.cancel();
    }
    if (phase === "inactive" && previousVoiceState && previousVoiceState.phase !== "inactive") {
      ritualController?.cancel();
    }
    if (
      activity === "listening" &&
      phase === "active" &&
      previousVoiceState?.phase !== "active"
    ) {
      startRitual("greeting");
    }
  }
}

function handleThinkingCueExpiry(event) {
  handleBridgeEvent(event);
  if (latestVoiceState !== null) {
    emitToRenderer({ type: "state", state: latestVoiceState });
  }
}

function startRitual(ritual) {
  if (
    latestVoiceState?.phase === "active" &&
    latestVoiceState.activity === "speaking" &&
    latestVoiceState.outputMuted === false
  ) {
    return { status: "busy", ritual };
  }
  return ritualController?.start(ritual) ?? { status: "busy", ritual };
}

function handleExternalBridgeEvent(event) {
  if (event.type === "presence-cue") {
    const ritual = RITUAL_BY_PRESENCE_CUE[event.cue];
    if (ritual) {
      showOverlay();
      startRitual(ritual);
    } else if (event.cue === "clear") {
      if (!ritualController?.cancel()) handleBridgeEvent(event);
    } else {
      handleBridgeEvent(event);
    }
    return;
  }
  routeExternalEvent(event, { coordinator: speechVoiceState, emit: handleBridgeEvent });
}

function handleListenerStatus(status) {
  latestListenerStatus = status;
  emitToRenderer({ type: "listener-status", status });
}

async function handleMcpWindowAction(action) {
  if (action === "show") showOverlay({ focus: true });
  else if (action === "hide") await hideOverlay();
  else if (avatarWindow?.isVisible()) await hideOverlay();
  else showOverlay({ focus: true });
  return avatarWindow?.isVisible() ?? false;
}

function getMcpStatus() {
  return {
    windowVisible: avatarWindow?.isVisible() ?? false,
    voiceState: latestVoiceState,
    listener: latestListenerStatus,
    speechEngine: loginRuntime?.getStatus() ?? Object.freeze({ state: "idle" }),
  };
}

function handleProtocolUrl(rawUrl) {
  const commands = parseProtocolUrl(rawUrl, protocolScheme);
  if (!commands) return false;
  for (const command of commands) {
    if (command.type === "show") showOverlay({ focus: true });
    else if (command.type === "hide") void hideOverlay();
    else if (command.type === "toggle") toggleOverlay();
    else if (command.type === "event") handleExternalBridgeEvent(command.event);
    else if (command.type === "ritual") {
      showOverlay({ focus: true });
      startRitual(command.ritual);
    }
  }
  return true;
}

function handleProtocolArgv(argv) {
  const protocolUrl = argv.find((value) => value.startsWith(`${protocolScheme}://`));
  if (protocolUrl) handleProtocolUrl(protocolUrl);
}

function requestSpeechEngineStart(argv) {
  if (!hasSpeechEngineStart(argv)) return false;
  if (loginRuntime !== null && typeof loginRuntime.startManual === "function") {
    void loginRuntime.startManual();
  } else {
    pendingSpeechEngineStart = true;
  }
  return true;
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  tray = new Tray(icon);
  tray.setToolTip(PRODUCT_NAME);
  if (pendingTrayMenu !== null) tray.setContextMenu(pendingTrayMenu);
  tray.on("click", toggleOverlay);
}

function cleanupRuntimeNow() {
  isQuitting = true;
  clearTimeout(hyprlandConfigurationTimer);
  audioListener?.stop();
  characterRuntimeBinding?.stop();
  ritualController?.dispose();
  ritualController = null;
  thinkingCueExpiry?.dispose();
  thinkingCueExpiry = null;
  globalShortcut.unregisterAll();
  void bridge?.close().catch((error) => debugLog("integration server close failed", error));
}

function runRuntime() {
  startInBackground = process.argv.includes("--background");
  pendingSpeechEngineStart = hasSpeechEngineStart(process.argv);
  pendingRendererEvents = new Map();
  rendererSnapshot = createRendererEventSnapshot();
  rendererReadiness = createRendererReadiness({ getWindow: () => avatarWindow });
  protocolActionGate = createInitializationActionGate({
    dispatch: handleProtocolUrl,
  });

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const handled = argv.some((value) => value.startsWith(`${protocolScheme}://`));
      const handledSpeechEngine = requestSpeechEngineStart(argv);
      handleProtocolArgv(argv);
      if (!handled && !handledSpeechEngine && !argv.includes("--background")) {
        showOverlay({ focus: true });
      }
    });

    app.on("open-url", (event, url) => {
      event.preventDefault();
      protocolActionGate.handle(url);
    });

    app.whenReady().then(async () => {
      app.setAppUserModelId(PRODUCT_APP_ID);
      app.dock?.hide();
      if (app.isPackaged) app.setAsDefaultProtocolClient(protocolScheme);

      ipcMain.handle("persona:get-snapshot", getRendererSnapshot);
      ipcMain.on("persona:hide", () => void hideOverlay());
      speechVoiceState = createSpeechVoiceState({
        initialExternalState: voiceState("idle", "inactive"),
        internalSpeakingState: voiceState("speaking"),
        emit: handleBridgeEvent,
      });
      rendererSpeechBridge = createRendererSpeechBridge({
        getWindow: () => rendererReadiness.getReadyWindow(),
        onStarted: () => speechVoiceState.startInternal(),
        onFinished: () => speechVoiceState.finishInternal(),
      });
      characterRuntimeBinding = createCharacterRuntimeBinding({
        userDataPath: app.getPath("userData"),
        ipcMain,
        rendererSpeechBridge,
      });
      ipcMain.on("persona:speech-result", (event, payload) => {
        if (!avatarWindow || avatarWindow.isDestroyed()) return;
        if (event.sender !== avatarWindow.webContents) return;
        rendererSpeechBridge.handleRendererResult(event.sender.id, payload);
      });
      ipcMain.on("persona:speech-ready", (event) => {
        rendererReadiness.acknowledge(event.sender);
      });
      let loginStateReadFailed = false;
      let loginState = Object.freeze({
        status: "not-registered",
        openAtLogin: false,
        wasOpenedAtLogin: false,
      });
      if (process.platform === "darwin") {
        try {
          loginState = readLoginStartupState(app);
        } catch {
          loginStateReadFailed = true;
        }
      }
      const initiallyHidden = startInBackground
        || loginStateReadFailed
        || loginState.wasOpenedAtLogin === true;
      const activationPolicy = createActivationRevealPolicy({ initiallyHidden, showOverlay });
      app.on("activate", activationPolicy.handleActivate);
      ritualController = createRitualController({
        emit: handleBridgeEvent,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });
      thinkingCueExpiry = createThinkingCueExpiry({
        emit: handleThinkingCueExpiry,
        setTimer: setTimeout,
        clearTimer: clearTimeout,
      });
      protocolActionGate.open();
      const rendererSettlement = settleAvatarWindowStartup({
        initiallyHidden,
        createWindow,
        showOverlay,
        onError: (error) => debugLog("renderer startup failed", error),
      });

      trayStatus = createTrayStatus({
        buildFromTemplate: (template) => Menu.buildFromTemplate(template),
        setContextMenu: (menu) => {
          pendingTrayMenu = menu;
          tray?.setContextMenu(menu);
        },
        onShow: () => showOverlay({ focus: true }),
        onHide: () => void hideOverlay(),
        onPreviewListening: () => handleExternalBridgeEvent(voiceState("listening")),
        onPreviewSpeaking: () => handleExternalBridgeEvent(voiceState("speaking")),
        onPreviewDance: () => handleBridgeEvent({ type: "animation", animation: "DANCE" }),
        onQuit: () => app.quit(),
      });
      if (loginStateReadFailed) trayStatus.update("failed");
      loginRuntime = createLoginRuntime({
        platform: process.platform,
        loginState,
        characterRuntime: characterRuntimeBinding.runtime,
        providerRegistry,
        adapterDeps: Object.freeze({
          homeDirectory: os.homedir(),
          platform: process.platform,
        }),
        createManagedService: createManagedLocalService,
        serviceOptions: Object.freeze({}),
        trayStatus,
        debug: debugLog,
      });
      void loginRuntime.startIfLoginLaunch();
      if (pendingSpeechEngineStart) {
        pendingSpeechEngineStart = false;
        void loginRuntime.startManual();
      }
      void rendererSettlement.then(
        (window) => debugLog("renderer startup settled", { ready: window !== null }),
        () => debugLog("renderer startup settlement failed"),
      );

      const onSpeech = async (text) => {
        try {
          return await characterRuntimeBinding.onSpeech(text);
        } catch (error) {
          if (error?.code === "AIVIS_PROVIDER_FAILED") trayStatus.update("failed");
          throw error;
        }
      };

      const mcpHandler = createPersonaMcpHandler({
        onAnimation: (animation) =>
          handleBridgeEvent({ type: "animation", animation: animation.toUpperCase() }),
        onRitual: (ritual) => {
          showOverlay({ focus: true });
          return startRitual(ritual);
        },
        onWindowAction: handleMcpWindowAction,
        onSpeech,
        getStatus: getMcpStatus,
      });
      bridge = createBridgeServer({
        port: Number(process.env.PERSONA_BRIDGE_PORT || DEFAULT_PORT),
        onEvent: handleExternalBridgeEvent,
        mcpHandler,
      });
      try {
        await bridge.listen();
      } catch (error) {
        console.error(
          "[persona] local integration server unavailable:",
          error instanceof Error ? error.message : String(error),
        );
        bridge = null;
      }

      createTray();
      globalShortcut.register("CommandOrControl+Shift+A", toggleOverlay);
      handleProtocolArgv(process.argv);

      audioListener = createAudioListener({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        onActivity: (activity) => {
          debugLog("listener activity", activity);
          handleExternalBridgeEvent(voiceState(activity));
        },
        onDebug: debugEnabled ? (nodes) => debugLog("listener output nodes", nodes) : null,
        onLevel: (level) => handleBridgeEvent({ type: "audio-level", level }),
        onSession: (active) => {
          debugLog("listener session", active);
          handleExternalBridgeEvent(
            voiceState(active ? "listening" : "idle", active ? "active" : "inactive"),
          );
        },
        onStatus: (status) => {
          debugLog("listener status", status);
          handleListenerStatus(status);
        },
      });
      if (audioListener) void audioListener.start();
      if (!audioListener) {
        handleListenerStatus({
          available: false,
          capturing: false,
          monitoring: false,
          source: null,
        });
      }
    });
  }

  shutdownCoordinator = createAppShutdownCoordinator({
    cleanupNow: cleanupRuntimeNow,
    stopRuntime: () => loginRuntime?.stop() ?? Promise.resolve(),
    exit: (code) => app.exit(code),
  });
  app.on("before-quit", shutdownCoordinator.handleBeforeQuit);

  app.on("window-all-closed", () => {
    // The tray, protocol handler, and adapter server keep Persona available.
  });
}

configureProductIdentity(app);
void bootstrapPersona({ app, argv: process.argv, runRuntime });
