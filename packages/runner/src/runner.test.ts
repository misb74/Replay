import { describe, expect, it } from "vitest";
import type { BranchNode, Workflow, WorkflowAction, WorkflowStep, WorkflowTarget } from "@replay/ir";
import { WorkflowRunner } from "./runner.js";
import type { ActionReceipt, NativeDriver, RunnerEvent, Screenshot, SemanticJudge } from "./types.js";

const provenance = { source: "recorded" as const, timestampRefs: [{ sessionId: "session-1", startMs: 100 }] };

function step(id: string, actions: WorkflowAction[] = [{ id: `action-${id}`, type: "click", target: { description: `${id} button` } }]): WorkflowStep {
  return { kind: "step", id, intent: `Complete ${id}`, actions, expects: [`${id} is complete`], provenance };
}

function workflow(steps: WorkflowStep[] = [step("one")], approval: "approved" | "draft" = "approved"): Workflow {
  return {
    version: 1,
    metadata: {
      workflowId: "workflow-1",
      revision: 3,
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      approval: approval === "approved"
        ? { status: "approved", approvedAt: "2026-08-17T00:00:00.000Z", approvedBy: "user" }
        : { status: "draft" },
    },
    name: "Test workflow",
    goal: "Exercise the runner safely",
    parameters: [],
    steps,
  };
}

class FakeDriver implements NativeDriver {
  readonly performed: WorkflowAction[] = [];
  readonly screenshots: Screenshot[] = [];
  readonly regrounded: string[] = [];
  userActivityOnAttach = false;
  killOnAttach = false;
  resumedAfterActivity = 0;
  interruptNextAction = false;
  readonly failOnceForActionIds = new Set<string>();

  async screenshot(label: string): Promise<Screenshot> {
    const shot = { id: `shot-${this.screenshots.length + 1}`, path: `/tmp/${label}.png`, capturedAt: "2026-08-17T00:00:00.000Z" };
    this.screenshots.push(shot);
    return shot;
  }

  async perform({ action }: { action: WorkflowAction }): Promise<ActionReceipt> {
    if (this.interruptNextAction) { this.interruptNextAction = false; throw new Error("user takeover"); }
    if (this.failOnceForActionIds.delete(action.id)) throw new Error(`failed ${action.id}`);
    this.performed.push(action);
    return { actionId: action.id, method: "accessibility" };
  }

  async reground(target: WorkflowTarget): Promise<WorkflowTarget> {
    this.regrounded.push(target.description);
    return target;
  }

  onUserActivity(listener: () => void): () => void {
    if (this.userActivityOnAttach) listener();
    return () => {};
  }

  onKillSwitch(listener: () => void): () => void {
    if (this.killOnAttach) listener();
    return () => {};
  }

  async resumeAfterUserActivity(): Promise<void> { this.resumedAfterActivity += 1; }
  isUserActivityInterruption(cause: unknown): boolean { return cause instanceof Error && cause.message === "user takeover"; }
}

function judge(options: {
  condition?: boolean;
  expectations?: boolean[];
  onCondition?: (input: Parameters<SemanticJudge["condition"]>[0]) => void;
} = {}): SemanticJudge {
  const expectations = [...(options.expectations ?? [])];
  return {
    async expectation() { return { met: expectations.shift() ?? true, reason: "fixture judgment" }; },
    async condition(input) {
      options.onCondition?.(input);
      return { result: options.condition ?? true, reason: "fixture branch judgment" };
    },
  };
}

