import type { CondensedAction } from "./condense.js";
import type { TimestampedTranscript } from "./transcript.js";

export type InferenceSource = "recorded" | "narrated";
export type InferenceConfidence = "high" | "medium" | "low";

export interface TimestampReference {
  startMs: number;
  endMs: number;
}

export type ParameterType = "string" | "number" | "boolean" | "date" | "enum" | "secret";

export interface InferredParameter {
  name: string;
  type: ParameterType;
  example: unknown;
  description: string;
  actionIds: string[];
}

export interface SegmentedStep {
  id: string;
  intent: string;
  actionIds: string[];
  expects: string[];
  source: InferenceSource;
  timestampRefs: TimestampReference[];
}

export interface StepSegmentationOutput {
  name: string;
  goal: string;
  parameters: InferredParameter[];
  steps: SegmentedStep[];
}

export type InferredDecisionPath =
  | { kind: "recorded_steps"; stepIds: string[] }
  | { kind: "narrated_steps"; description: string }
  | { kind: "ask_user"; prompt: string }
  | { kind: "stop_and_flag"; reason: string };

export interface DecisionEvidence {
  kind: "screen" | "narration" | "pause" | "action";
  description: string;
  timestampMs: number;
  transcriptSegmentIds: string[];
}

export interface InferredDecision {
  id: string;
  afterStepId: string;
  condition: string;
  confidence: InferenceConfidence;
  source: InferenceSource;
  evidence: DecisionEvidence[];
  then: InferredDecisionPath;
  else: InferredDecisionPath;
}

export interface DecisionQuestion {
  id: string;
  decisionId: string;
  prompt: string;
  timestampRefs: TimestampReference[];
}

export interface DecisionExtractionOutput {
  decisions: InferredDecision[];
  questions: DecisionQuestion[];
}

export type InferenceValidationResult<T> =
  | { ok: true; value: T; issues: [] }
  | { ok: false; issues: string[] };

export function validateStepSegmentation(
  value: unknown,
  actions: readonly CondensedAction[],
  recordingDurationMs?: number,
  transcript?: TimestampedTranscript,
): InferenceValidationResult<StepSegmentationOutput> {
  const issues: string[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: ["Segmentation output must be an object."] };
  }
  if (!isNonEmptyString(value.name)) {
    issues.push("Workflow name must be a non-empty string.");
  }
  if (!isNonEmptyString(value.goal)) {
    issues.push("Workflow goal must be a non-empty string.");
  }
  if (!Array.isArray(value.parameters)) {
    issues.push("Workflow parameters must be an array.");
  }
  if (!Array.isArray(value.steps)) {
    issues.push("Workflow steps must be an array.");
  }
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const actionIds = new Set(actions.map((action) => action.id));
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const actionOrder = new Map(actions.map((action, index) => [action.id, index]));
  const assignedActions = new Set<string>();
  const stepIds = new Set<string>();
  const parameterNames = new Set<string>();

  for (const [index, raw] of (value.parameters as unknown[]).entries()) {
    const prefix = `Parameter ${index + 1}`;
    if (!isRecord(raw)) {
      issues.push(`${prefix} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(raw.name) || parameterNames.has(raw.name)) {
      issues.push(`${prefix} must have a unique, non-empty name.`);
    } else {
      parameterNames.add(raw.name);
    }
    if (!PARAMETER_TYPES.has(raw.type as ParameterType)) {
      issues.push(`${prefix} has an unsupported type.`);
    }
    if (!isNonEmptyString(raw.description)) {
      issues.push(`${prefix} must have a description.`);
    }
    validateIdArray(raw.actionIds, actionIds, `${prefix} actionIds`, issues);
    if (raw.type === "secret" && !isVaultReference(raw.example)) {
      issues.push(`${prefix} must use a vault reference as its example.`);
    }
    if (raw.type !== "secret" && !isScalar(raw.example)) {
      issues.push(`${prefix} must use a scalar example.`);
    }
    if (
      Array.isArray(raw.actionIds) &&
      raw.actionIds.some(
        (id) => typeof id === "string" && isVaultReference(actionById.get(id)?.value),
      ) &&
      raw.type !== "secret"
    ) {
      issues.push(`${prefix} references protected input and must use the secret type.`);
    }
  }

  let lastStepFirstAction = -1;
  for (const [index, raw] of (value.steps as unknown[]).entries()) {
    const prefix = `Step ${index + 1}`;
    if (!isRecord(raw)) {
      issues.push(`${prefix} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(raw.id) || stepIds.has(raw.id)) {
      issues.push(`${prefix} must have a unique, non-empty id.`);
    } else {
      stepIds.add(raw.id);
    }
    if (!isNonEmptyString(raw.intent)) {
      issues.push(`${prefix} must have an intent.`);
    }
    if (
      !Array.isArray(raw.expects) ||
      raw.expects.length === 0 ||
      raw.expects.some((item) => !isNonEmptyString(item))
    ) {
      issues.push(`${prefix} expects must contain only non-empty strings.`);
    }
    if (raw.source !== "recorded" && raw.source !== "narrated") {
      issues.push(`${prefix} has an unsupported source.`);
    }
    validateTimestampReferences(
      raw.timestampRefs,
      `${prefix} timestampRefs`,
      issues,
      recordingDurationMs,
    );
    if (
      raw.source === "narrated" &&
      !hasNarrationForRanges(raw.timestampRefs, transcript)
    ) {
      issues.push(`${prefix} has narrated provenance without matching transcript evidence.`);
    }
    validateIdArray(raw.actionIds, actionIds, `${prefix} actionIds`, issues);
    if (Array.isArray(raw.actionIds)) {
      let previousAction = -1;
      for (const id of raw.actionIds) {
        if (typeof id !== "string") {
          continue;
        }
        if (assignedActions.has(id)) {
          issues.push(`${prefix} reuses action id ${id}.`);
        }
        assignedActions.add(id);
        const order = actionOrder.get(id);
        if (order !== undefined && order < previousAction) {
          issues.push(`${prefix} action ids are out of order.`);
        }
        if (order !== undefined) {
          previousAction = order;
        }
      }
      const firstId = raw.actionIds.find((id): id is string => typeof id === "string");
      const firstOrder = firstId === undefined ? undefined : actionOrder.get(firstId);
      if (firstOrder !== undefined && firstOrder < lastStepFirstAction) {
        issues.push(`${prefix} occurs before the preceding step.`);
      }
      if (firstOrder !== undefined) {
        lastStepFirstAction = firstOrder;
      }
    }
  }

  if ((value.steps as unknown[]).length === 0 && actions.length > 0) {
    issues.push("Segmentation must contain at least one step when actions exist.");
  }

  return issues.length === 0
    ? { ok: true, value: value as unknown as StepSegmentationOutput, issues: [] }
    : { ok: false, issues };
}

