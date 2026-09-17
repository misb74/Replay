import { describe, expect, it } from "vitest";
import {
  classifyLiveModelError,
  LiveModelError,
  liveMessages,
  liveUsageChunk,
  parseLiveCheckResult,
  type LiveCheckRequest,
  type LiveHistoryItem,
} from "./live-model.js";

describe("liveUsageChunk", () => {
  it("names the model that answered, which an alias resolves to only at the API", () => {
    const chunk = liveUsageChunk({
      model: "claude-opus-5-20260401",
      usage: { input_tokens: 1_700, output_tokens: 30, cache_read_input_tokens: 900 },
    });

    expect(chunk).toEqual({
      kind: "usage",
      model: "claude-opus-5-20260401",
      inputTokens: 1_700,
      outputTokens: 30,
      cacheReadTokens: 900,
    });
  });

  it("counts a reply that read no cache as having read none", () => {
    const chunk = liveUsageChunk({ model: "claude-opus-5", usage: { input_tokens: 12, output_tokens: 3 } });

    expect(chunk).toMatchObject({ cacheReadTokens: 0 });
  });
});

describe("classifyLiveModelError", () => {
  it("separates retryable failures from permanent ones", () => {
    expect(classifyLiveModelError({ status: 401 })).toBe("unauthenticated");
    expect(classifyLiveModelError({ status: 429 })).toBe("unavailable");
    expect(classifyLiveModelError({ status: 503 })).toBe("unavailable");
    expect(classifyLiveModelError({ status: 400 })).toBe("failed");
    expect(classifyLiveModelError({ name: "AbortError" })).toBe("timeout");
    expect(classifyLiveModelError(new Error("socket hang up"))).toBe("failed");
  });

  it("keeps no response detail on the error it raises", () => {
    const error = new LiveModelError("unavailable");
    expect(error.message).toBe("The live model request failed.");
    expect(Object.keys(error)).not.toContain("response");
  });

  // The cases above are the brief's own; the ones below round out coverage of
  // every branch classifyLiveModelError can take, since Task 11-14 depend on
  // each failure path (network error, 401/403, 429, 5xx, abort) mapping to
  // the right LiveModelErrorCode.

  it("classifies 403 as unauthenticated alongside 401", () => {
    expect(classifyLiveModelError({ status: 403 })).toBe("unauthenticated");
  });

  it("classifies every 5xx status as unavailable, not only 503", () => {
    expect(classifyLiveModelError({ status: 500 })).toBe("unavailable");
    expect(classifyLiveModelError({ status: 529 })).toBe("unavailable");
  });

  it("classifies a bare TimeoutError the same as an AbortError", () => {
    expect(classifyLiveModelError({ name: "TimeoutError" })).toBe("timeout");
  });

  it("falls back to failed when the cause carries no usable status or name", () => {
    expect(classifyLiveModelError(null)).toBe("failed");
    expect(classifyLiveModelError(undefined)).toBe("failed");
    expect(classifyLiveModelError("boom")).toBe("failed");
    expect(classifyLiveModelError({ status: "429" })).toBe("failed");
  });
});

describe("parseLiveCheckResult", () => {
  it("answers ask: false when the text block is not valid JSON", () => {
    const message = { stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] };
    expect(parseLiveCheckResult(message)).toEqual({ ask: false });
  });

  it("answers ask: false when the text was truncated mid-object", () => {
    // The realistic way to get unparseable JSON: max_tokens cuts the reply
    // off before the closing brace.
    const message = { stop_reason: "end_turn", content: [{ type: "text", text: '{"ask": true, "quest' }] };
    expect(parseLiveCheckResult(message)).toEqual({ ask: false });
  });

  it("answers ask: false on a refusal, without looking at the content", () => {
    const message = { stop_reason: "refusal", content: [{ type: "text", text: '{"ask": true, "question": "Why?"}' }] };
    expect(parseLiveCheckResult(message)).toEqual({ ask: false });
  });

  it("answers ask: true with the trimmed question for a valid reply", () => {
    const message = { stop_reason: "end_turn", content: [{ type: "text", text: '{"ask": true, "question": "Why?"}' }] };
    expect(parseLiveCheckResult(message)).toEqual({ ask: true, question: "Why?" });
  });

  it("answers ask: false when the question is empty", () => {
    const message = { stop_reason: "end_turn", content: [{ type: "text", text: '{"ask": true, "question": ""}' }] };
    expect(parseLiveCheckResult(message)).toEqual({ ask: false });
  });
});

describe("liveMessages", () => {
  const question = "Should a difference under $1.00 still count as a match?";
  const flagged = 'clicked "Flag for follow-up" in Northstar Ledger';

  const request = (history: LiveHistoryItem[]): LiveCheckRequest => ({
    system: "You are Replay's live tutor.",
    actions: [flagged],
    history,
    screenshot: { base64: "bGF0ZXN0" },
    trigger: flagged,
    signal: new AbortController().signal,
  });

  const latest = (...leading: Array<{ type: "text"; text: string }>) => ({
    role: "user",
    content: [
      ...leading,
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "bGF0ZXN0" } },
      { type: "text", text: `Recent actions:\n${flagged}` },
      { type: "text", text: "Closing instruction." },
    ],
  });

  it("sends a history that begins with the user as it is", () => {
    expect(liveMessages(request([
      { speaker: "user", text: "Which column is the total?", screenshotOmittedAt: "0:12" },
      { speaker: "assistant", text: "The third one." },
    ]), "Closing instruction.")).toEqual([
      { role: "user", content: [{ type: "text", text: "[screenshot at 0:12 omitted]" }, { type: "text", text: "Which column is the total?" }] },
      { role: "assistant", content: [{ type: "text", text: "The third one." }] },
      latest(),
    ]);
  });

  it("never begins with the tutor: what it said before the user first spoke opens the user's first message, as its own words", () => {
    // A question the tutor asked before the user had said anything, then the
    // user's answer and the tutor's reply.
    expect(liveMessages(request([
      { speaker: "assistant", text: question, trigger: flagged },
      { speaker: "user", text: "Only under a dollar.", screenshot: { base64: "ZWFybGllcg" }, screenshotTakenAt: "0:52" },
      { speaker: "assistant", text: "Noted." },
    ]), "Closing instruction.")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: `[Earlier, you said: "${question}"]` },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZWFybGllcg" } },
          { type: "text", text: "Only under a dollar." },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      latest(),
    ]);
  });

  it("carries the tutor's earlier words in the latest message when the user has not yet spoken", () => {
    const messages = liveMessages(request([
      { speaker: "assistant", text: question, trigger: flagged },
      { speaker: "assistant", text: "Or only an exact match?" },
    ]), "Closing instruction.");

    expect(messages).toEqual([latest({ type: "text", text: `[Earlier, you said: "${question} Or only an exact match?"]` })]);
  });
});
