import type { SampledFrame } from "./frame-sampling.js";
import type { ModelStage, VersionedPrompt } from "./prompts.js";

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModelInferenceRequest {
  stage: ModelStage;
  prompt: VersionedPrompt;
  context: unknown;
  frames: readonly SampledFrame[];
  cacheKey: string;
  signal?: AbortSignal;
}

export interface ModelInferenceResponse {
  output: unknown;
  model: string;
  cached: boolean;
  usage?: ModelUsage;
}

export interface StructuredModelAdapter {
  generate(request: ModelInferenceRequest): Promise<ModelInferenceResponse>;
}

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: SampledFrame["mimeType"];
        data: string;
      };
    };

export interface ClaudeTransportRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: ClaudeContentBlock[] }>;
  signal?: AbortSignal;
}

export interface ClaudeTransportResponse {
  model?: string;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** The only boundary that a Claude SDK or HTTP client needs to implement. */
export interface ClaudeMessagesTransport {
  createMessage(request: ClaudeTransportRequest): Promise<ClaudeTransportResponse>;
}

export interface ClaudeModelAdapterOptions {
  transport: ClaudeMessagesTransport;
  model: string;
  maxTokens?: number;
  maxFrames?: number;
  maxContextChars?: number;
  maxFrameBase64Chars?: number;
}

export type ModelTransportErrorCode =
  | "authentication_failed"
  | "model_unavailable"
  | "rate_limited"
  | "billing_failed"
  | "network_failed"
  | "request_timed_out"
  | "service_unavailable"
  | "transport_failed";

/**
 * A deliberately data-free error passed across the model transport boundary.
 * Transports must classify provider errors without retaining response bodies,
 * headers, credentials, or request evidence.
 */
export class ModelTransportError extends Error {
  constructor(readonly code: ModelTransportErrorCode) {
    super("The model transport failed.");
    this.name = "ModelTransportError";
  }
}

export type ModelAdapterErrorCode =
  | "invalid_request"
  | "context_too_large"
  | "invalid_frame"
  | ModelTransportErrorCode
  | "invalid_response";

export class ModelAdapterError extends Error {
  constructor(readonly code: ModelAdapterErrorCode, message: string) {
    super(message);
    this.name = "ModelAdapterError";
  }
}

/**
 * Claude adapter with no SDK dependency. The caller owns authentication in the
 * injected transport, so keys never enter pipeline state or serialized input.
 */
export class ClaudeModelAdapter implements StructuredModelAdapter {
  readonly #transport: ClaudeMessagesTransport;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #maxFrames: number;
  readonly #maxContextChars: number;
  readonly #maxFrameBase64Chars: number;

  constructor(options: ClaudeModelAdapterOptions) {
    if (options.model.trim() === "") {
      throw new ModelAdapterError("invalid_request", "A Claude model id is required.");
    }
    this.#transport = options.transport;
    this.#model = options.model.trim();
    this.#maxTokens = options.maxTokens ?? 8_192;
    this.#maxFrames = options.maxFrames ?? 60;
    this.#maxContextChars = options.maxContextChars ?? 2_000_000;
    this.#maxFrameBase64Chars = options.maxFrameBase64Chars ?? 20_000_000;
  }

  async generate(request: ModelInferenceRequest): Promise<ModelInferenceResponse> {
    validateInferenceRequest(request);
    if (request.frames.length > this.#maxFrames) {
      throw new ModelAdapterError("invalid_request", "The model request contains too many frames.");
    }
    const contextJson = stringifyContext(request.context);
    if (contextJson.length > this.#maxContextChars) {
      throw new ModelAdapterError("context_too_large", "The model context exceeds the configured limit.");
    }

    const content: ClaudeContentBlock[] = [
      {
        type: "text",
        text: `${request.prompt.instructions}\n\n<untrusted_evidence_json>\n${contextJson}\n</untrusted_evidence_json>`,
      },
    ];
    for (const frame of request.frames) {
      assertFrameIsSafe(frame, this.#maxFrameBase64Chars);
      content.push({
        type: "text",
        text: `<untrusted_frame id="${escapeAttribute(frame.id)}" timestamp_ms="${frame.timestampMs}">`,
      });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: frame.mimeType,
          data: frame.dataBase64,
        },
      });
      content.push({ type: "text", text: "</untrusted_frame>" });
    }

    let response: ClaudeTransportResponse;
    try {
      response = await this.#transport.createMessage({
        model: this.#model,
        max_tokens: this.#maxTokens,
        system: request.prompt.system,
        messages: [{ role: "user", content }],
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (cause) {
      if (request.signal?.aborted === true) {
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new DOMException("The model request was aborted.", "AbortError");
      }
      const code = cause instanceof ModelTransportError ? cause.code : "transport_failed";
      throw modelAdapterErrorForTransportFailure(code);
    }

    const text = response.content
      .filter((block): block is { type: string; text: string } => typeof block.text === "string")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text === "") {
      throw new ModelAdapterError("invalid_response", "The model returned no structured output.");
    }

