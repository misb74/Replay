import { randomUUID } from "node:crypto";
import type {
  AskUserNode,
  BranchNode,
  DecisionNode,
  InputReference,
  VaultReference,
  WorkflowAction,
  WorkflowStep,
  WorkflowStringValue,
  WorkflowTarget,
  WorkflowValue,
} from "@replay/ir";
import { cloneRunLog, createRunLog, createStepLog } from "./run-log.js";
import { OperatorGate } from "./operator-gate.js";
import type {
  OperatorResponse,
  PauseReason,
  RunHandle,
  RunLog,
  RunnerEvent,
  RunnerStartInput,
  Screenshot,
  StepRunLog,
} from "./types.js";

class RunAborted extends Error {}
class StopAndFlag extends Error {}
class StepFailed extends Error {}

class ActionExecutionFailed extends Error {
  constructor(
    readonly actionIndex: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ActionExecutionFailed";
  }
}

class ActionCompletionReportingFailed extends Error {
  constructor(
    readonly nextActionIndex: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ActionCompletionReportingFailed";
  }
}

type WithoutEventEnvelope<T> = T extends unknown ? Omit<T, "runId" | "at"> : never;
type RunnerEventInput = WithoutEventEnvelope<RunnerEvent>;

export class WorkflowRunner {
  start(input: RunnerStartInput): RunHandle {
    if (input.workflow.metadata.approval.status !== "approved") {
      throw new Error("Only an approved workflow can run");
    }
    const execution = new Execution(input);
    return execution.start();
  }
}

class Execution {
  private readonly gate = new OperatorGate();
  private readonly runId: string;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly logValue: RunLog;
  private aborted = false;
  private pauseRequested = false;
  private detachUserActivity: (() => void) | undefined;
  private detachKillSwitch: (() => void) | undefined;

  constructor(private readonly input: RunnerStartInput) {
    this.runId = input.options.runId ?? randomUUID();
    this.maxRetries = input.options.maxRetries ?? 1;
    this.now = input.options.now ?? (() => new Date());
    this.logValue = createRunLog({
      runId: this.runId,
      workflowId: input.workflow.metadata.workflowId,
      workflowRevision: input.workflow.metadata.revision,
      mode: input.options.mode,
      startedAt: this.timestamp(),
    });
  }

  start(): RunHandle {
    this.detachUserActivity = this.input.driver.onUserActivity?.(() => { this.pauseRequested = true; });
    this.detachKillSwitch = this.input.driver.onKillSwitch?.(() => this.abort());
    const result = this.execute();
    return {
      runId: this.runId,
      result,
      respond: (response) => this.gate.respond(response),
      abort: () => this.abort(),
      log: () => cloneRunLog(this.logValue),
    };
  }

  private abort(): void {
    this.aborted = true;
    this.gate.abort();
  }

  private async execute(): Promise<RunLog> {
    await this.emit({ type: "run_started", mode: this.input.options.mode, workflowId: this.input.workflow.metadata.workflowId });
    let outcome: RunLog["outcome"] = "completed";
    let message = "Workflow completed";
    try {
      await this.executeNodes(this.input.workflow.steps);
    } catch (cause) {
      if (cause instanceof RunAborted) {
        outcome = "aborted";
        message = "Run stopped by the operator";
      } else if (cause instanceof StopAndFlag) {
        outcome = "stopped_and_flagged";
        message = cause.message;
      } else {
        outcome = "failed";
        message = cause instanceof Error ? cause.message : String(cause);
      }
    } finally {
      this.detachUserActivity?.();
      this.detachKillSwitch?.();
    }
    this.logValue.completedAt = this.timestamp();
    this.logValue.outcome = outcome;
    await this.emit({ type: "run_finished", outcome, message });
    return cloneRunLog(this.logValue);
  }

  private async executeNodes(nodes: BranchNode[]): Promise<void> {
    for (const node of nodes) {
      this.assertNotAborted();
      if (node.kind === "step") await this.executeStep(node);
      else if (node.kind === "ask_user") await this.askUser(node);
      else throw new StopAndFlag(node.reason);
    }
  }

  private async askUser(node: AskUserNode): Promise<void> {
    const response = await this.pause("ask_user", node.message);
    if (response.kind !== "answer") {
      throw new StopAndFlag(`The question "${node.message}" requires an answer before the run can continue.`);
    }
    const answer = { nodeId: node.id, answer: response.value, at: this.timestamp() };
    this.logValue.answers.push(answer);
    await this.emit({ type: "ask_user_answered", nodeId: node.id, answer: response.value });
  }

