import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from "@anthropic-ai/sdk";
import ffmpegStatic from "ffmpeg-static";
import {
  ClaudeModelAdapter,
  UnderstandingPipeline,
  assertValidTranscript,
  createReplayIrAdapter,
  type ClaudeMessagesTransport,
  type FrameProvider,
  type FrameProviderRequest,
  type ElementCropEvidence,
  type PipelineProgress,
  type SampledFrame,
  type ScreenChangeObservation,
  type StructuredModelAdapter,
  type TimestampedTranscript,
  type TranscriptProvider,
  type TranscriptionRequest,
  type CondensedAction,
  TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS,
  isSecureTarget,
  modelAdapterErrorForTransportFailure,
  ModelAdapterError,
  ModelTransportError,
  type ModelTransportErrorCode,
} from "@replay/pipeline";
import type { ProcessingUpdate, WorkflowView } from "../shared/contracts.js";
import { SessionService } from "./session-service.js";
import { WorkflowRepository } from "./workflow-repository.js";

export interface PipelineServiceOptions {
  apiKey?: string;
  model?: string;
  transcriberCommand?: string;
  onProgress?: (update: ProcessingUpdate) => void;
  modelAdapter?: StructuredModelAdapter;
  frameProvider?: FrameProvider;
  transcriptProvider?: TranscriptProvider;
  screenChangeProvider?: ScreenChangeProvider;
  videoValidator?: RecordingVideoValidator;
  modelPreflight?: ModelPreflight;
}

export interface ScreenChangeProvider {
  detect(input: { videoPath: string; durationMs: number; signal?: AbortSignal }): Promise<ScreenChangeObservation[]>;
}

export interface RecordingVideoValidator {
  validate(videoPath: string): Promise<void>;
}

export interface ModelPreflight {
  validate(): Promise<void>;
}

export class DesktopPipelineService {
  readonly #model: StructuredModelAdapter;
  readonly #transcriber: TranscriptProvider | undefined;
  readonly #frameProvider: FrameProvider;
  readonly #screenChangeProvider: ScreenChangeProvider;
  readonly #videoValidator: RecordingVideoValidator;
  readonly #modelPreflight: ModelPreflight | undefined;
  readonly #onProgress: ((update: ProcessingUpdate) => void) | undefined;

