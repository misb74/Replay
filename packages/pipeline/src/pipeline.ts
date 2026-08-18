import { condenseEvents, type CondensationOptions, type CondensedAction } from "./condense.js";
import { excludeReplayCaptureControlTail } from "./capture-controls.js";
import {
  safeParseEventsJsonl,
  EventsJsonlError,
  type CaptureEvent,
  type EventParseIssue,
  type EventParseOptions,
} from "./events.js";
import {
  planFrameSamples,
  validateSampledFrames,
  type FrameProvider,
  type FrameSamplingOptions,
  type FrameSamplingPlan,
  type SampledFrame,
  type ScreenChangeObservation,
} from "./frame-sampling.js";
import {
  validateDecisionExtraction,
  validateStepSegmentation,
  type DecisionExtractionOutput,
  type StepSegmentationOutput,
} from "./inference.js";
import {
  PipelineIrValidationError,
  type PipelineDraftEvidence,
  type WorkflowIrAdapter,
} from "./ir-adapter.js";
import {
  createModelCacheKey,
  type ModelInferenceResponse,
  type StructuredModelAdapter,
} from "./model.js";
import { PIPELINE_PROMPTS } from "./prompts.js";
import {
  assertValidTranscript,
  clampTranscriptTail,
  TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS,
  validateTranscriptDuration,
  type TimestampedTranscript,
  type TranscriptProvider,
} from "./transcript.js";

export type PipelineStage =
  | "transcribe"
  | "ingest_events"
  | "condense_events"
  | "sample_frames"
  | "segment_steps"
  | "extract_decisions"
  | "validate_ir";

export interface PipelineProgress {
  stage: PipelineStage;
  status: "started" | "completed" | "skipped" | "failed";
  stageProgress: number;
  overallProgress: number;
  message: string;
}

export interface PipelineNarrationInput {
  audioPath?: string;
  transcript?: TimestampedTranscript;
  languageHint?: string;
}

export interface PipelineVideoInput {
  path: string;
  durationMs: number;
  screenChanges?: ScreenChangeObservation[];
  displayScale?: number;
  displayWidth?: number;
  displayHeight?: number;
}

export interface PipelineInput {
  sessionId: string;
  eventsJsonl: string;
  video: PipelineVideoInput;
  narration?: PipelineNarrationInput;
}

export interface PipelineRunOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PipelineProgress) => void;
}

export interface UnderstandingPipelineOptions<TWorkflow> {
  model: StructuredModelAdapter;
  ir: WorkflowIrAdapter<TWorkflow>;
  transcriber?: TranscriptProvider;
  frameProvider?: FrameProvider;
  eventParsing?: EventParseOptions;
  condensation?: CondensationOptions;
  frameSampling?: FrameSamplingOptions;
}

export interface PipelineModelResults {
  segmentation: ModelInferenceResponse;
  decisions: ModelInferenceResponse;
}

export interface PipelineResult<TWorkflow> {
  workflow: TWorkflow;
  events: CaptureEvent[];
  eventIssues: EventParseIssue[];
  actions: CondensedAction[];
  transcript?: TimestampedTranscript;
  framePlan: FrameSamplingPlan;
  frames: SampledFrame[];
  segmentation: StepSegmentationOutput;
  decisions: DecisionExtractionOutput;
  modelResults: PipelineModelResults;
}

export class PipelineInferenceValidationError extends Error {
  readonly stage: "step_segmentation" | "decision_extraction";
  readonly issues: readonly string[];

  constructor(
    stage: PipelineInferenceValidationError["stage"],
    issues: readonly string[],
  ) {
    super(`Model output for ${stage} failed validation (${issues.length} issue${issues.length === 1 ? "" : "s"}).`);
    this.name = "PipelineInferenceValidationError";
    this.stage = stage;
    this.issues = issues;
  }
}

export class PipelineConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineConfigurationError";
  }
}

const STAGES: readonly PipelineStage[] = [
  "transcribe",
  "ingest_events",
  "condense_events",
  "sample_frames",
  "segment_steps",
  "extract_decisions",
  "validate_ir",
];

const STAGE_WEIGHTS: Readonly<Record<PipelineStage, number>> = {
  transcribe: 0.12,
  ingest_events: 0.08,
  condense_events: 0.1,
  sample_frames: 0.15,
  segment_steps: 0.25,
  extract_decisions: 0.2,
  validate_ir: 0.1,
};

