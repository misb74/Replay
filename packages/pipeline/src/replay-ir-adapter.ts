import {
  validateWorkflow,
  type BranchNode,
  type DecisionNode,
  type InputReference,
  type ParameterType as IrParameterType,
  type Provenance,
  type Workflow,
  type WorkflowAction,
  type WorkflowParameter,
  type WorkflowStep,
  type WorkflowTarget,
  type WorkflowValue,
} from "@replay/ir";

import type { CondensedAction } from "./condense.js";
import type { ElementCropEvidence, SampledFrame } from "./frame-sampling.js";
import type { PipelineDraftEvidence, WorkflowIrAdapter } from "./ir-adapter.js";
import type {
  DecisionExtractionOutput,
  InferredDecision,
  InferredDecisionPath,
  InferredParameter,
  SegmentedStep,
} from "./inference.js";
import { isSecureTarget, type VaultParameterReference } from "./redaction.js";

export interface ReplayIrAdapterOptions {
  workflowId?: string | ((evidence: PipelineDraftEvidence) => string);
  now?: () => Date;
}

/** Ready-to-use bridge to the repository's canonical `@replay/ir` package. */
export function createReplayIrAdapter(
  options: ReplayIrAdapterOptions = {},
): WorkflowIrAdapter<Workflow> {
  return {
    assemble(evidence) {
      return assembleReplayWorkflow(evidence, options);
    },
    validate: validateWorkflow,
  };
}

export function assembleReplayWorkflow(
  evidence: PipelineDraftEvidence,
  options: ReplayIrAdapterOptions = {},
): Workflow {
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const workflowId =
    typeof options.workflowId === "function"
      ? options.workflowId(evidence)
      : options.workflowId ?? `workflow-${evidence.sessionId}`;
  const parameters = buildParameters(evidence);
  const parameterByAction = new Map<string, WorkflowParameter>();
  for (const parameter of parameters) {
    const inferred = evidence.segmentation.parameters.find(
      (item) => validParameterName(item.name, "input") === parameter.name,
    );
    for (const actionId of inferred?.actionIds ?? []) {
      parameterByAction.set(actionId, parameter);
    }
  }
  for (const action of evidence.actions) {
    if (isVaultReference(action.value)) {
      const secureName = validParameterName(action.value.param, "secret");
      const parameter = parameters.find((item) => item.name === secureName);
      if (parameter !== undefined) {
        parameterByAction.set(action.id, parameter);
      }
    }
  }

  const actionById = new Map(evidence.actions.map((action) => [action.id, action]));
  const cropEvidence = indexElementCrops(evidence.actions, evidence.frames ?? []);
  const stepById = new Map(evidence.segmentation.steps.map((step) => [step.id, step]));
  const decisionsByStep = groupDecisionsByStep(evidence.decisions);
  const nestedStepIds = new Set<string>();
  for (const decision of evidence.decisions.decisions) {
    collectRecordedStepIds(decision.then, nestedStepIds);
    collectRecordedStepIds(decision.else, nestedStepIds);
  }
  const building = new Set<string>();

  const buildStep = (segmented: SegmentedStep): WorkflowStep => {
    if (building.has(segmented.id)) {
      throw new Error("The inferred decision graph contains a step cycle.");
    }
    building.add(segmented.id);
    const decisions = decisionsByStep.get(segmented.id)?.map((decision) =>
      buildDecision(decision, evidence, stepById, buildStep),
    );
    const step: WorkflowStep = {
      kind: "step",
      id: segmented.id,
      intent: segmented.intent,
      actions: segmented.actionIds.flatMap((id) => {
        const action = actionById.get(id);
        return action === undefined ? [] : [toWorkflowAction(action, parameterByAction.get(id), cropEvidence.get(action.id))];
      }),
      expects: segmented.expects,
      ...(decisions === undefined || decisions.length === 0 ? {} : { decisions }),
      provenance: provenanceForStep(evidence.sessionId, segmented),
    };
    building.delete(segmented.id);
    return step;
  };

  const steps = evidence.segmentation.steps
    .filter((step) => !nestedStepIds.has(step.id))
    .map(buildStep);
  if (steps.length === 0 && evidence.segmentation.steps.length > 0) {
    throw new Error("Every inferred step was placed inside a branch; no workflow entry step remains.");
  }

  return {
    version: 1,
    metadata: {
      workflowId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      approval: { status: "draft" },
    },
    name: evidence.segmentation.name,
    goal: evidence.segmentation.goal,
    parameters,
    steps,
  };
}

