import { describe, expect, it } from "vitest";
import { liveAvailabilityNote, liveStateLabel, recordControlState } from "./live-state.js";

describe("liveStateLabel", () => {
  it("names every state in the words the service uses", () => {
    expect(liveStateLabel("preparing_model")).toBe("Preparing speech model");
    expect(liveStateLabel("listening")).toBe("Listening");
    expect(liveStateLabel("thinking")).toBe("Thinking");
    expect(liveStateLabel("speaking")).toBe("Speaking");
    expect(liveStateLabel("paused")).toBe("Paused");
    expect(liveStateLabel("failed")).toBe("Failed");
  });
});

describe("liveAvailabilityNote", () => {
  it("has no note when live is available", () => {
    expect(liveAvailabilityNote({ available: true })).toBeUndefined();
  });

  it("passes the first blocking reason through unchanged", () => {
    expect(liveAvailabilityNote({ available: false, reason: "Needs macOS 26" })).toBe("Needs macOS 26");
  });

  it("falls back to a plain reason when none is given", () => {
    expect(liveAvailabilityNote({ available: false })).toBe("Unavailable on this Mac");
  });
});

describe("recordControlState", () => {
  it("offers live when it is available and not recording", () => {
    expect(recordControlState({ available: true }, false)).toEqual({
      liveEnabled: true,
      note: undefined,
      narrationLocked: false,
    });
  });

  it("disables live with its reason", () => {
    expect(recordControlState({ available: false, reason: "Needs macOS 26" }, false)).toEqual({
      liveEnabled: false,
      note: "Needs macOS 26",
      narrationLocked: false,
    });
  });

  it("locks narration on while live is chosen", () => {
    expect(recordControlState({ available: true }, true)).toEqual({
      liveEnabled: true,
      note: undefined,
      narrationLocked: true,
    });
  });
});