  constructor(
    private readonly sessions: SessionService,
    private readonly workflows: WorkflowRepository,
    options: PipelineServiceOptions,
  ) {
    let defaultModelPreflight: ModelPreflight | undefined;
    if (options.modelAdapter) this.#model = options.modelAdapter;
    else {
      const apiKey = options.apiKey?.trim();
      if (!apiKey) throw new ModelAdapterError("authentication_failed", "Replay has no Anthropic API key. Set ANTHROPIC_API_KEY, restart Replay, and try again.");
      const model = (options.model ?? "claude-sonnet-5").trim();
      if (!model) throw new ModelAdapterError("invalid_request", "REPLAY_CLAUDE_MODEL is empty. Set it to a Claude model id, restart Replay, and try again.");
      const client = new Anthropic({ apiKey });
      this.#model = new ClaudeModelAdapter({
        model,
        transport: new AnthropicTransport(client),
      });
      defaultModelPreflight = {
        validate: () => preflightAnthropicModel(client, model),
      };
    }
    this.#transcriber = options.transcriptProvider ?? (options.transcriberCommand ? new CommandTranscriptProvider(options.transcriberCommand) : undefined);
    this.#frameProvider = options.frameProvider ?? new FfmpegFrameProvider();
    this.#screenChangeProvider = options.screenChangeProvider ?? new FfmpegScreenChangeProvider();
    this.#videoValidator = options.videoValidator ?? new FfmpegRecordingVideoValidator();
    this.#modelPreflight = options.modelPreflight ?? defaultModelPreflight;
    this.#onProgress = options.onProgress;
  }

  async process(sessionId: string): Promise<WorkflowView> {
    const metadata = await this.sessions.readMetadata(sessionId);
    if (metadata.status === "recording") throw new Error("Stop the recording before building its workflow");
    if (metadata.status === "interrupted" || metadata.partial) {
      throw new Error("This recording is incomplete because capture was interrupted. Make a new recording before building a workflow.");
    }
    const videoPath = this.sessions.videoPath(sessionId);
    await this.#videoValidator.validate(videoPath);
    await this.#modelPreflight?.validate();
    const eventsJsonl = await this.sessions.readEvents(sessionId);
    const durationMs = Math.max(
      metadata.lastEventTimestampMs ?? 0,
      metadata.stoppedAt ? Date.parse(metadata.stoppedAt) - Date.parse(metadata.startedAt) : 0,
    );
    const transcript = metadata.narration ? await this.#existingTranscript(sessionId) : undefined;
    if (metadata.narration && !transcript && !this.#transcriber) {
      throw new Error("This recording includes narration, but no local transcriber is configured. Set REPLAY_TRANSCRIBE_COMMAND or add transcript.json to the session.");
    }
    const screenChanges = await this.#screenChangeProvider.detect({ videoPath, durationMs: Math.max(0, durationMs) });
    const pipeline = new UnderstandingPipeline({
      model: this.#model,
      ir: createReplayIrAdapter(),
      frameProvider: this.#frameProvider,
      ...(this.#transcriber ? { transcriber: this.#transcriber } : {}),
    });
    const result = await pipeline.run({
      sessionId,
      eventsJsonl,
      video: {
        path: videoPath,
        durationMs: Math.max(0, durationMs),
        screenChanges,
        displayScale: metadata.display.scale,
        displayWidth: metadata.display.width,
        displayHeight: metadata.display.height,
      },
      ...(metadata.narration
        ? { narration: transcript ? { transcript } : { audioPath: this.sessions.audioPath(sessionId) } }
        : {}),
    }, {
      onProgress: (progress) => this.#onProgress?.(progressToView(sessionId, progress)),
    });
    return this.workflows.create(result.workflow);
  }

  async #existingTranscript(sessionId: string): Promise<TimestampedTranscript | undefined> {
    try {
      const candidate = JSON.parse(await readFile(join(this.sessions.directory(sessionId), "transcript.json"), "utf8")) as unknown;
      assertValidTranscript(candidate);
      return candidate;
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
  }
}

export class FfmpegRecordingVideoValidator implements RecordingVideoValidator {
  constructor(private readonly executable: string | null = bundledFfmpegPath()) {}

  async validate(videoPath: string): Promise<void> {
    await assertReadableVideoFile(videoPath);
    if (!this.executable) throw new Error("Replay could not locate its bundled video decoder");
    try {
      await runProcess(this.executable, [
        "-loglevel", "error",
        "-i", videoPath,
        "-map", "0:v:0",
        "-frames:v", "1",
        "-f", "null",
        "-",
      ]);
    } catch {
      throw new Error("Replay cannot read this recording's video. Make a new recording before building a workflow.");
    }
  }
}

export class AnthropicTransport implements ClaudeMessagesTransport {
  constructor(private readonly client: Anthropic) {}

  async createMessage(request: Parameters<ClaudeMessagesTransport["createMessage"]>[0]) {
    try {
      const response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.max_tokens,
        system: request.system,
        messages: request.messages,
      }, request.signal ? { signal: request.signal } : undefined);
      return {
        model: response.model,
        content: response.content.map((block) => block.type === "text" ? { type: block.type, text: block.text } : { type: block.type }),
        usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      };
    } catch (cause) {
      throw normalizeAnthropicFailure(cause);
    }
  }
}

/** Convert SDK failures to a fixed, data-free category before they reach IPC. */
export function normalizeAnthropicFailure(cause: unknown): ModelTransportError {
  return new ModelTransportError(anthropicFailureCode(cause));
}

