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
