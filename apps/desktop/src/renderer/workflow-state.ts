import type { StepView, WorkflowView } from "../shared/contracts.js";

export type WorkflowEdit =
  | { type: "rename"; name: string }
  | { type: "goal"; goal: string }
  | { type: "step_intent"; stepId: string; intent: string }
  | { type: "step_expects"; stepId: string; expects: string }
  | { type: "move_step"; stepId: string; direction: -1 | 1 }
  | { type: "merge_next"; stepId: string }
  | { type: "split_step"; stepId: string; afterActionId?: string }
  | { type: "delete_step"; stepId: string }
  | { type: "action_target"; stepId: string; actionId: string; target: string }
  | { type: "promote_action_value"; stepId: string; actionId: string; name: string }
  | { type: "decision_condition"; stepId: string; decisionId: string; condition: string }
  | { type: "decision_path"; stepId: string; decisionId: string; side: "then" | "else"; kind: "steps" | "ask_user" | "stop_and_flag"; summary: string }
  | { type: "confirm_decision"; stepId: string; decisionId: string }
  | { type: "remove_decision"; stepId: string; decisionId: string }
  | { type: "confirm_parameter"; parameterId: string; confirmed: boolean }
  | { type: "rename_parameter"; parameterId: string; name: string };

export function editWorkflow(workflow: WorkflowView, edit: WorkflowEdit): WorkflowView {
  const draft = markDraft(workflow);
  switch (edit.type) {
    case "rename":
      return { ...draft, name: edit.name };
    case "goal":
      return { ...draft, goal: edit.goal };
    case "step_intent":
      return updateStep(draft, edit.stepId, (step) => ({ ...step, intent: edit.intent, source: "user-added-in-review" }));
    case "step_expects":
      return updateStep(draft, edit.stepId, (step) => ({ ...step, expects: edit.expects, source: "user-added-in-review" }));
    case "action_target":
      return updateStep(draft, edit.stepId, (step) => ({
        ...step,
        source: "user-added-in-review",
        actions: step.actions.map((action) => action.id === edit.actionId ? { ...action, target: edit.target } : action),
      }));
    case "promote_action_value": {
      const name = uniqueParameterName(draft, edit.name);
      const step = draft.steps.find((candidate) => candidate.id === edit.stepId);
      const action = step?.actions.find((candidate) => candidate.id === edit.actionId);
      if (!action || action.value === undefined || action.parameter) return draft;
      return {
        ...updateStep(draft, edit.stepId, (candidate) => ({
          ...candidate,
          source: "user-added-in-review",
          actions: candidate.actions.map((item) => item.id === edit.actionId ? { ...item, parameter: name } : item),
        })),
        parameters: [...draft.parameters, {
          id: `review-${edit.actionId}`,
          name,
          type: "string",
          example: action.value,
          description: `Value used by ${action.description}`,
          confirmed: true,
          vault: false,
        }],
      };
    }
    case "decision_condition":
      return updateDecision(draft, edit.stepId, edit.decisionId, (decision) => ({ ...decision, condition: edit.condition, source: "user-added-in-review" }));
    case "decision_path":
      return updateDecision(draft, edit.stepId, edit.decisionId, (decision) => ({ ...decision, [edit.side]: { kind: edit.kind, summary: edit.summary }, source: "user-added-in-review" }));
    case "confirm_decision":
      return updateDecision(draft, edit.stepId, edit.decisionId, (decision) => ({ ...decision, confidence: "high", source: "user-added-in-review" }));
    case "remove_decision":
      return updateStep(draft, edit.stepId, (step) => {
        if (!step.decisions.some((decision) => decision.id === edit.decisionId)) return step;
        const removedDecisionIds = [...new Set([...(step.removedDecisionIds ?? []), edit.decisionId])];
        return { ...step, decisions: step.decisions.filter((decision) => decision.id !== edit.decisionId), removedDecisionIds };
      });
    case "delete_step":
      return { ...draft, steps: draft.steps.filter((step) => step.id !== edit.stepId) };
    case "confirm_parameter":
      return {
        ...draft,
        parameters: draft.parameters.map((parameter) => parameter.id === edit.parameterId
          ? { ...parameter, confirmed: edit.confirmed }
          : parameter),
      };
    case "rename_parameter":
      {
        const current = draft.parameters.find((parameter) => parameter.id === edit.parameterId);
        const steps = current ? draft.steps.map((step) => ({
          ...step,
          actions: step.actions.map((action) => action.parameter === current.name ? { ...action, parameter: edit.name } : action),
        })) : draft.steps;
      return {
        ...draft,
        steps,
        parameters: draft.parameters.map((parameter) => parameter.id === edit.parameterId
          ? { ...parameter, name: edit.name }
          : parameter),
      };
      }
    case "merge_next": {
      const index = draft.steps.findIndex((step) => step.id === edit.stepId);
      const current = draft.steps[index];
      const next = draft.steps[index + 1];
      if (!current || !next || current.decisions.length > 0 || next.decisions.length > 0) return draft;
      const merged: StepView = {
        ...current,
        intent: `${current.intent}; ${lowercaseFirst(next.intent)}`,
        expects: [...new Set([...expectationLines(current.expects), ...expectationLines(next.expects)])].join("\n"),
        source: "user-added-in-review",
        time: { startMs: Math.min(current.time.startMs, next.time.startMs), endMs: Math.max(current.time.endMs, next.time.endMs) },
        actions: [...current.actions, ...next.actions],
      };
      return { ...draft, steps: [...draft.steps.slice(0, index), merged, ...draft.steps.slice(index + 2)] };
    }
    case "split_step": {
      const index = draft.steps.findIndex((step) => step.id === edit.stepId);
      const current = draft.steps[index];
      if (!current || current.actions.length < 2) return draft;
      const requested = edit.afterActionId
        ? current.actions.findIndex((action) => action.id === edit.afterActionId) + 1
        : Math.ceil(current.actions.length / 2);
      const splitAt = Math.min(Math.max(requested, 1), current.actions.length - 1);
      const midpoint = Math.round((current.time.startMs + current.time.endMs) / 2);
      const secondId = uniqueStepId(draft, `${current.id}-split`);
      const removedDecisionIds = current.decisions.length > 0
        ? [...new Set([...(current.removedDecisionIds ?? []), ...current.decisions.map((decision) => decision.id)])]
        : current.removedDecisionIds;
      const first: StepView = {
        ...current,
        intent: `${current.intent} — first part`,
        expects: `The first part of ${lowercaseFirst(current.intent)} is complete`,
        source: "user-added-in-review",
        time: { startMs: current.time.startMs, endMs: midpoint },
        actions: current.actions.slice(0, splitAt),
        decisions: [],
        ...(removedDecisionIds ? { removedDecisionIds } : {}),
      };
      const second: StepView = {
        ...current,
        id: secondId,
        intent: `${current.intent} — second part`,
        source: "user-added-in-review",
        time: { startMs: midpoint, endMs: current.time.endMs },
        actions: current.actions.slice(splitAt),
      };
      return { ...draft, steps: [...draft.steps.slice(0, index), first, second, ...draft.steps.slice(index + 1)] };
    }
    case "move_step": {
      const from = draft.steps.findIndex((step) => step.id === edit.stepId);
      if (from < 0) return draft;
      const to = from + edit.direction;
      if (to < 0 || to >= draft.steps.length) return draft;
      const steps = [...draft.steps];
      const [step] = steps.splice(from, 1);
      if (!step) return draft;
      steps.splice(to, 0, step);
      return { ...draft, steps };
    }
  }
}