  private async executeStep(step: WorkflowStep): Promise<void> {
    if (this.input.options.mode === "test") {
      const response = await this.pause("before_step", step.intent, step.id);
      if (response.kind === "skip") {
        const skipped = createStepLog(step.id, step.intent, this.timestamp(), 0);
        skipped.outcome = "skipped";
        skipped.completedAt = this.timestamp();
        this.logValue.steps.push(skipped);
        return;
      }
    }

    const stepLog = createStepLog(step.id, step.intent, this.timestamp(), 1);
    this.logValue.steps.push(stepLog);
    let nextActionIndex = 0;
    let actionToReground: number | undefined;
    let verifiedScreenshot: Screenshot | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      stepLog.attempts = attempt + 1;

      await this.emit({ type: "step_started", stepId: step.id, intent: step.intent, attempt: attempt + 1 });
      try {
        await this.performActions(step, stepLog, nextActionIndex, actionToReground);
        nextActionIndex = step.actions.length;
        actionToReground = undefined;
        await this.honorUserActivity(step.id);
        const screenshot = await this.input.driver.screenshot(`${step.id}-attempt-${attempt + 1}`);
        stepLog.screenshots.push(screenshot);
        const passed = await this.verifyExpectations(step, screenshot, stepLog);
        if (!passed) throw new StepFailed(`Expected result was not visible after: ${step.intent}`);
        verifiedScreenshot = screenshot;
        break;
      } catch (cause) {
        if (cause instanceof RunAborted || cause instanceof StopAndFlag) throw cause;
        if (cause instanceof ActionExecutionFailed) {
          nextActionIndex = cause.actionIndex;
          actionToReground = cause.actionIndex;
        } else if (cause instanceof ActionCompletionReportingFailed) {
          nextActionIndex = cause.nextActionIndex;
          actionToReground = undefined;
        } else {
          // Once the driver reports an action as complete, a later visual or
          // reporting failure must never cause that side effect to run again.
          nextActionIndex = step.actions.length;
          actionToReground = undefined;
        }
        if (attempt >= this.maxRetries) {
          const screenshot = await this.input.driver.screenshot(`${step.id}-failed`);
          stepLog.screenshots.push(screenshot);
          const response = await this.pause("expectation_failed", cause instanceof Error ? cause.message : String(cause), step.id, screenshot);
          if (response.kind === "skip") {
            stepLog.outcome = "skipped";
            stepLog.completedAt = this.timestamp();
            return;
          }
          throw new StepFailed(cause instanceof Error ? cause.message : String(cause));
        }
      }
    }

    if (verifiedScreenshot === undefined) {
      throw new StepFailed(`Expected result was not visible after: ${step.intent}`);
    }

