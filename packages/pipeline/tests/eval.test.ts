import { describe, expect, it } from "vitest";

import {
  condenseEvents,
  evaluateInference,
  parseEventsJsonl,
  type DecisionExtractionOutput,
  type PipelineEvalLabels,
  type StepSegmentationOutput,
} from "../src/index.js";
import { fixtureJson, fixtureText } from "./fixture.js";

describe("fixture-based inference evaluation", () => {
  it("scores semantic agreement without requiring byte-identical model wording", () => {
    const actions = condenseEvents(
      parseEventsJsonl(fixtureText("recordings/invoice-match/events.jsonl")),
    );
    const segmentation = fixtureJson(
      "model-outputs/invoice-match.step-segmentation.v1.json",
    ) as StepSegmentationOutput;
    const decisions = fixtureJson(
      "model-outputs/invoice-match.decision-extraction.v1.json",
    ) as DecisionExtractionOutput;
    const labels = fixtureJson(
      "labels/invoice-match.workflow-eval.json",
    ) as PipelineEvalLabels;

    const result = evaluateInference(segmentation, decisions, actions, labels);

    expect(result.metrics.actionCoverage.score).toBe(1);
    expect(result.metrics.parameters.score).toBe(1);
    expect(result.metrics.groundedBranches.score).toBe(1);
    expect(result.overallScore).toBeGreaterThan(0.9);
    expect(result.warnings).toEqual([]);
  });

  it("reports low action coverage and review-dependent branches", () => {
    const labels: PipelineEvalLabels = {
      fixtureVersion: 1,
      sessionId: "evaluation",
      expectedGoalConcepts: [],
      expectedParameterNames: [],
      expectedStepIntents: [],
      expectedDecisionConditions: [],
      minimumActionCoverage: 1,
    };
    const result = evaluateInference(
      { name: "Draft", goal: "Draft", parameters: [], steps: [] },
      {
        decisions: [
          {
            id: "decision",
            afterStepId: "step",
            condition: "A value is visible",
            confidence: "low",
            source: "recorded",
            evidence: [],
            then: { kind: "ask_user", prompt: "What next?" },
            else: { kind: "stop_and_flag", reason: "Unknown" },
          },
        ],
        questions: [],
      },
      [
        {
          id: "action",
          kind: "click",
          description: "click",
          startMs: 0,
          endMs: 0,
          sourceEventIds: ["event"],
        },
      ],
      labels,
    );

    expect(result.metrics.actionCoverage.score).toBe(0);
    expect(result.metrics.groundedBranches.score).toBe(0);
    expect(result.warnings).toHaveLength(2);
  });
});
