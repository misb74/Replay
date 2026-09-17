import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  Tray,
} from "electron";
import { ModelAdapterError, type ModelAdapterErrorCode } from "@replay/pipeline";
import type { CompileRequest, LiveUpdate, PermissionName, ProcessSessionIpcResult, RunMode, RunResponse, WorkflowView } from "../shared/contracts.js";
import { ipcChannels } from "../shared/contracts.js";
import { CompilerService } from "./compiler-service.js";
import { LiveAssistService, type LiveSidecar, type LiveSpeechSignal, type LiveStateSignal, type LiveTranscriptSignal } from "./live-assist-service.js";
import { liveAvailability, withDeadline, withoutFailing } from "./live-lifecycle.js";
import { LiveEventsTail } from "./live-events-tail.js";
import { createClaudeLiveTransport } from "./live-model.js";
import { DesktopPipelineService } from "./pipeline-service.js";
import { RunnerService } from "./runner-service.js";
import { PermissionService, SessionService, type LiveStartOptions } from "./session-service.js";
import { createRecordingVideoHandler, recordingVideoPrivileges, recordingVideoScheme } from "./recording-video-protocol.js";
import { SidecarClient, SidecarRequestError } from "./sidecar-client.js";
import { WorkflowRepository } from "./workflow-repository.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let sidecar: SidecarClient | undefined;
let runner: RunnerService | undefined;
/** The conversation running with the current recording, and the recording it belongs to. */
let liveSession: { id: string; service: LiveAssistService } | undefined;

/** How long anything ending a recording waits for the live conversation to finish its files. */
const LIVE_END_DEADLINE_MS = 5_000;

app.setName("Replay");
protocol.registerSchemesAsPrivileged([{
  scheme: recordingVideoScheme,
  privileges: recordingVideoPrivileges,
}]);

app.whenReady().then(async () => {
  const dataDirectory = join(app.getPath("userData"), "ReplayData");
  const sidecarClient = new SidecarClient({ binaryPath: captureBinaryPath() });
  sidecar = sidecarClient;
  const workflows = new WorkflowRepository(dataDirectory);
  const sessions = new SessionService(sidecarClient, dataDirectory, {
    // However a recording ends, the tutor and its panel end with it.
    onRecordingEnded: (sessionId) => { if (liveSession?.id === sessionId) void endLiveSession(); },
  });
  const permissions = new PermissionService(sidecarClient);
  const compiler = new CompilerService(workflows, sessions, dataDirectory);
  await Promise.all([workflows.initialize(), sessions.initialize()]);
  protocol.handle(recordingVideoScheme, createRecordingVideoHandler(sessions));
  sidecarClient.on("exit", () => {
    // The capture process is gone, and with it the recording, the microphone,
    // and the clock the conversation's times are on (spec §8).
    void endLiveSession("capture stopped");
  });

  mainWindow = createWindow();
  runner = new RunnerService(workflows, sidecarClient, dataDirectory, {
    model: process.env.REPLAY_CLAUDE_MODEL ?? "claude-sonnet-5",
    onUpdate: (update) => sendToWindow(ipcChannels.runUpdate, update),
  });
  registerIpc({ dataDirectory, workflows, sessions, permissions, compiler, sidecar: sidecarClient, runner, send: sendToWindow });
  installRunKillSwitch(runner);
  tray = createTray(runner);
  installContentPolicy();
  await loadRenderer(mainWindow);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow();
    void loadRenderer(mainWindow);
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  // Aborting the same runs twice is a no-op, so this is safe on both passes.
  runner?.stopAll();
  if (liveSession) {
    // The conversation finishes its files before the app goes, so the quit
    // waits for it — but never for long, and never fails. Ending it clears
    // `liveSession`, so the quit below takes the ordinary path.
    event.preventDefault();
    void endLiveSession().then(() => app.quit());
    return;
  }
  sidecar?.close();
  // Belt and braces: every path that opens the panel opens it with a live
  // session, and every path that ends one already closes the panel above —
  // but a quit is not the place to find out that invariant slipped.
  closeLivePanel();
  globalShortcut.unregisterAll();
  tray?.destroy();
});

