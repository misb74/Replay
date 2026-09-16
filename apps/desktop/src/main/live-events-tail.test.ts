import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LiveEventsTail } from "./live-events-tail.js";

const clickLine = (id: string, label: string, role = "AXButton") => JSON.stringify({
  schemaVersion: 1,
  id,
  sessionId: "session-1",
  timestampMs: 4_140,
  type: "click",
  target: { role, label, bundleId: "com.example.ledger", windowTitle: "Northstar Ledger — Invoice review" },
}) + "\n";

describe("LiveEventsTail", () => {
  it("returns only events appended since the previous read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tail-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, clickLine("event-1", "Approve invoice"));
    const tail = new LiveEventsTail(path);

    const first = await tail.read();
    await appendFile(path, clickLine("event-2", "Flag for follow-up"));
    const second = await tail.read();

    expect(first.map((action) => action.description)).toEqual(['clicked "Approve invoice" in Northstar Ledger — Invoice review']);
    expect(second.map((action) => action.description)).toEqual(['clicked "Flag for follow-up" in Northstar Ledger — Invoice review']);
  });

  it("holds back a partially written line until it is complete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tail-partial-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, clickLine("event-1", "Approve invoice").trimEnd());
    const tail = new LiveEventsTail(path);

    expect(await tail.read()).toEqual([]);
    await appendFile(path, "\n");
    expect((await tail.read()).map((action) => action.description)).toEqual(['clicked "Approve invoice" in Northstar Ledger — Invoice review']);
  });

  it("marks only committed controls and app switches as triggers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tail-commit-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, [
      clickLine("event-1", "Approve invoice", "AXButton"),
      clickLine("event-2", "Invoice total", "AXTextField"),
      JSON.stringify({ schemaVersion: 1, id: "event-3", sessionId: "session-1", timestampMs: 5_000, type: "key", key: { keyCode: 4, text: "a", modifiers: [], redacted: false } }) + "\n",
      // The application-switch event type is `app_switch` in the real log
      // (see native/capture/Sources/ReplayCaptureCore/EventModels.swift,
      // CapturedEventType) — not `app_activated`.
      JSON.stringify({ schemaVersion: 1, id: "event-4", sessionId: "session-1", timestampMs: 6_000, type: "app_switch", target: { bundleId: "com.apple.mail", windowTitle: "Inbox" } }) + "\n",
      // A window switch (same app, different window) is deliberately not a
      // trigger — only a switch to another application merits a question.
      JSON.stringify({ schemaVersion: 1, id: "event-5", sessionId: "session-1", timestampMs: 6_500, type: "window_switch", target: { bundleId: "com.apple.mail", windowTitle: "Drafts" } }) + "\n",
    ].join(""));
    const tail = new LiveEventsTail(path);

    const actions = await tail.read();

    expect(actions.filter((action) => action.committed).map((action) => action.description)).toEqual([
      'clicked "Approve invoice" in Northstar Ledger — Invoice review',
      "switched to Inbox",
    ]);
  });

  it("returns an empty list when the file does not exist yet", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tail-missing-"));
    const tail = new LiveEventsTail(join(directory, "events.jsonl"));
    expect(await tail.read()).toEqual([]);
  });

  it("describes the most recently observed actions across reads, oldest first", async () => {
    const directory = await mkdtemp(join(tmpdir(), "replay-tail-recent-"));
    const path = join(directory, "events.jsonl");
    await writeFile(path, clickLine("event-1", "Approve invoice"));
    const tail = new LiveEventsTail(path);
    await tail.read();
    await appendFile(path, clickLine("event-2", "Flag for follow-up"));
    await tail.read();
    await appendFile(path, clickLine("event-3", "Add note"));
    await tail.read();

    expect(tail.describeRecent(2)).toEqual([
      'clicked "Flag for follow-up" in Northstar Ledger — Invoice review',
      'clicked "Add note" in Northstar Ledger — Invoice review',
    ]);
  });
});
