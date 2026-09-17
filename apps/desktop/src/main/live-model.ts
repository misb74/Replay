import Anthropic from "@anthropic-ai/sdk";

export type LiveModelErrorCode = "unauthenticated" | "unavailable" | "timeout" | "failed";

/**
 * Deliberately carries no response body, headers, or request evidence, for the
 * same reason `ModelTransportError` in the pipeline does not.
 */
export class LiveModelError extends Error {
  constructor(readonly code: LiveModelErrorCode) {
    super("The live model request failed.");
    this.name = "LiveModelError";
  }
}

export interface LiveHistoryItem {
  speaker: "user" | "assistant";
  text: string;
  /** Present on user turns whose screenshot is still being sent. */
  screenshot?: { base64: string };
  /** When `screenshot` was taken, as time into the session such as `4:07`. */
  screenshotTakenAt?: string;
  /** Present on user turns whose screenshot has aged out. */
  screenshotOmittedAt?: string;
  /** Present on an assistant turn the tutor began itself: the action it asked about. */
  trigger?: string;
}

export interface LiveReplyRequest {
  system: string;
  actions: readonly string[];
  history: readonly LiveHistoryItem[];
  screenshot: { base64: string };
  userText: string;
  signal: AbortSignal;
}

export interface LiveCheckRequest {
  system: string;
  actions: readonly string[];
  history: readonly LiveHistoryItem[];
  screenshot: { base64: string };
  trigger: string;
  signal: AbortSignal;
}

export type LiveReplyChunk =
  | { kind: "text"; text: string }
  | { kind: "refusal" }
  | { kind: "usage"; model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number };

export interface LiveCheckResult {
  ask: boolean;
  question?: string;
}

export interface LiveModelTransport {
  reply(request: LiveReplyRequest): AsyncIterable<LiveReplyChunk>;
  check(request: LiveCheckRequest): Promise<LiveCheckResult>;
}

export interface ClaudeLiveTransportOptions {
  apiKey: string;
  model: string;
}

export function classifyLiveModelError(cause: unknown): LiveModelErrorCode {
  if (typeof cause === "object" && cause !== null) {
    const error = cause as { status?: unknown; name?: unknown };
    if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
    if (typeof error.status === "number") {
      if (error.status === 401 || error.status === 403) return "unauthenticated";
      if (error.status === 429 || error.status >= 500) return "unavailable";
      return "failed";
    }
  }
  return "failed";
}

// Structured-output schemas only accept a subset of JSON Schema, and the
// installed SDK documents no list of what that subset is: JSONOutputFormat's
// `schema` field is typed as a bare index signature (see
// node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts), with no
// comment restricting or confirming support for a `type` array. Rather than
// rely on an unverified `type: ["string", "null"]`, `question` stays a plain
// required string: the closing prompt below asks the model to return "" when
// it has nothing to ask, and the parsing in `check()` already treats a blank
// question as "don't ask".
const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ask: { type: "boolean" },
    question: { type: "string", description: "The question to ask, or an empty string if ask is false." },
  },
  required: ["ask", "question"],
} as const;

/**
 * The minimal shape of a `check()` response that `parseLiveCheckResult`
 * needs, kept separate from `Anthropic.Message` so it can be constructed and
 * tested without a network or a full message fixture.
 */
export interface LiveCheckMessage {
  stop_reason: string | null;
  content: readonly { type: string; text?: string }[];
}

/**
 * Turns a `check()` response into a `LiveCheckResult`. A reply the transport
 * cannot use — a refusal, a missing text block, or text that is not valid
 * JSON in the expected shape (for example because `max_tokens` cut it off
 * mid-object) — is not a transport failure, so this never throws; it answers
 * `{ ask: false }` instead.
 */
export function parseLiveCheckResult(message: LiveCheckMessage): LiveCheckResult {
  if (message.stop_reason === "refusal") return { ask: false };
  const block = message.content.find((item) => item.type === "text");
  const text = block?.type === "text" ? block.text : undefined;
  if (text === undefined) return { ask: false };
  // A reply the transport cannot use is not a transport failure: parsing and
  // the shape check get their own try/catch so a malformed or truncated
  // response (unlike a genuine network/auth/rate-limit error) answers
  // `{ ask: false }` rather than surfacing as a LiveModelError.
  try {
    const parsed = JSON.parse(text) as { ask?: unknown; question?: unknown };
    if (parsed.ask !== true || typeof parsed.question !== "string" || parsed.question.trim() === "") {
      return { ask: false };
    }
    return { ask: true, question: parsed.question.trim() };
  } catch {
    return { ask: false };
  }
}