    let output: unknown;
    try {
      output = JSON.parse(removeJsonFence(text)) as unknown;
    } catch {
      // Never include model text here: evidence can be sensitive and the error
      // may be persisted by the desktop process.
      throw new ModelAdapterError("invalid_response", "The model response is not valid JSON.");
    }

    const usage: ModelUsage = {
      ...(response.usage?.input_tokens === undefined
        ? {}
        : { inputTokens: response.usage.input_tokens }),
      ...(response.usage?.output_tokens === undefined
        ? {}
        : { outputTokens: response.usage.output_tokens }),
    };
    return {
      output,
      model: response.model ?? this.#model,
      cached: false,
      ...(Object.keys(usage).length === 0 ? {} : { usage }),
    };
  }
}

export type FixtureModelCache = Readonly<Record<string, unknown>>;

/** Deterministic model substitute used by unit tests and offline regressions. */
export class FixtureModelAdapter implements StructuredModelAdapter {
  readonly requests: ModelInferenceRequest[] = [];
  readonly #cache: FixtureModelCache;

  constructor(cache: FixtureModelCache) {
    this.#cache = cache;
  }

  async generate(request: ModelInferenceRequest): Promise<ModelInferenceResponse> {
    validateInferenceRequest(request);
    this.requests.push(request);
    if (!Object.hasOwn(this.#cache, request.cacheKey)) {
      throw new ModelAdapterError(
        "invalid_request",
        `No cached model fixture exists for key ${request.cacheKey}.`,
      );
    }
    const cached = this.#cache[request.cacheKey];
    return {
      output: structuredClone(cached),
      model: "fixture",
      cached: true,
    };
  }
}

export function createModelCacheKey(
  sessionId: string,
  stage: ModelStage,
  prompt: VersionedPrompt,
): string {
  return `${sessionId}/${stage}/${prompt.id}`;
}

function validateInferenceRequest(request: ModelInferenceRequest): void {
  if (request.stage !== request.prompt.stage) {
    throw new ModelAdapterError("invalid_request", "The prompt does not match the inference stage.");
  }
  if (request.cacheKey.trim() === "") {
    throw new ModelAdapterError("invalid_request", "A model cache key is required.");
  }
  if (request.signal?.aborted === true) {
    throw request.signal.reason instanceof Error
      ? request.signal.reason
      : new DOMException("The model request was aborted.", "AbortError");
  }
}

function stringifyContext(context: unknown): string {
  try {
    const value = JSON.stringify(context);
    if (value === undefined) {
      throw new Error("Not serializable");
    }
    // Keep evidence from closing the explicit untrusted-data boundary in the
    // prompt while preserving valid JSON semantics.
    return value
      .replaceAll("&", "\\u0026")
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e");
  } catch {
    throw new ModelAdapterError("invalid_request", "The model context is not JSON serializable.");
  }
}

function assertFrameIsSafe(frame: SampledFrame, maxBase64Chars: number): void {
  if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0) {
    throw new ModelAdapterError("invalid_frame", "A sampled frame has an invalid timestamp.");
  }
  if (frame.dataBase64.length === 0 || frame.dataBase64.length > maxBase64Chars) {
    throw new ModelAdapterError("invalid_frame", "A sampled frame has an invalid image size.");
  }
  if (
    frame.dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(frame.dataBase64)
  ) {
    throw new ModelAdapterError("invalid_frame", "A sampled frame is not valid base64 data.");
  }
}

function removeJsonFence(value: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(value.trim());
  return match?.[1] ?? value;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function modelAdapterErrorForTransportFailure(code: ModelTransportErrorCode): ModelAdapterError {
  return new ModelAdapterError(code, modelTransportFailureMessage(code));
}

function modelTransportFailureMessage(code: ModelTransportErrorCode): string {
  switch (code) {
    case "authentication_failed":
      return "Anthropic rejected the API key. Update ANTHROPIC_API_KEY, restart Replay, and try again.";
    case "model_unavailable":
      return "Anthropic could not use the configured Claude model. Check REPLAY_CLAUDE_MODEL and confirm this API key can access it, then restart Replay and try again.";
    case "rate_limited":
      return "Anthropic's request limit was reached. Wait a minute, then try building the workflow again.";
    case "billing_failed":
      return "Anthropic could not bill this request. Check the API account's credits and billing status, then try again.";
    case "network_failed":
      return "Replay could not connect to Anthropic. Check your internet connection and try again.";
    case "request_timed_out":
      return "Anthropic took too long to respond. Check your connection and try again.";
    case "service_unavailable":
      return "Anthropic is temporarily unavailable. Wait a moment and try again.";
    case "transport_failed":
      return "Anthropic could not complete the model request. Try again; if it keeps failing, check Replay's model setting.";
  }
}
