import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BranchPathView,
  CompileResultView,
  PermissionName,
  PermissionStatus,
  ProcessingUpdate,
  ReplayDesktopApi,
  RunHistoryView,
  RunMode,
  RunResponse,
  RunUpdate,
  SessionSummary,
  StepView,
  WorkflowView,
} from "../shared/contracts.js";
import { createMockApi } from "./mock-api.js";
import { activeRecording, buildableRecording, latestUnprocessedRecording } from "./recording-state.js";
import { editWorkflow, isWorkflowReviewValid, type WorkflowEdit } from "./workflow-state.js";

const browserMock = createMockApi();

/** The Ivy mark — the same white ivy line-art used across the Ivy suite (see the HR Agentic Blueprint app). */
const IvyMark = ({ size = 22 }: { size?: number }) => (
  <svg viewBox="0 0 64 64" fill="none" width={size} height={size} aria-hidden="true">
    <g stroke="#fff" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 44C8 48 8 54 12 58C18 62 30 62 40 60C48 58 54 50 54 42L54 28" />
      <ellipse cx="20" cy="36" rx="8" ry="9" />
      <path d="M32 28C31 20 31 14 32 8" />
      <path d="M40 25C40 17 40 11 41 6" />
      <path d="M48 28C48 20 49 14 50 10" />
    </g>
  </svg>
);

/** Ivy lockup: rose tile with the mark, the Ivy wordmark, and the product name — matching the sibling Ivy apps. */
const BrandLockup = ({ product = "Replay" }: { product?: string }) => (
  <><span className="brand-tile"><IvyMark /></span><b>Ivy</b><small>{product}</small></>
);