async function preflightAnthropicModel(client: Anthropic, model: string): Promise<void> {
  try {
    const info = await client.models.retrieve(model);
    if (info.capabilities?.image_input.supported === false) {
      throw new ModelTransportError("model_unavailable");
    }
  } catch (cause) {
    const failure = cause instanceof ModelTransportError ? cause : normalizeAnthropicFailure(cause);
    throw modelAdapterErrorForTransportFailure(failure.code);
  }
}

function anthropicFailureCode(cause: unknown): ModelTransportErrorCode {
  if (cause instanceof APIConnectionTimeoutError) return "request_timed_out";
  if (cause instanceof APIConnectionError) return "network_failed";
  if (!(cause instanceof APIError)) return "transport_failed";

  switch (cause.type) {
    case "authentication_error":
      return "authentication_failed";
    case "permission_error":
    case "not_found_error":
      return "model_unavailable";
    case "rate_limit_error":
      return "rate_limited";
    case "billing_error":
      return "billing_failed";
    case "timeout_error":
      return "request_timed_out";
    case "overloaded_error":
      return "service_unavailable";
  }

  if (cause.status === 401) return "authentication_failed";
  if (cause.status === 402) return "billing_failed";
  if (cause.status === 403 || cause.status === 404) return "model_unavailable";
  if (cause.status === 408 || cause.status === 504) return "request_timed_out";
  if (cause.status === 429) return "rate_limited";
  if (typeof cause.status === "number" && cause.status >= 500) return "service_unavailable";
  return "transport_failed";
}

export class FfmpegFrameProvider implements FrameProvider {
  constructor(private readonly executable: string | null = bundledFfmpegPath()) {}