const STAGE_MESSAGES: Readonly<Record<PipelineStage, { started: string; completed: string; skipped: string }>> = {
  transcribe: {
    started: "Transcribing narration",
    completed: "Narration transcribed",
    skipped: "No narration to transcribe",
  },
  ingest_events: {
    started: "Reading captured interactions",
    completed: "Captured interactions read",
    skipped: "No captured interactions to read",
  },
  condense_events: {
    started: "Turning raw input into actions",
    completed: "Raw input condensed into actions",
    skipped: "No interactions to condense",
  },
  sample_frames: {
    started: "Sampling important video frames",
    completed: "Important video frames sampled",
    skipped: "No video frames were needed",
  },
  segment_steps: {
    started: "Drafting workflow steps",
    completed: "Workflow steps drafted",
    skipped: "No workflow steps were needed",
  },
  extract_decisions: {
    started: "Looking for decision points",
    completed: "Decision points extracted",
    skipped: "No decision analysis was needed",
  },
  validate_ir: {
    started: "Checking the workflow draft",
    completed: "Workflow draft checked",
    skipped: "Workflow validation skipped",
  },
};

export class UnderstandingPipeline<TWorkflow> {
  readonly #options: UnderstandingPipelineOptions<TWorkflow>;

  constructor(options: UnderstandingPipelineOptions<TWorkflow>) {
    this.#options = options;
  }