export function App() {
  const api = window.replay ?? browserMock;
  const [permissions, setPermissions] = useState<PermissionStatus[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<WorkflowView>();
  const [captured, setCaptured] = useState<SessionSummary>();
  const [processing, setProcessing] = useState<ProcessingUpdate>();
  const [run, setRun] = useState<RunUpdate>();
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const dismissedSessions = useRef(new Set<string>());
  const recording = activeRecording(sessions);

  const refresh = useCallback(async () => {
    try {
      const [nextPermissions, nextWorkflows, nextSessions] = await Promise.all([api.getPermissions(), api.listWorkflows(), api.listSessions()]);
      setPermissions(nextPermissions);
      setWorkflows(nextWorkflows);
      setSessions(nextSessions);
      setSelected((current) => nextWorkflows.find((workflow) => workflow.id === current?.id) ?? nextWorkflows[0]);
      setCaptured((current) => {
        const currentSummary = current ? nextSessions.find((session) => session.id === current.id) : undefined;
        if (buildableRecording(currentSummary)) return currentSummary;
        const linkedSessions = new Set(nextWorkflows.map((workflow) => workflow.sessionId).filter((id): id is string => Boolean(id)));
        return latestUnprocessedRecording(nextSessions, linkedSessions, dismissedSessions.current);
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoaded(true);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => api.onProcessingUpdate(setProcessing), [api]);
  useEffect(() => api.onRunUpdate(setRun), [api]);

  const receiveWorkflow = useCallback((workflow: WorkflowView) => {
    setSelected(workflow);
    setWorkflows((items) => items.map((item) => item.id === workflow.id ? workflow : item));
  }, []);

  const requiredPermissions = permissions.filter((permission) => permission.required);
  const requiredPermissionsReady = requiredPermissions.length > 0 && requiredPermissions.every((permission) => permission.state === "granted");

  if (!loaded) return <LoadingScreen />;
  if (!requiredPermissionsReady) {
    return <PermissionSetup api={api} permissions={permissions} error={error} onRefresh={refresh} />;
  }

  async function toggleRecording(microphone: boolean) {
    try {
      setError(undefined);
      if (recording?.state === "recording") {
        const stopped = await api.stopRecording();
        setCaptured(buildableRecording(stopped));
        setSessions((items) => [stopped, ...items.filter((item) => item.id !== stopped.id)]);
        if (stopped.state === "partial" || stopped.state === "failed") {
          setError("The recording was interrupted before it finished, so Replay will not offer it for building. Please make a new recording.");
        }
      } else {
        const started = await api.startRecording({ microphone });
        setSessions((items) => [started, ...items.filter((item) => item.id !== started.id)]);
      }
    } catch (cause) {
      setError(messageOf(cause));
      try {
        setSessions(await api.listSessions());
      } catch {
        // Keep the last confirmed session list. In particular, a failed refresh
        // must not hide a recording whose stop acknowledgement was uncertain.
      }
    }
  }

  async function processCaptured() {
    if (!captured) return;
    try {
      setError(undefined);
      setProcessing({ sessionId: captured.id, stage: "condensing", progress: 0, message: "Preparing local evidence" });
      const workflow = await api.processSession(captured.id);
      setSelected(workflow);
      setWorkflows((items) => [workflow, ...items.filter((item) => item.id !== workflow.id)]);
      setCaptured(undefined);
      setProcessing(undefined);
    } catch (cause) {
      setProcessing(undefined);
      await refresh();
      setError(messageOf(cause));
    }
  }

  async function saveWorkflow(workflow: WorkflowView): Promise<WorkflowView | undefined> {
    try {
      const saved = await api.saveWorkflow(workflow);
      setSelected(saved);
      setWorkflows((items) => items.map((item) => item.id === saved.id ? saved : item));
      return saved;
    } catch (cause) { setError(messageOf(cause)); return undefined; }
  }

  async function approveWorkflow() {
    if (!selected) return;
    try {
      const approved = await api.approveWorkflow(selected.id);
      setSelected(approved);
      setWorkflows((items) => items.map((item) => item.id === approved.id ? approved : item));
    } catch (cause) { setError(messageOf(cause)); }
  }

  async function startRun(mode: RunMode, parameters?: Record<string, string | number | boolean | null>) {
    if (!selected) return;
    try { setRun(await api.startRun(selected.id, mode, parameters)); } catch (cause) { setError(messageOf(cause)); }
  }

  return (
    <div className="shell">
      <Sidebar
        workflows={workflows}
        selectedId={selected?.id}
        recording={recording}
        onSelect={(workflow) => setSelected(workflow)}
        onRecord={toggleRecording}
      />
      <main className="content">
        {error && <ErrorBanner message={error} onClose={() => setError(undefined)} />}
        {captured && !processing && <CaptureReadyBanner session={captured} onProcess={() => void processCaptured()} onDismiss={() => { dismissedSessions.current.add(captured.id); setCaptured(undefined); }} />}
        {processing && <ProcessingBanner update={processing} />}
        {selected
          ? <ReviewWorkspace
              key={`${selected.id}:${selected.revision}`}
              api={api}
              workflow={selected}
              videoUrl={sessions.find((session) => session.id === selected.sessionId)?.videoUrl}
              run={run}
              onSave={saveWorkflow}
              onApprove={approveWorkflow}
              onRun={startRun}
              onRunChange={setRun}
              onWorkflowRefresh={receiveWorkflow}
            />
          : <EmptyWorkspace onRecord={() => void toggleRecording(true)} />}
      </main>
    </div>
  );
}

function Sidebar(props: {
  workflows: WorkflowView[];
  selectedId: string | undefined;
  recording: SessionSummary | undefined;
  onSelect: (workflow: WorkflowView) => void;
  onRecord: (microphone: boolean) => Promise<void>;
}) {
  const [microphone, setMicrophone] = useState(false);
  const isRecording = props.recording?.state === "recording";
  return (
    <aside className="sidebar">
      <div className="app-brand"><BrandLockup /></div>
      <section className={`record-card ${isRecording ? "active" : ""}`}>
        <button className="record-button" onClick={() => void props.onRecord(microphone)}>
          <span className="record-dot" />
          {isRecording ? "Stop recording" : "Record a workflow"}
        </button>
        {isRecording
          ? <RecordingClock startedAt={props.recording!.startedAt} />
          : <label className="mic-toggle"><input type="checkbox" checked={microphone} onChange={(event) => setMicrophone(event.target.checked)} /><span>Include narration</span></label>}
      </section>
      <nav className="workflow-nav" aria-label="Workflows">
        <div className="nav-heading"><span>Workflows</span><span className="count">{props.workflows.length}</span></div>
        {props.workflows.map((workflow) => (
          <button key={workflow.id} className={workflow.id === props.selectedId ? "active" : ""} onClick={() => props.onSelect(workflow)}>
            <span className="workflow-icon">{workflow.status === "approved" ? "✓" : "◌"}</span>
            <span className="workflow-copy"><strong>{workflow.name}</strong><small>{workflow.steps.length} steps · {workflow.status}</small></span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer"><span className="local-indicator" /> Everything stays on this Mac</div>
    </aside>
  );
}

function ReviewWorkspace(props: {
  api: ReplayDesktopApi;
  workflow: WorkflowView;
  videoUrl: string | undefined;
  run: RunUpdate | undefined;
  onSave: (workflow: WorkflowView) => Promise<WorkflowView | undefined>;
  onApprove: () => Promise<void>;
  onRun: (mode: RunMode, parameters?: Record<string, string | number | boolean | null>) => Promise<void>;
  onRunChange: (run: RunUpdate | undefined) => void;
  onWorkflowRefresh: (workflow: WorkflowView) => void;
}) {
  const [draft, setDraft] = useState(props.workflow);
  const [selectedStepId, setSelectedStepId] = useState(props.workflow.steps[0]?.id);
  const [tab, setTab] = useState<"steps" | "parameters" | "questions" | "history">("steps");
  const [history, setHistory] = useState<RunHistoryView[]>([]);
  const [runEvidenceUrl, setRunEvidenceUrl] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [exportResult, setExportResult] = useState<CompileResultView>();
  const [exportOpen, setExportOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.workflow);
  const lowConfidence = draft.steps.flatMap((step) => step.decisions).filter((decision) => decision.confidence === "low").length;
  const reviewValid = isWorkflowReviewValid(draft);

  const refreshHistory = useCallback(() => {
    void props.api.listRuns(props.workflow.id).then(setHistory).catch(() => undefined);
  }, [props.api, props.workflow.id]);
  useEffect(refreshHistory, [refreshHistory]);
  useEffect(() => {
    if (props.run?.status !== "completed" && props.run?.status !== "failed" && props.run?.status !== "aborted") return;
    refreshHistory();
    void props.api.getWorkflow(props.workflow.id).then(props.onWorkflowRefresh).catch(() => undefined);
  }, [props.run?.status, props.api, props.workflow.id, props.onWorkflowRefresh, refreshHistory]);

  function apply(edit: WorkflowEdit) { setDraft((workflow) => editWorkflow(workflow, edit)); }
  function selectStep(step: StepView) {
    setSelectedStepId(step.id);
    if (videoRef.current) videoRef.current.currentTime = step.time.startMs / 1_000;
  }
  function followVideo() {
    const timeMs = (videoRef.current?.currentTime ?? 0) * 1_000;
    const current = [...draft.steps].reverse().find((step) => step.time.startMs <= timeMs);
    if (current && current.id !== selectedStepId) setSelectedStepId(current.id);
  }
  async function save() {
    setSaving(true);
    try {
      const saved = await props.onSave(draft);
      if (saved) setDraft(saved);
    } finally { setSaving(false); }
  }

  async function saveRunCorrection(runId: string, stepId: string, intent: string, expects: string) {
    let corrected = editWorkflow(draft, { type: "step_intent", stepId, intent });
    corrected = editWorkflow(corrected, { type: "step_expects", stepId, expects });
    await props.api.stopRun(runId);
    const saved = await props.onSave(corrected);
    if (!saved) return;
    setDraft(saved);
    props.onRunChange(undefined);
    setRunOpen(false);
  }

  return (
    <>
      <header className="workspace-header">
        <div className="title-block">
          <div className="title-line">
            <input aria-label="Workflow name" value={draft.name} onChange={(event) => apply({ type: "rename", name: event.target.value })} />
            <span className={`approval-pill ${draft.status}`}>{draft.status === "approved" ? "Approved" : "Draft"}</span>
          </div>
          <p>Version {draft.revision} · Captured locally</p>
        </div>
        <div className="header-actions">
          {dirty && <button className="text-button" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save draft"}</button>}
          <button className="outline-button" disabled={draft.status !== "approved"} onClick={() => setExportOpen(true)}>Export</button>
          <button className="run-button" disabled={draft.status !== "approved"} onClick={() => setRunOpen(true)}><span>▶</span> Run workflow</button>
        </div>
      </header>
      <section className="goal-strip">
        <span>Goal</span>
        <textarea aria-label="Workflow goal" value={draft.goal} rows={2} onChange={(event) => apply({ type: "goal", goal: event.target.value })} />
      </section>
      <section className="review-grid">
        <div className="evidence-pane">
          <div className="video-stage">
            {runEvidenceUrl
              ? <img className="run-evidence" src={runEvidenceUrl} alt="Evidence captured during a workflow run" />
              : props.workflow.sessionId === "session-demo"
              ? <DemoFrame step={draft.steps.find((step) => step.id === selectedStepId)} />
              : props.videoUrl
                ? <video ref={videoRef} src={props.videoUrl} controls onTimeUpdate={followVideo} aria-label="Source recording" />
                : <div className="video-unavailable"><span>Recording unavailable</span><small>The workflow remains editable from its captured evidence.</small></div>}
            <div className="video-badge">{runEvidenceUrl ? "Run evidence" : "Source recording"}</div>
          </div>
          <Timeline steps={draft.steps} selectedId={selectedStepId} onSelect={selectStep} />
          <div className="evidence-note"><span>⌁</span><p><strong>Every step stays linked to evidence.</strong><br />Select a step to jump to the moment it came from.</p>{runEvidenceUrl && <button onClick={() => setRunEvidenceUrl(undefined)}>Back to recording</button>}</div>
        </div>
        <div className="editor-pane">
          <div className="tabs" role="tablist">
            <button className={tab === "steps" ? "active" : ""} onClick={() => setTab("steps")}>Steps <span>{draft.steps.length}</span></button>
            <button className={tab === "parameters" ? "active" : ""} onClick={() => setTab("parameters")}>Inputs <span>{draft.parameters.length}</span></button>
            <button className={tab === "questions" ? "active" : ""} onClick={() => setTab("questions")}>Questions {lowConfidence > 0 && <span className="question-count">{lowConfidence}</span>}</button>
            <button className={tab === "history" ? "active" : ""} onClick={() => setTab("history")}>Runs <span>{history.length}</span></button>
          </div>
          {tab === "steps" && <StepEditor workflow={draft} selectedId={selectedStepId} onSelect={selectStep} onEdit={apply} />}
          {tab === "parameters" && <ParameterEditor workflow={draft} onEdit={apply} />}
          {tab === "questions" && <QuestionQueue workflow={draft} onEdit={apply} />}
          {tab === "history" && <RunHistory runs={history} onSelect={(stepId, screenshot) => { const step = draft.steps.find((candidate) => candidate.id === stepId); if (step) selectStep(step); if (screenshot) setRunEvidenceUrl(screenshot); }} />}
          <footer className="approval-footer">
            <div><strong>{draft.status === "approved" ? "This version is approved" : "Ready to trust this workflow?"}</strong><p>{draft.status === "approved" ? "Export and test-run controls are unlocked." : "Review the steps, inputs, and decision paths first."}</p></div>
            <button className="approve-button" disabled={draft.status === "approved" || dirty || !reviewValid} onClick={() => void props.onApprove()}>{dirty ? "Save before approval" : !reviewValid ? "Finish required details" : "Approve workflow"}</button>
          </footer>
        </div>
      </section>
      {exportOpen && <ExportDialog api={props.api} workflow={draft} result={exportResult} onResult={setExportResult} onClose={() => { setExportOpen(false); setExportResult(undefined); }} />}
      {runOpen && <RunDialog api={props.api} workflow={draft} run={props.run} onStart={props.onRun} onRunChange={props.onRunChange} onCorrect={saveRunCorrection} onClose={() => setRunOpen(false)} />}
    </>
  );
}

function StepEditor(props: { workflow: WorkflowView; selectedId: string | undefined; onSelect: (step: StepView) => void; onEdit: (edit: WorkflowEdit) => void }) {
  return (
    <div className="step-list">
      {props.workflow.steps.map((step, index) => (
        <article key={step.id} className={`step-card ${props.selectedId === step.id ? "selected" : ""}`} onClick={() => props.onSelect(step)}>
          <div className="step-number">{index + 1}</div>
          <div className="step-body">
            <div className="step-meta"><span>{formatTime(step.time.startMs)}</span><span className={`source source-${step.source}`}>{sourceLabel(step.source)}</span></div>
            <input aria-label={`Step ${index + 1} intent`} value={step.intent} onChange={(event) => props.onEdit({ type: "step_intent", stepId: step.id, intent: event.target.value })} />
            <div className="action-list">{step.actions.map((action) => <div className="action-row" key={action.id}>
              <span>{action.description}</span>
              {action.target && <input aria-label={`Target for ${action.description}`} value={action.target} onChange={(event) => props.onEdit({ type: "action_target", stepId: step.id, actionId: action.id, target: event.target.value })} />}
              {action.value !== undefined && <small>{action.parameter ? `Input: {${action.parameter}}` : `Recorded: ${action.value}`}</small>}
              {action.value !== undefined && !action.parameter && action.value !== "[SECURE INPUT]" && <button onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "promote_action_value", stepId: step.id, actionId: action.id, name: suggestedParameterName(action.target, props.workflow.parameters.length) }); }}>Make reusable</button>}
            </div>)}</div>
            <label className="expects"><span>Success looks like</span><textarea value={step.expects} rows={2} onChange={(event) => props.onEdit({ type: "step_expects", stepId: step.id, expects: event.target.value })} /></label>
            {step.decisions.map((decision) => <DecisionEditor key={decision.id} step={step} decision={decision} onEdit={props.onEdit} />)}
          </div>
          <div className="step-tools">
            <button aria-label="Move step up" disabled={index === 0} onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "move_step", stepId: step.id, direction: -1 }); }}>↑</button>
            <button aria-label="Move step down" disabled={index === props.workflow.steps.length - 1} onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "move_step", stepId: step.id, direction: 1 }); }}>↓</button>
            <button aria-label="Split step" disabled={step.actions.length < 2} onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "split_step", stepId: step.id }); }}>⑂</button>
            <button aria-label="Merge with next step" disabled={index === props.workflow.steps.length - 1 || step.decisions.length > 0 || (props.workflow.steps[index + 1]?.decisions.length ?? 0) > 0} onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "merge_next", stepId: step.id }); }}>⌁</button>
            <button aria-label="Delete step" onClick={(event) => { event.stopPropagation(); props.onEdit({ type: "delete_step", stepId: step.id }); }}>×</button>
          </div>
        </article>
      ))}
    </div>
  );
}