function buildParameters(evidence: PipelineDraftEvidence): WorkflowParameter[] {
  const result = evidence.segmentation.parameters.map(toWorkflowParameter);
  const names = new Set(result.map((parameter) => parameter.name));
  for (const action of evidence.actions) {
    if (!isVaultReference(action.value)) {
      continue;
    }
    const name = validParameterName(action.value.param, "secret");
    if (names.has(name)) {
      continue;
    }
    names.add(name);
    result.push({
      name,
      type: "secret",
      description: `Protected value entered into ${action.target?.label ?? "a secure field"}.`,
      required: true,
      example: { param: name, vault: true },
    });
  }
  return result;
}

function toWorkflowParameter(parameter: InferredParameter): WorkflowParameter {
  const name = validParameterName(parameter.name, "input");
  const type: IrParameterType = parameter.type === "enum" ? "string" : parameter.type;
  return {
    name,
    type,
    description: parameter.description,
    required: true,
    example:
      type === "secret"
        ? { param: name, vault: true }
        : scalarExample(parameter.example),
  };
}

function scalarExample(value: unknown): WorkflowValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as string | number | boolean | null;
  }
  return JSON.stringify(value) ?? "";
}

function groupDecisionsByStep(
  output: DecisionExtractionOutput,
): Map<string, InferredDecision[]> {
  const grouped = new Map<string, InferredDecision[]>();
  for (const decision of output.decisions) {
    const existing = grouped.get(decision.afterStepId) ?? [];
    existing.push(decision);
    grouped.set(decision.afterStepId, existing);
  }
  return grouped;
}

function buildDecision(
  decision: InferredDecision,
  evidence: PipelineDraftEvidence,
  stepById: ReadonlyMap<string, SegmentedStep>,
  buildStep: (step: SegmentedStep) => WorkflowStep,
): DecisionNode {
  const question = evidence.decisions.questions.find((item) => item.decisionId === decision.id);
  return {
    id: decision.id,
    condition: decision.condition,
    confidence: decision.confidence,
    ...(question === undefined ? {} : { confidenceRationale: question.prompt }),
    then: buildDecisionPath(decision.then, "then", decision, evidence.sessionId, stepById, buildStep),
    else: buildDecisionPath(decision.else, "else", decision, evidence.sessionId, stepById, buildStep),
    provenance: provenanceForDecision(evidence.sessionId, decision),
  };
}

function buildDecisionPath(
  path: InferredDecisionPath,
  side: "then" | "else",
  decision: InferredDecision,
  sessionId: string,
  stepById: ReadonlyMap<string, SegmentedStep>,
  buildStep: (step: SegmentedStep) => WorkflowStep,
): BranchNode[] {
  const provenance = provenanceForDecision(sessionId, decision);
  switch (path.kind) {
    case "recorded_steps":
      return path.stepIds.map((id) => {
        const step = stepById.get(id);
        if (step === undefined) {
          throw new Error("A recorded decision path references a missing step.");
        }
        return buildStep(step);
      });
    case "narrated_steps": {
      const id = `${decision.id}-${side}-narrated`;
      return [
        {
          kind: "step",
          id,
          intent: path.description,
          actions: [
            {
              id: `${id}-action`,
              type: "custom",
              description: path.description,
            },
          ],
          expects: [`The screen confirms: ${path.description}`],
          provenance: { ...provenance, source: "narrated" },
        },
      ];
    }
    case "ask_user":
      return [
        {
          kind: "ask_user",
          id: `${decision.id}-${side}-ask-user`,
          message: path.prompt,
          provenance,
        },
      ];
    case "stop_and_flag":
      return [
        {
          kind: "stop_and_flag",
          id: `${decision.id}-${side}-stop`,
          reason: path.reason,
          provenance,
        },
      ];
  }
}

