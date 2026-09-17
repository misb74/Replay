import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionService } from "./session-service.js";
import type { SidecarClient } from "./sidecar-client.js";

describe("SessionService recovery", () => {
  it("marks an abruptly terminated recording partial without deleting events", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-session-"));
    const sessionDirectory = join(root, "sessions", "session-safe");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "events.jsonl"), "{\"id\":\"event-1\"}\n");
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({ schemaVersion: 1, sessionId: "session-safe", status: "recording", partial: true, startedAt: "2026-08-17T10:00:00Z", display: { width: 100, height: 100, scale: 2 }, narration: false, appVersions: {}, eventCount: 1 }));
    const sidecar = { on: () => () => {} } as unknown as SidecarClient;
    const service = new SessionService(sidecar, root);
    await service.recoverIncomplete();
    await expect(service.readEvents("session-safe")).resolves.toContain("event-1");
    const recovered = JSON.parse(await readFile(join(sessionDirectory, "meta.json"), "utf8")) as Record<string, unknown>;
    expect(recovered).toMatchObject({ status: "interrupted", partial: true, interruptionReason: "sidecar_terminated" });
  });

  it("does not modify a completed recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-complete-"));
    const sessionDirectory = join(root, "sessions", "session-complete");
    await mkdir(sessionDirectory, { recursive: true });
    const meta = { schemaVersion: 1, sessionId: "session-complete", status: "completed", partial: false, startedAt: "2026-08-17T10:00:00Z", stoppedAt: "2026-08-17T10:01:00Z", display: { width: 100, height: 100, scale: 2 }, narration: false, appVersions: {}, eventCount: 0 };
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify(meta));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
    await service.recoverIncomplete();
    expect(await service.readMetadata("session-complete")).toEqual(meta);
  });

  it("never reports an interrupted recording as ready when its partial flag is contradictory", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-interrupted-summary-"));
    const sessionDirectory = join(root, "sessions", "session-interrupted");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      sessionId: "session-interrupted",
      status: "interrupted",
      partial: false,
      startedAt: "2026-08-17T10:00:00Z",
      stoppedAt: "2026-08-17T10:00:10Z",
      display: { width: 100, height: 100, scale: 2 },
      narration: false,
      appVersions: {},
      eventCount: 0,
    }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.summary("session-interrupted")).resolves.toMatchObject({ state: "partial" });
  });

  it("never reports a completed recording with no video bytes as buildable", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-empty-video-summary-"));
    const sessionDirectory = join(root, "sessions", "session-empty-video");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "video.mp4"), "");
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      sessionId: "session-empty-video",
      status: "completed",
      partial: false,
      startedAt: "2026-08-17T10:00:00Z",
      stoppedAt: "2026-08-17T10:00:10Z",
      display: { width: 100, height: 100, scale: 2 },
      narration: false,
      appVersions: {},
      eventCount: 0,
    }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    const summary = await service.summary("session-empty-video");
    expect(summary.state).toBe("failed");
    expect(summary).not.toHaveProperty("videoUrl");
  });

  it("does not expose a symlink as a completed session video", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-linked-video-summary-"));
    const sessionDirectory = join(root, "sessions", "session-linked-video");
    const outsideVideo = join(root, "outside.mp4");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(outsideVideo, "private bytes");
    await symlink(outsideVideo, join(sessionDirectory, "video.mp4"));
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      sessionId: "session-linked-video",
      status: "completed",
      partial: false,
      startedAt: "2026-08-17T10:00:00Z",
      stoppedAt: "2026-08-17T10:00:10Z",
      display: { width: 100, height: 100, scale: 2 },
      narration: false,
      appVersions: {},
      eventCount: 0,
    }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    const summary = await service.summary("session-linked-video");
    expect(summary.state).toBe("failed");
    expect(summary).not.toHaveProperty("videoUrl");
  });

  it("reports a completed recording with private video bytes as ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-valid-video-summary-"));
    const sessionDirectory = join(root, "sessions", "session-valid-video");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "video.mp4"), "video bytes", { mode: 0o600 });
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      sessionId: "session-valid-video",
      status: "completed",
      partial: false,
      startedAt: "2026-08-17T10:00:00Z",
      stoppedAt: "2026-08-17T10:00:10Z",
      display: { width: 100, height: 100, scale: 2 },
      narration: false,
      appVersions: {},
      eventCount: 0,
    }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.summary("session-valid-video")).resolves.toMatchObject({
      state: "ready",
      videoUrl: "replay-video://recording/session-valid-video/video.mp4",
    });
  });

  it("never marks the current live recording interrupted when the sidebar refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-active-"));
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    const sidecar = {
      on(event: string, listener: (...arguments_: unknown[]) => void) { listeners.set(event, listener); return () => listeners.delete(event); },
      async request(command: string, payload: Record<string, unknown>) {
        if (command !== "record") throw new Error("unexpected command");
        const sessionDirectory = String(payload.sessionDirectory);
        const sessionId = String(payload.sessionId);
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(join(sessionDirectory, "events.jsonl"), "");
        await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({ schemaVersion: 1, sessionId, status: "recording", partial: true, startedAt: "2026-08-17T10:00:00Z", display: { width: 100, height: 100, scale: 2 }, narration: false, appVersions: {}, eventCount: 0 }));
        return { type: "recording_started" };
      },
    } as unknown as SidecarClient;
    const service = new SessionService(sidecar, root);
    await service.initialize();
    const active = await service.start({ microphone: false, display: { width: 100, height: 100, scale: 2 }, appVersion: "test" });
    expect((await service.list()).find((session) => session.id === active.id)?.state).toBe("recording");
    await service.recoverIncomplete();
    expect((await service.readMetadata(active.id)).status).toBe("recording");
  });
});

