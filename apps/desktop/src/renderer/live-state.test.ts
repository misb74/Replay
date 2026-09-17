import { describe, expect, it } from "vitest";
import {
  liveAvailabilityNote,
  liveFailureReason,
  liveFailureText,
  livePanelPaused,
  livePanelShowsPause,
  liveStateLabel,
  liveStatusLabel,
  recordControlState,
} from "./live-state.js";

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

describe("liveStatusLabel", () => {
  it("shows nothing when there is no update", () => {
    expect(liveStatusLabel(undefined, "session-1")).toBeUndefined();
  });

  it("shows the state for the active recording's own session", () => {
    expect(liveStatusLabel({ sessionId: "session-1", state: "listening", sharing: false }, "session-1")).toBe("Live · Listening");
  });

  it("shows nothing for a leftover update from a different session", () => {
    expect(liveStatusLabel({ sessionId: "session-2", state: "listening", sharing: false }, "session-1")).toBeUndefined();
  });

  it("shows nothing once the session has ended", () => {
    expect(liveStatusLabel({ sessionId: "session-1", state: "ended", sharing: false }, "session-1")).toBeUndefined();
  });

  it("shows nothing when nothing is recording", () => {
    expect(liveStatusLabel({ sessionId: "session-1", state: "listening", sharing: false }, undefined)).toBeUndefined();
  });

  it("shows the speech model being prepared for a start that has no recording yet", () => {
    expect(liveStatusLabel({ sessionId: "session-1", state: "preparing_model", sharing: false }, undefined))
      .toBe("Live · Preparing speech model");
  });

  it("still shows the speech model being prepared once the recording it belongs to exists", () => {
    expect(liveStatusLabel({ sessionId: "session-1", state: "preparing_model", sharing: false }, "session-1"))
      .toBe("Live · Preparing speech model");
  });
});

describe("liveFailureReason", () => {
  it("names a sidecar exit in the words the panel already uses", () => {
    expect(liveFailureReason("capture stopped")).toBe("capture stopped");
  });

  it("names a live event that arrived without usable capture times", () => {
    expect(liveFailureReason("live_timing_invalid")).toBe("capture timing was invalid");
  });

  it("names the sidecar's own audio failure", () => {
    expect(liveFailureReason("live_audio_failed")).toBe("live audio failed");
  });

  it("names an audio route change — the native README's live-tutor checklist plugs in headphones and expects this by name", () => {
    expect(liveFailureReason("audio_route_changed")).toBe("audio route changed");
  });

  it("names a speech recogniser that stopped working", () => {
    expect(liveFailureReason("recogniser_failed")).toBe("speech recognition stopped working");
  });

  it("names a narration file that could not be written", () => {
    expect(liveFailureReason("narration_write_failed")).toBe("narration could not be saved");
  });

  it("names the audio engine stopping", () => {
    expect(liveFailureReason("audio_engine_stopped")).toBe("audio engine stopped");
  });

  it("names a refused microphone permission", () => {
    expect(liveFailureReason("permission_denied")).toBe("microphone permission was refused");
  });

  it("names the microphone or speech model failing to start", () => {
    expect(liveFailureReason("capture_failed")).toBe("microphone or speech model failed to start");
  });

  it("names a session file that could not be written", () => {
    expect(liveFailureReason("io_failed")).toBe("session file could not be saved");
  });

  it("names a rejected key", () => {
    expect(liveFailureReason("unauthenticated")).toBe("Claude needs a valid API key");
  });

  it("names Claude being unreachable, in spec's own words", () => {
    expect(liveFailureReason("unavailable")).toBe("Claude unavailable");
  });

  it("names a request that ran past the cap", () => {
    expect(liveFailureReason("timeout")).toBe("Claude timed out");
  });

  it("names a plain failed request", () => {
    expect(liveFailureReason("failed")).toBe("Claude failed to respond");
  });

  it("falls back to a readable sentence for a code it does not recognise", () => {
    expect(liveFailureReason("a_future_swift_code")).toBe("something went wrong");
  });
});

describe("liveFailureText", () => {
  it("shows nothing while the state is not failed, even with an error code on the update", () => {
    // One turn failing sets `error` without failing the session (spec §8's
    // single retry before the tutor apologises and keeps listening); the
    // panel says nothing about it until the state itself is `failed`.
    expect(liveFailureText("listening", "timeout")).toBeUndefined();
  });

  it("shows nothing once failed if the service never published a reason", () => {
    expect(liveFailureText("failed", undefined)).toBeUndefined();
  });

  it("shows the mapped reason once the state is failed", () => {
    expect(liveFailureText("failed", "capture stopped")).toBe("capture stopped");
  });

  it("falls back for an unrecognised code while failed", () => {
    expect(liveFailureText("failed", "a_future_swift_code")).toBe("something went wrong");
  });
});

describe("livePanelPaused", () => {
  it("is paused once the service's own state says so", () => {
    expect(livePanelPaused("paused")).toBe(true);
  });

  it("is not paused for any other state", () => {
    for (const state of ["starting", "preparing_model", "listening", "thinking", "speaking", "failed", "ended"] as const) {
      expect(livePanelPaused(state)).toBe(false);
    }
  });
});

describe("livePanelShowsPause", () => {
  it("hides Pause once the session has failed", () => {
    expect(livePanelShowsPause("failed")).toBe(false);
  });

  it("shows Pause in every other state", () => {
    for (const state of ["starting", "preparing_model", "listening", "thinking", "speaking", "paused", "ended"] as const) {
      expect(livePanelShowsPause(state)).toBe(true);
    }
  });
});