function toWorkflowAction(
  action: CondensedAction,
  parameter: WorkflowParameter | undefined,
  crops: Readonly<Partial<Record<ElementCropRegion, IndexedElementCrop>>> | undefined,
): WorkflowAction {
  const target = toWorkflowTarget(action, crops?.target);
  const parameterReference: InputReference | undefined =
    parameter === undefined
      ? undefined
      : parameter.type === "secret"
        ? { param: parameter.name, vault: true }
        : { param: parameter.name, vault: false };
  switch (action.kind) {
    case "click": {
      const button = toMouseButton(action.button);
      return {
        id: action.id,
        type: "click",
        target,
        ...(button === undefined ? {} : { button }),
        ...(action.clickCount === undefined ? {} : { clickCount: Math.max(1, Math.round(action.clickCount)) }),
      };
    }
    case "type": {
      const secure = isSecureTarget(action.target) || isVaultReference(action.value);
      const value = secure
        ? (parameterReference ?? (isVaultReference(action.value) ? action.value : undefined) ?? {
            param: validParameterName(action.target?.label ?? "secret", "secret"),
            vault: true,
          })
        : parameterReference ?? (typeof action.value === "string" ? action.value : "");
      return { id: action.id, type: "type", target, value, ...(secure ? { secure: true } : {}) };
    }
    case "select":
      return {
        id: action.id,
        type: "select",
        target,
        value: parameterReference ?? (typeof action.value === "string" ? action.value : ""),
      };
    case "navigate":
      return {
        id: action.id,
        type: "navigate",
        url: parameterReference ?? action.url ?? action.target?.url ?? "about:blank",
      };
    case "scroll": {
      const x = action.scrollDelta?.x ?? 0;
      const y = action.scrollDelta?.y ?? 0;
      const direction =
        Math.abs(y) >= Math.abs(x) ? (y >= 0 ? "up" : "down") : x >= 0 ? "left" : "right";
      const distance = Math.hypot(x, y);
      return {
        id: action.id,
        type: "scroll",
        direction,
        ...(distance > 0 ? { distance } : {}),
        ...(action.target === undefined ? {} : { target }),
      };
    }
    case "drag": {
      const start = action.drag?.start;
      const end = action.drag?.end;
      const fromTarget = toWorkflowTarget(action, crops?.from ?? crops?.target);
      const toTarget = toWorkflowTarget(action, crops?.to ?? crops?.target);
      return {
        id: action.id,
        type: "drag",
        from: {
          ...fromTarget,
          description: `Start of ${action.description}`,
          ...(start ? { accessibility: { ...fromTarget.accessibility, bounds: { x: start.x, y: start.y, width: 1, height: 1 } } } : {}),
        },
        to: {
          ...toTarget,
          description: `End of ${action.description}`,
          ...(end ? { accessibility: { ...toTarget.accessibility, bounds: { x: end.x, y: end.y, width: 1, height: 1 } } } : {}),
        },
      };
    }
    case "key_press":
      return {
        id: action.id,
        type: "key",
        key: [...(action.modifiers ?? []), action.key ?? "Unknown"].join("+"),
        ...(action.target === undefined ? {} : { target }),
      };
    case "app_switch":
    case "window_switch":
      return {
        id: action.id,
        type: "custom",
        description: action.description,
        ...(action.target === undefined ? {} : { target }),
      };
  }
}

