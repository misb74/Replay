import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workflow, WorkflowAction } from "@replay/ir";
import {
  FixtureModelAdapter,
  UnderstandingPipeline,
  createReplayIrAdapter,
  type FrameProvider,
  type TimestampedTranscript,
} from "@replay/pipeline";
import { WorkflowRunner, type ActionReceipt, type NativeDriver, type Screenshot, type SemanticJudge } from "@replay/runner";
import { describe, expect, it } from "vitest";

const fixtures = fileURLToPath(new URL("../../../../packages/fixtures/", import.meta.url));
const frames: FrameProvider = {
  async sample({ plan }) {
    return plan.frames.map((frame) => ({ id: frame.id, timestampMs: frame.timestampMs, mimeType: "image/png", dataBase64: "AA==" }));
  },
};

class InvoiceScreen implements NativeDriver {
  state: "reviewing" | "approved" | "flagged" = "reviewing";
  readonly actions: string[] = [];

  async screenshot(label: string): Promise<Screenshot> {
    return { id: label, path: `/tmp/replay-${label}.png`, capturedAt: "2026-08-17T10:00:00.000Z" };
  }

  async perform({ action }: { action: WorkflowAction }): Promise<ActionReceipt> {
    this.actions.push(action.id);
    if (action.id === "action-0004") this.state = "approved";
    if (action.type === "custom" && /flag difference/iu.test(action.description)) this.state = "flagged";
    return { actionId: action.id, method: action.type === "custom" ? "vision" : "accessibility" };
  }
}

describe("north-star screen-to-workflow spine", () => {
  it.each([
    [true, "approved"],
    [false, "flagged"],
  ] as const)("builds, approves, and runs the invoice workflow through the %s branch", async (matches, expectedState) => {
    const workflow = await buildApprovedInvoiceWorkflow();
    const screen = new InvoiceScreen();
    const judge: SemanticJudge = {
      async condition() { return { result: matches, reason: matches ? "The totals visibly match" : "The totals visibly differ" }; },
      async expectation({ expectation }) {
        const met = /shows approved/iu.test(expectation)
          ? screen.state === "approved"
          : /needs attention/iu.test(expectation)
            ? screen.state === "flagged"
            : true;
        return { met, reason: met ? "Expected screen state is visible" : "Expected screen state is missing" };
      },
    };
    const log = await new WorkflowRunner().start({
      workflow,
      driver: screen,
      judge,
      options: { mode: "autonomous", parameters: { invoice_id: matches ? "INV-1048" : "INV-1049" } },
    }).result;

    expect(log.outcome).toBe("completed");
    expect(screen.state).toBe(expectedState);
    expect(log.steps.flatMap((step) => step.decisions)).toContainEqual(expect.objectContaining({ decisionId: "decision-001", result: matches }));
    expect(screen.actions).toContain(matches ? "action-0004" : "decision-001-else-narrated-action");
    expect(screen.actions).not.toContain(matches ? "decision-001-else-narrated-action" : "action-0004");
  });
});

async function buildApprovedInvoiceWorkflow(): Promise<Workflow> {
  const cache = JSON.parse(readFileSync(join(fixtures, "model-outputs/invoice-match.cache.json"), "utf8")) as Record<string, unknown>;
  const transcript = JSON.parse(readFileSync(join(fixtures, "recordings/invoice-match/transcript.json"), "utf8")) as TimestampedTranscript;
  const pipeline = new UnderstandingPipeline({
    model: new FixtureModelAdapter(cache),
    frameProvider: frames,
    ir: createReplayIrAdapter({ workflowId: "workflow-invoice-e2e", now: () => new Date("2026-08-17T10:00:00.000Z") }),
  });
  const result = await pipeline.run({
    sessionId: "invoice-match-demo",
    eventsJsonl: readFileSync(join(fixtures, "recordings/invoice-match/events.jsonl"), "utf8"),
    video: { path: "fixture-video.mp4", durationMs: 7_000 },
    narration: { transcript },
  });
  return {
    ...result.workflow,
    metadata: {
      ...result.workflow.metadata,
      revision: 2,
      previousRevision: 1,
      updatedAt: "2026-08-17T10:01:00.000Z",
      approval: { status: "approved", approvedAt: "2026-08-17T10:01:00.000Z", approvedBy: "user" },
    },
  };
}
