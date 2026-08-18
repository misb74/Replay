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
import type { CompileRequest, PermissionName, ProcessSessionIpcResult, RunMode, RunResponse, WorkflowView } from "../shared/contracts.js";
import { ipcChannels } from "../shared/contracts.js";
import { CompilerService } from "./compiler-service.js";
import { DesktopPipelineService } from "./pipeline-service.js";
import { RunnerService } from "./runner-service.js";
import { PermissionService, SessionService } from "./session-service.js";
import { createRecordingVideoHandler, recordingVideoPrivileges, recordingVideoScheme } from "./recording-video-protocol.js";
import { SidecarClient } from "./sidecar-client.js";
import { WorkflowRepository } from "./workflow-repository.js";

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let sidecar: SidecarClient | undefined;
let runner: RunnerService | undefined;

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
  const sessions = new SessionService(sidecarClient, dataDirectory);
  const permissions = new PermissionService(sidecarClient);
  const compiler = new CompilerService(workflows, sessions, dataDirectory);
  await Promise.all([workflows.initialize(), sessions.initialize()]);
  protocol.handle(recordingVideoScheme, createRecordingVideoHandler(sessions));

  mainWindow = createWindow();
  const send = (channel: string, value: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
  };
  runner = new RunnerService(workflows, sidecarClient, dataDirectory, {
    model: process.env.REPLAY_CLAUDE_MODEL ?? "claude-sonnet-5",
    onUpdate: (update) => send(ipcChannels.runUpdate, update),
  });
  registerIpc({ dataDirectory, workflows, sessions, permissions, compiler, sidecar: sidecarClient, runner, send });
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

app.on("before-quit", () => {
  runner?.stopAll();
  sidecar?.close();
  globalShortcut.unregisterAll();
  tray?.destroy();
});

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
  ipcMain.handle(ipcChannels.startRecording, async (_event, value: unknown) => {
    const options = recordingOptions(value);
    const display = screen.getPrimaryDisplay();
    return services.sessions.start({
      microphone: options.microphone,
      display: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
        scale: display.scaleFactor,
        displayId: display.id,
      },
      appVersion: app.getVersion(),
    });
  });
  ipcMain.handle(ipcChannels.stopRecording, () => services.sessions.stop());
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

function recordingOptions(value: unknown): { microphone: boolean } {
  if (!isRecord(value) || typeof value.microphone !== "boolean") throw new Error("Invalid recording options");
  return { microphone: value.microphone };
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
