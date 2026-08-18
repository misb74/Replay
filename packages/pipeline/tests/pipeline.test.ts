import { validateWorkflow, type Workflow } from "@replay/ir";
import { describe, expect, it } from "vitest";

import {
  FixtureModelAdapter,
  PipelineConfigurationError,
  PipelineInferenceValidationError,
  PipelineIrValidationError,
  UnderstandingPipeline,
  createReplayIrAdapter,
  type AccessibilityTarget,
  type CaptureEvent,
  type CondensedAction,
  type FrameProvider,
  type FrameProviderRequest,
  type ModelInferenceRequest,
  type PipelineProgress,
  type StructuredModelAdapter,
  type TimestampedTranscript,
} from "../src/index.js";
import { fixtureJson, fixtureText } from "./fixture.js";

const frameProvider: FrameProvider = {
  async sample({ plan }) {
    return plan.frames.map((frame) => ({
      id: frame.id,
      timestampMs: frame.timestampMs,
      mimeType: "image/png",
      dataBase64: "AA==",
      ...(frame.actionIds[0]
        ? {
            elementCrops: [{
              actionId: frame.actionIds[0],
              path: `crops/${frame.id}-${frame.actionIds[0]}.png`,
              bounds: { x: 10, y: 20, width: 120, height: 40 },
            }],
          }
        : {}),
    }));
  },
};