describe("SessionService live transcript", () => {
  it("returns the segments from a well-formed transcript file", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-"));
    const sessionDirectory = join(root, "sessions", "session-transcript");
    await mkdir(sessionDirectory, { recursive: true });
    const segments = [
      { id: "seg-1", startMs: 100, endMs: 1300, text: "I start with the invoice already selected.", speaker: "user" },
      { id: "seg-2", startMs: 1400, endMs: 2700, text: "Good — now compare the totals.", speaker: "assistant" },
    ];
    await writeFile(join(sessionDirectory, "transcript.json"), JSON.stringify({ version: 1, segments }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toEqual({ version: 1, segments });
  });

  it("accepts a segment with no speaker", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-no-speaker-"));
    const sessionDirectory = join(root, "sessions", "session-transcript");
    await mkdir(sessionDirectory, { recursive: true });
    const segments = [{ id: "seg-1", startMs: 100, endMs: 1300, text: "No speaker recorded for this line." }];
    await writeFile(join(sessionDirectory, "transcript.json"), JSON.stringify({ version: 1, segments }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toEqual({ version: 1, segments });
  });

  it("drops malformed segments while keeping well-formed ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-malformed-"));
    const sessionDirectory = join(root, "sessions", "session-transcript");
    await mkdir(sessionDirectory, { recursive: true });
    const good = { id: "seg-good", startMs: 100, endMs: 1300, text: "A well-formed line.", speaker: "user" };
    const segments = [
      good,
      { startMs: 100, endMs: 200, text: "Missing an id" },
      { id: "seg-bad-text", startMs: 100, endMs: 200, text: 42 },
      { id: "seg-bad-start", startMs: "100", endMs: 200, text: "startMs is a string" },
      { id: "seg-bad-end", startMs: 100, endMs: -5, text: "endMs is negative" },
      { id: "seg-bad-speaker", startMs: 100, endMs: 200, text: "Unknown speaker", speaker: "system" },
      "not an object",
      null,
    ];
    await writeFile(join(sessionDirectory, "transcript.json"), JSON.stringify({ version: 1, segments }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toEqual({ version: 1, segments: [good] });
  });

  it("returns undefined when the transcript file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-missing-"));
    await mkdir(join(root, "sessions", "session-transcript"), { recursive: true });
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toBeUndefined();
  });

  it("returns undefined for invalid JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-badjson-"));
    const sessionDirectory = join(root, "sessions", "session-transcript");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "transcript.json"), "{not json");
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toBeUndefined();
  });

  it("returns undefined when segments is not an array", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-wrongshape-"));
    const sessionDirectory = join(root, "sessions", "session-transcript");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "transcript.json"), JSON.stringify({ segments: "x" }));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("session-transcript")).resolves.toBeUndefined();
  });

  it("rejects an unsafe session id", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-transcript-unsafe-"));
    const service = new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);

    await expect(service.readLiveTranscript("../outside")).rejects.toThrow("Invalid session id");
  });
});
