import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { FixtureModelAdapter, ModelTransportError, modelAdapterErrorForTransportFailure, type FrameProvider, type TranscriptProvider } from "@replay/pipeline";
import ffmpegStatic from "ffmpeg-static";
import { describe, expect, it, vi } from "vitest";
import { CommandTranscriptProvider, DesktopPipelineService, FfmpegFrameProvider, normalizeAnthropicFailure, parseFfmpegSceneMetadata, parseFfmpegVideoInfo, planTargetCrop, tailFallbackTimestamp } from "./pipeline-service.js";
import { SessionService } from "./session-service.js";
import type { SidecarClient } from "./sidecar-client.js";
import { WorkflowRepository } from "./workflow-repository.js";

const fixtures = fileURLToPath(new URL("../../../../packages/fixtures/", import.meta.url));
const execFileAsync = promisify(execFile);

describe("desktop pipeline adapters", () => {
  it.each([
    [apiFailure(401, "invalid_request_error"), "authentication_failed"],
    [apiFailure(400, "authentication_error"), "authentication_failed"],
    [apiFailure(403, "invalid_request_error"), "model_unavailable"],
    [apiFailure(400, "permission_error"), "model_unavailable"],
    [apiFailure(404, "invalid_request_error"), "model_unavailable"],
    [apiFailure(429, "invalid_request_error"), "rate_limited"],
    [apiFailure(400, "rate_limit_error"), "rate_limited"],
    [apiFailure(402, "invalid_request_error"), "billing_failed"],
    [apiFailure(400, "billing_error"), "billing_failed"],
    [apiFailure(504, "invalid_request_error"), "request_timed_out"],
    [apiFailure(400, "timeout_error"), "request_timed_out"],
    [apiFailure(500, "api_error"), "service_unavailable"],
    [apiFailure(400, "overloaded_error"), "service_unavailable"],
    [new APIConnectionError({ message: "PRIVATE_NETWORK_DETAIL" }), "network_failed"],
    [new APIConnectionTimeoutError({ message: "PRIVATE_TIMEOUT_DETAIL" }), "request_timed_out"],
    [new Error("PRIVATE_UNKNOWN_DETAIL"), "transport_failed"],
  ] as const)("classifies an Anthropic failure as %s without retaining provider data", (cause, expectedCode) => {
    const normalized = normalizeAnthropicFailure(cause);

    expect(normalized).toBeInstanceOf(ModelTransportError);
    expect(normalized.code).toBe(expectedCode);
    expect(String(normalized)).not.toContain("PRIVATE_");
    expect(JSON.stringify(normalized)).not.toContain("PRIVATE_");
    expect((normalized as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(normalized).not.toHaveProperty("headers");
    expect(normalized).not.toHaveProperty("error");
  });

  it("requires an absolute local transcriber path", () => {
    expect(() => new CommandTranscriptProvider("whisper")).toThrow("absolute executable path");
  });

  it("rejects blank API and model settings before processing", () => {
    const sessions = {} as SessionService;
    const workflows = {} as WorkflowRepository;

    expect(() => new DesktopPipelineService(sessions, workflows, { apiKey: "   " })).toThrow("Set ANTHROPIC_API_KEY");
    expect(() => new DesktopPipelineService(sessions, workflows, { apiKey: "test-key", model: "   " })).toThrow("REPLAY_CLAUDE_MODEL is empty");
  });

  it("fails clearly if the bundled video decoder is unavailable", async () => {
    const provider = new FfmpegFrameProvider(null);
    await expect(provider.sample({ sessionId: "session", videoPath: "/tmp/missing.mp4", plan: { version: 1, durationMs: 100, frames: [] } })).rejects.toThrow("video decoder");
  });

  it("parses observed screen changes and scales safe element crops", () => {
    expect(parseFfmpegSceneMetadata("frame:0 pts:25 pts_time:1.25\nlavfi.scene_score=0.72\n", 2_000)).toEqual([{ timestampMs: 1_250, score: 0.72 }]);
    expect(planTargetCrop({ id: "a1", kind: "click", description: "Click", startMs: 0, endMs: 0, sourceEventIds: ["e1"], target: { label: "Approve", bounds: { x: 10, y: 20, width: 30, height: 40 } } }, {
      sessionId: "session",
      videoPath: "video.mp4",
      plan: { version: 1, durationMs: 1, frames: [] },
      displayScale: 2,
      displayWidth: 200,
      displayHeight: 200,
    })).toEqual({ bounds: { x: 10, y: 20, width: 30, height: 40 }, pixels: { x: 20, y: 40, width: 60, height: 80 } });
  });

  it("maps Retina accessibility bounds into the encoded video's real pixel grid", () => {
    const bounds = { x: 306, y: 32, width: 1_170, height: 920 };
    const request = {
      sessionId: "retina-session",
      videoPath: "video.mp4",
      plan: { version: 1 as const, durationMs: 33_342, frames: [] },
      displayScale: 2,
      displayWidth: 3_024,
      displayHeight: 1_964,
    };
    const action = { id: "window", kind: "click" as const, description: "Click", startMs: 0, endMs: 0, sourceEventIds: ["e1"], target: { label: "Window", bounds } };

    expect(planTargetCrop(action, request, { width: 1_512, height: 982, durationMs: 33_258 })).toEqual({
      bounds,
      pixels: bounds,
    });
    expect(planTargetCrop(action, { ...request, displayScale: 1, displayWidth: 1_512, displayHeight: 982 }, { width: 1_512, height: 982, durationMs: 33_258 })).toEqual({
      bounds,
      pixels: bounds,
    });
  });

  it("clips mapped crops to the decoded frame and rejects malformed, outside, and secure targets", () => {
    const request = {
      sessionId: "retina-session",
      videoPath: "video.mp4",
      plan: { version: 1 as const, durationMs: 1_000, frames: [] },
      displayScale: 2,
      displayWidth: 200,
      displayHeight: 200,
    };
    const video = { width: 100, height: 100, durationMs: 1_000 };
    const action = (bounds: { x: number; y: number; width: number; height: number }, secure = false) => ({
      id: "a1",
      kind: "click" as const,
      description: "Click",
      startMs: 0,
      endMs: 0,
      sourceEventIds: ["e1"],
      target: { label: "Target", bounds, ...(secure ? { isSecure: true } : {}) },
    });

    expect(planTargetCrop(action({ x: 90, y: 80, width: 30, height: 40 }), request, video)?.pixels).toEqual({ x: 90, y: 80, width: 10, height: 20 });
    expect(planTargetCrop(action({ x: 101, y: 10, width: 10, height: 10 }), request, video)).toBeUndefined();
    expect(planTargetCrop(action({ x: Number.NaN, y: 10, width: 10, height: 10 }), request, video)).toBeUndefined();
    expect(planTargetCrop(action({ x: 10, y: 10, width: -1, height: 10 }), request, video)).toBeUndefined();
    expect(planTargetCrop(action({ x: 10, y: 10, width: 10, height: 10 }, true), request, video)).toBeUndefined();
  });

  it("parses decoded dimensions and bounds only tail fallback timestamps", () => {
    expect(parseFfmpegVideoInfo("Duration: 00:00:33.26, start: 0.000000\n[Parsed_showinfo_0] n: 0 pts: 0 s:1512x982 i:P")).toEqual({
      width: 1_512,
      height: 982,
      durationMs: 33_260,
    });
    expect(parseFfmpegVideoInfo("Duration: N/A\n[Parsed_showinfo_0] n: 0 s:1512x982")).toBeUndefined();
    expect(tailFallbackTimestamp(5_000, 10_000)).toBe(5_000);
    expect(tailFallbackTimestamp(10_212, 10_192)).toBe(9_962);
  });

  it("samples a real Retina-sized tail frame and crop into owner-only files", async () => {
    if (!ffmpegStatic) throw new Error("The test requires the bundled video decoder");
    const root = await mkdtemp(join(tmpdir(), "replay-retina-frame-"));
    const videoPath = join(root, "video.mp4");
    try {
      await execFileAsync(ffmpegStatic, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", "color=c=blue:s=1512x982:r=30",
        "-t", "0.4",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-y", videoPath,
      ]);
      const bounds = { x: 306, y: 32, width: 1_170, height: 920 };
      const frames = await new FfmpegFrameProvider(ffmpegStatic).sample({
        sessionId: "retina-session",
        videoPath,
        plan: {
          version: 1,
          durationMs: 500,
          frames: [{ id: "frame-retina", timestampMs: 484, reasons: ["after_significant_action"], actionIds: ["window"] }],
        },
        actions: [{ id: "window", kind: "click", description: "Click", startMs: 0, endMs: 484, sourceEventIds: ["e1"], target: { label: "Window", bounds } }],
        displayScale: 2,
        displayWidth: 3_024,
        displayHeight: 1_964,
      });

      expect(frames).toHaveLength(1);
      expect(frames[0]?.timestampMs).toBe(484);
      expect(frames[0]?.dataBase64.length).toBeGreaterThan(0);
      expect(frames[0]?.elementCrops).toEqual([{ actionId: "window", path: "frames/crops/frame-retina-window-target.jpg", bounds }]);
      expect((await stat(join(root, "frames"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "frames/crops"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "frames/frame-retina.jpg"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, "frames/crops/frame-retina-window-target.jpg"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects a materially truncated video instead of masking missing evidence", async () => {
    if (!ffmpegStatic) throw new Error("The test requires the bundled video decoder");
    const root = await mkdtemp(join(tmpdir(), "replay-truncated-frame-"));
    const videoPath = join(root, "video.mp4");
    try {
      await execFileAsync(ffmpegStatic, [
        "-hide_banner", "-loglevel", "error",
        "-f", "lavfi",
        "-i", "color=c=blue:s=64x64:r=30",
        "-t", "0.2",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-pix_fmt", "yuv420p",
        "-y", videoPath,
      ]);
      await expect(new FfmpegFrameProvider(ffmpegStatic).sample({
        sessionId: "truncated-session",
        videoPath,
        plan: { version: 1, durationMs: 1_000, frames: [{ id: "late", timestampMs: 1_000, reasons: ["after_significant_action"], actionIds: [] }] },
      })).rejects.toThrow("video ends too early");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("processes a saved session through inference and persists its draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-pipeline-service-"));
    const sessionId = "invoice-match-demo";
    await mkdir(join(root, "sessions"), { recursive: true });
    await cp(join(fixtures, "recordings/invoice-match"), join(root, "sessions", sessionId), { recursive: true });
    const sessions = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
    const workflows = new WorkflowRepository(root);
    const cache = JSON.parse(await readFile(join(fixtures, "model-outputs/invoice-match.cache.json"), "utf8")) as Record<string, unknown>;
    const frameProvider: FrameProvider = {
      async sample({ plan }) {
        return plan.frames.map((frame) => ({ id: frame.id, timestampMs: frame.timestampMs, mimeType: "image/png", dataBase64: "AA==" }));
      },
    };
    const progress: string[] = [];
    const view = await new DesktopPipelineService(sessions, workflows, {
      modelAdapter: new FixtureModelAdapter(cache),
      frameProvider,
      videoValidator: { async validate() {} },
      screenChangeProvider: { async detect() { return [{ timestampMs: 2_400, score: 0.91 }]; } },
      onProgress: (update) => progress.push(`${update.stage}:${update.progress}`),
    }).process(sessionId);
    const stored = await workflows.get(view.id);
    expect(view).toMatchObject({ sessionId, revision: 1, status: "draft" });
    expect(stored.metadata).toMatchObject({ revision: 1, approval: { status: "draft" } });
    expect(stored.steps.flatMap((step) => step.provenance.timestampRefs).some((reference) => reference.sessionId === sessionId)).toBe(true);
    expect(progress.at(-1)).toBe("saving:1");
    await expect(workflows.approve(view.id)).resolves.toMatchObject({ status: "approved", revision: 2 });
  });

  it.each([
    { status: "interrupted", partial: true },
    { status: "interrupted", partial: false },
    { status: "completed", partial: true },
  ] as const)("rejects an incomplete $status recording before any media provider runs", async ({ status, partial }) => {
    const harness = await pipelineHarness({ status, partial, video: "not-used" });

    await expect(harness.service.process(harness.sessionId)).rejects.toThrow("incomplete because capture was interrupted");
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.sample).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", video: undefined, message: "video is missing" },
    { label: "empty", video: "", message: "video is empty" },
  ])("reports a $label video before any media provider runs", async ({ video, message }) => {
    const harness = await pipelineHarness({ video });

    await expect(harness.service.process(harness.sessionId)).rejects.toThrow(message);
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.sample).not.toHaveBeenCalled();
  });

  it("reports an unreadable video before any media provider runs", async () => {
    const harness = await pipelineHarness({ video: "this is not a video" });

    await expect(harness.service.process(harness.sessionId)).rejects.toThrow("cannot read this recording's video");
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.sample).not.toHaveBeenCalled();
  });

  it("checks model access after validating video and before processing private media", async () => {
    const order: string[] = [];
    const validateVideo = vi.fn(async () => { order.push("video"); });
    const validateModel = vi.fn(async () => {
      order.push("model");
      throw modelAdapterErrorForTransportFailure("authentication_failed");
    });
    const harness = await pipelineHarness({
      video: "video bytes are not inspected by injected validator",
      videoValidator: { validate: validateVideo },
      modelPreflight: { validate: validateModel },
    });

    await expect(harness.service.process(harness.sessionId)).rejects.toThrow("Update ANTHROPIC_API_KEY");
    expect(order).toEqual(["video", "model"]);
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.detect).not.toHaveBeenCalled();
    expect(harness.sample).not.toHaveBeenCalled();
  });
});

function apiFailure(status: number, type: string): APIError {
  return APIError.generate(
    status,
    { error: { type, message: `PRIVATE_PROVIDER_${status}_${type}` } },
    undefined,
    new Headers({ authorization: `PRIVATE_HEADER_${status}` }),
  );
}

async function pipelineHarness(options: {
  status?: "completed" | "interrupted";
  partial?: boolean;
  video?: string;
  videoValidator?: { validate(videoPath: string): Promise<void> };
  modelPreflight?: { validate(): Promise<void> };
}) {
  const root = await mkdtemp(join(tmpdir(), "replay-pipeline-preflight-"));
  const sessionId = "media-preflight";
  const sessionDirectory = join(root, "sessions", sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    status: options.status ?? "completed",
    partial: options.partial ?? false,
    startedAt: "2026-08-17T10:00:00.000Z",
    stoppedAt: "2026-08-17T10:00:01.000Z",
    display: { width: 100, height: 100, scale: 1 },
    narration: true,
    appVersions: {},
    eventCount: 0,
  }));
  await writeFile(join(sessionDirectory, "events.jsonl"), "");
  if (options.video !== undefined) await writeFile(join(sessionDirectory, "video.mp4"), options.video);

  const transcribe = vi.fn<TranscriptProvider["transcribe"]>();
  const detect = vi.fn(async () => []);
  const sample = vi.fn<FrameProvider["sample"]>();
  const sessions = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
  const service = new DesktopPipelineService(sessions, new WorkflowRepository(root), {
    modelAdapter: new FixtureModelAdapter({}),
    transcriptProvider: { transcribe },
    screenChangeProvider: { detect },
    frameProvider: { sample },
    ...(options.videoValidator ? { videoValidator: options.videoValidator } : {}),
    ...(options.modelPreflight ? { modelPreflight: options.modelPreflight } : {}),
  });
  return { service, sessionId, transcribe, detect, sample };
}