function DecisionEditor({ step, decision, onEdit }: { step: StepView; decision: StepView["decisions"][number]; onEdit: (edit: WorkflowEdit) => void }) {
  return (
    <div className="decision-card">
      <div className="decision-heading"><span className="branch-symbol">◇</span><strong>Decision point</strong><span className={`confidence ${decision.confidence}`}>{decision.confidence} confidence</span></div>
      <input aria-label={`Decision condition ${decision.id}`} value={decision.condition} onChange={(event) => onEdit({ type: "decision_condition", stepId: step.id, decisionId: decision.id, condition: event.target.value })} />
      <BranchEditor label="If yes" side="then" stepId={step.id} decisionId={decision.id} path={decision.then} onEdit={onEdit} />
      <BranchEditor label="If no" side="else" stepId={step.id} decisionId={decision.id} path={decision.else} onEdit={onEdit} />
    </div>
  );
}

function BranchEditor({ label, side, stepId, decisionId, path, onEdit }: { label: string; side: "then" | "else"; stepId: string; decisionId: string; path: BranchPathView; onEdit: (edit: WorkflowEdit) => void }) {
  return <div className={`branch-editor ${side}`}>
    <span>{label}</span>
    <select aria-label={`${label} behavior`} value={path.kind} onChange={(event) => onEdit({ type: "decision_path", stepId, decisionId, side, kind: event.target.value as "steps" | "ask_user" | "stop_and_flag", summary: path.summary })}>
      <option value="steps">Describe steps</option>
      <option value="ask_user">Ask me at run time</option>
      <option value="stop_and_flag">Stop and flag</option>
    </select>
    <textarea aria-label={`${label} path`} rows={2} value={path.summary} onChange={(event) => onEdit({ type: "decision_path", stepId, decisionId, side, kind: path.kind, summary: event.target.value })} />
  </div>;
}