function toWorkflowTarget(action: CondensedAction, crop?: IndexedElementCrop): WorkflowTarget {
  const target = action.target;
  const dom = action.dom;
  const cropBounds = crop?.bounds ?? target?.bounds;
  const screenshotCrop = crop === undefined || isSecureTarget(target)
    ? undefined
    : {
        path: crop.path,
        capturedAtMs: crop.capturedAtMs,
        ...(cropBounds === undefined ? {} : { bounds: cropBounds }),
      };
  const workflowDom =
    dom === undefined
      ? undefined
      : {
          ...(dom.selector === undefined ? {} : { selector: dom.selector }),
          ...(dom.testId === undefined ? {} : { testId: dom.testId }),
          ...(dom.text === undefined ? {} : { text: dom.text }),
          ...(dom.attributes === undefined ? {} : { attributes: dom.attributes }),
        };
  if (target === undefined) {
    return {
      description: action.description,
      ...(workflowDom === undefined || Object.keys(workflowDom).length === 0
        ? {}
        : { dom: workflowDom }),
      ...(screenshotCrop === undefined ? {} : { screenshotCrop }),
    };
  }
  const accessibility = {
    ...(target.role === undefined && target.subrole === undefined
      ? {}
      : { role: isSecureTarget(target) ? target.subrole ?? target.role : target.role ?? target.subrole }),
    ...(target.label === undefined ? {} : { label: target.label }),
    ...(target.identifier === undefined ? {} : { identifier: target.identifier }),
    ...(target.value === undefined || isSecureTarget(target) ? {} : { value: target.value }),
    ...(target.bundleId === undefined ? {} : { appBundleId: target.bundleId }),
    ...(target.windowTitle === undefined ? {} : { windowTitle: target.windowTitle }),
    ...(target.bounds === undefined ? {} : { bounds: target.bounds }),
  };
  return {
    description: target.label ?? action.description,
    ...(Object.keys(accessibility).length === 0 ? {} : { accessibility }),
    ...(target.url === undefined ? {} : { url: target.url }),
    ...(workflowDom === undefined || Object.keys(workflowDom).length === 0
      ? {}
      : { dom: workflowDom }),
    ...(screenshotCrop === undefined ? {} : { screenshotCrop }),
  };
}

type ElementCropRegion = "target" | "from" | "to";

interface IndexedElementCrop extends ElementCropEvidence {
  capturedAtMs: number;
}

function indexElementCrops(
  actions: readonly CondensedAction[],
  frames: readonly SampledFrame[],
): Map<string, Partial<Record<ElementCropRegion, IndexedElementCrop>>> {
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const result = new Map<string, Partial<Record<ElementCropRegion, IndexedElementCrop>>>();
  for (const frame of frames) {
    for (const crop of frame.elementCrops ?? []) {
      const action = actionById.get(crop.actionId);
      if (action === undefined) continue;
      const region = crop.region ?? "target";
      const indexed: IndexedElementCrop = { ...crop, capturedAtMs: frame.timestampMs };
      const existing = result.get(crop.actionId) ?? {};
      const previous = existing[region];
      if (previous === undefined || isBetterCrop(indexed, previous, action.startMs)) {
        existing[region] = indexed;
        result.set(crop.actionId, existing);
      }
    }
  }
  return result;
}

function isBetterCrop(candidate: IndexedElementCrop, previous: IndexedElementCrop, actionTimestampMs: number): boolean {
  const candidateDistance = Math.abs(candidate.capturedAtMs - actionTimestampMs);
  const previousDistance = Math.abs(previous.capturedAtMs - actionTimestampMs);
  return candidateDistance < previousDistance ||
    (candidateDistance === previousDistance && (
      candidate.capturedAtMs < previous.capturedAtMs ||
      (candidate.capturedAtMs === previous.capturedAtMs && candidate.path.localeCompare(previous.path) < 0)
    ));
}

function provenanceForStep(sessionId: string, step: SegmentedStep): Provenance {
  return {
    source: step.source,
    timestampRefs: step.timestampRefs.map((range) => ({ sessionId, ...range })),
  };
}

function provenanceForDecision(sessionId: string, decision: InferredDecision): Provenance {
  return {
    source: decision.source,
    timestampRefs: decision.evidence.map((item) => ({
      sessionId,
      startMs: item.timestampMs,
      endMs: item.timestampMs,
    })),
  };
}

function collectRecordedStepIds(path: InferredDecisionPath, destination: Set<string>): void {
  if (path.kind === "recorded_steps") {
    for (const id of path.stepIds) {
      destination.add(id);
    }
  }
}

function validParameterName(value: string, fallback: string): string {
  const normalized = value
    .normalize("NFKD")
    .replaceAll(/[^A-Za-z0-9_-]+/gu, "_")
    .replaceAll(/^[^A-Za-z]+/gu, "")
    .replaceAll(/_+$/gu, "");
  return normalized.length > 0 ? normalized : fallback;
}

function isVaultReference(value: unknown): value is VaultParameterReference {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { vault?: unknown }).vault === true &&
    typeof (value as { param?: unknown }).param === "string"
  );
}

function toMouseButton(value: string | undefined): "left" | "right" | "middle" | undefined {
  if (value === "other") {
    return "middle";
  }
  return value === "left" || value === "right" || value === "middle" ? value : undefined;
}
