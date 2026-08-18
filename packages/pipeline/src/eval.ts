import type { CondensedAction } from "./condense.js";
import type { DecisionExtractionOutput, StepSegmentationOutput } from "./inference.js";

export interface PipelineEvalLabels {
  fixtureVersion: 1;
  sessionId: string;
  expectedGoalConcepts: string[];
  expectedParameterNames: string[];
  expectedStepIntents: string[];
  expectedDecisionConditions: string[];
  minimumActionCoverage: number;
  notes?: string;
}

export interface EvalMetric {
  score: number;
  matched: number;
  total: number;
}

export interface InferenceEvalResult {
  sessionId: string;
  overallScore: number;
  metrics: {
    goalConcepts: EvalMetric;
    parameters: EvalMetric;
    stepIntents: EvalMetric;
    decisionConditions: EvalMetric;
    actionCoverage: EvalMetric;
    groundedBranches: EvalMetric;
  };
  warnings: string[];
}

/**
 * Score variable model wording against human labels instead of treating one
 * cached JSON document as the only correct answer.
 */
export function evaluateInference(
  segmentation: StepSegmentationOutput,
  decisions: DecisionExtractionOutput,
  actions: readonly CondensedAction[],
  labels: PipelineEvalLabels,
): InferenceEvalResult {
  assertValidEvalLabels(labels);
  const goalConcepts = languageMetric(labels.expectedGoalConcepts, [segmentation.goal]);
  const parameters = exactNameMetric(
    labels.expectedParameterNames,
    segmentation.parameters.map((parameter) => parameter.name),
  );
  const stepIntents = languageMetric(
    labels.expectedStepIntents,
    segmentation.steps.map((step) => step.intent),
  );
  const decisionConditions = languageMetric(
    labels.expectedDecisionConditions,
    decisions.decisions.map((decision) => decision.condition),
  );

  const knownActionIds = new Set(actions.map((action) => action.id));
  const coveredActionIds = new Set(
    segmentation.steps.flatMap((step) => step.actionIds).filter((id) => knownActionIds.has(id)),
  );
  const actionCoverage = metric(coveredActionIds.size, knownActionIds.size);

  const groundedCount = decisions.decisions.filter((decision) => {
    const paths = [decision.then, decision.else];
    return (
      paths.filter((path) => path.kind === "recorded_steps").length === 1 &&
      paths.filter((path) => path.kind !== "recorded_steps").length === 1 &&
      decision.evidence.length > 0
    );
  }).length;
  const groundedBranches = metric(groundedCount, decisions.decisions.length);

  const metrics = {
    goalConcepts,
    parameters,
    stepIntents,
    decisionConditions,
    actionCoverage,
    groundedBranches,
  };
  const weights = {
    goalConcepts: 0.2,
    parameters: 0.15,
    stepIntents: 0.2,
    decisionConditions: 0.2,
    actionCoverage: 0.15,
    groundedBranches: 0.1,
  } as const;
  const overallScore = roundScore(
    Object.entries(weights).reduce(
      (sum, [name, weight]) => sum + metrics[name as keyof typeof metrics].score * weight,
      0,
    ),
  );
  const warnings: string[] = [];
  if (actionCoverage.score < labels.minimumActionCoverage) {
    warnings.push(
      `Action coverage ${formatPercent(actionCoverage.score)} is below the labeled minimum ${formatPercent(labels.minimumActionCoverage)}.`,
    );
  }
  if (decisions.decisions.some((decision) => decision.confidence === "low")) {
    warnings.push("The draft contains low-confidence decisions that need review.");
  }

  return { sessionId: labels.sessionId, overallScore, metrics, warnings };
}

export function assertValidEvalLabels(labels: PipelineEvalLabels): void {
  if (labels.fixtureVersion !== 1 || labels.sessionId.trim() === "") {
    throw new Error("Evaluation labels have an unsupported version or no session id.");
  }
  if (
    !Number.isFinite(labels.minimumActionCoverage) ||
    labels.minimumActionCoverage < 0 ||
    labels.minimumActionCoverage > 1
  ) {
    throw new Error("Evaluation action coverage must be between 0 and 1.");
  }
  for (const collection of [
    labels.expectedGoalConcepts,
    labels.expectedParameterNames,
    labels.expectedStepIntents,
    labels.expectedDecisionConditions,
  ]) {
    if (!Array.isArray(collection) || collection.some((value) => value.trim() === "")) {
      throw new Error("Evaluation label collections must contain only non-empty strings.");
    }
  }
}

function languageMetric(expected: readonly string[], actual: readonly string[]): EvalMetric {
  if (expected.length === 0) {
    return metric(actual.length === 0 ? 1 : 0, 1);
  }
  const actualTokenSets = actual.map(tokenize);
  let scoreSum = 0;
  for (const phrase of expected) {
    const expectedTokens = tokenize(phrase);
    const best = actualTokenSets.reduce((bestScore, candidate) => {
      if (expectedTokens.size === 0) {
        return Math.max(bestScore, 1);
      }
      const matches = [...expectedTokens].filter((token) => candidate.has(token)).length;
      return Math.max(bestScore, matches / expectedTokens.size);
    }, 0);
    scoreSum += best;
  }
  return {
    score: roundScore(scoreSum / expected.length),
    matched: roundScore(scoreSum),
    total: expected.length,
  };
}

function exactNameMetric(expected: readonly string[], actual: readonly string[]): EvalMetric {
  if (expected.length === 0) {
    return metric(actual.length === 0 ? 1 : 0, 1);
  }
  const names = new Set(actual.map(normalizeName));
  const matched = expected.map(normalizeName).filter((name) => names.has(name)).length;
  return metric(matched, expected.length);
}

function metric(matched: number, total: number): EvalMetric {
  return {
    score: total === 0 ? 1 : roundScore(matched / total),
    matched,
    total,
  };
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .normalize("NFKD")
      .toLowerCase()
      .split(/[^a-z0-9]+/gu)
      .filter((token) => token.length > 1)
      .map(stem),
  );
}

function stem(value: string): string {
  if (value.length > 5 && value.endsWith("ing")) {
    return value.slice(0, -3);
  }
  if (value.length > 4 && value.endsWith("ed")) {
    return value.slice(0, -2);
  }
  if (value.length > 3 && value.endsWith("s")) {
    return value.slice(0, -1);
  }
  return value;
}

function normalizeName(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}

function roundScore(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