function ParameterEditor({ workflow, onEdit }: { workflow: WorkflowView; onEdit: (edit: WorkflowEdit) => void }) {
  return (
    <div className="parameter-list">
      <div className="section-intro"><h2>Reusable inputs</h2><p>Confirm values that should change from one run to the next.</p></div>
      {workflow.parameters.map((parameter) => (
        <article className="parameter-card" key={parameter.id}>
          <div className="parameter-icon">{parameter.vault ? "⌘" : "{ }"}</div>
          <div><input className="parameter-name" aria-label={`Name for ${parameter.name}`} value={parameter.name} onChange={(event) => onEdit({ type: "rename_parameter", parameterId: parameter.id, name: event.target.value })} /><p>{parameter.description}</p>{parameter.example && <small>Recorded value: {parameter.example}</small>}{parameter.vault && <small>Secure value · never stored in the workflow</small>}</div>
          <label className="confirm-switch"><input type="checkbox" disabled={parameter.vault} checked={parameter.confirmed} onChange={(event) => onEdit({ type: "confirm_parameter", parameterId: parameter.id, confirmed: event.target.checked })} /><span>{parameter.vault ? "Required securely" : parameter.confirmed ? "Included" : "Ignored"}</span></label>
        </article>
      ))}
    </div>
  );
}

