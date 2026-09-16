import { describe, expect, it } from "vitest";
import { PIPELINE_PROMPTS } from "../src/prompts.js";

describe("transcript speakers", () => {
  it("tells both stages what a speaker field means", () => {
    for (const prompt of Object.values(PIPELINE_PROMPTS)) {
      expect(prompt.instructions).toContain('"speaker":"assistant"');
      expect(prompt.instructions).toContain("Replay's live tutor");
    }
  });

  it("keeps the prompt ids stable so cached fixtures still resolve", () => {
    expect(PIPELINE_PROMPTS.stepSegmentation.id).toBe("step-segmentation.v1");
    expect(PIPELINE_PROMPTS.decisionExtraction.id).toBe("decision-extraction.v1");
  });
});
