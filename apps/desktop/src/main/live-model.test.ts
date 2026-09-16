import { describe, expect, it } from "vitest";
import { classifyLiveModelError, LiveModelError, parseLiveCheckResult } from "./live-model.js";

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