function QuestionQueue({ workflow, onEdit }: { workflow: WorkflowView; onEdit: (edit: WorkflowEdit) => void }) {
  const uncertain = workflow.steps.flatMap((step) => step.decisions.filter((decision) => decision.confidence === "low").map((decision) => ({ step, decision })));
  if (uncertain.length === 0) return <div className="empty-questions"><span>✓</span><h2>No open questions</h2><p>Replay found enough evidence to describe every decision path.</p></div>;
  return <div className="question-list">{uncertain.map(({ step, decision }) => <article key={decision.id}><p>At {formatTime(step.time.startMs)}, was this a decision point?</p><strong>{decision.condition}</strong><div><button onClick={() => onEdit({ type: "confirm_decision", stepId: step.id, decisionId: decision.id })}>Yes, keep it</button><button onClick={() => onEdit({ type: "remove_decision", stepId: step.id, decisionId: decision.id })}>No, remove it</button></div></article>)}</div>;
}

function RunHistory({ runs, onSelect }: { runs: RunHistoryView[]; onSelect: (stepId: string, screenshot: string | undefined) => void }) {
  if (runs.length === 0) return <div className="empty-questions"><span>▶</span><h2>No runs yet</h2><p>Test this approved workflow to build an evidence-backed run history.</p></div>;
  return <div className="run-history">{runs.map((run) => <article key={run.runId}>
    <header><div><strong>{run.mode} run</strong><small>{new Date(run.startedAt).toLocaleString()} · version {run.workflowRevision}</small></div><span className={`run-outcome ${run.outcome ?? "running"}`}>{(run.outcome ?? "running").replaceAll("_", " ")}</span></header>
    <div className="history-steps">{run.steps.map((step, index) => <button key={`${run.runId}:${step.stepId}`} onClick={() => onSelect(step.stepId, step.screenshots.at(-1))}>
      <span>{index + 1}</span><div><strong>{step.intent}</strong><small>{step.outcome} · {step.attempts} {step.attempts === 1 ? "attempt" : "attempts"}{step.decisions[0] ? ` · branch ${step.decisions[0].result ? "yes" : "no"}` : ""}</small></div>{step.screenshots.length > 0 && <em>View evidence</em>}
    </button>)}</div>{run.answers.length > 0 && <div className="run-answers">{run.answers.map((answer) => <p key={`${answer.nodeId}:${answer.at}`}><strong>Runtime answer</strong><span>{answer.answer}</span></p>)}</div>}
  </article>)}</div>;
}