/**
 * The minimal shape of a finished reply that `liveUsageChunk` needs, kept
 * separate from `Anthropic.Message` for the same reason `LiveCheckMessage` is:
 * so it can be constructed and tested without a network.
 */
export interface LiveUsageMessage {
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null };
}

/**
 * What one finished reply cost. The model named is the one the API answered
 * with, not the one asked for: an alias such as `claude-opus-5` resolves to a
 * dated model at the API, and the session's log should say which actually ran.
 */
export function liveUsageChunk(message: LiveUsageMessage): LiveReplyChunk {
  return {
    kind: "usage",
    model: message.model,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * The messages for a reply or a check, both built here: the history, then the
 * newest user message, which carries the screenshot, the recent actions, and
 * `closing`.
 *
 * The Messages API requires the first message to be the user's, but the
 * history can begin with the tutor: a question it asked before the user had
 * said anything, or a turn left at the front once older turns were dropped.
 * Those leading turns are never sent as the user's words. The first user
 * message opens by naming them as what the tutor said earlier.
 */
export function liveMessages(request: LiveReplyRequest | LiveCheckRequest, closing: string): Anthropic.MessageParam[] {
  const firstUserTurn = request.history.findIndex((item) => item.speaker === "user");
  const leadingCount = firstUserTurn === -1 ? request.history.length : firstUserTurn;
  const earlier: Anthropic.TextBlockParam[] = leadingCount === 0 ? [] : [{
    type: "text",
    text: `[Earlier, you said: "${request.history.slice(0, leadingCount).map((item) => item.text).join(" ")}"]`,
  }];

  const messages: Anthropic.MessageParam[] = [];
  for (const item of request.history.slice(leadingCount)) {
    const blocks: Anthropic.ContentBlockParam[] = messages.length === 0 ? [...earlier] : [];
    if (item.screenshot) {
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: item.screenshot.base64 } });
    } else if (item.screenshotOmittedAt) {
      blocks.push({ type: "text", text: `[screenshot at ${item.screenshotOmittedAt} omitted]` });
    }
    blocks.push({ type: "text", text: item.text });
    messages.push({ role: item.speaker === "user" ? "user" : "assistant", content: blocks });
  }
  messages.push({
    role: "user",
    content: [
      ...(messages.length === 0 ? earlier : []),
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: request.screenshot.base64 } },
      { type: "text", text: `Recent actions:\n${request.actions.join("\n")}` },
      { type: "text", text: closing },
    ],
  });
  return messages;
}

export function createClaudeLiveTransport(options: ClaudeLiveTransportOptions): LiveModelTransport {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 1 });

  return {
    async *reply(request) {
      let stream;
      try {
        stream = client.messages.stream(
          {
            model: options.model,
            max_tokens: 2048,
            output_config: { effort: "low" },
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: liveMessages(request, request.userText),
          },
          { signal: request.signal },
        );
      } catch (cause) {
        throw new LiveModelError(classifyLiveModelError(cause));
      }
      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { kind: "text", text: event.delta.text };
          }
        }
        const message = await stream.finalMessage();
        if (message.stop_reason === "refusal") {
          yield { kind: "refusal" };
        }
        yield liveUsageChunk(message);
      } catch (cause) {
        throw new LiveModelError(classifyLiveModelError(cause));
      }
    },

    async check(request) {
      try {
        const message = await client.messages.create(
          {
            model: options.model,
            max_tokens: 2048,
            output_config: {
              effort: "low",
              format: { type: "json_schema", schema: CHECK_SCHEMA },
            },
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: liveMessages(
              request,
              `The user just did: ${request.trigger}. Decide whether one short question about the judgment behind it would help capture this workflow. Ask only if the reason is not obvious from the screen. If you would not ask, set question to an empty string.`,
            ),
          },
          { signal: request.signal },
        );
        return parseLiveCheckResult(message);
      } catch (cause) {
        throw new LiveModelError(classifyLiveModelError(cause));
      }
    },
  };
}