function sendToWindow(channel: string, value: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

/** The conversation reaches both the main window's record card and the floating panel. */
function publishLiveUpdate(update: LiveUpdate): void {
  // Kept so a panel that opens (or reloads) after the update was sent still
  // shows the current state rather than "Starting" until the next change.
  lastLiveUpdate = update;
  sendToWindow(ipcChannels.liveUpdate, update);
  sendToPanel(ipcChannels.liveUpdate, update);
}

let panelWindow: BrowserWindow | undefined;
let lastLiveUpdate: LiveUpdate | undefined;

/**
 * The always-on-top HUD for the live conversation (spec §6.3). `type: "panel"`
 * adds macOS's non-activating panel style mask (`NSWindowStyleMaskNonactivatingPanel`),
 * so showing it — and clicking its buttons — never brings Replay frontmost or
 * takes focus from whatever the user is recording; `showInactive()` is the
 * other half of that (Electron 44 docs, `structures/base-window-options.md`
 * and `base-window.md`: "Shows the window but doesn't focus on it").
 */
function openLivePanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay().workArea;
  panelWindow = new BrowserWindow({
    width: 340,
    height: 150,
    x: display.x + display.width - 360,
    y: display.y + display.height - 170,
    type: "panel",
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  panelWindow.setAlwaysOnTop(true, "floating");
  panelWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  panelWindow.once("ready-to-show", () => panelWindow?.showInactive());
  panelWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panelWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  // The panel's own subscription starts empty: without this, it would say
  // "Starting" until the next change, however far into the conversation it
  // opened (spec §8's states are meant to be read live, not guessed at).
  panelWindow.webContents.on("did-finish-load", () => {
    if (lastLiveUpdate) sendToPanel(ipcChannels.liveUpdate, lastLiveUpdate);
  });
  const developmentUrl = process.env.REPLAY_DEV_SERVER_URL;
  void (developmentUrl
    ? panelWindow.loadURL(`${developmentUrl}/panel.html`)
    : panelWindow.loadFile(join(app.getAppPath(), "dist/renderer/panel.html")));
}

function closeLivePanel(): void {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close();
  panelWindow = undefined;
}

function sendToPanel(channel: string, value: unknown): void {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send(channel, value);
}

/**
 * Ends the live conversation, if one is running, and closes its panel. The
 * conversation never outlives its recording, so every path that ends a
 * recording comes through here. A `failure` is published after the service's
 * own `ended` update, so the panel says why the tutor stopped rather than
 * falling silent (spec §8).
 *
 * It never fails and never waits beyond `LIVE_END_DEADLINE_MS`, because the
 * recording is never the casualty: Stop ends the tutor before it stops the
 * recording, and a tutor that cannot end must not keep the recorder running.
 * Every caller that must fail rethrows its own cause instead.
 */
async function endLiveSession(failure?: string): Promise<void> {
  const session = liveSession;
  liveSession = undefined;
  if (!session) return;
  await withDeadline(session.service.end(), LIVE_END_DEADLINE_MS, () => {
    // Carries no session content: the tutor's files, not what is in them.
    console.warn("The live conversation did not finish within five seconds; some of its notes may be incomplete.");
  });
  if (failure !== undefined) {
    withoutFailing(() => publishLiveUpdate({ sessionId: session.id, state: "failed", sharing: false, error: failure }));
  }
  // Guarded on its own, so a panel that cannot be told still gets closed.
  withoutFailing(closeLivePanel);
}

/**
 * The only capability the tutor has over the Mac: it can look at the screen,
 * speak, stop speaking, and be paused. There is deliberately no path here to
 * any `act_*` command other than the screenshot.
 */
function createLiveSidecar(client: SidecarClient): LiveSidecar {
  // A sidecar that has gone is never revived for the tutor. A fresh capture
  // process would start its clock again at zero, and this conversation belongs
  // to the recording that went with the old one.
  const request = async (command: string, payload: Record<string, unknown> = {}) => {
    if (!client.isRunning()) throw new SidecarRequestError("exited", "The capture sidecar is no longer running.");
    return client.request(command, payload);
  };
  return {
    screenshot: async (outputPath) => {
      // Replay's own windows are never in what the tutor sees, and
      // `createDirectories: false` stops a late screenshot from recreating the
      // private directory the conversation has already swept.
      const result = await request("act_screenshot", { outputPath, excludeProcessIds: [process.pid], createDirectories: false });
      return { path: result.screenshot?.path ?? outputPath };
    },
    speak: async (utteranceId, text) => { await request("live_speak", { utteranceId, text }); },
    stopSpeaking: async () => { await request("live_stop_speaking"); },
    setPaused: async (paused) => { await request("live_set_paused", { paused }); },
    onTranscript: (listener) => client.on("live_transcript", (event) => listener(event as LiveTranscriptSignal)),
    onSpeech: (listener) => client.on("live_speech", (event) => listener(event as LiveSpeechSignal)),
    onState: (listener) => client.on("live_state", (event) => listener(event as LiveStateSignal)),
  };
}

/**
 * What `SessionService.start` needs to bring the tutor up with a recording.
 * The conversation is made and started in the moment before `record` is sent,
 * so its clocks begin with the recording rather than minutes earlier while the
 * speech model was being prepared.
 */
function liveStartOptions(client: SidecarClient): LiveStartOptions {
  return {
    onPreparing: (sessionId) => publishLiveUpdate({ sessionId, state: "preparing_model", sharing: false }),
    beforeRecord: async ({ id, directory }) => {
      // A conversation is never overwritten: an orphan would go on listening
      // to the sidecar with nobody left to end it.
      await endLiveSession();
      const service = new LiveAssistService({
        sessionId: id,
        sessionDirectory: directory,
        sidecar: createLiveSidecar(client),
        transport: createClaudeLiveTransport({
          apiKey: process.env.ANTHROPIC_API_KEY ?? "",
          model: process.env.REPLAY_LIVE_MODEL ?? "claude-opus-5",
        }),
        events: new LiveEventsTail(join(directory, "events.jsonl")),
        onUpdate: publishLiveUpdate,
        readImage: async (path) => nativeImage.createFromPath(path).toJPEG(85).toString("base64"),
        // Half duplex until echo cancellation is verified: while the tutor
        // speaks, the user interrupts with Pause rather than by talking over it.
        fullDuplex: process.env.REPLAY_LIVE_FULL_DUPLEX === "1",
      });
      liveSession = { id, service };
      try {
        await service.start();
      } catch (cause) {
        await endLiveSession();
        throw cause;
      }
    },
  };
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#f8fafc",
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), "dist/preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  return window;
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const developmentUrl = process.env.REPLAY_DEV_SERVER_URL;
  if (developmentUrl) await window.loadURL(developmentUrl);
  else await window.loadFile(join(app.getAppPath(), "dist/renderer/index.html"));
}

function installContentPolicy(): void {
  if (process.env.REPLAY_DEV_SERVER_URL) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; media-src 'self' replay-video:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'"],
      },
    });
  });
}