describe("understanding pipeline", () => {
  it("runs the full invoice fixture offline and returns validated draft IR", async () => {
    const model = new FixtureModelAdapter(
      fixtureJson("model-outputs/invoice-match.cache.json") as Record<string, unknown>,
    );
    const progress: PipelineProgress[] = [];
    const pipeline = new UnderstandingPipeline({
      model,
      frameProvider,
      ir: createReplayIrAdapter({
        now: () => new Date("2026-08-16T18:01:00.000Z"),
        workflowId: "workflow-invoice-match",
      }),
    });

    const result = await pipeline.run(
      {
        sessionId: "invoice-match-demo",
        eventsJsonl: fixtureText("recordings/invoice-match/events.jsonl"),
        video: {
          path: "video.mp4",
          durationMs: 4_500,
          screenChanges: [{ timestampMs: 2_400, score: 0.91, actionId: "action-0003" }],
        },
        narration: {
          transcript: fixtureJson(
            "recordings/invoice-match/transcript.json",
          ) as TimestampedTranscript,
        },
      },
      { onProgress: (event) => progress.push(event) },
    );

    expect(validateWorkflow(result.workflow)).toEqual({ ok: true, value: result.workflow });
    expect(result.actions).toHaveLength(5);
    expect(result.modelResults.segmentation.cached).toBe(true);
    expect(result.modelResults.decisions.cached).toBe(true);
    expect(model.requests).toHaveLength(2);
    expect(progress).toHaveLength(14);
    expect(progress.at(-1)).toMatchObject({
      stage: "validate_ir",
      status: "completed",
      overallProgress: 1,
    });
    expect(progress.map((event) => event.overallProgress)).toEqual(
      [...progress.map((event) => event.overallProgress)].sort((a, b) => a - b),
    );

    const workflow = result.workflow;
    expect(workflow.metadata.approval).toEqual({ status: "draft" });
    expect(workflow.steps.map((step) => step.id)).toEqual(["step-001"]);
    expect(workflow.steps[0]?.decisions?.[0]).toMatchObject({
      id: "decision-001",
      then: [{ kind: "step", id: "step-002" }],
      else: [{ kind: "step", id: "decision-001-else-narrated" }],
    });
    expect(result.framePlan.frames.some((frame) => frame.reasons.includes("observed_screen_change") && frame.actionIds.includes("action-0003"))).toBe(true);
    expect(workflow.steps[0]?.actions[0]).toMatchObject({
      target: { screenshotCrop: { path: expect.stringMatching(/^crops\//u), capturedAtMs: expect.any(Number) } },
    });
    expect(JSON.stringify(workflow)).toContain("Approve invoice");
    expect(JSON.stringify(workflow)).toContain("Flag difference");
  });

  it("keeps Replay's terminal recording controls out of every workflow evidence boundary", async () => {
    const requests: ModelInferenceRequest[] = [];
    const sampled: FrameProviderRequest[] = [];
    const model: StructuredModelAdapter = {
      async generate(request) {
        requests.push(request);
        const context = request.context as { actions: CondensedAction[] };
        const actions = context.actions;
        if (request.stage === "step_segmentation") {
          return {
            model: "fixture",
            cached: false,
            output: {
              name: "Recorded task",
              goal: "Repeat the recorded task",
              parameters: [],
              steps: [{
                id: "step-001",
                intent: "Complete the recorded task",
                actionIds: actions.map((action) => action.id),
                expects: ["The task is complete"],
                source: "recorded",
                timestampRefs: [{
                  startMs: actions[0]?.startMs ?? 0,
                  endMs: actions.at(-1)?.endMs ?? 0,
                }],
              }],
            },
          };
        }
        return {
          model: "fixture",
          cached: false,
          output: { decisions: [], questions: [] },
        };
      },
    };
    const localFrames: FrameProvider = {
      async sample(request) {
        sampled.push(request);
        return request.plan.frames.map((frame) => ({
          id: frame.id,
          timestampMs: frame.timestampMs,
          mimeType: "image/png",
          dataBase64: "AA==",
        }));
      },
    };
    const pipeline = new UnderstandingPipeline({
      model,
      frameProvider: localFrames,
      ir: createReplayIrAdapter({
        now: () => new Date("2026-08-18T06:00:00.000Z"),
        workflowId: "workflow-capture-tail",
      }),
    });
    const sessionId = "capture-tail";
    const events = [
      captureEvent(sessionId, "other-electron", 1_000, "click", {
        bundleId: "com.github.Electron",
        windowTitle: "Another Electron app",
        role: "AXButton",
        label: "Continue",
      }, { position: { x: 500, y: 400 }, button: "left", clickCount: 1 }),
      captureEvent(sessionId, "earlier-replay-switch", 2_000, "app_switch", replayTarget()),
      captureEvent(sessionId, "earlier-replay-task", 2_100, "click", {
        ...replayTarget(),
        role: "AXButton",
        label: "Open workflow",
      }, { position: { x: 150, y: 300 }, button: "left", clickCount: 1 }),
      captureEvent(sessionId, "task-app-switch", 3_000, "app_switch", {
        bundleId: "com.apple.TextEdit",
        windowTitle: "Untitled",
        role: "AXTextArea",
      }),
      captureEvent(sessionId, "task-click", 3_100, "click", {
        bundleId: "com.apple.TextEdit",
        windowTitle: "Untitled",
        role: "AXButton",
        label: "Save",
      }, { position: { x: 200, y: 150 }, button: "left", clickCount: 1 }),
      captureEvent(sessionId, "cleanup-app", 8_736, "app_switch", replayTarget()),
      captureEvent(sessionId, "cleanup-window", 8_736, "window_switch", replayTarget()),
      captureEvent(sessionId, "cleanup-jitter", 8_875, "drag", replayTarget(), {
        drag: { start: { x: 855.49, y: 661.59 }, end: { x: 855.49, y: 661.86 } },
        button: "left",
      }),
      captureEvent(sessionId, "cleanup-stop", 10_211, "drag", {
        ...replayTarget(),
        role: "AXStaticText",
        value: "Stop recording",
        bounds: { x: 97, y: 135, width: 116, height: 19 },
      }, {
        drag: { start: { x: 192.01, y: 137.33 }, end: { x: 192.01, y: 137.45 } },
        button: "left",
      }),
    ];
    const transcript: TimestampedTranscript = {
      version: 1,
      segments: [
        { id: "task-narration", startMs: 500, endMs: 3_500, text: "Complete the task." },
        { id: "recorder-narration", startMs: 9_000, endMs: 10_000, text: "Stop the capture." },
      ],
    };

    const result = await pipeline.run({
      sessionId,
      eventsJsonl: events.map((event) => JSON.stringify(event)).join("\n"),
      video: {
        path: "video.mp4",
        durationMs: 11_000,
        screenChanges: [
          { timestampMs: 4_000, score: 0.8 },
          { timestampMs: 9_000, score: 0.9 },
        ],
      },
      narration: { transcript },
    });

    const retainedEventIds = new Set(result.events.map((event) => event.id));
    const actionIds = new Set(result.actions.map((action) => action.id));
    expect(result.events.map((event) => event.id)).toEqual([
      "other-electron",
      "earlier-replay-switch",
      "earlier-replay-task",
      "task-app-switch",
      "task-click",
    ]);
    expect(result.actions.every((action) => action.sourceEventIds.every((id) => retainedEventIds.has(id)))).toBe(true);
    expect(result.framePlan.durationMs).toBe(8_736);
    expect(result.framePlan.frames.every((frame) =>
      frame.timestampMs < 8_736 && frame.actionIds.every((id) => actionIds.has(id))
    )).toBe(true);
    expect(sampled[0]?.plan).toEqual(result.framePlan);
    expect(result.transcript?.segments.map((segment) => segment.id)).toEqual(["task-narration"]);
    expect(JSON.stringify(requests.map((request) => request.context))).not.toContain("Stop recording");
    expect(result.segmentation.steps[0]?.actionIds.every((id) => actionIds.has(id))).toBe(true);
    expect(result.workflow.steps[0]?.actions.map((action) => action.id)).toEqual(
      result.actions.map((action) => action.id),
    );
    expect(result.workflow.metadata.approval).toEqual({ status: "draft" });
  });

  it("stops before IR assembly when a model invents an action", async () => {
    const cache = fixtureJson("model-outputs/invoice-match.cache.json") as Record<string, unknown>;
    const invalid = structuredClone(
      cache["invoice-match-demo/step_segmentation/step-segmentation.v1"],
    ) as { steps: Array<{ actionIds: string[] }> };
    invalid.steps[0]?.actionIds.push("not-recorded");
    cache["invoice-match-demo/step_segmentation/step-segmentation.v1"] = invalid;
    const pipeline = new UnderstandingPipeline({
      model: new FixtureModelAdapter(cache),
      frameProvider,
      ir: createReplayIrAdapter(),
    });
    const progress: PipelineProgress[] = [];

    await expect(runInvoicePipeline(pipeline, progress)).rejects.toBeInstanceOf(
      PipelineInferenceValidationError,
    );
    expect(progress.at(-1)).toMatchObject({ stage: "segment_steps", status: "failed" });
  });

  it("refuses to return a candidate rejected by the IR package boundary", async () => {
    const pipeline = new UnderstandingPipeline<Workflow>({
      model: new FixtureModelAdapter(
        fixtureJson("model-outputs/invoice-match.cache.json") as Record<string, unknown>,
      ),
      frameProvider,
      ir: {
        assemble: () => ({ version: 1 }),
        validate: validateWorkflow,
      },
    });

    await expect(runInvoicePipeline(pipeline)).rejects.toBeInstanceOf(PipelineIrValidationError);
  });

  it("never sends a broken producer's secure text to the model boundary", async () => {
    const model = new FixtureModelAdapter({
      "secure-defense/step_segmentation/step-segmentation.v1": {
        name: "Sign in",
        goal: "Enter the protected value.",
        parameters: [
          {
            name: "password",
            type: "secret",
            example: { param: "password", vault: true },
            description: "The protected password.",
            actionIds: ["action-0002"],
          },
        ],
        steps: [
          {
            id: "step-sign-in",
            intent: "Enter the protected password",
            actionIds: ["action-0001", "action-0002"],
            expects: ["The protected value is accepted"],
            source: "recorded",
            timestampRefs: [{ startMs: 0, endMs: 150 }],
          },
        ],
      },
      "secure-defense/decision_extraction/decision-extraction.v1": {
        decisions: [],
        questions: [],
      },
    });
    const pipeline = new UnderstandingPipeline({
      model,
      frameProvider,
      ir: createReplayIrAdapter({ now: () => new Date("2026-08-16T18:00:00.000Z") }),
    });

    const result = await pipeline.run({
      sessionId: "secure-defense",
      eventsJsonl: fixtureText("security/adversarial-secure-leak.jsonl"),
      video: { path: "video.mp4", durationMs: 500 },
    });

    expect(JSON.stringify(model.requests)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(result.workflow)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(result.workflow.parameters[0]).toMatchObject({
      name: "password",
      type: "secret",
      example: { param: "password", vault: true },
    });
  });

  it("accepts bounded Whisper tail drift and clamps the transcript to the video", async () => {
    const model = new FixtureModelAdapter(
      fixtureJson("model-outputs/invoice-match.cache.json") as Record<string, unknown>,
    );
    const transcript = fixtureJson(
      "recordings/invoice-match/transcript.json",
    ) as TimestampedTranscript;
    transcript.segments[2] = { ...transcript.segments[2]!, endMs: 4_750 };
    const pipeline = new UnderstandingPipeline({
      model,
      frameProvider,
      ir: createReplayIrAdapter(),
    });

    const result = await pipeline.run({
      sessionId: "invoice-match-demo",
      eventsJsonl: fixtureText("recordings/invoice-match/events.jsonl"),
      video: { path: "video.mp4", durationMs: 4_500 },
      narration: { transcript },
    });

    expect(result.transcript?.segments[2]?.endMs).toBe(4_500);
    expect(transcript.segments[2]?.endMs).toBe(4_750);
    const firstContext = model.requests[0]?.context as { transcript?: TimestampedTranscript };
    expect(firstContext.transcript?.segments[2]?.endMs).toBe(4_500);
    expect(model.requests).toHaveLength(2);
  });

  it("still rejects transcript tail drift beyond the bounded tolerance", async () => {
    const model = new FixtureModelAdapter(
      fixtureJson("model-outputs/invoice-match.cache.json") as Record<string, unknown>,
    );
    const transcript = fixtureJson(
      "recordings/invoice-match/transcript.json",
    ) as TimestampedTranscript;
    transcript.segments[2] = { ...transcript.segments[2]!, endMs: 4_751 };
    const pipeline = new UnderstandingPipeline({
      model,
      frameProvider,
      ir: createReplayIrAdapter(),
    });

    await expect(pipeline.run({
      sessionId: "invoice-match-demo",
      eventsJsonl: fixtureText("recordings/invoice-match/events.jsonl"),
      video: { path: "video.mp4", durationMs: 4_500 },
      narration: { transcript },
    })).rejects.toBeInstanceOf(PipelineConfigurationError);
    expect(model.requests).toHaveLength(0);
  });
});

function runInvoicePipeline(
  pipeline: UnderstandingPipeline<Workflow>,
  progress?: PipelineProgress[],
): Promise<unknown> {
  return pipeline.run(
    {
      sessionId: "invoice-match-demo",
      eventsJsonl: fixtureText("recordings/invoice-match/events.jsonl"),
      video: { path: "video.mp4", durationMs: 4_500 },
      narration: {
        transcript: fixtureJson("recordings/invoice-match/transcript.json") as TimestampedTranscript,
      },
    },
    progress === undefined ? {} : { onProgress: (event) => progress.push(event) },
  );
}

function replayTarget(): AccessibilityTarget {
  return {
    bundleId: "com.github.Electron",
    windowTitle: "Replay",
    role: "AXGroup",
    subrole: "AXLandmarkMain",
    bounds: { x: 306, y: 32, width: 1_170, height: 920 },
  };
}

function captureEvent(
  sessionId: string,
  id: string,
  timestampMs: number,
  type: CaptureEvent["type"],
  target: AccessibilityTarget,
  detail: Partial<Omit<CaptureEvent, "schemaVersion" | "sessionId" | "id" | "timestampMs" | "type" | "target">> = {},
): CaptureEvent {
  return { schemaVersion: 1, sessionId, id, timestampMs, type, target, ...detail };
}
