import type {
  DeterministicCondition,
  Workflow,
  WorkflowAction,
  WorkflowStep,
  WorkflowTarget,
} from "@replay/ir";

export type RunMode = "test" | "supervised" | "autonomous";
export type RunOutcome = "completed" | "aborted" | "failed" | "stopped_and_flagged";
export type PauseReason = "before_step" | "decision" | "expectation_failed" | "ask_user" | "secure_input" | "user_activity";

export interface Screenshot {
  id: string;
  path: string;
  capturedAt: string;
  width?: number;
  height?: number;
  scale?: number;
}

export interface ResolvedAction {
  action: WorkflowAction;
  value?: string | number | boolean | null;
}

export interface ActionReceipt {
  actionId: string;
  method: "accessibility" | "vision" | "coordinate" | "keyboard" | "human" | "none";
  targetDescription?: string;
  detail?: string;
}

export interface NativeDriver {
  screenshot(label: string): Promise<Screenshot>;
  perform(action: ResolvedAction): Promise<ActionReceipt>;
  reground?(target: WorkflowTarget, screenshot: Screenshot): Promise<WorkflowTarget>;
  evaluateDeterministic?(condition: DeterministicCondition): Promise<boolean>;
  isUserActivityInterruption?(cause: unknown): boolean;
  resumeAfterUserActivity?(): Promise<void>;
  onUserActivity?(listener: () => void): () => void;
  onKillSwitch?(listener: () => void): () => void;
}

export interface SemanticJudge {
  expectation(input: { expectation: string; screenshot: Screenshot; step: WorkflowStep }): Promise<{ met: boolean; reason: string }>;
  condition(input: { condition: string; screenshot: Screenshot }): Promise<{ result: boolean; reason: string }>;
  reground?(input: { target: WorkflowTarget; screenshot: Screenshot }): Promise<WorkflowTarget | undefined>;
  customAction?(input: { description: string; screenshot: Screenshot }): Promise<SemanticActionPlan>;
}

export type SemanticActionPlan =
  | { kind: "click"; x: number; y: number; reason: string }
  | { kind: "key"; key: string; modifiers: string[]; reason: string }
  | { kind: "stop"; reason: string };

export interface ParameterValues {
  [name: string]: string | number | boolean | null | undefined;
}

export type OperatorResponse =
  | { kind: "approve" }
  | { kind: "skip" }
  | { kind: "abort" }
  | { kind: "resume" }
  | { kind: "answer"; value: string }
  | { kind: "secure_input_complete" };

export interface RunnerEventBase {
  runId: string;
  at: string;
}

export type RunnerEvent = RunnerEventBase & (
  | { type: "run_started"; mode: RunMode; workflowId: string }
  | { type: "step_started"; stepId: string; intent: string; attempt: number }
  | { type: "action_completed"; stepId: string; receipt: ActionReceipt }
  | { type: "expectation_checked"; stepId: string; expectation: string; met: boolean; reason: string }
  | { type: "decision_taken"; stepId: string; decisionId: string; result: boolean; reason: string }
  | { type: "ask_user_answered"; nodeId: string; answer: string }
  | { type: "paused"; reason: PauseReason; stepId?: string; message: string; screenshot?: Screenshot }
  | { type: "resumed"; stepId?: string }
  | { type: "step_completed"; stepId: string; screenshot: Screenshot }
  | { type: "run_finished"; outcome: RunOutcome; message: string }
);

export interface ActionLogEntry {
  actionId: string;
  receipt: ActionReceipt;
  at: string;
}

export interface ExpectationLogEntry {
  expectation: string;
  met: boolean;
  reason: string;
}

export interface DecisionLogEntry {
  decisionId: string;
  result: boolean;
  reason: string;
}

export interface AskUserAnswerLogEntry {
  nodeId: string;
  answer: string;
  at: string;
}

export interface StepRunLog {
  stepId: string;
  intent: string;
  startedAt: string;
  completedAt?: string;
  attempts: number;
  actions: ActionLogEntry[];
  expectations: ExpectationLogEntry[];
  decisions: DecisionLogEntry[];
  screenshots: Screenshot[];
  outcome: "completed" | "skipped" | "failed";
}

export interface RunLog {
  runId: string;
  workflowId: string;
  workflowRevision: number;
  mode: RunMode;
  startedAt: string;
  completedAt?: string;
  outcome?: RunOutcome;
  steps: StepRunLog[];
  answers: AskUserAnswerLogEntry[];
}

export interface RunnerOptions {
  runId?: string;
  mode: RunMode;
  parameters?: ParameterValues;
  maxRetries?: number;
  now?: () => Date;
  onEvent?: (event: RunnerEvent) => void | Promise<void>;
}

export interface RunHandle {
  runId: string;
  result: Promise<RunLog>;
  respond(response: OperatorResponse): void;
  abort(): void;
  log(): RunLog;
}

export interface RunnerStartInput {
  workflow: Workflow;
  driver: NativeDriver;
  judge: SemanticJudge;
  options: RunnerOptions;
}
