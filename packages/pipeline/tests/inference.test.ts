import { describe, expect, it } from "vitest";

import {
  condenseEvents,
  parseEventsJsonl,
  validateDecisionExtraction,
  validateStepSegmentation,
  type DecisionExtractionOutput,
  type StepSegmentationOutput,
  type TimestampedTranscript,
} from "../src/index.js";
import { fixtureJson, fixtureText } from "./fixture.js";

describe("grounded inference validation", () => {
  const actions = condenseEvents(
    parseEventsJsonl(fixtureText("recordings/invoice-match/events.jsonl")),
  );
  const segmentation = fixtureJson(
    "model-outputs/invoice-match.step-segmentation.v1.json",
  ) as StepSegmentationOutput;
  const decisions = fixtureJson(
    "model-outputs/invoice-match.decision-extraction.v1.json",
  ) as DecisionExtractionOutput;
  const transcript = fixtureJson(
    "recordings/invoice-match/transcript.json",
  ) as TimestampedTranscript;

  it("accepts the labeled invoice fixture", () => {
    const cache = fixtureJson("model-outputs/invoice-match.cache.json") as Record<
      string,
      unknown
    >;
    expect(cache["invoice-match-demo/step_segmentation/step-segmentation.v1"]).toEqual(
      segmentation,
    );
    expect(cache["invoice-match-demo/decision_extraction/decision-extraction.v1"]).toEqual(
      decisions,
    );
    expect(validateStepSegmentation(segmentation, actions)).toEqual({
      ok: true,
      value: segmentation,
      issues: [],
    });
    expect(validateDecisionExtraction(decisions, segmentation, transcript)).toEqual({
      ok: true,
      value: decisions,
      issues: [],
    });
  });

  it("rejects action ids the recording did not contain", () => {
    const invalid = structuredClone(segmentation);
    invalid.steps[0]?.actionIds.push("invented-action");

    const result = validateStepSegmentation(invalid, actions);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("Step 1 actionIds contains an unknown id.");
    }
  });

  it("rejects two supposedly recorded outcomes from one recording", () => {
    const invalid = structuredClone(decisions);
    const decision = invalid.decisions[0];
    if (decision !== undefined) {
      decision.else = { kind: "recorded_steps", stepIds: ["step-005"] };
    }

    const result = validateDecisionExtraction(invalid, segmentation, transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain("Decision 1 cannot claim that both diverging paths were recorded.");
    }
  });

  it("requires narration evidence before describing an untaken path", () => {
    const invalid = structuredClone(decisions);
    const decision = invalid.decisions[0];
    if (decision !== undefined) {
      decision.evidence = decision.evidence.filter((item) => item.kind !== "narration");
    }

    const result = validateDecisionExtraction(invalid, segmentation, transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain(
        "Decision 1 describes an untaken path without narration evidence.",
      );
    }
  });

  it("requires review questions for low-confidence decisions", () => {
    const invalid = structuredClone(decisions);
    const decision = invalid.decisions[0];
    if (decision !== undefined) {
      decision.confidence = "low";
    }

    const result = validateDecisionExtraction(invalid, segmentation, transcript);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain(
        "Low-confidence decision decision-001 must have a review question.",
      );
    }
  });

  it("rejects provenance timestamps outside the recording", () => {
    const invalidSteps = structuredClone(segmentation);
    const firstStep = invalidSteps.steps[0];
    if (firstStep !== undefined) {
      firstStep.timestampRefs = [{ startMs: 0, endMs: 99_000 }];
    }
    const stepResult = validateStepSegmentation(invalidSteps, actions, 7_000);
    expect(stepResult.ok).toBe(false);
    if (!stepResult.ok) {
      expect(stepResult.issues).toContain(
        "Step 1 timestampRefs contains a range outside the recording duration.",
      );
    }

    const invalidDecisions = structuredClone(decisions);
    const firstDecision = invalidDecisions.decisions[0];
    if (firstDecision !== undefined && firstDecision.evidence[0] !== undefined) {
      firstDecision.evidence[0].timestampMs = 99_000;
    }
    const decisionResult = validateDecisionExtraction(
      invalidDecisions,
      segmentation,
      transcript,
      7_000,
    );
    expect(decisionResult.ok).toBe(false);
    if (!decisionResult.ok) {
      expect(decisionResult.issues).toContain(
        "Decision 1 evidence 1 is outside the recording duration.",
      );
    }
  });

  it("will not let a protected action be mislabeled as a normal parameter", () => {
    const secureActions = condenseEvents(
      parseEventsJsonl(fixtureText("security/adversarial-secure-leak.jsonl")),
    );
    const invalid: StepSegmentationOutput = {
      name: "Sign in",
      goal: "Sign in",
      parameters: [
        {
          name: "password",
          type: "string",
          example: "[REDACTED]",
          description: "Password",
          actionIds: ["action-0002"],
        },
      ],
      steps: [
        {
          id: "step",
          intent: "Enter password",
          actionIds: secureActions.map((action) => action.id),
          expects: ["Signed in"],
          source: "recorded",
          timestampRefs: [{ startMs: 0, endMs: 150 }],
        },
      ],
    };

    const result = validateStepSegmentation(invalid, secureActions, 500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContain(
        "Parameter 1 references protected input and must use the secret type.",
      );
    }
  });

  it("grounds narrated steps in an overlapping transcript segment", () => {
    const narrated = structuredClone(segmentation);
    const narratedStep = narrated.steps[1];
    if (narratedStep !== undefined) {
      narratedStep.source = "narrated";
    }

    const missing = validateStepSegmentation(narrated, actions, 7_000);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.issues).toContain(
        "Step 2 has narrated provenance without matching transcript evidence.",
      );
    }

    expect(validateStepSegmentation(narrated, actions, 7_000, transcript).ok).toBe(true);
  });
});
