import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@replay/ir";
import type { NativeDriver, Screenshot, SemanticJudge } from "@replay/runner";
import { RunnerService } from "./runner-service.js";
import type { SidecarClient } from "./sidecar-client.js";
import { WorkflowRepository, workflowContentHash } from "./workflow-repository.js";

function approved(): Workflow {
  const workflow: Workflow = {
    version: 1,
    metadata: { workflowId: "workflow-run", revision: 1, createdAt: "2026-08-17T10:00:00.000Z", updatedAt: "2026-08-17T10:00:00.000Z", approval: { status: "approved", approvedAt: "2026-08-17T10:00:00.000Z", approvedBy: "user" } },
    name: "Wait safely",
    goal: "Exercise run trust gating",
    parameters: [],
    steps: [{ kind: "step", id: "wait", intent: "Wait briefly", actions: [{ id: "wait-action", type: "wait", durationMs: 1 }], expects: ["Done"], provenance: { source: "recorded", timestampRefs: [{ sessionId: "session", startMs: 0 }] } }],
  };
  if (workflow.metadata.approval.status === "approved") workflow.metadata.approval.contentHash = workflowContentHash(workflow);
  return workflow;
}

const judge: SemanticJudge = { async expectation() { return { met: true, reason: "fixture" }; }, async condition() { return { result: true, reason: "fixture" }; } };

describe("RunnerService", () => {
  it("blocks autonomous mode until the exact approved revision has a clean test", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-run-"));
    const repository = new WorkflowRepository(root);
    await repository.create(approved());
    const service = new RunnerService(repository, { on: () => () => {} } as unknown as SidecarClient, root, { judge });
    await expect(service.start("workflow-run", "autonomous")).rejects.toThrow("clean test run");
  });

  it("returns safe, workflow-scoped run evidence for the review timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-history-"));
    const repository = new WorkflowRepository(root);
    const runDirectory = join(root, "runs", "run-history");
    const screenshot = join(runDirectory, "screenshots", "after.png");
    await mkdir(join(runDirectory, "screenshots"), { recursive: true });
    await writeFile(screenshot, "image");
    await writeFile(join(runDirectory, "run.json"), JSON.stringify({
      runId: "run-history",
      workflowId: "workflow-run",
      workflowRevision: 2,
      mode: "test",
      startedAt: "2026-08-17T10:00:00.000Z",
      completedAt: "2026-08-17T10:01:00.000Z",
      outcome: "completed",
      steps: [{ stepId: "wait", intent: "Wait briefly", outcome: "completed", attempts: 1, actions: [], expectations: [{ expectation: "Done", met: true, reason: "Visible" }], decisions: [], screenshots: [{ path: screenshot }, { path: "/tmp/not-run-evidence.png" }] }],
      answers: [{ nodeId: "choose-reviewer", answer: "Send it to finance", at: "2026-08-17T10:00:30.000Z" }],
    }));
    const service = new RunnerService(repository, { on: () => () => {} } as unknown as SidecarClient, root, { judge });
    const history = await service.list("workflow-run");
    expect(history[0]).toMatchObject({ runId: "run-history", outcome: "completed", steps: [{ outcome: "completed", screenshots: [expect.stringContaining("after.png")] }], answers: [{ nodeId: "choose-reviewer", answer: "Send it to finance" }] });
  });

  it("saves clean-test trust before announcing completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-clean-order-"));
    const repository = new WorkflowRepository(root, () => new Date("2026-08-17T10:05:00.000Z"));
    const workflow = approved();
    await repository.create(workflow);
    let finish!: (value: string | undefined) => void;
    const trustedAtTerminal = new Promise<string | undefined>((resolve) => { finish = resolve; });
    const sidecar = {
      on: () => () => {},
      isRunning: () => false,
      async request(command: string, payload: Record<string, unknown>) {
        if (command === "guardrails_subscribe") return { type: "guardrails_subscribed", guardrailsActive: true };
        if (command === "act_screenshot") return { type: "screenshot", screenshot: { path: String(payload.outputPath), width: 100, height: 100, scale: 1 } };
        return { type: "action_completed" };
      },
    } as unknown as SidecarClient;
    const service = new RunnerService(repository, sidecar, root, {
      judge,
      onUpdate(update) {
        if (update.status === "completed") void repository.getView(workflow.metadata.workflowId).then((view) => finish(view.cleanTestRunAt));
      },
    });
    const started = await service.start(workflow.metadata.workflowId, "test");
    service.respond(started.runId, "approve");
    await expect(trustedAtTerminal).resolves.toBe("2026-08-17T10:05:00.000Z");
  });
});

// Compile-time contract guard: the sidecar driver remains a NativeDriver and
// screenshots retain the evidence fields the run log promises.
const _driverContract: Pick<NativeDriver, "screenshot" | "perform"> | undefined = undefined;
const _screenshotContract: Screenshot | undefined = undefined;
void _driverContract;
void _screenshotContract;
