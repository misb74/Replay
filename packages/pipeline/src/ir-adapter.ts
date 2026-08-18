import type { CondensedAction } from "./condense.js";
import type { FrameSamplingPlan, SampledFrame } from "./frame-sampling.js";
import type { DecisionExtractionOutput, StepSegmentationOutput } from "./inference.js";
import type { TimestampedTranscript } from "./transcript.js";

export interface PipelineDraftEvidence {
  sessionId: string;
  actions: CondensedAction[];
  transcript?: TimestampedTranscript;
  framePlan: FrameSamplingPlan;
  /** Validated local visual evidence returned by the frame provider. */
  frames?: SampledFrame[];
  segmentation: StepSegmentationOutput;
  decisions: DecisionExtractionOutput;
}

export interface IrValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type IrValidationResult<TWorkflow> =
  | { ok: true; value: TWorkflow }
  | { ok: false; issues: IrValidationIssue[] };

/**
 * Package boundary between model-shaped inference and the versioned workflow
 * contract. `@replay/ir` can implement this without the pipeline importing a
 * concrete schema or weakening validation with a cast.
 */
export interface WorkflowIrAdapter<TWorkflow> {
  assemble(evidence: PipelineDraftEvidence): unknown | Promise<unknown>;
  validate(candidate: unknown): IrValidationResult<TWorkflow>;
}

export interface WorkflowIrAdapterOptions<TWorkflow> {
  assemble(evidence: PipelineDraftEvidence): unknown | Promise<unknown>;
  validate(candidate: unknown): IrValidationResult<TWorkflow>;
}

export function createWorkflowIrAdapter<TWorkflow>(
  options: WorkflowIrAdapterOptions<TWorkflow>,
): WorkflowIrAdapter<TWorkflow> {
  return {
    assemble: options.assemble,
    validate: options.validate,
  };
}

export class PipelineIrValidationError extends Error {
  readonly issues: readonly IrValidationIssue[];

  constructor(issues: readonly IrValidationIssue[]) {
    super(`The inferred workflow failed IR validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`);
    this.name = "PipelineIrValidationError";
    this.issues = issues;
  }
}
