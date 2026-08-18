export type PermissionName = "screen" | "accessibility" | "inputMonitoring" | "microphone";
export type PermissionState = "granted" | "denied" | "notDetermined" | "restricted" | "unavailable";

export interface PermissionStatus {
  name: PermissionName;
  state: PermissionState;
  required: boolean;
  explanation: string;
}

export type SessionState = "recording" | "processing" | "ready" | "partial" | "failed";

export interface SessionSummary {
  id: string;
  name: string;
  state: SessionState;
  startedAt: string;
  durationMs?: number;
  videoUrl?: string;
  workflowId?: string;
}

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export type ProvenanceSource = "recorded" | "narrated" | "user-added-in-review";

export interface ActionView {
  id: string;
  kind: "click" | "type" | "select" | "navigate" | "scroll" | "drag" | "keypress" | "wait";
  description: string;
  target?: string;
  value?: string;
  parameter?: string;
  timestampMs: number;
}

export interface BranchPathView {
  kind: "steps" | "ask_user" | "stop_and_flag";
  summary: string;
}

export interface DecisionView {
  id: string;
  condition: string;
  confidence: "high" | "medium" | "low";
  source: ProvenanceSource;
  then: BranchPathView;
  else: BranchPathView;
}

export interface StepView {
  id: string;
  intent: string;
  expects: string;
  source: ProvenanceSource;
  time: TimeRange;
  actions: ActionView[];
  decisions: DecisionView[];
  removedDecisionIds?: string[];
}

export interface ParameterView {
  id: string;
  name: string;
  type: "string" | "number" | "boolean" | "secret";
  example?: string;
  description: string;
  confirmed: boolean;
  vault: boolean;
}

export type WorkflowStatus = "draft" | "approved";

export interface WorkflowView {
  id: string;
  sessionId: string;
  name: string;
  goal: string;
  schemaVersion: string;
  revision: number;
  status: WorkflowStatus;
  approvedAt?: string;
  cleanTestRunAt?: string;
  parameters: ParameterView[];
  steps: StepView[];
}

/** Internal IPC result. The preload unwraps this so model errors stay concise. */
export type ProcessSessionIpcResult =
  | { ok: true; workflow: WorkflowView }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };

export interface ProcessingUpdate {
  sessionId: string;
  stage: "transcribing" | "condensing" | "sampling" | "segmenting" | "decisions" | "saving";
  progress: number;
  message: string;
}

export type RunMode = "test" | "supervised" | "autonomous";
export type RunStatus = "starting" | "awaiting_approval" | "running" | "paused" | "completed" | "failed" | "aborted";
export type RunPauseReason = "before_step" | "decision" | "expectation_failed" | "ask_user" | "secure_input" | "user_activity";
export type RunResponse = "approve" | "skip" | "abort" | "resume" | "secure_input_complete" | { kind: "answer"; value: string };

export interface RunUpdate {
  runId: string;
  workflowId: string;
  status: RunStatus;
  pauseReason?: RunPauseReason;
  stepId?: string;
  message: string;
  screenshotUrl?: string;
}

export interface RunHistoryStepView {
  stepId: string;
  intent: string;
  outcome: "completed" | "skipped" | "failed";
  attempts: number;
  screenshots: string[];
  expectations: Array<{ expectation: string; met: boolean; reason: string }>;
  decisions: Array<{ decisionId: string; result: boolean; reason: string }>;
}

export interface RunHistoryView {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  mode: RunMode;
  startedAt: string;
  completedAt?: string;
  outcome?: "completed" | "aborted" | "failed" | "stopped_and_flagged";
  steps: RunHistoryStepView[];
  answers: Array<{ nodeId: string; answer: string; at: string }>;
}

export interface CompileRequest {
  workflowId: string;
  target: "playbook" | "playwright" | "computer-use";
  checkpointMode?: "human" | "agent";
}

export interface CompileResultView {
  outputDirectory: string;
  files: string[];
  warnings: Array<{ stepId?: string; message: string }>;
}

export interface ReplayDesktopApi {
  getPermissions(): Promise<PermissionStatus[]>;
  requestPermission(name: PermissionName): Promise<PermissionStatus[]>;
  openPermissionSettings(name: PermissionName): Promise<void>;
  listSessions(): Promise<SessionSummary[]>;
  startRecording(options: { microphone: boolean; displayId?: string }): Promise<SessionSummary>;
  stopRecording(): Promise<SessionSummary>;
  processSession(sessionId: string): Promise<WorkflowView>;
  listWorkflows(): Promise<WorkflowView[]>;
  getWorkflow(workflowId: string): Promise<WorkflowView>;
  saveWorkflow(workflow: WorkflowView): Promise<WorkflowView>;
  approveWorkflow(workflowId: string): Promise<WorkflowView>;
  compileWorkflow(request: CompileRequest): Promise<CompileResultView>;
  startRun(workflowId: string, mode: RunMode, parameters?: Record<string, string | number | boolean | null>): Promise<RunUpdate>;
  listRuns(workflowId: string): Promise<RunHistoryView[]>;
  respondToRun(runId: string, response: RunResponse): Promise<void>;
  stopRun(runId: string): Promise<void>;
  onProcessingUpdate(listener: (update: ProcessingUpdate) => void): () => void;
  onRunUpdate(listener: (update: RunUpdate) => void): () => void;
}

export const ipcChannels = {
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
} as const;
