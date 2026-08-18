export const CURRENT_WORKFLOW_VERSION = 1 as const;

export type WorkflowVersion = typeof CURRENT_WORKFLOW_VERSION;

export type ParameterType =
  | "string"
  | "number"
  | "boolean"
  | "url"
  | "date"
  | "file"
  | "secret";

export type WorkflowScalar = string | number | boolean | null;

/** A normal parameter reference. `vault` is explicit so it cannot be confused with a secret. */
export interface ParameterReference {
  param: string;
  vault: false;
}

/** A reference to a value that must never be embedded in the workflow document. */
export interface VaultReference {
  param: string;
  vault: true;
}

export type InputReference = ParameterReference | VaultReference;
export type WorkflowValue = WorkflowScalar | InputReference;
export type WorkflowStringValue = string | InputReference;

export interface WorkflowParameter {
  name: string;
  type: ParameterType;
  description: string;
  required: boolean;
  example: WorkflowValue;
}

export type ProvenanceSource =
  | "recorded"
  | "narrated"
  | "user-added-in-review";

export interface TimestampReference {
  sessionId: string;
  startMs: number;
  endMs?: number;
}

export interface Provenance {
  source: ProvenanceSource;
  timestampRefs: TimestampReference[];
  note?: string;
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AccessibilityTarget {
  role?: string;
  label?: string;
  identifier?: string;
  /** Never set for AXSecureTextField targets; canonical validation rejects it. */
  value?: string;
  appBundleId?: string;
  windowTitle?: string;
  bounds?: Rectangle;
}

/** Reserved browser detail populated by a future extension or imported workflows. */
export interface DomTarget {
  selector?: string;
  testId?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface ScreenshotCropReference {
  path: string;
  capturedAtMs?: number;
  bounds?: Rectangle;
}

/** Layered target: consumers can use DOM, AX, or semantic/visual identity. */
export interface WorkflowTarget {
  description: string;
  accessibility?: AccessibilityTarget;
  url?: string;
  dom?: DomTarget;
  screenshotCrop?: ScreenshotCropReference;
}

interface ActionBase {
  id: string;
}

export interface ClickAction extends ActionBase {
  type: "click";
  target: WorkflowTarget;
  button?: "left" | "right" | "middle";
  clickCount?: number;
}

export interface TypeAction extends ActionBase {
  type: "type";
  target: WorkflowTarget;
  value: WorkflowStringValue;
  clearFirst?: boolean;
  /** Secure fields must use a VaultReference; validators enforce this. */
  secure?: boolean;
}

export interface SelectAction extends ActionBase {
  type: "select";
  target: WorkflowTarget;
  value: WorkflowStringValue;
}

export interface NavigateAction extends ActionBase {
  type: "navigate";
  url: WorkflowStringValue;
}

export interface ScrollAction extends ActionBase {
  type: "scroll";
  direction: "up" | "down" | "left" | "right";
  distance?: number;
  target?: WorkflowTarget;
}

export interface DragAction extends ActionBase {
  type: "drag";
  from: WorkflowTarget;
  to: WorkflowTarget;
}

export interface KeyAction extends ActionBase {
  type: "key";
  /** Named control keys are allowed on secure targets; literal characters are not. */
  key: string;
  target?: WorkflowTarget;
}

export interface WaitAction extends ActionBase {
  type: "wait";
  durationMs?: number;
  until?: string;
}

export interface CustomAction extends ActionBase {
  type: "custom";
  description: string;
  target?: WorkflowTarget;
}

export type WorkflowAction =
  | ClickAction
  | TypeAction
  | SelectAction
  | NavigateAction
  | ScrollAction
  | DragAction
  | KeyAction
  | WaitAction
  | CustomAction;

export type ConfidenceLevel = "low" | "medium" | "high";

export interface DeterministicCondition {
  kind: "visible" | "hidden" | "text-equals" | "text-contains";
  target: WorkflowTarget;
  expected?: WorkflowStringValue;
}

/** Optional machine-readable realization of one plain-language `expects` entry. */
export interface ExpectationCheck extends DeterministicCondition {
  expectation: string;
}

export interface AskUserNode {
  kind: "ask_user";
  id: string;
  message: string;
  provenance: Provenance;
}

export interface StopAndFlagNode {
  kind: "stop_and_flag";
  id: string;
  reason: string;
  provenance: Provenance;
}

export interface WorkflowStep {
  kind: "step";
  id: string;
  intent: string;
  actions: WorkflowAction[];
  expects: string[];
  expectationChecks?: ExpectationCheck[];
  decisions?: DecisionNode[];
  provenance: Provenance;
}

export type BranchNode = WorkflowStep | AskUserNode | StopAndFlagNode;

export interface DecisionNode {
  id: string;
  condition: string;
  confidence: ConfidenceLevel;
  confidenceRationale?: string;
  deterministicCheck?: DeterministicCondition;
  then: BranchNode[];
  else: BranchNode[];
  provenance: Provenance;
}

export interface DraftApproval {
  status: "draft";
}

export interface ApprovedApproval {
  status: "approved";
  approvedAt: string;
  approvedBy: "user";
  contentHash?: string;
}

export type ApprovalState = DraftApproval | ApprovedApproval;

export interface WorkflowMetadata {
  workflowId: string;
  revision: number;
  previousRevision?: number;
  createdAt: string;
  updatedAt: string;
  approval: ApprovalState;
}

/** The format-neutral, persisted workflow contract. */
export interface Workflow {
  version: WorkflowVersion;
  metadata: WorkflowMetadata;
  name: string;
  goal: string;
  parameters: WorkflowParameter[];
  steps: WorkflowStep[];
}