function hasNarrationForRanges(
  value: unknown,
  transcript: TimestampedTranscript | undefined,
): boolean {
  if (transcript === undefined || !Array.isArray(value)) {
    return false;
  }
  return value.some((range) => {
    if (
      !isRecord(range) ||
      !isFiniteNonNegativeNumber(range.startMs) ||
      !isFiniteNonNegativeNumber(range.endMs)
    ) {
      return false;
    }
    const startMs = range.startMs;
    const endMs = range.endMs;
    return transcript.segments.some(
      (segment) => segment.endMs >= startMs && segment.startMs <= endMs,
    );
  });
}

export function validateDecisionExtraction(
  value: unknown,
  segmentation: StepSegmentationOutput,
  transcript?: TimestampedTranscript,
  recordingDurationMs?: number,
): InferenceValidationResult<DecisionExtractionOutput> {
  const issues: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.decisions) || !Array.isArray(value.questions)) {
    return { ok: false, issues: ["Decision output must contain decisions and questions arrays."] };
  }
  const stepIds = new Set(segmentation.steps.map((step) => step.id));
  const transcriptIds = new Set(transcript?.segments.map((segment) => segment.id) ?? []);
  const stepOrder = new Map(segmentation.steps.map((step, index) => [step.id, index]));
  const decisionIds = new Set<string>();
  const lowConfidenceIds = new Set<string>();
  const recordedBranchStepIds = new Set<string>();

  for (const [index, raw] of value.decisions.entries()) {
    const prefix = `Decision ${index + 1}`;
    if (!isRecord(raw)) {
      issues.push(`${prefix} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(raw.id) || decisionIds.has(raw.id)) {
      issues.push(`${prefix} must have a unique, non-empty id.`);
    } else {
      decisionIds.add(raw.id);
    }
    if (!isNonEmptyString(raw.afterStepId) || !stepIds.has(raw.afterStepId)) {
      issues.push(`${prefix} must reference an existing attachment step.`);
    }
    if (!isNonEmptyString(raw.condition)) {
      issues.push(`${prefix} must have a screen-observable condition.`);
    }
    if (!CONFIDENCE_LEVELS.has(raw.confidence as InferenceConfidence)) {
      issues.push(`${prefix} has an unsupported confidence.`);
    } else if (raw.confidence === "low" && typeof raw.id === "string") {
      lowConfidenceIds.add(raw.id);
    }
    if (raw.source !== "recorded" && raw.source !== "narrated") {
      issues.push(`${prefix} has an unsupported source.`);
    }
    validateEvidence(raw.evidence, transcriptIds, prefix, issues, recordingDurationMs);
    validateDecisionPath(raw.then, stepIds, `${prefix} then path`, issues);
    validateDecisionPath(raw.else, stepIds, `${prefix} else path`, issues);
    const thenRecorded = isRecord(raw.then) && raw.then.kind === "recorded_steps";
    const elseRecorded = isRecord(raw.else) && raw.else.kind === "recorded_steps";
    if (thenRecorded && elseRecorded) {
      issues.push(`${prefix} cannot claim that both diverging paths were recorded.`);
    }
    if (!thenRecorded && !elseRecorded) {
      issues.push(`${prefix} must identify the path demonstrated by the recording.`);
    }
    const attachmentOrder =
      typeof raw.afterStepId === "string" ? stepOrder.get(raw.afterStepId) : undefined;
    validateRecordedPathPlacement(
      raw.then,
      attachmentOrder,
      stepOrder,
      recordedBranchStepIds,
      `${prefix} then path`,
      issues,
    );
    validateRecordedPathPlacement(
      raw.else,
      attachmentOrder,
      stepOrder,
      recordedBranchStepIds,
      `${prefix} else path`,
      issues,
    );
    const hasNarrationEvidence =
      Array.isArray(raw.evidence) && raw.evidence.some((item) => isRecord(item) && item.kind === "narration");
    if (raw.source === "narrated" && !hasNarrationEvidence) {
      issues.push(`${prefix} has narrated provenance without narration evidence.`);
    }
    if (
      (isRecord(raw.then) && raw.then.kind === "narrated_steps") ||
      (isRecord(raw.else) && raw.else.kind === "narrated_steps")
    ) {
      if (!hasNarrationEvidence) {
        issues.push(`${prefix} describes an untaken path without narration evidence.`);
      }
    }
  }

  const questionDecisionIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const [index, raw] of value.questions.entries()) {
    const prefix = `Question ${index + 1}`;
    if (!isRecord(raw)) {
      issues.push(`${prefix} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(raw.id) || questionIds.has(raw.id)) {
      issues.push(`${prefix} must have a unique, non-empty id.`);
    } else {
      questionIds.add(raw.id);
    }
    if (!isNonEmptyString(raw.decisionId) || !decisionIds.has(raw.decisionId)) {
      issues.push(`${prefix} must reference an existing decision.`);
    } else {
      questionDecisionIds.add(raw.decisionId);
    }
    if (!isNonEmptyString(raw.prompt)) {
      issues.push(`${prefix} must have a prompt.`);
    }
    validateTimestampReferences(
      raw.timestampRefs,
      `${prefix} timestampRefs`,
      issues,
      recordingDurationMs,
    );
  }
  for (const decisionId of lowConfidenceIds) {
    if (!questionDecisionIds.has(decisionId)) {
      issues.push(`Low-confidence decision ${decisionId} must have a review question.`);
    }
  }

  return issues.length === 0
    ? { ok: true, value: value as unknown as DecisionExtractionOutput, issues: [] }
    : { ok: false, issues };
}