function Timeline({ steps, selectedId, onSelect }: { steps: StepView[]; selectedId: string | undefined; onSelect: (step: StepView) => void }) {
  const end = Math.max(...steps.map((step) => step.time.endMs), 1);
  return (
    <div className="timeline" aria-label="Recording timeline">
      <div className="timeline-track">
        {steps.map((step, index) => <button key={step.id} className={step.id === selectedId ? "active" : ""} style={{ left: `${(step.time.startMs / end) * 100}%` }} onClick={() => onSelect(step)} aria-label={`Jump to step ${index + 1}`}><span>{index + 1}</span></button>)}
      </div>
      <div className="timeline-labels"><span>0:00</span><span>{formatTime(end)}</span></div>
    </div>
  );
}

function DemoFrame({ step }: { step: StepView | undefined }) {
  const isDecision = (step?.decisions.length ?? 0) > 0;
  return <div className="demo-frame"><div className="fake-bar"><i /><i /><i /><span>northstar.local/invoices/INV-1048</span></div><div className="fake-app"><aside><b>N</b><span>Dashboard</span><span className="active">Invoices</span><span>Vendors</span></aside><main><small>Invoice review</small><h3>INV-1048</h3><div className="fake-comparison"><div><span>Invoice total</span><strong>$1,284.40</strong></div><em>{isDecision ? "=" : "→"}</em><div><span>PO-8821</span><strong>$1,284.40</strong></div></div><button>{isDecision ? "Totals match" : "Approve invoice"}</button></main></div></div>;
}

function ExportDialog(props: { api: ReplayDesktopApi; workflow: WorkflowView; result: CompileResultView | undefined; onResult: (result: CompileResultView) => void; onClose: () => void }) {
  const [target, setTarget] = useState<"playbook" | "playwright" | "computer-use">("playbook");
  const [busy, setBusy] = useState(false);
  async function compile() { setBusy(true); try { props.onResult(await props.api.compileWorkflow({ workflowId: props.workflow.id, target, checkpointMode: "human" })); } finally { setBusy(false); } }
  return <Modal title="Export workflow" onClose={props.onClose}>{props.result ? <div className="export-result"><span>✓</span><h3>Export ready</h3><p>{props.result.files.join(", ")}</p><small>{props.result.outputDirectory}</small>{props.result.warnings.map((warning) => <div className="warning" key={warning.message}>{warning.message}</div>)}</div> : <><div className="export-options">{([['playbook','Agent playbook','A readable SKILL.md for an agent or person'],['playwright','Playwright script','Deterministic browser automation with honest checkpoints'],['computer-use','Runner task','IR, policy, prompt, and visual target bundle']] as const).map(([value,title,copy]) => <label className={target === value ? "selected" : ""} key={value}><input type="radio" name="export" value={value} checked={target === value} onChange={() => setTarget(value)} /><span><strong>{title}</strong><small>{copy}</small></span></label>)}</div><button className="modal-primary" disabled={busy} onClick={() => void compile()}>{busy ? "Compiling…" : "Create export"}</button></>}</Modal>;
}