function registerIpc(services: {
  dataDirectory: string;
  workflows: WorkflowRepository;
  sessions: SessionService;
  permissions: PermissionService;
  compiler: CompilerService;
  sidecar: SidecarClient;
  runner: RunnerService;
  send: (channel: string, value: unknown) => void;
}): void {
  ipcMain.handle(ipcChannels.getPermissions, () => services.permissions.get());
  ipcMain.handle(ipcChannels.requestPermission, (_event, value: unknown) => services.permissions.request(permissionName(value)));
  ipcMain.handle(ipcChannels.openPermissionSettings, (_event, value: unknown) => services.permissions.openSettings(permissionName(value)));
  ipcMain.handle(ipcChannels.listSessions, () => services.sessions.list());
  ipcMain.handle(ipcChannels.liveTranscript, async (_event, value: unknown) => {
    const transcript = await services.sessions.readLiveTranscript(safeId(value, "session"));
    return transcript?.segments ?? [];
  });
  ipcMain.handle(ipcChannels.startRecording, async (_event, value: unknown) => {
    const options = recordingOptions(value);
    const display = screen.getPrimaryDisplay();
    try {
      const summary = await services.sessions.start({
        microphone: options.microphone || options.live,
        ...(options.live ? { live: liveStartOptions(services.sidecar) } : {}),
        display: {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
          scale: display.scaleFactor,
          displayId: display.id,
        },
        appVersion: app.getVersion(),
        // Replay's own windows are absent from every recording (spec §4.3).
        excludeProcessIds: [process.pid],
      });
      if (options.live) openLivePanel();
      return summary;
    } catch (cause) {
      // A start that failed leaves no recording for the tutor to belong to.
      await endLiveSession();
      throw cause;
    }
  });
  ipcMain.handle(ipcChannels.stopRecording, async () => {
    // The tutor falls silent and finishes its files first: its speech commands
    // reach the sidecar only while the recording is still running.
    await endLiveSession();
    return services.sessions.stop();
  });
  ipcMain.handle(ipcChannels.liveAvailability, async () => liveAvailability(
    process.getSystemVersion(),
    process.env.ANTHROPIC_API_KEY,
    await services.permissions.get(),
  ));
  ipcMain.handle(ipcChannels.setLivePaused, async (_event, value: unknown) => {
    if (typeof value !== "boolean") throw new Error("Invalid pause value");
    await liveSession?.service.setPaused(value);
  });
  ipcMain.handle(ipcChannels.endLive, async () => { await endLiveSession(); });
  ipcMain.handle(ipcChannels.processSession, async (_event, value: unknown) => {
    const sessionId = safeId(value, "session");
    try {
      const pipeline = new DesktopPipelineService(services.sessions, services.workflows, {
        model: process.env.REPLAY_CLAUDE_MODEL ?? "claude-sonnet-5",
        ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
        ...(process.env.REPLAY_TRANSCRIBE_COMMAND ? { transcriberCommand: process.env.REPLAY_TRANSCRIBE_COMMAND } : {}),
        onProgress: (update) => services.send(ipcChannels.processingUpdate, update),
      });
      return { ok: true, workflow: await pipeline.process(sessionId) } satisfies ProcessSessionIpcResult;
    } catch (cause) {
      if (!(cause instanceof ModelAdapterError)) throw cause;
      return {
        ok: false,
        error: {
          code: cause.code,
          message: cause.message,
          retryable: isRetryableModelError(cause.code),
        },
      } satisfies ProcessSessionIpcResult;
    }
  });
  ipcMain.handle(ipcChannels.listWorkflows, () => services.workflows.list());
  ipcMain.handle(ipcChannels.getWorkflow, (_event, value: unknown) => services.workflows.getView(safeId(value, "workflow")));
  ipcMain.handle(ipcChannels.saveWorkflow, (_event, value: unknown) => services.workflows.saveView(workflowView(value)));
  ipcMain.handle(ipcChannels.approveWorkflow, (_event, value: unknown) => services.workflows.approve(safeId(value, "workflow")));
  ipcMain.handle(ipcChannels.compileWorkflow, (_event, value: unknown) => services.compiler.compile(compileRequest(value)));
  ipcMain.handle(ipcChannels.startRun, (_event, workflowId: unknown, mode: unknown, parameters: unknown) => services.runner.start(safeId(workflowId, "workflow"), runMode(mode), parameterValues(parameters)));
  ipcMain.handle(ipcChannels.listRuns, (_event, workflowId: unknown) => services.runner.list(safeId(workflowId, "workflow")));
  ipcMain.handle(ipcChannels.respondToRun, (_event, runId: unknown, response: unknown) => services.runner.respond(safeId(runId, "run"), operatorResponse(response)));
  ipcMain.handle(ipcChannels.stopRun, (_event, runId: unknown) => services.runner.stop(safeId(runId, "run")));
}

