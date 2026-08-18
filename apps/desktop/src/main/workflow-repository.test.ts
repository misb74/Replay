import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Workflow } from "@replay/ir";
import { WorkflowRepository, workflowContentHash } from "./workflow-repository.js";

function draft(): Workflow {
  return {
    version: 1,
    metadata: { workflowId: "workflow-safe", revision: 1, createdAt: "2026-08-17T10:00:00.000Z", updatedAt: "2026-08-17T10:00:00.000Z", approval: { status: "draft" } },
    name: "Safe workflow",
    goal: "Exercise versioned persistence",
    parameters: [],
    steps: [{ kind: "step", id: "step-1", intent: "Do the work", actions: [{ id: "action-1", type: "click", target: { description: "Continue" } }], expects: ["Work is complete"], provenance: { source: "recorded", timestampRefs: [{ sessionId: "session-1", startMs: 10, endMs: 20 }] } }],
  };
}

describe("WorkflowRepository", () => {
  it("retains every revision and never mutates the approved file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-workflows-"));
    const times = [new Date("2026-08-17T10:01:00.000Z"), new Date("2026-08-17T10:02:00.000Z")];
    const repository = new WorkflowRepository(directory, () => times.shift()!);
    const initial = await repository.create(draft());
    initial.name = "Edited safely";
    const edited = await repository.saveView(initial);
    const approved = await repository.approve(edited.id);
    expect(approved).toMatchObject({ revision: 3, status: "approved", name: "Edited safely" });
    const versions = await readdir(join(directory, "workflows", draft().metadata.workflowId));
    expect(versions.filter((name) => name.startsWith("workflow.v"))).toEqual(["workflow.v0001.json", "workflow.v0002.json", "workflow.v0003.json"]);
    const original = JSON.parse(await readFile(join(directory, "workflows", draft().metadata.workflowId, "workflow.v0001.json"), "utf8")) as Workflow;
    expect(original.name).toBe("Safe workflow");
  });

  it("unlocks autonomy only for the exact revision that passed a test run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-trust-"));
    const repository = new WorkflowRepository(directory, () => new Date("2026-08-17T10:05:00.000Z"));
    const created = await repository.create(draft());
    const approved = await repository.approve(created.id);
    const trusted = await repository.markCleanTestRun(approved.id, approved.revision);
    expect(trusted.cleanTestRunAt).toBe("2026-08-17T10:05:00.000Z");
    const snapshot = await repository.getRunSnapshot(approved.id);
    expect(snapshot.workflow.metadata.revision).toBe(snapshot.view.revision);
    expect(snapshot.view.cleanTestRunAt).toBe("2026-08-17T10:05:00.000Z");
    trusted.name = "New revision";
    const edited = await repository.saveView(trusted);
    expect(edited.cleanTestRunAt).toBeUndefined();
  });

  it("rejects path traversal ids", async () => {
    const repository = new WorkflowRepository(await mkdtemp(join(tmpdir(), "replay-path-")));
    await expect(repository.get("../../outside")).rejects.toThrow("Invalid workflow id");
  });

  it("hashes content independently from metadata timestamps", () => {
    const first = draft();
    const second = { ...first, metadata: { ...first.metadata, updatedAt: "2026-08-17T11:00:00.000Z" } };
    expect(workflowContentHash(first)).toBe(workflowContentHash(second));
  });

  it("refuses a stale review instead of overwriting a newer revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-stale-"));
    const repository = new WorkflowRepository(directory, () => new Date("2026-08-17T10:05:00.000Z"));
    const stale = await repository.create(draft());
    const firstEdit = structuredClone(stale);
    firstEdit.name = "Saved first";
    await repository.saveView(firstEdit);
    stale.name = "Would overwrite";
    await expect(repository.saveView(stale)).rejects.toThrow("changed after the review screen was opened");
  });

  it("detects changes made to approved workflow content on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tamper-"));
    const repository = new WorkflowRepository(directory, () => new Date("2026-08-17T10:05:00.000Z"));
    const created = await repository.create(draft());
    const approved = await repository.approve(created.id);
    const path = join(directory, "workflows", approved.id, "workflow.json");
    const stored = JSON.parse(await readFile(path, "utf8")) as Workflow;
    stored.goal = "Changed after approval";
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(stored)));
    await expect(repository.get(approved.id)).rejects.toThrow("no longer matches its approval stamp");
  });

  it("downgrades an unstamped approved document to a draft for review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-missing-stamp-"));
    const repository = new WorkflowRepository(directory);
    const workflow = draft();
    workflow.metadata.approval = { status: "approved", approvedAt: "2026-08-17T10:00:00.000Z", approvedBy: "user" };
    await repository.create(workflow);
    await expect(repository.get(workflow.metadata.workflowId)).resolves.toMatchObject({ metadata: { approval: { status: "draft" } } });
  });

  it("cannot approve while a low-confidence decision is unanswered", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-open-question-"));
    const repository = new WorkflowRepository(directory);
    const workflow = draft();
    const provenance = workflow.steps[0]!.provenance;
    workflow.steps[0]!.decisions = [{
      id: "uncertain",
      condition: "The amount needs review",
      confidence: "low",
      confidenceRationale: "The recording did not show enough evidence to confirm this branch",
      then: [{ kind: "stop_and_flag", id: "uncertain-then", reason: "Review it", provenance }],
      else: [{ kind: "stop_and_flag", id: "uncertain-else", reason: "Continue", provenance }],
      provenance,
    }];
    await repository.create(workflow);
    await expect(repository.approve(workflow.metadata.workflowId)).rejects.toThrow("low-confidence decision");
  });
});