function RunDialog(props: { api: ReplayDesktopApi; workflow: WorkflowView; run: RunUpdate | undefined; onStart: (mode: RunMode, parameters?: Record<string, string | number | boolean | null>) => Promise<void>; onRunChange: (run: RunUpdate | undefined) => void; onCorrect: (runId: string, stepId: string, intent: string, expects: string) => Promise<void>; onClose: () => void }) {
  const [mode, setMode] = useState<RunMode>(props.workflow.cleanTestRunAt ? "supervised" : "test");
  const [parameters, setParameters] = useState<Record<string, string>>(() => Object.fromEntries(
    props.workflow.parameters
      .filter((parameter) => !parameter.vault && parameter.confirmed)
      .map((parameter) => [parameter.name, parameter.example ?? ""]),
  ));
  if (props.run) {
    const terminal = props.run.status === "completed" || props.run.status === "failed" || props.run.status === "aborted";
    const respond = (response: RunResponse) => void props.api.respondToRun(props.run!.runId, response);
    return <Modal title="Workflow run" onClose={props.onClose}><div className="run-state">
      <div className={`run-orb ${props.run.status}`}><span>{terminal ? props.run.status === "completed" ? "✓" : "!" : "▶"}</span></div>
      <p className="run-status">{props.run.status.replaceAll("_", " ")}</p>
      <h3>{props.run.message}</h3>
      {props.run.screenshotUrl && <img className="run-screenshot" src={props.run.screenshotUrl} alt="Screen when the run paused" />}
      {props.run.status === "paused" && <div className="run-actions"><button onClick={() => respond("abort")}>Abort</button><button className="modal-primary" onClick={() => respond("resume")}>Resume safely</button></div>}
      {props.run.status === "awaiting_approval" && <RunPauseActions reason={props.run.pauseReason} onRespond={respond} />}
      {mode === "test" && props.run.stepId && (props.run.pauseReason === "before_step" || props.run.pauseReason === "expectation_failed") && <RunCorrectionEditor key={`${props.run.stepId}:${props.run.pauseReason}`} workflow={props.workflow} runId={props.run.runId} stepId={props.run.stepId} onCorrect={props.onCorrect} />}
      {terminal
        ? <button className="modal-primary" onClick={() => { props.onRunChange(undefined); props.onClose(); }}>Close</button>
        : <button className="stop-link" onClick={async () => { await props.api.stopRun(props.run!.runId); }}>Stop run now</button>}
    </div></Modal>;
  }
  return <Modal title="Run this workflow" onClose={props.onClose}><p className="modal-copy">Replay follows only the approved steps. Move your mouse or press the global stop shortcut to pause immediately.</p>{Object.keys(parameters).length > 0 && <div className="run-inputs"><strong>Inputs for this run</strong>{Object.entries(parameters).map(([name, value]) => <label key={name}><span>{name}</span><input value={value} onChange={(event) => setParameters((current) => ({ ...current, [name]: event.target.value }))} /></label>)}</div>}<div className="mode-options">{([['test','Test run','Pauses before every step. Required before autonomous runs.'],['supervised','Supervised','Runs continuously, pausing at decisions and failures.'],['autonomous','Autonomous','Pauses only where the workflow explicitly says to.']] as const).map(([value,title,copy]) => <label className={`${mode === value ? "selected" : ""} ${value === "autonomous" && !props.workflow.cleanTestRunAt ? "disabled" : ""}`} key={value}><input type="radio" disabled={value === "autonomous" && !props.workflow.cleanTestRunAt} checked={mode === value} onChange={() => setMode(value)} /><span><strong>{title}</strong><small>{copy}</small></span></label>)}</div><button className="modal-primary" onClick={() => void props.onStart(mode, parameters)}>Start {mode} run</button></Modal>;
}

function RunCorrectionEditor({ workflow, runId, stepId, onCorrect }: { workflow: WorkflowView; runId: string; stepId: string; onCorrect: (runId: string, stepId: string, intent: string, expects: string) => Promise<void> }) {
  const step = workflow.steps.find((candidate) => candidate.id === stepId);
  const [intent, setIntent] = useState(step?.intent ?? "");
  const [expects, setExpects] = useState(step?.expects ?? "");
  const [saving, setSaving] = useState(false);
  if (!step) return null;
  const changed = intent.trim() !== step.intent.trim() || expects.trim() !== step.expects.trim();
  return <details className="run-correction"><summary>Replay misunderstood this step</summary><div><label><span>What Replay should do</span><textarea rows={2} value={intent} onChange={(event) => setIntent(event.target.value)} /></label><label><span>Success looks like</span><textarea rows={2} value={expects} onChange={(event) => setExpects(event.target.value)} /></label><button disabled={saving || !changed || !intent.trim() || !expects.trim()} onClick={async () => { setSaving(true); try { await onCorrect(runId, stepId, intent, expects); } finally { setSaving(false); } }}>{saving ? "Saving correction…" : "Save as a new draft and end test"}</button></div></details>;
}

