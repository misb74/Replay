import type {
  CompileRequest,
  CompileResultView,
  LiveAvailability,
  LiveUpdate,
  PermissionName,
  PermissionStatus,
  ProcessingUpdate,
  ReplayDesktopApi,
  RunMode,
  RunUpdate,
  SessionSummary,
  WorkflowView,
} from "../shared/contracts.js";

export function createDemoWorkflow(): WorkflowView {
  return {
    id: "wf-invoice-match",
    sessionId: "session-demo",
    name: "Review an invoice against its PO",
    goal: "Open an invoice, compare its total with the linked purchase order, then approve an exact match or flag the invoice for follow-up.",
    schemaVersion: "1.0.0",
    revision: 1,
    status: "draft",
    parameters: [
      { id: "param-invoice", name: "invoice_number", type: "string", example: "INV-1048", description: "The invoice to review", confirmed: true, vault: false },
      { id: "param-password", name: "ledger_password", type: "secret", description: "Password entered by the operator at run time", confirmed: true, vault: true },
    ],
    steps: [
      {
        id: "step-open",
        intent: "Open the invoice from the review queue",
        expects: "The selected invoice details and purchase order total are visible",
        source: "recorded",
        time: { startMs: 3_200, endMs: 8_900 },
        actions: [{ id: "a-open", kind: "click", description: "Clicked invoice INV-1048", target: "INV-1048 button in Review queue", timestampMs: 4_140 }],
        decisions: [],
      },
      {
        id: "step-compare",
        intent: "Compare the invoice total with the purchase order total",
        expects: "Both totals are visible and the comparison result can be determined",
        source: "narrated",
        time: { startMs: 8_900, endMs: 16_400 },
        actions: [{ id: "a-wait", kind: "wait", description: "Reviewed both totals", timestampMs: 10_220 }],
        decisions: [{
          id: "decision-match",
          condition: "The invoice total exactly matches the purchase order total",
          confidence: "high",
          source: "narrated",
          then: { kind: "steps", summary: "Approve the invoice" },
          else: { kind: "steps", summary: "Flag the difference for follow-up" },
        }],
      },
      {
        id: "step-finish",
        intent: "Apply the correct review outcome",
        expects: "The invoice shows Approved or Needs attention",
        source: "recorded",
        time: { startMs: 16_400, endMs: 21_800 },
        actions: [{ id: "a-approve", kind: "click", description: "Clicked Approve invoice on the recorded path", target: "Approve invoice button", timestampMs: 17_360 }],
        decisions: [],
      },
    ],
  };
}

const permissionDescriptions: Record<PermissionName, string> = {
  screen: "Records the display so Replay can understand what happened.",
  accessibility: "Reads interface labels and lets approved workflows click controls.",
  inputMonitoring: "Records clicks and typing; secure fields are always redacted.",
  microphone: "Adds optional narration to explain intent and decision points.",
};

