import { describe, expect, it } from "vitest";

import { compileComputerUse } from "../src/index.js";
import { approvedWorkflow } from "./fixture.js";
import { golden, textOutput } from "./helpers.js";

describe("computer-use compiler", () => {
  it("matches the reviewed prompt and policy goldens", () => {
    const result = compileComputerUse(approvedWorkflow(), {
      assets: {
        "sessions/demo/crops/approve.png": new Uint8Array([137, 80, 78, 71]),
      },
    });

    expect(textOutput(result, "review-invoice/system-prompt.md")).toBe(
      golden("invoice.system-prompt.md"),
    );
    expect(textOutput(result, "review-invoice/run-policy.json")).toBe(
      golden("invoice.run-policy.json"),
    );
    expect(textOutput(result, "review-invoice/manifest.json")).toBe(
      golden("invoice.manifest.json"),
    );
  });

  it("copies screenshot crops and rewrites only the bundled workflow", () => {
    const source = approvedWorkflow();
    const result = compileComputerUse(source, {
      assets: {
        "sessions/demo/crops/approve.png": new Uint8Array([137, 80, 78, 71]),
      },
    });
    const bundled = JSON.parse(
      textOutput(result, "review-invoice/workflow.json"),
    ) as WorkflowShape;
    const binary = result.files.find((file) => file.path.endsWith("approve.png"));

    expect(
      bundled.steps[0]?.decisions?.[0]?.then[0]?.actions?.[0]?.target?.screenshotCrop?.path,
    ).toBe("assets/sessions%2Fdemo%2Fcrops%2Fapprove.png");
    expect(
      source.steps[0]!.decisions![0]!.then[0]!.kind === "step" &&
        source.steps[0]!.decisions![0]!.then[0]!.actions[0]!.type === "click"
        ? source.steps[0]!.decisions![0]!.then[0]!.actions[0]!.target.screenshotCrop?.path
        : undefined,
    ).toBe("sessions/demo/crops/approve.png");
    expect(binary?.content).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("bundles crops used only by deterministic expectation checks", () => {
    const workflow = approvedWorkflow();
    workflow.steps[0]!.expectationChecks = [
      {
        expectation: workflow.steps[0]!.expects[0]!,
        kind: "visible",
        target: {
          description: "Invoice details",
          url: "http://127.0.0.1:4173",
          screenshotCrop: { path: "sessions/demo/crops/invoice-details.png" },
        },
      },
    ];
    const result = compileComputerUse(workflow, {
      assets: {
        "sessions/demo/crops/approve.png": new Uint8Array([1]),
        "sessions/demo/crops/invoice-details.png": new Uint8Array([2]),
      },
    });
    const bundled = JSON.parse(
      textOutput(result, "review-invoice/workflow.json"),
    ) as WorkflowShape;

    expect(result.files.some((file) => file.path.endsWith("invoice-details.png"))).toBe(true);
    expect(bundled.steps[0]?.expectationChecks?.[0]?.target?.screenshotCrop?.path).toBe(
      "assets/sessions%2Fdemo%2Fcrops%2Finvoice-details.png",
    );
  });

  it("warns instead of pretending a missing crop is bundled", () => {
    const result = compileComputerUse(approvedWorkflow());

    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "missing-screenshot-asset",
        assetPath: "sessions/demo/crops/approve.png",
      }),
    );
  });

  it("derives explicit stop and retry policy without allowing the first test run to be disabled", () => {
    const result = compileComputerUse(approvedWorkflow(), {
      policy: { maxRetriesPerStep: 0, firstRunRequiresTest: false },
    });
    const policy = JSON.parse(
      textOutput(result, "review-invoice/run-policy.json"),
    ) as Record<string, unknown>;

    expect(policy).toMatchObject({
      maxRetriesPerStep: 0,
      firstRunRequiresTest: true,
      onExpectationFailure: "pause",
      stopAndFlagNodeIds: ["flag"],
    });
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "first-test-run-enforced",
        message: expect.stringContaining("cannot be disabled"),
      }),
    );
  });

  it("rejects invalid retry limits", () => {
    expect(() =>
      compileComputerUse(approvedWorkflow(), { policy: { maxRetriesPerStep: -1 } }),
    ).toThrow(RangeError);
  });
});

interface WorkflowShape {
  steps: Array<{
    expectationChecks?: Array<{
      target?: { screenshotCrop?: { path?: string } };
    }>;
    decisions?: Array<{
      then: Array<{
        actions?: Array<{
          target?: { screenshotCrop?: { path?: string } };
        }>;
      }>;
    }>;
  }>;
}