  async sample(request: FrameProviderRequest): Promise<SampledFrame[]> {
    if (!this.executable) throw new Error("Replay could not locate its bundled video decoder");
    const video = await inspectVideo(this.executable, request.videoPath, request.signal);
    const tailDriftMs = request.plan.durationMs - video.durationMs;
    if (tailDriftMs > TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS) {
      throw new Error("This recording's video ends too early to sample the recorded actions. Make a new recording before building a workflow.");
    }
    const outputDirectory = join(dirname(request.videoPath), "frames");
    const cropsDirectory = join(outputDirectory, "crops");
    await ensurePrivateDirectory(outputDirectory);
    await ensurePrivateDirectory(cropsDirectory);
    const actions = new Map((request.actions ?? []).map((action) => [action.id, action]));
    const frames: SampledFrame[] = [];
    for (const planned of request.plan.frames) {
      if (!/^[A-Za-z0-9_-]+$/u.test(planned.id)) throw new Error("The frame plan contains an unsafe id");
      if (request.signal?.aborted) throw abortReason(request.signal);
      const outputPath = join(outputDirectory, `${planned.id}.jpg`);
      const seekTimestampMs = planned.timestampMs;
      const fallbackTimestampMs = tailFallbackTimestamp(planned.timestampMs, video.durationMs);
      let data: Buffer;
      try {
        data = await extractPrivateJpeg({
          executable: this.executable,
          videoPath: request.videoPath,
          outputPath,
          timestampMs: seekTimestampMs,
          fallbackTimestampMs,
          quality: 3,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (cause) {
        if (request.signal?.aborted) throw abortReason(request.signal);
        throw new Error(`Replay could not sample frame ${planned.id} from this recording.`, { cause });
      }
      const elementCrops: ElementCropEvidence[] = [];
      for (const actionId of planned.actionIds) {
        const action = actions.get(actionId);
        const crop = action ? planTargetCrop(action, request, video) : undefined;
        if (!crop) continue;
        const cropName = `${planned.id}-${safeAssetPart(actionId)}-target.jpg`;
        const cropPath = join(cropsDirectory, cropName);
        try {
          await extractPrivateJpeg({
            executable: this.executable,
            videoPath: request.videoPath,
            outputPath: cropPath,
            timestampMs: seekTimestampMs,
            fallbackTimestampMs,
            quality: 2,
            crop: crop.pixels,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          });
        } catch (cause) {
          if (request.signal?.aborted) throw abortReason(request.signal);
          throw new Error(`Replay could not crop target evidence for frame ${planned.id}.`, { cause });
        }
        elementCrops.push({ actionId, path: `frames/crops/${cropName}`, bounds: crop.bounds });
      }
      frames.push({
        id: planned.id,
        timestampMs: planned.timestampMs,
        mimeType: "image/jpeg",
        dataBase64: data.toString("base64"),
        sha256: createHash("sha256").update(data).digest("hex"),
        ...(elementCrops.length > 0 ? { elementCrops } : {}),
      });
    }
    return frames;
  }
}

export class FfmpegScreenChangeProvider implements ScreenChangeProvider {
  constructor(private readonly executable: string | null = bundledFfmpegPath()) {}

  async detect(input: { videoPath: string; durationMs: number; signal?: AbortSignal }): Promise<ScreenChangeObservation[]> {
    if (input.durationMs <= 0) return [];
    if (!this.executable) throw new Error("Replay could not locate its bundled video decoder");
    const output = await runProcess(this.executable, [
      "-loglevel", "error",
      "-i", input.videoPath,
      "-filter:v", "select=gt(scene\\,0.20),metadata=print:file=-",
      "-an",
      "-f", "null",
      "-",
    ], input.signal);
    return parseFfmpegSceneMetadata(output, input.durationMs);
  }
}

export function parseFfmpegSceneMetadata(output: string, durationMs: number): ScreenChangeObservation[] {
  const observations: ScreenChangeObservation[] = [];
  let timestampMs: number | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const time = /pts_time:([0-9]+(?:\.[0-9]+)?)/u.exec(line)?.[1];
    if (time !== undefined) timestampMs = Number(time) * 1_000;
    const score = /lavfi\.scene_score=([0-9]+(?:\.[0-9]+)?)/u.exec(line)?.[1];
    if (score === undefined || timestampMs === undefined) continue;
    const value = Number(score);
    if (Number.isFinite(timestampMs) && timestampMs >= 0 && timestampMs <= durationMs && Number.isFinite(value) && value >= 0 && value <= 1) observations.push({ timestampMs, score: value });
    timestampMs = undefined;
  }
  return observations;
}

export interface DecodedVideoInfo {
  width: number;
  height: number;
  durationMs: number;
}

export function planTargetCrop(action: CondensedAction, request: FrameProviderRequest, video?: DecodedVideoInfo): { bounds: { x: number; y: number; width: number; height: number }; pixels: { x: number; y: number; width: number; height: number } } | undefined {
  const bounds = action.target?.bounds;
  if (!bounds || isSecureTarget(action.target) || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return undefined;
  const displayScale = positiveFinite(request.displayScale) ?? 1;
  const decodedWidth = positiveFinite(video?.width);
  const decodedHeight = positiveFinite(video?.height);
  const displayWidth = positiveFinite(request.displayWidth);
  const displayHeight = positiveFinite(request.displayHeight);
  const maximumWidth = Math.floor(decodedWidth ?? displayWidth ?? 16_384);
  const maximumHeight = Math.floor(decodedHeight ?? displayHeight ?? 16_384);

  // Accessibility bounds use macOS logical points. Electron records display
  // dimensions in backing pixels, while ScreenCaptureKit can encode at the
  // logical resolution. Map points to the decoder's real pixel grid instead
  // of assuming the display scale is also the video scale.
  const logicalDisplayWidth = displayWidth === undefined ? undefined : displayWidth / displayScale;
  const logicalDisplayHeight = displayHeight === undefined ? undefined : displayHeight / displayScale;
  const validLogicalDisplayWidth = positiveFinite(logicalDisplayWidth);
  const validLogicalDisplayHeight = positiveFinite(logicalDisplayHeight);
  const scaleX = decodedWidth !== undefined && validLogicalDisplayWidth !== undefined
    ? decodedWidth / validLogicalDisplayWidth
    : displayScale;
  const scaleY = decodedHeight !== undefined && validLogicalDisplayHeight !== undefined
    ? decodedHeight / validLogicalDisplayHeight
    : displayScale;
  if (![scaleX, scaleY, maximumWidth, maximumHeight].every((value) => Number.isFinite(value) && value > 0)) return undefined;

  const x = Math.max(0, Math.floor(bounds.x * scaleX));
  const y = Math.max(0, Math.floor(bounds.y * scaleY));
  const right = Math.min(maximumWidth, Math.ceil((bounds.x + bounds.width) * scaleX));
  const bottom = Math.min(maximumHeight, Math.ceil((bounds.y + bounds.height) * scaleY));
  const width = right - x;
  const height = bottom - y;
  if (width < 1 || height < 1 || x >= maximumWidth || y >= maximumHeight) return undefined;
  return { bounds, pixels: { x, y, width, height } };
}

export function tailFallbackTimestamp(timestampMs: number, videoDurationMs: number): number {
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || !Number.isFinite(videoDurationMs) || videoDurationMs <= 0) return 0;
  if (timestampMs < videoDurationMs - TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS) return timestampMs;
  // If a tail seek produces no frame, stay within the quarter-second capture
  // clock tolerance while moving back far enough to reach an encoded sample.
  return Math.max(0, Math.min(
    timestampMs - TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS,
    videoDurationMs - 100,
  ));
}

function safeAssetPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 80) || "action";
}

