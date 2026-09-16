import { describe, expect, it } from "vitest";
import { liveAvailabilityNote, liveStateLabel } from "./live-state.js";

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