function RunPauseActions({ reason, onRespond }: { reason: RunUpdate["pauseReason"]; onRespond: (response: RunResponse) => void }) {
  const [answer, setAnswer] = useState("");
  if (reason === "secure_input") return <div className="run-actions"><button onClick={() => onRespond("abort")}>Abort</button><button className="modal-primary" onClick={() => onRespond("secure_input_complete")}>I’ve typed it</button></div>;
  if (reason === "expectation_failed") return <div className="run-actions"><button onClick={() => onRespond("skip")}>Skip step</button><button className="modal-primary" onClick={() => onRespond("abort")}>End safely</button></div>;
  if (reason === "before_step") return <div className="run-actions three"><button onClick={() => onRespond("abort")}>Abort</button><button onClick={() => onRespond("skip")}>Skip</button><button className="modal-primary" onClick={() => onRespond("approve")}>Approve step</button></div>;
  if (reason === "ask_user") return <div className="run-answer"><label><span>Your answer</span><textarea autoFocus rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer this workflow question. Never enter a password here." /></label><div className="run-actions"><button onClick={() => onRespond("abort")}>Abort</button><button className="modal-primary" disabled={!answer.trim()} onClick={() => onRespond({ kind: "answer", value: answer })}>Answer and continue</button></div></div>;
  return <div className="run-actions"><button onClick={() => onRespond("abort")}>Abort</button><button className="modal-primary" onClick={() => onRespond(reason === "user_activity" ? "resume" : "approve")}>Continue</button></div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button aria-label="Close" onClick={onClose}>×</button></header>{children}</section></div>;
}

function PermissionSetup({ api, permissions, error, onRefresh }: { api: ReplayDesktopApi; permissions: PermissionStatus[]; error: string | undefined; onRefresh: () => Promise<void> }) {
  return <main className="permission-page"><div className="permission-brand"><BrandLockup /></div><section><p className="eyebrow">One-time setup</p><h1>Give Replay eyes and hands</h1><p className="permission-lead">These macOS permissions let Replay capture your work and run only the workflows you approve. Recordings stay on this Mac.</p>{error && <div className="error-banner"><span>Replay could not check permissions: {error}</span></div>}<div className="permission-list">{permissions.map((permission) => <article key={permission.name}><span className={`permission-state ${permission.state}`}>{permission.state === "granted" ? "✓" : permission.required ? "•" : "○"}</span><div><strong>{permissionTitle(permission.name)}</strong><p>{permission.explanation}</p></div><button disabled={permission.state === "granted"} onClick={async () => { if (permission.state === "notDetermined") await api.requestPermission(permission.name); else await api.openPermissionSettings(permission.name); await onRefresh(); }}>{permission.state === "granted" ? "Granted" : "Open settings"}</button></article>)}</div><button className="refresh-button" onClick={() => void onRefresh()}>Check permissions again</button></section></main>;
}

function RecordingClock({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  return <div className="recording-time"><span className="pulse" />{formatTime(Math.max(0, now - new Date(startedAt).getTime()))}</div>;
}

function ProcessingBanner({ update }: { update: ProcessingUpdate }) { return <div className="processing-banner"><div className="spinner" /><div><strong>Turning your recording into a workflow</strong><span>{update.message}</span></div><div className="progress-track"><i style={{ width: `${update.progress * 100}%` }} /></div><b>{Math.round(update.progress * 100)}%</b></div>; }
function CaptureReadyBanner({ session, onProcess, onDismiss }: { session: SessionSummary; onProcess: () => void; onDismiss: () => void }) { return <div className="capture-ready"><div><strong>Recording saved on this Mac</strong><span>Build a workflow by sending condensed actions and sampled frames to Claude. The full video stays local.</span></div><button className="capture-dismiss" aria-label="Keep recording without processing" onClick={onDismiss}>Not now</button><button onClick={onProcess}>Build workflow</button><small>{session.durationMs ? formatTime(session.durationMs) : "Saved"}</small></div>; }
function ErrorBanner({ message, onClose }: { message: string; onClose: () => void }) { return <div className="error-banner"><span>Something went wrong: {message}</span><button onClick={onClose}>×</button></div>; }
function LoadingScreen() { return <div className="loading-screen"><span className="brand-tile"><IvyMark /></span><p>Opening Replay…</p></div>; }
function EmptyWorkspace({ onRecord }: { onRecord: () => void }) { return <div className="empty-workspace"><div className="empty-art"><span>●</span><i /><i /></div><h1>Teach Replay a piece of work</h1><p>Record yourself completing a task. Narrate the choices you make, then review what Replay understood.</p><button onClick={onRecord}>Record your first workflow</button></div>; }

function formatTime(milliseconds: number): string { const total = Math.floor(milliseconds / 1_000); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`; }
function sourceLabel(source: StepView["source"]): string { return source === "user-added-in-review" ? "Added in review" : source[0]!.toUpperCase() + source.slice(1); }
function permissionTitle(name: PermissionName): string { return { screen: "Screen Recording", accessibility: "Accessibility", inputMonitoring: "Input Monitoring", microphone: "Microphone (optional)" }[name]; }
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
function suggestedParameterName(target: string | undefined, index: number): string { const base = (target ?? "input").toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "").replace(/^[^a-z]+/u, ""); return base || `input_${index + 1}`; }