export class CommandTranscriptProvider implements TranscriptProvider {
  constructor(private readonly executable: string) {
    if (!executable.startsWith("/")) throw new Error("REPLAY_TRANSCRIBE_COMMAND must be an absolute executable path");
  }

  async transcribe(request: TranscriptionRequest): Promise<TimestampedTranscript> {
    const output = await runProcess(this.executable, ["--input", request.audioPath, "--output-json", "-", ...(request.languageHint ? ["--language", request.languageHint] : [])], request.signal);
    let transcript: unknown;
    try { transcript = JSON.parse(output) as unknown; } catch { throw new Error("The local transcriber did not return timestamped JSON"); }
    assertValidTranscript(transcript);
    return transcript;
  }
}

function progressToView(sessionId: string, progress: PipelineProgress): ProcessingUpdate {
  const stageMap: Record<PipelineProgress["stage"], ProcessingUpdate["stage"]> = {
    transcribe: "transcribing",
    ingest_events: "condensing",
    condense_events: "condensing",
    sample_frames: "sampling",
    segment_steps: "segmenting",
    extract_decisions: "decisions",
    validate_ir: "saving",
  };
  return { sessionId, stage: stageMap[progress.stage], progress: progress.overallProgress, message: progress.message };
}

function positiveFinite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Replay cannot safely create its private frame directory.");
  }
  await chmod(path, 0o700);
}

interface ExtractJpegOptions {
  executable: string;
  videoPath: string;
  outputPath: string;
  timestampMs: number;
  fallbackTimestampMs: number;
  quality: number;
  crop?: { x: number; y: number; width: number; height: number };
  signal?: AbortSignal;
}

async function extractPrivateJpeg(options: ExtractJpegOptions): Promise<Buffer> {
  const attempts = options.timestampMs === options.fallbackTimestampMs
    ? [options.timestampMs]
    : [options.timestampMs, options.fallbackTimestampMs];
  let lastError: unknown;
  for (const timestampMs of attempts) {
    try {
      await removeGeneratedOutput(options.outputPath);
      await runProcess(options.executable, [
        "-loglevel", "error",
        "-ss", (timestampMs / 1_000).toFixed(3),
        "-i", options.videoPath,
        ...(options.crop
          ? ["-vf", `crop=${options.crop.width}:${options.crop.height}:${options.crop.x}:${options.crop.y}`]
          : []),
        "-frames:v", "1",
        "-q:v", String(options.quality),
        "-y", options.outputPath,
      ], options.signal);
      return await readAndSecureGeneratedFile(options.outputPath);
    } catch (cause) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      lastError = cause;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Frame extraction failed.");
}

async function removeGeneratedOutput(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
}

async function readAndSecureGeneratedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size <= 0) throw new Error("The media decoder did not create a frame.");
    await handle.chmod(0o600);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function inspectVideo(executable: string, videoPath: string, signal?: AbortSignal): Promise<DecodedVideoInfo> {
  let diagnostics: string;
  try {
    const result = await runProcessResult(executable, [
      "-hide_banner",
      "-loglevel", "info",
      "-i", videoPath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", "showinfo",
      "-f", "null",
      "-",
    ], signal, true);
    diagnostics = result.stderr;
  } catch (cause) {
    if (signal?.aborted) throw abortReason(signal);
    throw new Error("Replay could not inspect this recording's video before sampling frames.", { cause });
  }
  const video = parseFfmpegVideoInfo(diagnostics);
  if (!video) throw new Error("Replay could not inspect this recording's video dimensions and duration.");
  return video;
}

