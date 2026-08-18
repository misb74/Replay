import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkflowRunner, type OperatorResponse, type RunHandle, type RunnerEvent, type RunLog, type SemanticJudge } from "@replay/runner";
import type { RunHistoryView, RunMode, RunResponse, RunUpdate } from "../shared/contracts.js";
import { AgentSdkSemanticJudge } from "./agent-judge.js";
import { NativeSidecarDriver } from "./native-driver.js";
import { SidecarClient } from "./sidecar-client.js";
import { WorkflowRepository } from "./workflow-repository.js";

interface ActiveRun {
  handle: RunHandle;
  workflowId: string;
  workflowRevision: number;
  mode: RunMode;
  directory: string;
  persistChain: Promise<void>;
  terminalUpdate?: RunUpdate;
}

export interface RunnerServiceOptions {
  model?: string;
  judge?: SemanticJudge;
  onUpdate?: (update: RunUpdate) => void;
}

export class RunnerService {
  readonly #runsDirectory: string;
  readonly #active = new Map<string, ActiveRun>();
  readonly #judge: SemanticJudge;
  readonly #onUpdate: ((update: RunUpdate) => void) | undefined;

  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly sidecar: SidecarClient,
    dataDirectory: string,
    options: RunnerServiceOptions = {},
  ) {
    this.#runsDirectory = join(dataDirectory, "runs");
    this.#judge = options.judge ?? new AgentSdkSemanticJudge(options.model);
    this.#onUpdate = options.onUpdate;
  }

  async start(workflowId: string, mode: RunMode, parameters: Record<string, string | number | boolean | null> = {}): Promise<RunUpdate> {
    if (this.#active.size > 0) throw new Error("Stop the active run before starting another one");
    const { workflow, view } = await this.workflows.getRunSnapshot(workflowId);
    if (workflow.metadata.revision !== view.revision) throw new Error("The workflow changed while its run was being prepared. Please try again.");
    if (mode === "autonomous" && !view.cleanTestRunAt) throw new Error("Complete one clean test run before using autonomous mode");
    const runId = `run-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const directory = join(this.#runsDirectory, runId);
    await mkdir(join(directory, "screenshots"), { recursive: true, mode: 0o700 });
    const driver = new NativeSidecarDriver(this.sidecar, join(directory, "screenshots"), this.#judge);
    await driver.startGuardrails();
    let handle: RunHandle;
    try {
      handle = new WorkflowRunner().start({
        workflow,
        driver,
        judge: this.#judge,
        options: {
          runId,
          mode,
          parameters,
          maxRetries: 1,
          onEvent: (event) => this.#handleEvent(event),
        },
      });
    } catch (cause) {
      await driver.stopGuardrails().catch(() => undefined);
      throw cause;
    }
    const active: ActiveRun = { handle, workflowId, workflowRevision: workflow.metadata.revision, mode, directory, persistChain: Promise.resolve() };
    this.#active.set(runId, active);
    await this.#persist(active, handle.log());
    void handle.result.then(async (log) => {
      await this.#persist(active, log);
      let trustFailure: string | undefined;
      if (mode === "test" && log.outcome === "completed" && log.steps.length > 0 && log.steps.every((step) => step.outcome === "completed")) {
        try {
          await this.workflows.markCleanTestRun(workflowId, workflow.metadata.revision);
        } catch (cause) {
          trustFailure = cause instanceof Error ? cause.message : String(cause);
        }
      }
      const terminal = active.terminalUpdate ?? { runId, workflowId, status: log.outcome === "completed" ? "completed" as const : log.outcome === "aborted" ? "aborted" as const : "failed" as const, message: "Workflow run finished" };
      this.#onUpdate?.(trustFailure ? { ...terminal, message: `Workflow completed, but autonomous trust was not saved: ${trustFailure}` } : terminal);
    }).catch((cause: unknown) => {
      this.#onUpdate?.({ runId, workflowId, status: "failed", message: cause instanceof Error ? cause.message : String(cause) });
    }).finally(async () => {
      await driver.stopGuardrails().catch(() => undefined);
      this.#active.delete(runId);
    });
    const initial: RunUpdate = { runId, workflowId, status: "starting", message: mode === "test" ? "Preparing the first supervised step" : "Preparing the workflow" };
    this.#onUpdate?.(initial);
    return initial;
  }

  respond(runId: string, response: RunResponse): void {
    const active = this.#require(runId);
    const operatorResponse: OperatorResponse = typeof response === "string" ? { kind: response } : response;
    active.handle.respond(operatorResponse);
  }

  stop(runId: string): void {
    this.#require(runId).handle.abort();
  }

  stopAll(): void {
    for (const active of this.#active.values()) active.handle.abort();
  }

  hasActiveRuns(): boolean {
    return this.#active.size > 0;
  }

  async list(workflowId: string): Promise<RunHistoryView[]> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u.test(workflowId)) throw new Error("Invalid workflow id");
    await mkdir(this.#runsDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.#runsDirectory, { withFileTypes: true });
    const histories = await Promise.all(entries.filter((entry) => entry.isDirectory() && /^run-[A-Za-z0-9_-]+$/u.test(entry.name)).map(async (entry) => {
      const directory = join(this.#runsDirectory, entry.name);
      try {
        const candidate = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as unknown;
        return runHistory(candidate, directory, workflowId);
      } catch {
        return undefined;
      }
    }));
    return histories.filter((history): history is RunHistoryView => history !== undefined)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  #require(runId: string): ActiveRun {
    const active = this.#active.get(runId);
    if (!active) throw new Error("The requested run is no longer active");
    return active;
  }

  async #handleEvent(event: RunnerEvent): Promise<void> {
    const active = this.#active.get(event.runId);
    const update = eventToUpdate(event, active?.workflowId);
    if (active) await this.#persist(active, active.handle.log());
    if (update && event.type === "run_finished" && active) active.terminalUpdate = update;
    else if (update) this.#onUpdate?.(update);
  }

  async #persist(active: ActiveRun, log: RunLog): Promise<void> {
    const write = active.persistChain.then(async () => {
      const path = join(active.directory, "run.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(log, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
    active.persistChain = write.catch(() => undefined);
    await write;
  }
}

function runHistory(candidate: unknown, directory: string, workflowId: string): RunHistoryView | undefined {
  if (!isRecord(candidate) || candidate.workflowId !== workflowId || typeof candidate.runId !== "string" || typeof candidate.workflowRevision !== "number" || (candidate.mode !== "test" && candidate.mode !== "supervised" && candidate.mode !== "autonomous") || typeof candidate.startedAt !== "string" || !Array.isArray(candidate.steps)) return undefined;
  const outcome = candidate.outcome;
  if (outcome !== undefined && outcome !== "completed" && outcome !== "aborted" && outcome !== "failed" && outcome !== "stopped_and_flagged") return undefined;
  const steps = candidate.steps.flatMap((value) => {
    if (!isRecord(value) || typeof value.stepId !== "string" || typeof value.intent !== "string" || (value.outcome !== "completed" && value.outcome !== "skipped" && value.outcome !== "failed") || typeof value.attempts !== "number" || !Array.isArray(value.screenshots) || !Array.isArray(value.expectations) || !Array.isArray(value.decisions)) return [];
    const stepOutcome: "completed" | "skipped" | "failed" = value.outcome;
    const screenshots = value.screenshots.flatMap((shot) => isRecord(shot) && typeof shot.path === "string" ? safeScreenshotUrl(directory, shot.path) : []);
    const expectations = value.expectations.flatMap((check) => isRecord(check) && typeof check.expectation === "string" && typeof check.met === "boolean" && typeof check.reason === "string" ? [{ expectation: check.expectation, met: check.met, reason: check.reason }] : []);
    const decisions = value.decisions.flatMap((decision) => isRecord(decision) && typeof decision.decisionId === "string" && typeof decision.result === "boolean" && typeof decision.reason === "string" ? [{ decisionId: decision.decisionId, result: decision.result, reason: decision.reason }] : []);
    return [{ stepId: value.stepId, intent: value.intent, outcome: stepOutcome, attempts: value.attempts, screenshots, expectations, decisions }];
  });
  const answers = Array.isArray(candidate.answers) ? candidate.answers.flatMap((answer) => isRecord(answer) && typeof answer.nodeId === "string" && typeof answer.answer === "string" && typeof answer.at === "string" ? [{ nodeId: answer.nodeId, answer: answer.answer, at: answer.at }] : []) : [];
  return {
    runId: candidate.runId,
    workflowId,
    workflowRevision: candidate.workflowRevision,
    mode: candidate.mode,
    startedAt: candidate.startedAt,
    ...(typeof candidate.completedAt === "string" ? { completedAt: candidate.completedAt } : {}),
    ...(outcome ? { outcome } : {}),
    steps,
    answers,
  };
}

function safeScreenshotUrl(runDirectory: string, path: string): string[] {
  if (!isAbsolute(path)) return [];
  const screenshotsDirectory = resolve(runDirectory, "screenshots");
  const resolved = resolve(path);
  const child = relative(screenshotsDirectory, resolved);
  if (!child || child.startsWith("..") || isAbsolute(child)) return [];
  return [pathToFileURL(resolved).href];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventToUpdate(event: RunnerEvent, knownWorkflowId?: string): RunUpdate | undefined {
  const workflowId = event.type === "run_started" ? event.workflowId : knownWorkflowId;
  if (!workflowId) return undefined;
  switch (event.type) {
    case "run_started": return { runId: event.runId, workflowId, status: "starting", message: `Starting ${event.mode} run` };
    case "step_started": return { runId: event.runId, workflowId, status: "running", stepId: event.stepId, message: event.intent };
    case "action_completed": return { runId: event.runId, workflowId, status: "running", stepId: event.stepId, message: event.receipt.detail ?? `Completed action ${event.receipt.actionId}` };
    case "expectation_checked": return { runId: event.runId, workflowId, status: "running", stepId: event.stepId, message: event.reason };
    case "decision_taken": return { runId: event.runId, workflowId, status: "running", stepId: event.stepId, message: `${event.result ? "Yes" : "No"}: ${event.reason}` };
    case "ask_user_answered": return { runId: event.runId, workflowId, status: "running", message: "Answer recorded; continuing the approved path" };
    case "paused": return { runId: event.runId, workflowId, status: event.reason === "user_activity" ? "paused" : "awaiting_approval", pauseReason: event.reason, ...(event.stepId ? { stepId: event.stepId } : {}), message: event.message, ...(event.screenshot ? { screenshotUrl: pathToFileURL(event.screenshot.path).href } : {}) };
    case "resumed": return { runId: event.runId, workflowId, status: "running", ...(event.stepId ? { stepId: event.stepId } : {}), message: "Run resumed" };
    case "step_completed": return { runId: event.runId, workflowId, status: "running", stepId: event.stepId, message: "Step completed", screenshotUrl: pathToFileURL(event.screenshot.path).href };
    case "run_finished": return { runId: event.runId, workflowId, status: event.outcome === "completed" ? "completed" : event.outcome === "aborted" ? "aborted" : "failed", message: event.message };
  }
}
