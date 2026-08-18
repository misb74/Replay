import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@replay/ir";
import { assembleReplayWorkflow, type PipelineDraftEvidence } from "@replay/pipeline";
import { editWorkflow } from "../renderer/workflow-state.js";
import { applyViewEdits, workflowToView } from "./workflow-mapper.js";

const evidence: PipelineDraftEvidence = {
  sessionId: "session-1",
  actions: [
    { id: "a1", kind: "click", description: "clicked Invoice", startMs: 100, endMs: 100, sourceEventIds: ["e1"], target: { role: "AXButton", label: "Invoice" } },
    { id: "a2", kind: "type", description: "entered password", startMs: 200, endMs: 250, sourceEventIds: ["e2"], target: { role: "AXSecureTextField", label: "Password", isSecure: true }, value: { param: "password", vault: true } },
    { id: "a3", kind: "click", description: "clicked Approve", startMs: 500, endMs: 500, sourceEventIds: ["e3"], target: { role: "AXButton", label: "Approve" } },
  ],
  framePlan: { version: 1, durationMs: 600, frames: [] },
  segmentation: {
    name: "Review invoice",
    goal: "Compare an invoice with its purchase order",
    parameters: [{ name: "password", type: "secret", example: { param: "password", vault: true }, description: "Ledger password", actionIds: ["a2"] }],
    steps: [
      { id: "open", intent: "Open invoice", actionIds: ["a1", "a2"], expects: ["Invoice is open"], source: "recorded", timestampRefs: [{ startMs: 100, endMs: 300 }] },
      { id: "approve", intent: "Approve matching invoice", actionIds: ["a3"], expects: ["Invoice is approved"], source: "recorded", timestampRefs: [{ startMs: 500, endMs: 600 }] },
    ],
  },
  decisions: {
    decisions: [{
      id: "matches",
      afterStepId: "open",
      condition: "Invoice and PO totals match",
      confidence: "high",
      source: "narrated",
      evidence: [{ kind: "narration", description: "User described the match rule", timestampMs: 350, transcriptSegmentIds: ["t1"] }],
      then: { kind: "recorded_steps", stepIds: ["approve"] },
      else: { kind: "stop_and_flag", reason: "The totals differ" },
    }],
    questions: [],
  },
};

describe("pipeline to workflow mapping", () => {
  it("assembles valid IR without exposing secure input", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    expect(validateWorkflow(workflow)).toMatchObject({ ok: true });
    expect(workflow.steps).toHaveLength(1);
    expect(workflow.steps[0]?.decisions?.[0]?.then[0]).toMatchObject({ id: "approve" });
    expect(JSON.stringify(workflow)).not.toContain("secret-value");
    expect(workflow.parameters[0]?.example).toEqual({ param: "password", vault: true });
  });

  it("round-trips review edits while retaining branch structure", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    const view = workflowToView(workflow);
    view.steps[0]!.intent = "Open the selected invoice";
    view.steps[0]!.decisions[0]!.condition = "The two displayed totals are equal";
    const edited = applyViewEdits(workflow, view, new Date("2026-08-17T10:05:00.000Z"));
    expect(edited.metadata).toMatchObject({ revision: 2, previousRevision: 1, approval: { status: "draft" } });
    expect(edited.steps[0]).toMatchObject({
      intent: "Open the selected invoice",
      provenance: { source: "user-added-in-review" },
      decisions: [{ condition: "The two displayed totals are equal", provenance: { source: "user-added-in-review" }, then: [{ id: "approve" }] }],
    });
    expect(validateWorkflow(edited)).toMatchObject({ ok: true });
  });

  it("shows and preserves every decision attached to a step", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    const first = workflow.steps[0]!;
    const existing = first.decisions![0]!;
    first.decisions = [existing, {
      ...structuredClone(existing),
      id: "requires-manager",
      condition: "The invoice needs manager review",
      then: [{ kind: "stop_and_flag", id: "manager-then", reason: "Send to a manager", provenance: existing.provenance }],
      else: [{ kind: "stop_and_flag", id: "manager-else", reason: "No manager review", provenance: existing.provenance }],
    }];
    let view = workflowToView(workflow);
    expect(view.steps[0]?.decisions.map((decision) => decision.id)).toEqual(["matches", "requires-manager"]);
    view = editWorkflow(view, { type: "decision_condition", stepId: "open", decisionId: "requires-manager", condition: "The invoice exceeds the manager threshold" });
    const edited = applyViewEdits(workflow, view, new Date("2026-08-17T10:05:00.000Z"));
    expect(edited.steps[0]?.decisions?.map((decision) => decision.condition)).toEqual([
      "Invoice and PO totals match",
      "The invoice exceeds the manager threshold",
    ]);
    expect(validateWorkflow(edited)).toMatchObject({ ok: true });
  });

  it("round-trips split steps and renamed secure inputs through valid IR", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    let view = workflowToView(workflow);
    view = editWorkflow(view, { type: "split_step", stepId: "open", afterActionId: "a1" });
    view = editWorkflow(view, { type: "rename_parameter", parameterId: "password", name: "ledger_password" });
    const edited = applyViewEdits(workflow, view, new Date("2026-08-17T10:05:00.000Z"));
    expect(validateWorkflow(edited)).toMatchObject({ ok: true });
    expect(edited.steps.map((step) => step.actions.map((action) => action.id))).toEqual([["a1"], ["a2"]]);
    expect(edited.steps[1]?.actions[0]).toMatchObject({ type: "type", value: { param: "ledger_password", vault: true } });
    expect(edited.steps[1]?.decisions?.[0]?.then[0]).toMatchObject({ id: "approve" });
  });

  it("persists a reviewed unseen path as an explicit runtime question", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    let view = workflowToView(workflow);
    view = editWorkflow(view, { type: "decision_path", stepId: "open", decisionId: "matches", side: "else", kind: "ask_user", summary: "Choose how to handle the mismatch" });
    const edited = applyViewEdits(workflow, view, new Date("2026-08-17T10:05:00.000Z"));
    expect(validateWorkflow(edited)).toMatchObject({ ok: true });
    expect(edited.steps[0]?.decisions?.[0]?.else[0]).toMatchObject({ kind: "ask_user", message: "Choose how to handle the mismatch", provenance: { source: "user-added-in-review" } });
  });

  it("promotes a recorded typed value to a parameter without losing its action", () => {
    const workflow = assembleReplayWorkflow(evidence, { now: () => new Date("2026-08-17T10:00:00.000Z") });
    workflow.steps[0]!.actions.push({ id: "a4", type: "type", target: { description: "Comment" }, value: "Reviewed" });
    let view = workflowToView(workflow);
    view = editWorkflow(view, { type: "promote_action_value", stepId: "open", actionId: "a4", name: "review_note" });
    const edited = applyViewEdits(workflow, view, new Date("2026-08-17T10:05:00.000Z"));
    expect(validateWorkflow(edited)).toMatchObject({ ok: true });
    expect(edited.parameters).toContainEqual(expect.objectContaining({ name: "review_note", example: "Reviewed" }));
    expect(edited.steps[0]?.actions.find((action) => action.id === "a4")).toMatchObject({ value: { param: "review_note", vault: false } });
  });
});