export function createMockApi(): ReplayDesktopApi {
  let workflow = createDemoWorkflow();
  let recording: SessionSummary | undefined;
  let liveSessionId: string | undefined;
  const processingListeners = new Set<(update: ProcessingUpdate) => void>();
  const runListeners = new Set<(update: RunUpdate) => void>();
  const liveListeners = new Set<(update: LiveUpdate) => void>();

  const publishLive = (update: LiveUpdate) => {
    if (update.sessionId === liveSessionId) liveListeners.forEach((listener) => listener(update));
  };

  /**
   * Plays a scripted conversation so the record card and the panel can be
   * developed in a browser, where there is no sidecar to talk to.
   */
  const playLiveSession = (sessionId: string) => {
    liveSessionId = sessionId;
    const script: LiveUpdate[] = [
      { sessionId, state: "preparing_model", sharing: false },
      { sessionId, state: "listening", sharing: false },
      { sessionId, state: "listening", heard: { text: "Why did I flag that one?", final: true }, sharing: false },
      { sessionId, state: "thinking", sharing: true },
      { sessionId, state: "speaking", said: "The totals differ by forty cents.", sharing: false },
      { sessionId, state: "listening", sharing: false },
    ];
    script.forEach((update, index) => setTimeout(() => publishLive(update), 1_200 * index));
  };

  const endLiveSession = () => {
    if (liveSessionId) publishLive({ sessionId: liveSessionId, state: "ended", sharing: false });
    liveSessionId = undefined;
  };

  const permissions = (Object.keys(permissionDescriptions) as PermissionName[]).map<PermissionStatus>((name) => ({
    name,
    state: "granted",
    required: name !== "microphone",
    explanation: permissionDescriptions[name],
  }));

  return {
    async getPermissions() { return permissions; },
    async requestPermission() { return permissions; },
    async openPermissionSettings() {},
    async listSessions() {
      return recording ? [recording, demoSession()] : [demoSession()];
    },
    async getLiveTranscript(sessionId) {
      if (sessionId !== workflow.sessionId) return [];
      return [
        { id: "live-1", startMs: 4_200, endMs: 7_800, text: "I'm opening the invoice from the review queue now.", speaker: "user" },
        { id: "live-2", startMs: 9_000, endMs: 13_500, text: "Good — once it's open, compare the invoice total with the purchase order total before deciding.", speaker: "assistant" },
      ];
    },
    async startRecording({ microphone, live }) {
      recording = {
        id: `session-${Date.now()}`,
        name: microphone ? "Narrated recording" : "Screen recording",
        state: "recording",
        startedAt: new Date().toISOString(),
      };
      if (live) playLiveSession(recording.id);
      return recording;
    },
    async stopRecording() {
      if (!recording) throw new Error("No recording is active");
      endLiveSession();
      recording = { ...recording, state: "processing", durationMs: 42_000 };
      return recording;
    },
    async processSession(sessionId) {
      const stages: ProcessingUpdate["stage"][] = ["transcribing", "condensing", "sampling", "segmenting", "decisions", "saving"];
      stages.forEach((stage, index) => {
        processingListeners.forEach((listener) => listener({
          sessionId,
          stage,
          progress: (index + 1) / stages.length,
          message: stage === "decisions" ? "Finding decision points" : `${stage[0]!.toUpperCase()}${stage.slice(1)}`,
        }));
      });
      return workflow;
    },
    async listWorkflows() { return [workflow]; },
    async getWorkflow(workflowId) {
      if (workflowId !== workflow.id) throw new Error("Workflow not found");
      return structuredClone(workflow);
    },
    async saveWorkflow(next) {
      workflow = { ...structuredClone(next), revision: workflow.revision + 1, status: "draft" };
      delete workflow.approvedAt;
      return workflow;
    },
    async approveWorkflow(workflowId) {
      if (workflowId !== workflow.id) throw new Error("Workflow not found");
      workflow = { ...workflow, status: "approved", approvedAt: new Date().toISOString(), revision: workflow.revision + 1 };
      return workflow;
    },
    async compileWorkflow(request: CompileRequest): Promise<CompileResultView> {
      const extension = request.target === "playbook" ? "SKILL.md" : request.target === "playwright" ? "workflow.spec.ts" : "task.json";
      return { outputDirectory: `/tmp/replay-demo/${request.target}`, files: [extension], warnings: [] };
    },
    async startRun(workflowId: string, mode: RunMode) {
      const update: RunUpdate = {
        runId: `run-${Date.now()}`,
        workflowId,
        status: mode === "test" ? "awaiting_approval" : "running",
        ...(workflow.steps[0] ? { stepId: workflow.steps[0].id } : {}),
        message: mode === "test" ? "Ready to open the invoice" : "Opening the invoice",
      };
      queueMicrotask(() => runListeners.forEach((listener) => listener(update)));
      return update;
    },
    async listRuns() { return []; },
    async respondToRun(runId, response) {
      const status = response === "abort" ? "aborted" : "running";
      runListeners.forEach((listener) => listener({ runId, workflowId: workflow.id, status, message: response === "abort" ? "Run stopped" : "Continuing the run" }));
    },
    async stopRun(runId) {
      runListeners.forEach((listener) => listener({ runId, workflowId: workflow.id, status: "aborted", message: "Run stopped by the operator" }));
    },
    async getLiveAvailability(): Promise<LiveAvailability> { return { available: true }; },
    async setLivePaused(paused: boolean): Promise<void> {
      if (liveSessionId) publishLive({ sessionId: liveSessionId, state: paused ? "paused" : "listening", sharing: false });
    },
    async endLive(): Promise<void> { endLiveSession(); },
    onProcessingUpdate(listener) { processingListeners.add(listener); return () => processingListeners.delete(listener); },
    onRunUpdate(listener) { runListeners.add(listener); return () => runListeners.delete(listener); },
    onLiveUpdate(listener) { liveListeners.add(listener); return () => { liveListeners.delete(listener); }; },
  };
}

function demoSession(): SessionSummary {
  return {
    id: "session-demo",
    name: "Invoice review demonstration",
    state: "ready",
    startedAt: "2026-08-17T09:42:00.000Z",
    durationMs: 24_000,
    workflowId: "wf-invoice-match",
  };
}