export function parseFfmpegVideoInfo(diagnostics: string): DecodedVideoInfo | undefined {
  const showInfo = diagnostics.split(/\r?\n/u).find((line) => line.includes("showinfo") && /\bn:\s*\d+/u.test(line));
  const size = showInfo === undefined ? undefined : /\bs:(\d+)x(\d+)\b/u.exec(showInfo);
  const duration = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/u.exec(diagnostics);
  if (!size || !duration) return undefined;
  const width = Number(size[1]);
  const height = Number(size[2]);
  const durationMs = (Number(duration[1]) * 3_600 + Number(duration[2]) * 60 + Number(duration[3])) * 1_000;
  if (![width, height, durationMs].every((value) => Number.isFinite(value) && value > 0)) return undefined;
  return { width, height, durationMs };
}

function runProcess(executable: string, arguments_: string[], signal?: AbortSignal): Promise<string> {
  return runProcessResult(executable, arguments_, signal, false).then((result) => result.stdout);
}

function runProcessResult(executable: string, arguments_: string[], signal: AbortSignal | undefined, captureStderr: boolean): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutput = 10 * 1024 * 1024;
    const onAbort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { if (totalSize(stdout) < maxOutput) stdout.push(chunk); });
    // Diagnostics from transcription can repeat private narration, so stderr
    // is drained but never copied into app errors or logs.
    if (captureStderr) child.stderr.on("data", (chunk: Buffer) => { if (totalSize(stderr) < maxOutput) stderr.push(chunk); });
    else child.stderr.resume();
    child.on("error", reject);
    child.on("exit", (code, processSignal) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) { reject(abortReason(signal)); return; }
      if (code === 0) {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
        return;
      }
      reject(new Error(`Local media process failed (${processSignal ?? String(code)}).`));
    });
  });
}

function totalSize(buffers: Buffer[]): number {
  return buffers.reduce((total, buffer) => total + buffer.byteLength, 0);
}

async function assertReadableVideoFile(videoPath: string): Promise<void> {
  let handle;
  try {
    handle = await open(videoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (isNotFound(cause)) {
      throw new Error("This recording's video is missing. Make a new recording before building a workflow.");
    }
    throw new Error("Replay cannot read this recording's video. Make a new recording before building a workflow.");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error("Replay cannot read this recording's video. Make a new recording before building a workflow.");
    }
    if (stats.size === 0) {
      throw new Error("This recording's video is empty. Make a new recording before building a workflow.");
    }
    const firstByte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(firstByte, 0, 1, 0);
    if (bytesRead !== 1) {
      throw new Error("Replay cannot read this recording's video. Make a new recording before building a workflow.");
    }
  } finally {
    await handle.close();
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Processing was cancelled");
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function bundledFfmpegPath(): string | null {
  const imported: unknown = ffmpegStatic;
  if (typeof imported === "string") return imported;
  if (typeof imported === "object" && imported !== null && "default" in imported) {
    const value = (imported as { default: unknown }).default;
    return typeof value === "string" ? value : null;
  }
  return null;
}
