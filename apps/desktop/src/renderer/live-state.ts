import type { LiveAvailability, LiveState, LiveUpdate } from "../shared/contracts.js";

const LABELS: Record<LiveState, string> = {
  starting: "Starting",
  preparing_model: "Preparing speech model",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
  failed: "Failed",
  ended: "Ended",
};

export function liveStateLabel(state: LiveState): string {
  return LABELS[state];
}

/**
 * The wiring reports a failed turn or a failed session with a code, not a
 * sentence — `live_timing_invalid` from the sidecar client; the Mac audio
 * session's own wire codes (`audio_route_changed`, `recogniser_failed`,
 * `narration_write_failed`, `audio_engine_stopped`) and its coordinator's
 * error mapping (`permission_denied`, `capture_failed`, `io_failed`), both
 * from `native/capture`; its `live_audio_failed` fallback for anything else;
 * and the model transport's `LiveModelErrorCode`s (`unauthenticated`,
 * `unavailable`, `timeout`, `failed`) — alongside `"capture stopped"`,
 * already spec §8's own words for a sidecar exit. This is where every one of
 * them is given a short sentence a person can act on. An unrecognised code —
 * a new one from the Swift side, say — still reads as a sentence rather than
 * as raw wiring.
 */
const FAILURE_REASONS: Record<string, string> = {
  "capture stopped": "capture stopped",
  live_timing_invalid: "capture timing was invalid",
  live_audio_failed: "live audio failed",
  audio_route_changed: "audio route changed",
  recogniser_failed: "speech recognition stopped working",
  narration_write_failed: "narration could not be saved",
  audio_engine_stopped: "audio engine stopped",
  permission_denied: "microphone permission was refused",
  capture_failed: "microphone or speech model failed to start",
  io_failed: "session file could not be saved",
  unauthenticated: "Claude needs a valid API key",
  unavailable: "Claude unavailable",
  timeout: "Claude timed out",
  failed: "Claude failed to respond",
};

export function liveFailureReason(code: string): string {
  return FAILURE_REASONS[code] ?? "something went wrong";
}

/**
 * What the panel shows for `update.error`: only once the session itself has
 * failed, and only when the service actually published a reason. A single
 * turn's failure sets `error` too (spec §8's one retry before the tutor
 * apologises and keeps listening), but that is not the session failing, so
 * the panel says nothing about it until the state itself is `failed`.
 */
export function liveFailureText(state: LiveState, error: string | undefined): string | undefined {
  if (state !== "failed" || error === undefined) return undefined;
  return liveFailureReason(error);
}

/**
 * Pause is the service's own state, not a toggle the panel remembers:
 * Task 14's policy can pause the tutor by itself after repeated failures, and
 * the button has to agree with that the moment it happens rather than the
 * moment the panel was last clicked.
 */
export function livePanelPaused(state: LiveState): boolean {
  return state === "paused";
}

/** Pause has nothing left to do once the session has failed; End Live still does. */
export function livePanelShowsPause(state: LiveState): boolean {
  return state !== "failed";
}

export function liveAvailabilityNote(availability: LiveAvailability): string | undefined {
  if (availability.available) return undefined;
  return availability.reason ?? "Unavailable on this Mac";
}

export function recordControlState(
  availability: LiveAvailability,
  liveChosen: boolean,
): { liveEnabled: boolean; note: string | undefined; narrationLocked: boolean } {
  return {
    liveEnabled: availability.available,
    note: liveAvailabilityNote(availability),
    narrationLocked: liveChosen,
  };
}

export function liveStatusLabel(update: LiveUpdate | undefined, recordingId: string | undefined): string | undefined {
  if (!update || update.state === "ended") return undefined;
  // A start still preparing the speech model has no recording to belong to
  // yet, so the only session there is, is its own. Every other state belongs
  // to a recording, and a leftover update from another one shows nothing.
  if (recordingId === undefined) {
    return update.state === "preparing_model" ? `Live · ${liveStateLabel(update.state)}` : undefined;
  }
  if (update.sessionId !== recordingId) return undefined;
  return `Live · ${liveStateLabel(update.state)}`;
}