function validateRecordedPathPlacement(
  value: unknown,
  attachmentOrder: number | undefined,
  stepOrder: ReadonlyMap<string, number>,
  usedStepIds: Set<string>,
  prefix: string,
  issues: string[],
): void {
  if (!isRecord(value) || value.kind !== "recorded_steps" || !Array.isArray(value.stepIds)) {
    return;
  }
  const orders: number[] = [];
  for (const id of value.stepIds) {
    if (typeof id !== "string") {
      continue;
    }
    const order = stepOrder.get(id);
    if (order !== undefined) {
      orders.push(order);
    }
    if (attachmentOrder !== undefined && order !== undefined && order <= attachmentOrder) {
      issues.push(`${prefix} must reference steps recorded after the decision point.`);
    }
    if (usedStepIds.has(id)) {
      issues.push(`${prefix} reuses a step already assigned to another recorded branch.`);
    }
    usedStepIds.add(id);
  }
  if (
    attachmentOrder !== undefined &&
    orders[0] !== undefined &&
    orders[0] !== attachmentOrder + 1
  ) {
    issues.push(`${prefix} must begin with the next recorded step after the decision point.`);
  }
  for (let index = 1; index < orders.length; index += 1) {
    const previous = orders[index - 1];
    const current = orders[index];
    if (previous !== undefined && current !== undefined && current !== previous + 1) {
      issues.push(`${prefix} recorded steps must be contiguous and ordered.`);
      break;
    }
  }
}

