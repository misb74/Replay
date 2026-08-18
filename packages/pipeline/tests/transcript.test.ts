import { describe, expect, it } from "vitest";

import {
  TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS,
  clampTranscriptTail,
  transcriptTextBetween,
  validateTranscript,
  validateTranscriptDuration,
  type TimestampedTranscript,
} from "../src/index.js";
import { fixtureJson } from "./fixture.js";

describe("timestamped transcripts", () => {
  it("validates and queries fixture narration by recording time", () => {
    const transcript = fixtureJson(
      "recordings/invoice-match/transcript.json",
    ) as TimestampedTranscript;

    expect(validateTranscript(transcript)).toEqual({ ok: true, issues: [] });
    expect(transcriptTextBetween(transcript, 1_500, 2_000)).toEqual([
      "If the totals match, I click Approve invoice. If they differ, I click Flag difference.",
    ]);
  });

  it("rejects duplicate ids, reversed ranges, and invalid confidence", () => {
    const transcript: TimestampedTranscript = {
      version: 1,
      segments: [
        { id: "same", startMs: 100, endMs: 200, text: "one" },
        { id: "same", startMs: 50, endMs: 40, text: "", confidence: 2 },
      ],
    };

    expect(validateTranscript(transcript).issues).toHaveLength(5);
  });

  it("flags narration that extends past the video", () => {
    const transcript = fixtureJson(
      "recordings/invoice-match/transcript.json",
    ) as TimestampedTranscript;

    expect(validateTranscriptDuration(transcript, 4_000)).toEqual([
      "Segment 3 extends beyond the recording duration.",
    ]);
    expect(validateTranscriptDuration(transcript, 4_500)).toEqual([]);
  });

  it("allows only bounded end-of-recording drift and clamps it to the video", () => {
    const transcript: TimestampedTranscript = {
      version: 1,
      segments: [{ id: "tail", startMs: 3_800, endMs: 4_750, text: "Finish the workflow." }],
    };

    expect(validateTranscriptDuration(transcript, 4_500, TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS)).toEqual([]);
    expect(clampTranscriptTail(transcript, 4_500).segments[0]?.endMs).toBe(4_500);
    expect(transcript.segments[0]?.endMs).toBe(4_750);

    transcript.segments[0] = { ...transcript.segments[0]!, endMs: 4_751 };
    expect(validateTranscriptDuration(transcript, 4_500, TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS)).toEqual([
      "Segment 1 extends beyond the recording duration.",
    ]);
  });

  it("does not treat narration beginning after the video as tail drift", () => {
    const transcript: TimestampedTranscript = {
      version: 1,
      segments: [{ id: "after", startMs: 4_500, endMs: 4_600, text: "This is outside the video." }],
    };

    expect(validateTranscriptDuration(transcript, 4_500, TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS)).toEqual([
      "Segment 1 extends beyond the recording duration.",
    ]);
  });
});
