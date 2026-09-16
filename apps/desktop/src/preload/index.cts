const electron = require("electron") as typeof import("electron");
const { contextBridge, ipcRenderer } = electron;
import type {
  CompileRequest,
  LiveAvailability,
  LiveUpdate,
  PermissionName,
  ProcessSessionIpcResult,
  ProcessingUpdate,
  ReplayDesktopApi,
  RunMode,
  RunResponse,
  RunUpdate,
  WorkflowView,
} from "../shared/contracts.js";

const channels = {
  getPermissions: "permissions:get",
  requestPermission: "permissions:request",
  openPermissionSettings: "permissions:open-settings",
  listSessions: "sessions:list",
  startRecording: "capture:start",
  stopRecording: "capture:stop",
  processSession: "pipeline:process",
  processingUpdate: "pipeline:progress",
  listWorkflows: "workflows:list",
  getWorkflow: "workflows:get",
  saveWorkflow: "workflows:save",
  approveWorkflow: "workflows:approve",
  compileWorkflow: "workflows:compile",
  startRun: "runner:start",
  listRuns: "runner:list",
  respondToRun: "runner:respond",
  stopRun: "runner:stop",
  runUpdate: "runner:update",
  liveAvailability: "live:availability",
  setLivePaused: "live:set-paused",
  endLive: "live:end",
  liveUpdate: "live:update",
} as const;

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

async function processSession(sessionId: string): Promise<WorkflowView> {
  const result = await ipcRenderer.invoke(channels.processSession, sessionId) as ProcessSessionIpcResult;
  if (result.ok) return result.workflow;
  // This Error originates in the isolated preload, so Electron does not add
  // its remote-method prefix to the safe message prepared by the main process.
  throw new Error(result.error.message);
}

const api = {
  getPermissions: () => ipcRenderer.invoke(channels.getPermissions),
  requestPermission: (name: PermissionName) => ipcRenderer.invoke(channels.requestPermission, name),
  openPermissionSettings: (name: PermissionName) => ipcRenderer.invoke(channels.openPermissionSettings, name),
  listSessions: () => ipcRenderer.invoke(channels.listSessions),
  startRecording: (options: { microphone: boolean; live?: boolean; displayId?: string }) => ipcRenderer.invoke(channels.startRecording, options),
  stopRecording: () => ipcRenderer.invoke(channels.stopRecording),
  processSession,
  listWorkflows: () => ipcRenderer.invoke(channels.listWorkflows),
  getWorkflow: (workflowId: string) => ipcRenderer.invoke(channels.getWorkflow, workflowId),
  saveWorkflow: (workflow: WorkflowView) => ipcRenderer.invoke(channels.saveWorkflow, workflow),
  approveWorkflow: (workflowId: string) => ipcRenderer.invoke(channels.approveWorkflow, workflowId),
  compileWorkflow: (request: CompileRequest) => ipcRenderer.invoke(channels.compileWorkflow, request),
  startRun: (workflowId: string, mode: RunMode, parameters?: Record<string, string | number | boolean | null>) => ipcRenderer.invoke(channels.startRun, workflowId, mode, parameters),
  listRuns: (workflowId: string) => ipcRenderer.invoke(channels.listRuns, workflowId),
  respondToRun: (runId: string, response: RunResponse) => ipcRenderer.invoke(channels.respondToRun, runId, response),
  stopRun: (runId: string) => ipcRenderer.invoke(channels.stopRun, runId),
  getLiveAvailability: (): Promise<LiveAvailability> => ipcRenderer.invoke(channels.liveAvailability),
  setLivePaused: (paused: boolean): Promise<void> => ipcRenderer.invoke(channels.setLivePaused, paused),
  endLive: (): Promise<void> => ipcRenderer.invoke(channels.endLive),
  onProcessingUpdate: (listener: (update: ProcessingUpdate) => void) => subscribe(channels.processingUpdate, listener),
  onRunUpdate: (listener: (update: RunUpdate) => void) => subscribe(channels.runUpdate, listener),
  onLiveUpdate: (listener: (update: LiveUpdate) => void) => subscribe(channels.liveUpdate, listener),
} satisfies ReplayDesktopApi;

contextBridge.exposeInMainWorld("replay", api);