  async run(
    input: PipelineInput,
    runOptions: PipelineRunOptions = {},
  ): Promise<PipelineResult<TWorkflow>> {
    assertValidInput(input);
    const progress = createProgressReporter(runOptions.onProgress);
    const signal = runOptions.signal;

    try {
      assertNotAborted(signal);
      progress.started("transcribe");
      const resolvedTranscript = await this.#resolveTranscript(input, signal);
      let transcript = resolvedTranscript;
      if (resolvedTranscript !== undefined) {
        const transcriptDurationIssues = validateTranscriptDuration(
          resolvedTranscript,
          input.video.durationMs,
          TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS,
        );
        if (transcriptDurationIssues.length > 0) {
          throw new PipelineConfigurationError(
            `The transcript is not aligned to the video (${transcriptDurationIssues.length} issue${transcriptDurationIssues.length === 1 ? "" : "s"}).`,
          );
        }
        transcript = clampTranscriptTail(resolvedTranscript, input.video.durationMs);
      }
      progress.finished("transcribe", transcript === undefined ? "skipped" : "completed");

      assertNotAborted(signal);
      progress.started("ingest_events");
      const parseResult = safeParseEventsJsonl(input.eventsJsonl, {
        ...(this.#options.eventParsing ?? {}),
        expectedSessionId: input.sessionId,
      });
      if (parseResult.issues.some((issue) => issue.severity === "error")) {
        throw new EventsJsonlError(parseResult.issues);
      }
      const capture = excludeReplayCaptureControlTail(parseResult.events);
      const events = capture.events;
      const workflowDurationMs = capture.cutoffMs === undefined
        ? input.video.durationMs
        : Math.min(input.video.durationMs, capture.cutoffMs);
      if (transcript !== undefined && capture.cutoffMs !== undefined) {
        transcript = transcriptBefore(transcript, workflowDurationMs);
      }
      progress.finished("ingest_events", events.length === 0 ? "skipped" : "completed");

      assertNotAborted(signal);
      progress.started("condense_events");
      const actions = condenseEvents(events, this.#options.condensation ?? {});
      progress.finished("condense_events", events.length === 0 ? "skipped" : "completed");

      assertNotAborted(signal);
      progress.started("sample_frames");
      const framePlan = planFrameSamples(
        actions,
        workflowDurationMs,
        screenChangesBefore(
          input.video.screenChanges ?? [],
          workflowDurationMs,
          input.video.durationMs,
        ),
        this.#options.frameSampling ?? {},
      );
      const frames = await this.#resolveFrames(input, framePlan, actions, signal);
      progress.finished("sample_frames", framePlan.frames.length === 0 ? "skipped" : "completed");

      assertNotAborted(signal);
      progress.started("segment_steps");
      const segmentationModelResult = await this.#options.model.generate({
        stage: "step_segmentation",
        prompt: PIPELINE_PROMPTS.stepSegmentation,
        context: {
          sessionId: input.sessionId,
          actions,
          transcript: transcript ?? null,
          framePlan,
        },
        frames,
        cacheKey: createModelCacheKey(
          input.sessionId,
          "step_segmentation",
          PIPELINE_PROMPTS.stepSegmentation,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      const segmentationResult = validateStepSegmentation(
        segmentationModelResult.output,
        actions,
        workflowDurationMs,
        transcript,
      );
      if (!segmentationResult.ok) {
        throw new PipelineInferenceValidationError("step_segmentation", segmentationResult.issues);
      }
      const segmentation = segmentationResult.value;
      progress.finished("segment_steps", "completed");

      assertNotAborted(signal);
      progress.started("extract_decisions");
      const decisionModelResult = await this.#options.model.generate({
        stage: "decision_extraction",
        prompt: PIPELINE_PROMPTS.decisionExtraction,
        context: {
          sessionId: input.sessionId,
          actions,
          transcript: transcript ?? null,
          framePlan,
          segmentation,
        },
        frames,
        cacheKey: createModelCacheKey(
          input.sessionId,
          "decision_extraction",
          PIPELINE_PROMPTS.decisionExtraction,
        ),
        ...(signal === undefined ? {} : { signal }),
      });
      const decisionsResult = validateDecisionExtraction(
        decisionModelResult.output,
        segmentation,
        transcript,
        workflowDurationMs,
      );
      if (!decisionsResult.ok) {
        throw new PipelineInferenceValidationError("decision_extraction", decisionsResult.issues);
      }
      const decisions = decisionsResult.value;
      progress.finished("extract_decisions", "completed");

      assertNotAborted(signal);
      progress.started("validate_ir");
      const evidence: PipelineDraftEvidence = {
        sessionId: input.sessionId,
        actions,
        ...(transcript === undefined ? {} : { transcript }),
        framePlan,
        frames,
        segmentation,
        decisions,
      };
      const candidate = await this.#options.ir.assemble(evidence);
      const validation = this.#options.ir.validate(candidate);
      if (!validation.ok) {
        throw new PipelineIrValidationError(validation.issues);
      }
      progress.finished("validate_ir", "completed");

      return {
        workflow: validation.value,
        events,
        eventIssues: parseResult.issues,
        actions,
        ...(transcript === undefined ? {} : { transcript }),
        framePlan,
        frames,
        segmentation,
        decisions,
        modelResults: {
          segmentation: segmentationModelResult,
          decisions: decisionModelResult,
        },
      };
    } catch (error) {
      progress.failed();
      throw error;
    }
  }

  async #resolveTranscript(
    input: PipelineInput,
    signal: AbortSignal | undefined,
  ): Promise<TimestampedTranscript | undefined> {
    const narration = input.narration;
    if (narration === undefined) {
      return undefined;
    }
    if (narration.transcript !== undefined) {
      assertValidTranscript(narration.transcript);
      return narration.transcript;
    }
    if (narration.audioPath === undefined) {
      throw new PipelineConfigurationError("Narration needs either a transcript or an audio path.");
    }
    if (this.#options.transcriber === undefined) {
      throw new PipelineConfigurationError("An audio transcript provider is not configured.");
    }
    const transcript = await this.#options.transcriber.transcribe({
      sessionId: input.sessionId,
      audioPath: narration.audioPath,
      ...(narration.languageHint === undefined ? {} : { languageHint: narration.languageHint }),
      ...(signal === undefined ? {} : { signal }),
    });
    assertValidTranscript(transcript);
    return transcript;
  }

  async #resolveFrames(
    input: PipelineInput,
    plan: FrameSamplingPlan,
    actions: readonly CondensedAction[],
    signal: AbortSignal | undefined,
  ): Promise<SampledFrame[]> {
    if (plan.frames.length === 0) {
      return [];
    }
    if (this.#options.frameProvider === undefined) {
      throw new PipelineConfigurationError(
        "A frame provider is required when the capture contains actions.",
      );
    }
    const frames = await this.#options.frameProvider.sample({
      sessionId: input.sessionId,
      videoPath: input.video.path,
      plan,
      actions,
      ...(input.video.displayScale === undefined ? {} : { displayScale: input.video.displayScale }),
      ...(input.video.displayWidth === undefined ? {} : { displayWidth: input.video.displayWidth }),
      ...(input.video.displayHeight === undefined ? {} : { displayHeight: input.video.displayHeight }),
      ...(signal === undefined ? {} : { signal }),
    });
    const issues = validateSampledFrames(plan, frames);
    if (issues.length > 0) {
      throw new PipelineConfigurationError(
        `The frame provider returned an invalid sample set (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      );
    }
    return frames;
  }
}

interface ProgressReporter {
  started(stage: PipelineStage): void;
  finished(stage: PipelineStage, status: "completed" | "skipped"): void;
  failed(): void;
}

function createProgressReporter(
  callback: ((progress: PipelineProgress) => void) | undefined,
): ProgressReporter {
  let completedWeight = 0;
  let activeStage: PipelineStage | undefined;
  const notify = (event: PipelineProgress): void => {
    if (callback === undefined) {
      return;
    }
    // UI observers must not be able to corrupt a deterministic pipeline run.
    try {
      callback(event);
    } catch {
      // Deliberately ignored.
    }
  };
  return {
    started(stage) {
      activeStage = stage;
      notify({
        stage,
        status: "started",
        stageProgress: 0,
        overallProgress: completedWeight,
        message: STAGE_MESSAGES[stage].started,
      });
    },
    finished(stage, status) {
      completedWeight = Number(Math.min(1, completedWeight + STAGE_WEIGHTS[stage]).toFixed(10));
      notify({
        stage,
        status,
        stageProgress: 1,
        overallProgress: completedWeight,
        message: STAGE_MESSAGES[stage][status],
      });
      activeStage = undefined;
    },
    failed() {
      if (activeStage === undefined) {
        return;
      }
      notify({
        stage: activeStage,
        status: "failed",
        stageProgress: 0,
        overallProgress: completedWeight,
        message: `${STAGE_MESSAGES[activeStage].started} failed`,
      });
      activeStage = undefined;
    },
  };
}

function transcriptBefore(
  transcript: TimestampedTranscript,
  cutoffMs: number,
): TimestampedTranscript {
  const segments = transcript.segments
    .filter((segment) => segment.startMs < cutoffMs)
    .map((segment) => segment.endMs > cutoffMs
      ? { ...segment, endMs: cutoffMs }
      : segment);
  if (
    segments.length === transcript.segments.length &&
    segments.every((segment, index) => segment === transcript.segments[index])
  ) {
    return transcript;
  }
  return { ...transcript, segments };
}

function screenChangesBefore(
  observations: readonly ScreenChangeObservation[],
  cutoffMs: number,
  recordingDurationMs: number,
): ScreenChangeObservation[] {
  if (cutoffMs === recordingDurationMs) {
    return [...observations];
  }
  return observations.filter((observation) => {
    const validTimestamp = Number.isFinite(observation.timestampMs)
      && observation.timestampMs >= 0
      && observation.timestampMs <= recordingDurationMs;
    const validScore = Number.isFinite(observation.score)
      && observation.score >= 0
      && observation.score <= 1;
    // Keep malformed observations so the planner still rejects them instead
    // of letting recorder-tail filtering hide an upstream contract failure.
    return !validTimestamp || !validScore || observation.timestampMs < cutoffMs;
  });
}

function assertValidInput(input: PipelineInput): void {
  if (input.sessionId.trim() === "") {
    throw new PipelineConfigurationError("A session id is required.");
  }
  if (input.video.path.trim() === "") {
    throw new PipelineConfigurationError("A video path is required.");
  }
  if (!Number.isFinite(input.video.durationMs) || input.video.durationMs < 0) {
    throw new PipelineConfigurationError("Video duration must be a finite, non-negative number.");
  }
  for (const [label, value] of [["display scale", input.video.displayScale], ["display width", input.video.displayWidth], ["display height", input.video.displayHeight]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new PipelineConfigurationError(`Video ${label} must be a finite, positive number.`);
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The pipeline run was aborted.", "AbortError");
  }
}

/** Visible for progress contract tests and desktop weighting previews. */
export function pipelineStages(): readonly PipelineStage[] {
  return STAGES;
}
