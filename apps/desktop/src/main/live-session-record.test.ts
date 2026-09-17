import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertValidTranscript, type TimestampedTranscript } from "@replay/pipeline";
import { describe, expect, it } from "vitest";
import { LiveSessionRecord } from "./live-session-record.js";

/** A record writing into a directory of its own, with the conversation beginning at 1 s. */
async function makeRecord(now: () => number = () => 1_000) {
  const directory = await mkdtemp(join(tmpdir(), "replay-live-record-"));
  return { record: new LiveSessionRecord({ directory, startedAt: 1_000, now }), directory };
}

async function readTranscript(directory: string): Promise<TimestampedTranscript> {
  return JSON.parse(await readFile(join(directory, "transcript.json"), "utf8")) as TimestampedTranscript;
}

async function readLog(directory: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(directory, "live.jsonl"), "utf8");
  return text.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("LiveSessionRecord transcript", () => {
  it("writes a transcript Build accepts, owner-only, renaming each version into place", async () => {
    const { record, directory } = await makeRecord();
    const path = join(directory, "transcript.json");

    record.recordSegment({ speaker: "user", text: "Do the totals match?", startMs: 200, endMs: 900 });
    await record.flush();
    const first = await stat(path);
    record.recordSegment({ speaker: "assistant", text: "They match.", startMs: 1_100, endMs: 1_800 });
    await record.flush();
    const second = await stat(path);

    const transcript = await readTranscript(directory);
    expect(transcript).toEqual({
      version: 1,
      segments: [
        { id: "live-1", speaker: "user", text: "Do the totals match?", startMs: 200, endMs: 900 },
        { id: "live-2", speaker: "assistant", text: "They match.", startMs: 1_100, endMs: 1_800 },
      ],
    });
    expect(() => { assertValidTranscript(transcript); }).not.toThrow();
    expect(first.mode & 0o777).toBe(0o600);
    // Rewriting the file in place would keep it; renaming a whole new one over
    // it is what keeps a crash mid-write from truncating what Build reads.
    expect(second.ino).not.toBe(first.ino);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it.each([
    ["is not a number at all", Number.NaN],
    ["is a time without end", Number.POSITIVE_INFINITY],
    ["was never given", undefined as unknown as number],
  ])("records no segment whose start %s, so one bad number cannot cost the recording", async (_, startMs) => {
    const { record, directory } = await makeRecord();

    expect(record.recordSegment({ speaker: "assistant", text: "They match.", startMs, endMs: 1_800 })).toBeUndefined();
    record.recordSegment({ speaker: "user", text: "Still here.", startMs: 10, endMs: 20 });
    await record.flush();

    const transcript = await readTranscript(directory);
    expect(() => { assertValidTranscript(transcript); }).not.toThrow();
    // The refused segment took no id with it either.
    expect(transcript.segments).toEqual([
      { id: "live-1", speaker: "user", text: "Still here.", startMs: 10, endMs: 20 },
    ]);
  });

  it("takes a start before the capture origin as the origin, and an end it cannot use as the start", async () => {
    const { record, directory } = await makeRecord();

    expect(record.recordSegment({ speaker: "user", text: "Early.", startMs: -400, endMs: 200 }))
      .toMatchObject({ startMs: 0, endMs: 200 });
    expect(record.recordSegment({ speaker: "assistant", text: "No end.", startMs: 700, endMs: Number.NaN }))
      .toMatchObject({ startMs: 700, endMs: 700 });
    expect(record.recordSegment({ speaker: "assistant", text: "Backwards.", startMs: 900, endMs: 800 }))
      .toMatchObject({ startMs: 900, endMs: 900 });
    await record.flush();

    const transcript = await readTranscript(directory);
    expect(() => { assertValidTranscript(transcript); }).not.toThrow();
  });

  it("writes no transcript until something with words in it has been said", async () => {
    const { record, directory } = await makeRecord();

    expect(record.recordSegment({ speaker: "user", text: "   ", startMs: 0, endMs: 10 })).toBeUndefined();
    record.log({ type: "user_turn" });
    await record.flush();

    // Build transcribes the audio when it finds no transcript, and refuses a
    // recording whose transcript it cannot read, so an empty one is worse than
    // none.
    expect(existsSync(join(directory, "transcript.json"))).toBe(false);
  });

  it("orders the segments by when they were said, not by when it was told", async () => {
    const { record, directory } = await makeRecord();

    record.recordSegment({ speaker: "assistant", text: "Second.", startMs: 700, endMs: 1_500 });
    record.recordSegment({ speaker: "user", text: "First.", startMs: 100, endMs: 400 });
    await record.flush();

    const transcript = await readTranscript(directory);
    expect(transcript.segments.map((segment) => segment.text)).toEqual(["First.", "Second."]);
    expect(() => { assertValidTranscript(transcript); }).not.toThrow();
  });

  it("extends a segment already recorded, and never shortens or empties it", async () => {
    const { record, directory } = await makeRecord();

    const segment = record.recordSegment({ speaker: "user", text: "Which field", startMs: 0, endMs: 400 });
    record.extendSegment(segment!, { text: "Which field is the total?", endMs: 900 });
    // An end it cannot use, and one that falls back inside the segment, leave
    // the segment as long as it already was; words it cannot use leave it as
    // it was said.
    record.extendSegment(segment!, { text: "Which field is the total?", endMs: Number.NaN });
    record.extendSegment(segment!, { text: "Which field is the total?", endMs: 100 });
    record.extendSegment(segment!, { text: "   ", endMs: 1_200 });
    await record.flush();

    expect((await readTranscript(directory)).segments).toEqual([
      { id: "live-1", speaker: "user", text: "Which field is the total?", startMs: 0, endMs: 900 },
    ]);
  });

});

describe("LiveSessionRecord log", () => {
  it("appends each entry with the time it happened, owner-only", async () => {
    let clock = 1_000;
    const { record, directory } = await makeRecord(() => clock);

    record.log({ type: "user_turn", text: "Question?" });
    clock = 3_500;
    record.log({ type: "ended" });
    await record.flush();

    expect(await readLog(directory)).toEqual([
      { t: 0, type: "user_turn", text: "Question?" },
      { t: 2_500, type: "ended" },
    ]);
    expect((await stat(join(directory, "live.jsonl"))).mode & 0o777).toBe(0o600);
  });

  it("waits for every write, including one queued while another was in flight", async () => {
    const { record, directory } = await makeRecord();

    record.log({ type: "one" });
    const flushing = record.flush();
    record.log({ type: "two" });
    await flushing;

    expect((await readLog(directory)).map((line) => line.type)).toEqual(["one", "two"]);
  });

  it("lets a write it cannot make go, so nothing the conversation does fails with it", async () => {
    const record = new LiveSessionRecord({
      directory: join(tmpdir(), `replay-live-nowhere-${randomUUID()}`),
      startedAt: 0,
      now: () => 0,
    });

    record.log({ type: "ended" });
    record.recordSegment({ speaker: "user", text: "Anyone there?", startMs: 0, endMs: 1 });

    await expect(record.flush()).resolves.toBeUndefined();
  });
});