function isRetryableModelError(code: ModelAdapterErrorCode): boolean {
  return code === "rate_limited"
    || code === "network_failed"
    || code === "request_timed_out"
    || code === "service_unavailable"
    || code === "transport_failed";
}

function installRunKillSwitch(service: RunnerService): void {
  globalShortcut.register("CommandOrControl+Shift+Escape", () => service.stopAll());
}

function createTray(service: RunnerService): Tray {
  const item = new Tray(nativeImage.createEmpty());
  item.setTitle("Replay");
  item.setToolTip("Replay workflow controls");
  item.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Replay", click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: "separator" },
    { label: "Stop active run", accelerator: "CommandOrControl+Shift+Escape", click: () => service.stopAll() },
    { type: "separator" },
    { label: "Quit Replay", role: "quit" },
  ]));
  return item;
}

function captureBinaryPath(): string {
  if (process.env.REPLAY_CAPTURE_BINARY) return resolve(process.env.REPLAY_CAPTURE_BINARY);
  if (app.isPackaged) return join(process.resourcesPath, "capture", "replay-capture");
  const root = resolve(app.getAppPath(), "../..");
  const debug = join(root, "native/capture/.build/debug/replay-capture");
  const release = join(root, "native/capture/.build/release/replay-capture");
  return existsSync(debug) ? debug : release;
}

