import type { LiveAvailability, LiveState } from "../shared/contracts.js";

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