export function isWorkflowReviewValid(workflow: WorkflowView): boolean {
  return Boolean(
    workflow.name.trim()
    && workflow.goal.trim()
    && workflow.steps.length > 0
    && workflow.steps.every((step) => step.intent.trim()
      && step.expects.split("\n").some((item) => item.trim())
      && step.decisions.every((decision) => decision.confidence !== "low"
        && decision.condition.trim()
        && decision.then.summary.trim()
        && decision.else.summary.trim()))
    && workflow.parameters.filter((parameter) => parameter.confirmed)
      .every((parameter) => /^[A-Za-z][A-Za-z0-9_-]*$/u.test(parameter.name)),
  );
}

function expectationLines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function lowercaseFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : "the step";
}

function uniqueStepId(workflow: WorkflowView, base: string): string {
  const ids = new Set(workflow.steps.map((step) => step.id));
  let candidate = base;
  for (let suffix = 2; ids.has(candidate); suffix += 1) candidate = `${base}-${suffix}`;
  return candidate;
}

function uniqueParameterName(workflow: WorkflowView, requested: string): string {
  const base = requested.trim().replace(/[^A-Za-z0-9_-]/gu, "_").replace(/^[^A-Za-z]+/u, "") || "input";
  const names = new Set(workflow.parameters.map((parameter) => parameter.name));
  let candidate = base;
  for (let suffix = 2; names.has(candidate); suffix += 1) candidate = `${base}_${suffix}`;
  return candidate;
}

function markDraft(workflow: WorkflowView): WorkflowView {
  if (workflow.status === "draft") return workflow;
  const { approvedAt: _approvedAt, cleanTestRunAt: _cleanTestRunAt, ...withoutApproval } = workflow;
  return { ...withoutApproval, status: "draft" };
}

function updateStep(workflow: WorkflowView, id: string, update: (step: StepView) => StepView): WorkflowView {
  return { ...workflow, steps: workflow.steps.map((step) => step.id === id ? update(step) : step) };
}

function updateDecision(workflow: WorkflowView, stepId: string, decisionId: string, update: (decision: StepView["decisions"][number]) => StepView["decisions"][number]): WorkflowView {
  return updateStep(workflow, stepId, (step) => ({
    ...step,
    decisions: step.decisions.map((decision) => decision.id === decisionId ? update(decision) : decision),
  }));
}
