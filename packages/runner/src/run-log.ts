import type { RunLog, RunMode, StepRunLog } from "./types.js";

export function createRunLog(input: { runId: string; workflowId: string; workflowRevision: number; mode: RunMode; startedAt: string }): RunLog {
  return { ...input, steps: [], answers: [] };
}

export function createStepLog(stepId: string, intent: string, startedAt: string, attempt: number): StepRunLog {
  return {
    stepId,
    intent,
    startedAt,
    attempts: attempt,
    actions: [],
    expectations: [],
    decisions: [],
    screenshots: [],
    outcome: "failed",
  };
}

export function cloneRunLog(log: RunLog): RunLog {
  return structuredClone(log);
}
