import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@replay/ir";
import { CompilerService } from "./compiler-service.js";
import { SessionService } from "./session-service.js";
import type { SidecarClient } from "./sidecar-client.js";
import { WorkflowRepository, workflowContentHash } from "./workflow-repository.js";

function approvedWorkflow(): Workflow {
  const workflow: Workflow = {
    version: 1,
    metadata: { workflowId: "workflow-export", revision: 1, createdAt: "2026-08-17T10:00:00.000Z", updatedAt: "2026-08-17T10:00:00.000Z", approval: { status: "approved", approvedAt: "2026-08-17T10:00:00.000Z", approvedBy: "user" } },
    name: "Export me",
    goal: "Create a verifiable export",
    parameters: [],
    steps: [{ kind: "step", id: "step", intent: "Open the page", actions: [{ id: "navigate", type: "navigate", url: "http://127.0.0.1:4173" }], expects: ["Invoice review is visible"], provenance: { source: "recorded", timestampRefs: [{ sessionId: "session-export", startMs: 0 }] } }],
  };
  if (workflow.metadata.approval.status === "approved") workflow.metadata.approval.contentHash = workflowContentHash(workflow);
  return workflow;
}

describe("CompilerService", () => {
  it("writes a version-scoped playbook export", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-export-"));
    const workflows = new WorkflowRepository(root);
    await workflows.create(approvedWorkflow());
    const sessions = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
    const service = new CompilerService(workflows, sessions, root);
    const result = await service.compile({ workflowId: "workflow-export", target: "playbook" });
    expect(result.files).toContain("SKILL.md");
    expect(await readdir(result.outputDirectory)).toContain("SKILL.md");
  });

  it("bundles crops used by expectation and decision checks", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-export-crops-"));
    const workflow = approvedWorkflow();
    const step = workflow.steps[0]!;
    step.expectationChecks = [{
      expectation: step.expects[0]!,
      kind: "visible",
      target: { description: "Invoice review", screenshotCrop: { path: "crops/expectation.png", bounds: { x: 0, y: 0, width: 20, height: 20 } } },
    }];
    step.decisions = [{
      id: "decision",
      condition: "The totals match",
      deterministicCheck: { kind: "text-contains", target: { description: "Comparison", screenshotCrop: { path: "crops/decision.png", bounds: { x: 0, y: 0, width: 20, height: 20 } } }, expected: "match" },
      confidence: "high",
      then: [{ kind: "stop_and_flag", id: "then", reason: "Done", provenance: step.provenance }],
      else: [{ kind: "stop_and_flag", id: "else", reason: "Mismatch", provenance: step.provenance }],
      provenance: step.provenance,
    }];
    if (workflow.metadata.approval.status === "approved") workflow.metadata.approval.contentHash = workflowContentHash(workflow);
    const cropDirectory = join(root, "sessions", "session-export", "crops");
    await mkdir(cropDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(cropDirectory, "expectation.png"), "expectation image"),
      writeFile(join(cropDirectory, "decision.png"), "decision image"),
    ]);
    const workflows = new WorkflowRepository(root);
    await workflows.create(workflow);
    const sessions = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
    const result = await new CompilerService(workflows, sessions, root).compile({ workflowId: workflow.metadata.workflowId, target: "computer-use" });
    expect(result.warnings).toEqual([]);
    expect(result.files.filter((path) => path.includes("/assets/"))).toHaveLength(2);
  });
});
