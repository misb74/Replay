import { describe, expect, it } from "vitest";
import { classifyLiveModelError, LiveModelError } from "./live-model.js";

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
