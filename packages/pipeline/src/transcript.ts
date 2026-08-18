export interface TranscriptSegment {
  id: string;
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface TimestampedTranscript {
  version: 1;
  language?: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionRequest {
  sessionId: string;
  audioPath: string;
  languageHint?: string;
  signal?: AbortSignal;
}

export interface TranscriptProvider {
  transcribe(request: TranscriptionRequest): Promise<TimestampedTranscript>;
}

export interface TranscriptValidationResult {
  ok: boolean;
  issues: string[];
}

// Screen video, microphone audio, and Whisper timestamps finish on separate
// callback boundaries. A quarter second covers that endpoint quantization while
// remaining too small to conceal a genuinely misaligned recording.
export const TRANSCRIPT_TAIL_DRIFT_TOLERANCE_MS = 250;

export function validateTranscript(transcript: unknown): TranscriptValidationResult {
  const issues: string[] = [];
  if (!isRecord(transcript)) {
    return { ok: false, issues: ["Transcript must be an object."] };
  }
  if (transcript.version !== 1) {
    issues.push("Unsupported transcript version.");
  }
  if (!Array.isArray(transcript.segments)) {
    issues.push("Transcript segments must be an array.");
    return { ok: false, issues };
  }
  let previousStart = -Infinity;
  const ids = new Set<string>();
  for (const [index, segment] of transcript.segments.entries()) {
    const prefix = `Segment ${index + 1}`;
    if (!isRecord(segment)) {
      issues.push(`${prefix} must be an object.`);
      continue;
    }
    if (typeof segment.id !== "string" || segment.id.trim() === "" || ids.has(segment.id)) {
      issues.push(`${prefix} must have a unique, non-empty id.`);
    } else {
      ids.add(segment.id);
    }
    if (typeof segment.startMs !== "number" || !Number.isFinite(segment.startMs) || segment.startMs < 0) {
      issues.push(`${prefix} has an invalid start timestamp.`);
    }
    if (
      typeof segment.endMs !== "number" ||
      !Number.isFinite(segment.endMs) ||
      typeof segment.startMs !== "number" ||
      segment.endMs < segment.startMs
    ) {
      issues.push(`${prefix} has an invalid end timestamp.`);
    }
    if (typeof segment.startMs === "number" && segment.startMs < previousStart) {
      issues.push(`${prefix} is out of timestamp order.`);
    }
    if (typeof segment.startMs === "number") {
      previousStart = segment.startMs;
    }
    if (typeof segment.text !== "string" || segment.text.trim() === "") {
      issues.push(`${prefix} has no transcript text.`);
    }
    if (
      segment.confidence !== undefined &&
      (typeof segment.confidence !== "number" ||
        !Number.isFinite(segment.confidence) ||
        segment.confidence < 0 ||
        segment.confidence > 1)
    ) {
      issues.push(`${prefix} has a confidence outside 0–1.`);
    }
    if (segment.speaker !== undefined && typeof segment.speaker !== "string") {
      issues.push(`${prefix} has an invalid speaker.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function assertValidTranscript(
  transcript: unknown,
): asserts transcript is TimestampedTranscript {
  const result = validateTranscript(transcript);
  if (!result.ok) {
    throw new Error(`Invalid timestamped transcript: ${result.issues.join(" ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function transcriptTextBetween(
  transcript: TimestampedTranscript | undefined,
  startMs: number,
  endMs: number,
): string[] {
  if (transcript === undefined) {
    return [];
  }
  return transcript.segments
    .filter((segment) => segment.endMs >= startMs && segment.startMs <= endMs)
    .map((segment) => segment.text);
}

export function validateTranscriptDuration(
  transcript: TimestampedTranscript,
  recordingDurationMs: number,
  tailDriftToleranceMs = 0,
): string[] {
  if (!Number.isFinite(recordingDurationMs) || recordingDurationMs < 0) {
    return ["Recording duration must be a finite, non-negative number."];
  }
  if (!Number.isFinite(tailDriftToleranceMs) || tailDriftToleranceMs < 0) {
    return ["Transcript tail drift tolerance must be a finite, non-negative number."];
  }
  return transcript.segments.flatMap((segment, index) =>
    segment.endMs > recordingDurationMs
      && (segment.startMs >= recordingDurationMs || segment.endMs - recordingDurationMs > tailDriftToleranceMs)
      ? [`Segment ${index + 1} extends beyond the recording duration.`]
      : [],
  );
}

export function clampTranscriptTail(
  transcript: TimestampedTranscript,
  recordingDurationMs: number,
): TimestampedTranscript {
  const needsClamp = transcript.segments.some((segment) => segment.endMs > recordingDurationMs);
  if (!needsClamp) return transcript;
  return {
    ...transcript,
    segments: transcript.segments.map((segment) => segment.endMs > recordingDurationMs
      ? { ...segment, endMs: recordingDurationMs }
      : segment),
  };
}