    await this.executeDecisions(step, stepLog);
    stepLog.outcome = "completed";
    stepLog.completedAt = this.timestamp();
    await this.emit({ type: "step_completed", stepId: step.id, screenshot: verifiedScreenshot });
  }

  private async performActions(
    step: WorkflowStep,
    log: StepRunLog,
    startIndex: number,
    regroundIndex: number | undefined,
  ): Promise<void> {
    for (let index = startIndex; index < step.actions.length; index += 1) {
      const original = step.actions[index];
      if (original === undefined) continue;
      try {
        this.assertNotAborted();
        await this.honorUserActivity(step.id);
        const action = index === regroundIndex
          ? await this.regroundAction(original)
          : original;
        if (isSecureType(action)) {
          const screenshot = await this.input.driver.screenshot(`${step.id}-secure-input`);
          await this.pause("secure_input", `Type the secure value for ${action.value.param}, then continue`, step.id, screenshot);
          const receipt = { actionId: action.id, method: "human" as const, targetDescription: action.target.description, detail: "Secure value entered by operator; value was not available to Replay" };
          log.actions.push({ actionId: action.id, receipt, at: this.timestamp() });
          try {
            await this.emit({ type: "action_completed", stepId: step.id, receipt });
          } catch (cause) {
            throw new ActionCompletionReportingFailed(index + 1, cause);
          }
          continue;
        }
        const value = this.resolveActionValue(action);
        const receipt = await this.performWithTakeoverPause(action, value, step.id);
        log.actions.push({ actionId: action.id, receipt, at: this.timestamp() });
        try {
          await this.emit({ type: "action_completed", stepId: step.id, receipt });
        } catch (cause) {
          throw new ActionCompletionReportingFailed(index + 1, cause);
        }
      } catch (cause) {
        if (cause instanceof RunAborted || cause instanceof StopAndFlag) throw cause;
        if (cause instanceof ActionCompletionReportingFailed) throw cause;
        throw new ActionExecutionFailed(index, cause);
      }
    }
  }

  private async performWithTakeoverPause(action: WorkflowAction, value: string | number | boolean | null | undefined, stepId: string) {
    for (;;) {
      await this.honorUserActivity(stepId);
      try {
        return await this.input.driver.perform({ action, ...(value === undefined ? {} : { value }) });
      } catch (cause) {
        this.assertNotAborted();
        if (!this.pauseRequested && !this.input.driver.isUserActivityInterruption?.(cause)) throw cause;
        this.pauseRequested = false;
        const screenshot = await this.input.driver.screenshot(`${stepId}-user-takeover`);
        const response = await this.pause("user_activity", "Paused because the operator took control during an action", stepId, screenshot);
        await this.input.driver.resumeAfterUserActivity?.();
        if (response.kind === "skip") return { actionId: action.id, method: "human" as const, detail: "Operator skipped the interrupted action" };
      }
    }
  }

  private async regroundAction(action: WorkflowAction): Promise<WorkflowAction> {
    const target = actionTarget(action);
    if (!target) return action;
    const screenshot = await this.input.driver.screenshot(`${action.id}-reground`);
    const grounded = await this.input.driver.reground?.(target, screenshot) ?? await this.input.judge.reground?.({ target, screenshot });
    return grounded ? replaceActionTarget(action, grounded) : action;
  }

  private async verifyExpectations(step: WorkflowStep, screenshot: Screenshot, log: StepRunLog): Promise<boolean> {
    let allMet = true;
    for (const expectation of step.expects) {
      const result = await this.input.judge.expectation({ expectation, screenshot, step });
      log.expectations.push({ expectation, ...result });
      await this.emit({ type: "expectation_checked", stepId: step.id, expectation, ...result });
      allMet &&= result.met;
    }
    return allMet;
  }

  private async executeDecisions(step: WorkflowStep, log: StepRunLog): Promise<void> {
    for (const decision of step.decisions ?? []) {
      await this.honorUserActivity(step.id);
      let screenshot = await this.input.driver.screenshot(`${step.id}-${decision.id}-decision-before-pause`);
      log.screenshots.push(screenshot);
      if (this.input.options.mode === "supervised") {
        await this.pause("decision", `About to evaluate: ${decision.condition}`, step.id, screenshot);
        await this.honorUserActivity(step.id);
        screenshot = await this.input.driver.screenshot(`${step.id}-${decision.id}-after-pause`);
        log.screenshots.push(screenshot);
      }
      const result = await this.evaluateDecision(decision, screenshot);
      log.decisions.push({ decisionId: decision.id, ...result });
      await this.emit({ type: "decision_taken", stepId: step.id, decisionId: decision.id, ...result });
      await this.executeNodes(result.result ? decision.then : decision.else);
    }
  }

  private async evaluateDecision(decision: DecisionNode, screenshot: Screenshot): Promise<{ result: boolean; reason: string }> {
    if (decision.deterministicCheck && this.input.driver.evaluateDeterministic) {
      const result = await this.input.driver.evaluateDeterministic(decision.deterministicCheck);
      return { result, reason: "Evaluated using the workflow's deterministic screen check" };
    }
    return this.input.judge.condition({ condition: decision.condition, screenshot });
  }

  private async honorUserActivity(stepId: string): Promise<void> {
    if (!this.pauseRequested) return;
    this.pauseRequested = false;
    await this.pause("user_activity", "Paused because the operator moved the mouse", stepId);
    await this.input.driver.resumeAfterUserActivity?.();
  }

  private async pause(reason: PauseReason, message: string, stepId?: string, screenshot?: Screenshot): Promise<OperatorResponse> {
    const optional = { ...(stepId ? { stepId } : {}), ...(screenshot ? { screenshot } : {}) };
    await this.emit({ type: "paused", reason, message, ...optional });
    const response = await this.gate.wait();
    if (response.kind === "abort") throw new RunAborted();
    await this.emit({ type: "resumed", ...(stepId ? { stepId } : {}) });
    return response;
  }

  private resolveActionValue(action: WorkflowAction): string | number | boolean | null | undefined {
    if (action.type === "type" || action.type === "select") return this.resolveValue(action.value);
    if (action.type === "navigate") return this.resolveValue(action.url);
    return undefined;
  }

  private resolveValue(value: WorkflowValue | WorkflowStringValue): string | number | boolean | null {
    if (!isReference(value)) return value;
    if (value.vault) throw new Error(`Secure parameter ${value.param} must be entered by the operator`);
    const resolved = this.input.options.parameters?.[value.param];
    if (resolved === undefined) throw new Error(`Missing required parameter: ${value.param}`);
    return resolved;
  }

  private assertNotAborted(): void {
    if (this.aborted) throw new RunAborted();
  }

  private async emit(event: RunnerEventInput): Promise<void> {
    await this.input.options.onEvent?.({ ...event, runId: this.runId, at: this.timestamp() } as RunnerEvent);
  }

  private timestamp(): string { return this.now().toISOString(); }
}

function isReference(value: WorkflowValue | WorkflowStringValue): value is InputReference | VaultReference {
  return typeof value === "object" && value !== null && "param" in value;
}

function isSecureType(action: WorkflowAction): action is Extract<WorkflowAction, { type: "type" }> & { value: VaultReference } {
  return action.type === "type" && (action.secure === true || (isReference(action.value) && action.value.vault));
}

function actionTarget(action: WorkflowAction): WorkflowTarget | undefined {
  if ("target" in action) return action.target;
  if (action.type === "drag") return action.from;
  return undefined;
}

function replaceActionTarget(action: WorkflowAction, target: WorkflowTarget): WorkflowAction {
  if (action.type === "drag") return { ...action, from: target };
  if ("target" in action) return { ...action, target } as WorkflowAction;
  return action;
}
