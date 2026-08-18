import {
  assertApprovedWorkflow,
  parseWorkflow,
  type BranchNode,
  type DecisionNode,
  type Provenance,
  type Workflow,
  type WorkflowAction,
  type WorkflowStep,
  type WorkflowTarget,
  type WorkflowValue,
} from "@replay/ir";

import type { CompileWarning, GeneratedTextFile } from "./types.js";

export function prepareWorkflow(candidate: Workflow): Workflow {
  const workflow = parseWorkflow(candidate);
  assertApprovedWorkflow(workflow);
  return workflow;
}

export function textFile(path: string, mediaType: string, content: string): GeneratedTextFile {
  return { path, mediaType, content };
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "replay-workflow";
}

export function isReference(value: WorkflowValue): value is Exclude<WorkflowValue, string | number | boolean | null> {
  return typeof value === "object" && value !== null && "param" in value;
}

export function printableValue(value: WorkflowValue): string {
  if (isReference(value)) {
    return value.vault ? `<vault:${value.param}>` : `{{${value.param}}}`;
  }
  if (value === null) return "null";
  return String(value);
}

export function quoteMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatTimestamp(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const millis = Math.floor(milliseconds % 1_000);
  return `${String(minutes)}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function formatProvenance(provenance: Provenance): string {
  const timestamps = provenance.timestampRefs
    .map((reference) => {
      const end = reference.endMs === undefined ? "" : `–${formatTimestamp(reference.endMs)}`;
      return `${reference.sessionId}@${formatTimestamp(reference.startMs)}${end}`;
    })
    .join(", ");
  const pieces: string[] = [provenance.source];
  if (timestamps.length > 0) pieces.push(timestamps);
  if (provenance.note !== undefined) pieces.push(provenance.note);
  return pieces.join("; ");
}

export function describeTarget(target: WorkflowTarget): string {
  const context = [
    target.accessibility?.appBundleId,
    target.accessibility?.windowTitle,
    target.url,
  ].filter((part): part is string => part !== undefined);
  return context.length === 0
    ? target.description
    : `${target.description} (${context.join(" · ")})`;
}

export function describeAction(action: WorkflowAction): string {
  switch (action.type) {
    case "click":
      return `Click ${describeTarget(action.target)}`;
    case "type":
      return `Type ${printableValue(action.value)} into ${describeTarget(action.target)}`;
    case "select":
      return `Select ${printableValue(action.value)} in ${describeTarget(action.target)}`;
    case "navigate":
      return `Navigate to ${printableValue(action.url)}`;
    case "scroll":
      return `Scroll ${action.direction}${action.target === undefined ? "" : ` in ${describeTarget(action.target)}`}`;
    case "drag":
      return `Drag ${describeTarget(action.from)} to ${describeTarget(action.to)}`;
    case "key":
      return `Press ${action.key}${action.target === undefined ? "" : ` in ${describeTarget(action.target)}`}`;
    case "wait":
      if (action.durationMs !== undefined) return `Wait ${String(action.durationMs)} ms`;
      return `Wait until ${action.until ?? "the screen is ready"}`;
    case "custom":
      return action.description;
  }
}

export interface WalkContext {
  stepId?: string;
  branch?: "then" | "else";
  decisionId?: string;
}

export function walkWorkflow(
  workflow: Workflow,
  visitors: {
    step?: (step: WorkflowStep, context: WalkContext) => void;
    decision?: (decision: DecisionNode, context: WalkContext) => void;
    branchNode?: (node: BranchNode, context: WalkContext) => void;
  },
): void {
  const visitStep = (step: WorkflowStep, context: WalkContext): void => {
    visitors.step?.(step, context);
    step.decisions?.forEach((decision) => {
      visitors.decision?.(decision, { ...context, stepId: step.id });
      const visitPath = (nodes: BranchNode[], branch: "then" | "else"): void => {
        nodes.forEach((node) => {
          const nextContext: WalkContext = { stepId: step.id, decisionId: decision.id, branch };
          visitors.branchNode?.(node, nextContext);
          if (node.kind === "step") visitStep(node, nextContext);
        });
      };
      visitPath(decision.then, "then");
      visitPath(decision.else, "else");
    });
  };

  workflow.steps.forEach((step) => {
    visitStep(step, {});
  });
}

export function warningReport(
  workflow: Workflow,
  target: string,
  warnings: CompileWarning[],
  fallback?: Record<string, string>,
): Record<string, unknown> {
  return {
    target,
    workflowId: workflow.metadata.workflowId,
    workflowRevision: workflow.metadata.revision,
    ...(fallback === undefined ? {} : { fallback }),
    degradedItems: warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      ...(warning.stepId === undefined ? {} : { stepId: warning.stepId }),
      ...(warning.actionId === undefined ? {} : { actionId: warning.actionId }),
      ...(warning.decisionId === undefined ? {} : { decisionId: warning.decisionId }),
      ...(warning.assetPath === undefined ? {} : { assetPath: warning.assetPath }),
    })),
  };
}
