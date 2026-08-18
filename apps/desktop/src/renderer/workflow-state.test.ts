import { describe, expect, it } from "vitest";
import { createDemoWorkflow } from "./mock-api.js";
import { editWorkflow, isWorkflowReviewValid } from "./workflow-state.js";

describe("workflow editing", () => {
  it("turns an approved workflow back into a draft on edit", () => {
    const workflow = { ...createDemoWorkflow(), status: "approved" as const, approvedAt: "2026-08-17T10:00:00Z" };
    const edited = editWorkflow(workflow, { type: "rename", name: "Updated" });
    expect(edited.status).toBe("draft");
    expect(edited.approvedAt).toBeUndefined();
  });

  it("reorders steps without losing any", () => {
    const workflow = createDemoWorkflow();
    const ids = workflow.steps.map((step) => step.id);
    const edited = editWorkflow(workflow, { type: "move_step", stepId: ids[0]!, direction: 1 });
    expect(edited.steps.map((step) => step.id)).toEqual([ids[1], ids[0], ...ids.slice(2)]);
  });

  it("attributes human step and target edits to review", () => {
    const workflow = createDemoWorkflow();
    const stepId = workflow.steps[0]!.id;
    const intent = editWorkflow(workflow, { type: "step_intent", stepId, intent: "Open the selected invoice" });
    expect(intent.steps[0]?.source).toBe("user-added-in-review");
    const target = editWorkflow(workflow, { type: "action_target", stepId, actionId: workflow.steps[0]!.actions[0]!.id, target: "Selected invoice row" });
    expect(target.steps[0]?.source).toBe("user-added-in-review");
  });

  it("attributes decision corrections to review", () => {
    const workflow = createDemoWorkflow();
    const decisionStep = workflow.steps.find((step) => step.decisions.length > 0)!;
    const decisionId = decisionStep.decisions[0]!.id;
    const edited = editWorkflow(workflow, { type: "decision_condition", stepId: decisionStep.id, decisionId, condition: "The two totals are equal" });
    expect(edited.steps.find((step) => step.id === decisionStep.id)?.decisions[0]).toMatchObject({
      condition: "The two totals are equal",
      source: "user-added-in-review",
    });
  });

  it("splits and merges action groups without losing recorded actions", () => {
    const workflow = createDemoWorkflow();
    const first = workflow.steps[0]!;
    first.actions.push({ id: "a-open-2", kind: "click", description: "Opened details", target: "Details", timestampMs: 5_000 });
    const split = editWorkflow(workflow, { type: "split_step", stepId: first.id, afterActionId: first.actions[0]!.id });
    expect(split.steps.slice(0, 2).flatMap((step) => step.actions).map((action) => action.id)).toEqual(["a-open", "a-open-2"]);
    const merged = editWorkflow(split, { type: "merge_next", stepId: first.id });
    expect(merged.steps[0]?.actions.map((action) => action.id)).toEqual(["a-open", "a-open-2"]);
    expect(merged.steps[0]?.source).toBe("user-added-in-review");
  });

  it("promotes a typed value to a reusable parameter", () => {
    const workflow = createDemoWorkflow();
    workflow.steps[0]!.actions[0] = { id: "typed", kind: "type", description: "Typed customer", target: "Customer", value: "Northstar", timestampMs: 4_000 };
    const edited = editWorkflow(workflow, { type: "promote_action_value", stepId: workflow.steps[0]!.id, actionId: "typed", name: "customer" });
    expect(edited.parameters.at(-1)).toMatchObject({ name: "customer", example: "Northstar", confirmed: true });
    expect(edited.steps[0]?.actions[0]?.parameter).toBe("customer");
  });

  it("answers or removes a low-confidence decision in one edit", () => {
    const workflow = createDemoWorkflow();
    workflow.steps[1]!.decisions[0]!.confidence = "low";
    const decisionId = workflow.steps[1]!.decisions[0]!.id;
    const confirmed = editWorkflow(workflow, { type: "confirm_decision", stepId: workflow.steps[1]!.id, decisionId });
    expect(confirmed.steps[1]?.decisions[0]).toMatchObject({ confidence: "high", source: "user-added-in-review" });
    const removed = editWorkflow(workflow, { type: "remove_decision", stepId: workflow.steps[1]!.id, decisionId });
    expect(removed.steps[1]?.decisions).toHaveLength(0);
    expect(removed.steps[1]?.removedDecisionIds).toContain("decision-match");
  });

  it("cannot be approved while any decision question remains unresolved", () => {
    const workflow = createDemoWorkflow();
    workflow.steps[1]!.decisions[0]!.confidence = "low";
    expect(isWorkflowReviewValid(workflow)).toBe(false);
    const decisionId = workflow.steps[1]!.decisions[0]!.id;
    const confirmed = editWorkflow(workflow, { type: "confirm_decision", stepId: workflow.steps[1]!.id, decisionId });
    expect(isWorkflowReviewValid(confirmed)).toBe(true);
  });

  it("turns a test-run correction into an untrusted reviewed draft", () => {
    const workflow = { ...createDemoWorkflow(), status: "approved" as const, approvedAt: "2026-08-17T10:00:00.000Z", cleanTestRunAt: "2026-08-17T10:02:00.000Z" };
    const stepId = workflow.steps[0]!.id;
    let corrected = editWorkflow(workflow, { type: "step_intent", stepId, intent: "Open the invoice selected for this run" });
    corrected = editWorkflow(corrected, { type: "step_expects", stepId, expects: "The selected invoice details are visible" });
    expect(corrected.status).toBe("draft");
    expect(corrected.steps[0]).toMatchObject({ source: "user-added-in-review", intent: "Open the invoice selected for this run", expects: "The selected invoice details are visible" });
    expect(corrected.approvedAt).toBeUndefined();
    expect(corrected.cleanTestRunAt).toBeUndefined();
  });
});
