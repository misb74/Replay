import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../shared/contracts.js";
import { activeRecording, buildableRecording, latestUnprocessedRecording } from "./recording-state.js";

describe("renderer recording state", () => {
  it("restores the explicitly recording session from an initial refresh", () => {
    const recording = session("session-live", "recording");
    expect(activeRecording([session("session-ready", "ready"), recording])).toBe(recording);
  });

  it("does not infer a live recording from partial or completed sessions", () => {
    expect(activeRecording([session("session-partial", "partial"), session("session-ready", "ready")])).toBeUndefined();
  });

  it("keeps showing the live session after an uncertain stop leaves the list unchanged", () => {
    const recording = session("session-live", "recording");
    const sessionsAfterFailedStop = [recording, session("session-ready", "ready")];
    expect(activeRecording(sessionsAfterFailedStop)?.id).toBe("session-live");
  });

  it("stops showing a recording only when the refreshed session state says it stopped", () => {
    const stopped = session("session-live", "ready");
    expect(activeRecording([stopped])).toBeUndefined();
  });

  it("offers only a completed recording for building after stop", () => {
    const ready = session("session-ready", "ready");
    expect(buildableRecording(ready)).toBe(ready);
    expect(buildableRecording(session("session-partial", "partial"))).toBeUndefined();
    expect(buildableRecording(session("session-recording", "recording"))).toBeUndefined();
    expect(buildableRecording(session("session-processing", "processing"))).toBeUndefined();
    expect(buildableRecording(session("session-failed", "failed"))).toBeUndefined();
  });

  it("restores the newest completed recording that has not produced a workflow", () => {
    const older = { ...session("session-older", "ready"), startedAt: "2026-08-17T09:00:00.000Z" };
    const newest = { ...session("session-newest", "ready"), startedAt: "2026-08-17T11:00:00.000Z" };
    expect(latestUnprocessedRecording(
      [older, session("session-partial", "partial"), newest],
      new Set([older.id]),
    )).toBe(newest);
  });

  it("does not reopen a dismissed or already processed recording", () => {
    const processed = session("session-processed", "ready");
    const dismissed = session("session-dismissed", "ready");
    expect(latestUnprocessedRecording(
      [processed, dismissed],
      new Set([processed.id]),
      new Set([dismissed.id]),
    )).toBeUndefined();
  });

  it("does not walk backward to an older recording after processing the newest completed one", () => {
    const older = { ...session("session-older", "ready"), startedAt: "2026-08-17T09:00:00.000Z" };
    const newest = { ...session("session-newest", "ready"), startedAt: "2026-08-17T11:00:00.000Z" };
    expect(latestUnprocessedRecording(
      [older, newest],
      new Set([newest.id]),
    )).toBeUndefined();
  });

  it("does not walk backward to an older recording after dismissing the newest completed one", () => {
    const older = { ...session("session-older", "ready"), startedAt: "2026-08-17T09:00:00.000Z" };
    const newest = { ...session("session-newest", "ready"), startedAt: "2026-08-17T11:00:00.000Z" };
    expect(latestUnprocessedRecording(
      [older, newest],
      new Set(),
      new Set([newest.id]),
    )).toBeUndefined();
  });
});

function session(id: string, state: SessionSummary["state"]): SessionSummary {
  return { id, state, name: id, startedAt: "2026-08-17T10:00:00.000Z" };
}