function validateDecisionPath(
  value: unknown,
  stepIds: ReadonlySet<string>,
  prefix: string,
  issues: string[],
): void {
  if (!isRecord(value) || !isNonEmptyString(value.kind)) {
    issues.push(`${prefix} must be an object with a supported kind.`);
    return;
  }
  switch (value.kind) {
    case "recorded_steps":
      validateIdArray(value.stepIds, stepIds, `${prefix} stepIds`, issues, true);
      return;
    case "narrated_steps":
      if (!isNonEmptyString(value.description)) {
        issues.push(`${prefix} must describe the narrated behavior.`);
      }
      return;
    case "ask_user":
      if (!isNonEmptyString(value.prompt)) {
        issues.push(`${prefix} must include a user prompt.`);
      }
      return;
    case "stop_and_flag":
      if (!isNonEmptyString(value.reason)) {
        issues.push(`${prefix} must include a reason.`);
      }
      return;
    default:
      issues.push(`${prefix} has an unsupported kind.`);
  }
}

function validateEvidence(
  value: unknown,
  transcriptIds: ReadonlySet<string>,
  prefix: string,
  issues: string[],
  recordingDurationMs: number | undefined,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${prefix} must include evidence.`);
    return;
  }
  for (const [index, item] of value.entries()) {
    const itemPrefix = `${prefix} evidence ${index + 1}`;
    if (!isRecord(item)) {
      issues.push(`${itemPrefix} must be an object.`);
      continue;
    }
    if (!EVIDENCE_KINDS.has(item.kind as DecisionEvidence["kind"])) {
      issues.push(`${itemPrefix} has an unsupported kind.`);
    }
    if (!isNonEmptyString(item.description)) {
      issues.push(`${itemPrefix} needs a description.`);
    }
    if (!isFiniteNonNegativeNumber(item.timestampMs)) {
      issues.push(`${itemPrefix} has an invalid timestamp.`);
    } else if (recordingDurationMs !== undefined && item.timestampMs > recordingDurationMs) {
      issues.push(`${itemPrefix} is outside the recording duration.`);
    }
    if (!Array.isArray(item.transcriptSegmentIds)) {
      issues.push(`${itemPrefix} transcriptSegmentIds must be an array.`);
    } else {
      for (const id of item.transcriptSegmentIds) {
        if (typeof id !== "string" || !transcriptIds.has(id)) {
          issues.push(`${itemPrefix} references an unknown transcript segment.`);
        }
      }
      if (item.kind === "narration" && item.transcriptSegmentIds.length === 0) {
        issues.push(`${itemPrefix} narration must reference a transcript segment.`);
      }
    }
  }
}

function validateTimestampReferences(
  value: unknown,
  prefix: string,
  issues: string[],
  recordingDurationMs?: number,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(`${prefix} must contain at least one timestamp range.`);
    return;
  }
  for (const range of value) {
    if (
      !isRecord(range) ||
      !isFiniteNonNegativeNumber(range.startMs) ||
      !isFiniteNonNegativeNumber(range.endMs) ||
      range.endMs < range.startMs
    ) {
      issues.push(`${prefix} contains an invalid timestamp range.`);
    } else if (recordingDurationMs !== undefined && range.endMs > recordingDurationMs) {
      issues.push(`${prefix} contains a range outside the recording duration.`);
    }
  }
}

function validateIdArray(
  value: unknown,
  knownIds: ReadonlySet<string>,
  prefix: string,
  issues: string[],
  requireNonEmpty = false,
): void {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    issues.push(`${prefix} must be ${requireNonEmpty ? "a non-empty" : "an"} array.`);
    return;
  }
  for (const id of value) {
    if (typeof id !== "string" || !knownIds.has(id)) {
      issues.push(`${prefix} contains an unknown id.`);
    }
  }
}

function isVaultReference(value: unknown): boolean {
  return isRecord(value) && isNonEmptyString(value.param) && value.vault === true;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const PARAMETER_TYPES = new Set<ParameterType>([
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "secret",
]);
const CONFIDENCE_LEVELS = new Set<InferenceConfidence>(["high", "medium", "low"]);
const EVIDENCE_KINDS = new Set<DecisionEvidence["kind"]>([
  "screen",
  "narration",
  "pause",
  "action",
]);