function permissionName(value: unknown): PermissionName {
  if (value === "screen" || value === "accessibility" || value === "inputMonitoring" || value === "microphone") return value;
  throw new Error("Invalid permission name");
}

function recordingOptions(value: unknown): { microphone: boolean; live: boolean } {
  if (!isRecord(value) || typeof value.microphone !== "boolean") throw new Error("Invalid recording options");
  return { microphone: value.microphone, live: value.live === true };
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u.test(value)) throw new Error(`Invalid ${label} id`);
  return value;
}

function workflowView(value: unknown): WorkflowView {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.steps) || !Array.isArray(value.parameters)) throw new Error("Invalid workflow edit");
  if (JSON.stringify(value).length > 5_000_000) throw new Error("The workflow edit is too large");
  return value as unknown as WorkflowView;
}

function compileRequest(value: unknown): CompileRequest {
  if (!isRecord(value)) throw new Error("Invalid compile request");
  const target = value.target;
  if (target !== "playbook" && target !== "playwright" && target !== "computer-use") throw new Error("Invalid compiler target");
  const checkpointMode = value.checkpointMode;
  if (checkpointMode !== undefined && checkpointMode !== "human" && checkpointMode !== "agent") throw new Error("Invalid checkpoint mode");
  return { workflowId: safeId(value.workflowId, "workflow"), target, ...(checkpointMode ? { checkpointMode } : {}) };
}

function runMode(value: unknown): RunMode {
  if (value === "test" || value === "supervised" || value === "autonomous") return value;
  throw new Error("Invalid run mode");
}

function operatorResponse(value: unknown): RunResponse {
  if (value === "approve" || value === "skip" || value === "abort" || value === "resume" || value === "secure_input_complete") return value;
  if (isRecord(value) && value.kind === "answer" && typeof value.value === "string" && value.value.trim().length > 0 && value.value.length <= 10_000) return { kind: "answer", value: value.value.trim() };
  throw new Error("Invalid run response");
}

function parameterValues(value: unknown): Record<string, string | number | boolean | null> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 100) throw new Error("Invalid run parameters");
  const result: Record<string, string | number | boolean | null> = {};
  for (const [name, parameter] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name) || (typeof parameter !== "string" && typeof parameter !== "number" && typeof parameter !== "boolean" && parameter !== null)) throw new Error("Invalid run parameter");
    if (typeof parameter === "string" && parameter.length > 100_000) throw new Error("A run parameter is too large");
    result[name] = parameter;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