describe("WorkflowRunner", () => {
  it("refuses to run an unapproved draft", () => {
    expect(() => new WorkflowRunner().start({ workflow: workflow(undefined, "draft"), driver: new FakeDriver(), judge: judge(), options: { mode: "test" } })).toThrow("Only an approved workflow can run");
  });

  it("runs approved steps in order and records evidence", async () => {
    const driver = new FakeDriver();
    const events: RunnerEvent[] = [];
    const handle = new WorkflowRunner().start({
      workflow: workflow([step("one"), step("two")]),
      driver,
      judge: judge(),
      options: { mode: "autonomous", runId: "run-fixed", onEvent: (event) => { events.push(event); } },
    });
    const log = await handle.result;
    expect(log.outcome).toBe("completed");
    expect(driver.performed.map((action) => action.id)).toEqual(["action-one", "action-two"]);
    expect(log.steps).toHaveLength(2);
    expect(log.steps.every((entry) => entry.screenshots.length === 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run_finished", outcome: "completed" });
  });

  it("requires an operator approval before every step in test mode", async () => {
    const driver = new FakeDriver();
    const events: RunnerEvent[] = [];
    const handle = new WorkflowRunner().start({
      workflow: workflow([step("one"), step("two")]),
      driver,
      judge: judge(),
      options: { mode: "test", onEvent: (event) => { events.push(event); } },
    });
    handle.respond({ kind: "approve" });
    handle.respond({ kind: "skip" });
    const log = await handle.result;
    expect(driver.performed).toHaveLength(1);
    expect(log.steps.map((entry) => entry.outcome)).toEqual(["completed", "skipped"]);
    expect(events.filter((event) => event.type === "paused" && event.reason === "before_step")).toHaveLength(2);
  });

  it.each([
    [true, "then-step"],
    [false, "else-step"],
  ])("takes only the branch selected by the screen judgment (%s)", async (condition, expectedAction) => {
    const thenNode: BranchNode = step("then-step");
    const elseNode: BranchNode = step("else-step");
    const deciding = { ...step("decide"), decisions: [{ id: "match", condition: "Totals match", confidence: "high" as const, then: [thenNode], else: [elseNode], provenance }] };
    const driver = new FakeDriver();
    const log = await new WorkflowRunner().start({ workflow: workflow([deciding]), driver, judge: judge({ condition }), options: { mode: "autonomous" } }).result;
    expect(log.outcome).toBe("completed");
    expect(driver.performed.map((action) => action.id)).toContain(`action-${expectedAction}`);
    expect(driver.performed.map((action) => action.id)).not.toContain(`action-${condition ? "else-step" : "then-step"}`);
  });

  it("records ask-user answers separately from action data", async () => {
    const events: RunnerEvent[] = [];
    const askUser: BranchNode = {
      kind: "ask_user",
      id: "explain-mismatch",
      message: "Why do the totals differ?",
      provenance,
    };
    const deciding = {
      ...step("decide"),
      decisions: [{
        id: "mismatch",
        condition: "The totals differ",
        confidence: "high" as const,
        then: [askUser],
        else: [],
        provenance,
      }],
    };
    const handle = new WorkflowRunner().start({
      workflow: workflow([deciding]),
      driver: new FakeDriver(),
      judge: judge({ condition: true }),
      options: { mode: "autonomous", onEvent: (event) => { events.push(event); } },
    });
    handle.respond({ kind: "answer", value: "The PO excludes shipping." });

    const log = await handle.result;
    expect(log.outcome).toBe("completed");
    expect(log.answers).toEqual([expect.objectContaining({
      nodeId: "explain-mismatch",
      answer: "The PO excludes shipping.",
    })]);
    expect(JSON.stringify(log.steps)).not.toContain("The PO excludes shipping.");
    expect(events).toContainEqual(expect.objectContaining({
      type: "ask_user_answered",
      nodeId: "explain-mismatch",
      answer: "The PO excludes shipping.",
    }));
  });

  it("stops safely when an ask-user node receives no answer", async () => {
    const askUser: BranchNode = {
      kind: "ask_user",
      id: "missing-context",
      message: "What should happen next?",
      provenance,
    };
    const deciding = {
      ...step("decide"),
      decisions: [{
        id: "needs-help",
        condition: "More context is needed",
        confidence: "high" as const,
        then: [askUser],
        else: [],
        provenance,
      }],
    };
    const handle = new WorkflowRunner().start({
      workflow: workflow([deciding]),
      driver: new FakeDriver(),
      judge: judge({ condition: true }),
      options: { mode: "autonomous" },
    });
    handle.respond({ kind: "resume" });

    const log = await handle.result;
    expect(log.outcome).toBe("stopped_and_flagged");
    expect(log.answers).toEqual([]);
  });

  it("rechecks a failed expectation without replaying successful actions", async () => {
    const driver = new FakeDriver();
    const events: RunnerEvent[] = [];
    const multiActionStep = step("one", [
      { id: "save", type: "click", target: { description: "Save" } },
      { id: "submit", type: "click", target: { description: "Submit" } },
    ]);
    const handle = new WorkflowRunner().start({
      workflow: workflow([multiActionStep]),
      driver,
      judge: judge({ expectations: [false, false] }),
      options: { mode: "autonomous", maxRetries: 1, onEvent: (event) => { events.push(event); } },
    });
    handle.respond({ kind: "abort" });
    const log = await handle.result;
    expect(driver.performed.map((action) => action.id)).toEqual(["save", "submit"]);
    expect(driver.regrounded).toEqual([]);
    expect(log.steps[0]?.attempts).toBe(2);
    expect(log.outcome).toBe("aborted");
    expect(events).toContainEqual(expect.objectContaining({ type: "paused", reason: "expectation_failed" }));
  });

  it("retries only the action that failed, never earlier successful actions", async () => {
    const driver = new FakeDriver();
    driver.failOnceForActionIds.add("second");
    const twoActions = step("two-actions", [
      { id: "first", type: "click", target: { description: "First" } },
      { id: "second", type: "click", target: { description: "Second" } },
    ]);

    const log = await new WorkflowRunner().start({
      workflow: workflow([twoActions]),
      driver,
      judge: judge(),
      options: { mode: "autonomous", maxRetries: 1 },
    }).result;

    expect(log.outcome).toBe("completed");
    expect(driver.performed.map((action) => action.id)).toEqual(["first", "second"]);
    expect(driver.regrounded).toEqual(["Second"]);
    expect(log.steps[0]?.attempts).toBe(2);
  });

  it("does not replay a completed action when its event callback fails", async () => {
    const driver = new FakeDriver();
    const twoActions = step("two-actions", [
      { id: "first", type: "click", target: { description: "First" } },
      { id: "second", type: "click", target: { description: "Second" } },
    ]);
    let failActionEvent = true;

    const log = await new WorkflowRunner().start({
      workflow: workflow([twoActions]),
      driver,
      judge: judge(),
      options: {
        mode: "autonomous",
        maxRetries: 1,
        onEvent(event) {
          if (event.type === "action_completed" && failActionEvent) {
            failActionEvent = false;
            throw new Error("event sink unavailable");
          }
        },
      },
    }).result;

    expect(log.outcome).toBe("completed");
    expect(driver.performed.map((action) => action.id)).toEqual(["first", "second"]);
    expect(driver.regrounded).toEqual([]);
    expect(log.steps[0]?.attempts).toBe(2);
  });

  it("takes a fresh screenshot before every decision", async () => {
    const screenshotsUsed: string[] = [];
    const decisions = ["first-decision", "second-decision"].map((id) => ({
      id,
      condition: `${id} is true`,
      confidence: "high" as const,
      then: [step(`${id}-then`)],
      else: [step(`${id}-else`)],
      provenance,
    }));
    const deciding = { ...step("deciding"), decisions };
    const driver = new FakeDriver();

    const log = await new WorkflowRunner().start({
      workflow: workflow([deciding]),
      driver,
      judge: judge({ onCondition: ({ screenshot }) => screenshotsUsed.push(screenshot.path) }),
      options: { mode: "autonomous" },
    }).result;

    expect(log.outcome).toBe("completed");
    expect(screenshotsUsed).toHaveLength(2);
    expect(screenshotsUsed[0]).not.toBe(screenshotsUsed[1]);
    expect(screenshotsUsed.every((path) => path.includes("-decision-"))).toBe(true);
  });

  it("refreshes the decision screenshot after a supervised pause", async () => {
    let screenshotUsed = "";
    const deciding = {
      ...step("deciding"),
      decisions: [{
        id: "review-decision",
        condition: "The totals match",
        confidence: "high" as const,
        then: [step("then")],
        else: [step("else")],
        provenance,
      }],
    };
    const handle = new WorkflowRunner().start({
      workflow: workflow([deciding]),
      driver: new FakeDriver(),
      judge: judge({ onCondition: ({ screenshot }) => { screenshotUsed = screenshot.path; } }),
      options: { mode: "supervised" },
    });
    handle.respond({ kind: "approve" });

    expect((await handle.result).outcome).toBe("completed");
    expect(screenshotUsed).toContain("review-decision-after-pause");
  });

  it("never passes a secure value to the native driver", async () => {
    const secureAction: WorkflowAction = { id: "password", type: "type", target: { description: "Password" }, value: { param: "password", vault: true }, secure: true };
    const driver = new FakeDriver();
    const handle = new WorkflowRunner().start({ workflow: workflow([step("login", [secureAction])]), driver, judge: judge(), options: { mode: "autonomous", parameters: { password: "must-not-be-observed" } } });
    handle.respond({ kind: "secure_input_complete" });
    const log = await handle.result;
    expect(log.outcome).toBe("completed");
    expect(driver.performed).toHaveLength(0);
    expect(log.steps[0]?.actions[0]?.receipt).toMatchObject({ method: "human", actionId: "password" });
    expect(JSON.stringify(log)).not.toContain("must-not-be-observed");
  });

  it("auto-pauses when user activity is observed", async () => {
    const driver = new FakeDriver();
    driver.userActivityOnAttach = true;
    const events: RunnerEvent[] = [];
    const handle = new WorkflowRunner().start({ workflow: workflow(), driver, judge: judge(), options: { mode: "autonomous", onEvent: (event) => { events.push(event); } } });
    handle.respond({ kind: "resume" });
    expect((await handle.result).outcome).toBe("completed");
    expect(events).toContainEqual(expect.objectContaining({ type: "paused", reason: "user_activity" }));
    expect(driver.resumedAfterActivity).toBe(1);
  });

  it("honors the kill switch before another action can run", async () => {
    const driver = new FakeDriver();
    driver.killOnAttach = true;
    const log = await new WorkflowRunner().start({ workflow: workflow(), driver, judge: judge(), options: { mode: "autonomous" } }).result;
    expect(log.outcome).toBe("aborted");
    expect(driver.performed).toHaveLength(0);
  });

  it("pauses and resets the native latch when movement interrupts an action", async () => {
    const driver = new FakeDriver();
    driver.interruptNextAction = true;
    const events: RunnerEvent[] = [];
    const handle = new WorkflowRunner().start({ workflow: workflow(), driver, judge: judge(), options: { mode: "autonomous", onEvent: (event) => { events.push(event); } } });
    handle.respond({ kind: "resume" });
    const log = await handle.result;
    expect(log.outcome).toBe("completed");
    expect(driver.performed).toHaveLength(1);
    expect(driver.resumedAfterActivity).toBe(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "paused", reason: "user_activity" }));
  });
});
