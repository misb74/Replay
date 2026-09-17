import { randomUUID } from "node:crypto";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TimestampedTranscript, TranscriptSegment } from "@replay/pipeline";

/** One segment of `transcript.json`: what one side said, on the capture clock. */
export interface LiveSegment extends TranscriptSegment {
  /** Which side said it, which is how the prompts built from this transcript tell them apart. */
  speaker: "user" | "assistant";
}

export interface LiveSessionRecordOptions {
  /** The session directory both files are written into. */
  directory: string;
  /** When the conversation began, on the clock `now` reads. */
  startedAt: number;
  /** Defaults to `Date.now`. */
  now?: () => number;
}

/** What Build reads, and what `TimestampedTranscript` names it. */
const TRANSCRIPT_FILE = "transcript.json";

const LOG_FILE = "live.jsonl";

/**
 * What one live session leaves in its session directory (spec §5.6, in
 * `docs/design/live-tutor.md`), and the only thing that writes there.
 *
 * `transcript.json` is what Build reads: each change rewrites it whole and
 * renames it into place, so a crash mid-write leaves the last complete file
 * rather than a truncated one. A crash between the write and the rename
 * leaves a `transcript.json.<uuid>.tmp` beside it, which nothing sweeps: the
 * transcript itself is whole, every session directory is new, and no later
 * session ever opens that one again. Build refuses a recording whose
 * transcript it cannot read, so every rule that keeps the file valid lives
 * here rather than with each caller: a segment with no words, or whose start
 * is not a usable time, is not recorded at all; a start before the capture
 * origin counts as the origin; an end that is not usable, or that falls
 * before its start, counts as the start; and the segments are written in the
 * order they were said, not the order they were recorded. Nothing is written
 * until something has been said, because Build transcribes the audio when it
 * finds no transcript and an empty transcript would stop it.
 *
 * `live.jsonl` is one JSON object per line, appended in the order things
 * happened, each carrying `t`, the milliseconds since the conversation began.
 * Callers never put an image in one.
 *
 * Both files are owner-only. Writes are queued one after another, so they
 * never overlap and the newest transcript is the one left on disk; a write
 * that fails is let go, because there is nothing a conversation could
 * usefully do about it and the recording is never the casualty. `flush()`
 * waits for them all.
 */
export class LiveSessionRecord {
  readonly #options: LiveSessionRecordOptions & Required<Pick<LiveSessionRecordOptions, "now">>;
  /** The segments so far, in the order they were first recorded. */
  readonly #segments: LiveSegment[] = [];
  /** Every write, in the order it was queued. */
  #writing: Promise<void> = Promise.resolve();

  constructor(options: LiveSessionRecordOptions) {
    this.#options = { now: () => Date.now(), ...options };
  }

  /**
   * Adds one segment to the transcript and writes the file again, answering
   * it as it was recorded, or undefined when it had no words or no usable
   * start. Ids run in the order segments are recorded, so each is unique.
   */
  recordSegment(segment: Omit<LiveSegment, "id">): LiveSegment | undefined {
    const text = segment.text.trim();
    if (text === "" || !Number.isFinite(segment.startMs)) return undefined;
    const startMs = Math.max(0, segment.startMs);
    const recorded: LiveSegment = {
      ...segment,
      id: `live-${this.#segments.length + 1}`,
      text,
      startMs,
      endMs: endNoEarlierThan(startMs, segment.endMs),
    };
    this.#segments.push(recorded);
    this.#persist();
    return recorded;
  }

  /**
   * Gives a segment already recorded the words it has gained and the time it
   * now runs to, and writes the file again. It never loses words it had, and
   * never ends earlier than it already did.
   */
  extendSegment(segment: LiveSegment, words: { text: string; endMs: number }): void {
    const text = words.text.trim();
    if (text === "") return;
    segment.text = text;
    segment.endMs = endNoEarlierThan(segment.endMs, words.endMs);
    this.#persist();
  }

  /** Adds one line to `live.jsonl`: what happened, and when. */
  log(entry: Record<string, unknown>): void {
    const line = `${JSON.stringify({ t: this.#options.now() - this.#options.startedAt, ...entry })}\n`;
    const path = join(this.#options.directory, LOG_FILE);
    this.#queueWrite(() => appendFile(path, line, { encoding: "utf8", mode: 0o600 }));
  }

  /** Waits for every queued write, which is how a session ends with its files complete. */
  async flush(): Promise<void> {
    // A write queued while an earlier one is still in flight joins the end of
    // the chain, so this waits again until the chain has stopped growing.
    let pending: Promise<void>;
    do {
      pending = this.#writing;
      await pending;
    } while (pending !== this.#writing);
  }

  /**
   * The snapshot is taken here, synchronously, so that a segment still
   * growing cannot change what an earlier write says.
   */
  #persist(): void {
    const snapshot: TimestampedTranscript = {
      version: 1,
      segments: [...this.#segments].sort((left, right) => left.startMs - right.startMs),
    };
    const body = `${JSON.stringify(snapshot)}\n`;
    const path = join(this.#options.directory, TRANSCRIPT_FILE);
    this.#queueWrite(async () => {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
  }

  #queueWrite(write: () => Promise<void>): void {
    this.#writing = this.#writing.then(write).catch(() => undefined);
  }
}

/** `endMs` as a time no earlier than `startMs`, and never one the file could not carry. */
function endNoEarlierThan(startMs: number, endMs: number): number {
  return Number.isFinite(endMs) ? Math.max(startMs, endMs) : startMs;
}
