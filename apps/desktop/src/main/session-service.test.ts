import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionService } from "./session-service.js";
import { SidecarRequestError, type SidecarClient } from "./sidecar-client.js";

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

const display = { width: 100, height: 100, scale: 2 };

interface FakeSidecar {
  client: SidecarClient;
  requests: Array<{ command: string; payload: Record<string, unknown> }>;
  commands: string[];
  emit: (event: string) => void;
}

/** A sidecar that answers `handler` and remembers everything it was asked. */
function fakeSidecar(handler: (command: string, payload: Record<string, unknown>) => Promise<unknown>): FakeSidecar {
  const requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(...arguments_: unknown[]) => void>>();
  const client = {
    on(event: string, listener: (...arguments_: unknown[]) => void) {
      const registered = listeners.get(event) ?? new Set<(...arguments_: unknown[]) => void>();
      registered.add(listener);
      listeners.set(event, registered);
      return () => registered.delete(listener);
    },
    async request(command: string, payload: Record<string, unknown> = {}) {
      requests.push({ command, payload });
      return handler(command, payload);
    },
  } as unknown as SidecarClient;
  return {
    client,
    requests,
    get commands() { return requests.map((request) => request.command); },
    emit: (event) => listeners.get(event)?.forEach((listener) => listener({})),
  };
}

/** Writes what the sidecar writes when a recording starts, so summaries can be read. */
async function writeRecordingMetadata(payload: Record<string, unknown>): Promise<void> {
  const directory = String(payload.sessionDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "events.jsonl"), "");
  await writeFile(join(directory, "meta.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId: String(payload.sessionId),
    status: "recording",
    partial: true,
    startedAt: "2026-08-17T10:00:00.000Z",
    display: payload.display,
    narration: payload.includeAudio,
    appVersions: payload.appVersions,
    eventCount: 0,
  }));
}

describe("SessionService live start", () => {
  afterEach(() => vi.useRealTimers());

  it("asks the sidecar for live audio and window exclusions when starting", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-start-"));
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "live_prepare") return { type: "live_ready" };
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);

    await service.start({ microphone: true, live: {}, display, appVersion: "0.1.0", excludeProcessIds: [4321] });

    expect(sidecar.requests.find((request) => request.command === "record")?.payload).toMatchObject({
      includeAudio: true,
      live: {},
      excludeProcessIds: [4321],
    });
  });

  it("never prepares the speech model for an ordinary recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-plain-start-"));
    const sidecar = fakeSidecar(async (_command, payload) => {
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);

    await service.start({ microphone: false, display, appVersion: "0.1.0" });

    expect(sidecar.commands).toEqual(["record"]);
    expect(sidecar.requests[0]?.payload).not.toHaveProperty("live");
  });

  it("keeps asking for the speech model until it is ready, and only then records", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-prepare-"));
    let answered = 0;
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "live_prepare") return answered++ < 2 ? { type: "live_preparing" } : { type: "live_ready" };
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);
    await service.initialize();
    vi.useFakeTimers();

    const started = service.start({ microphone: true, live: {}, display, appVersion: "0.1.0" });
    await vi.advanceTimersByTimeAsync(5_000);
    await started;

    expect(sidecar.commands).toEqual(["live_prepare", "live_prepare", "live_prepare", "record"]);
  });

  it("shows the wait while the speech model is being prepared", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-preparing-note-"));
    let answered = 0;
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "live_prepare") return answered++ < 1 ? { type: "live_preparing" } : { type: "live_ready" };
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);
    await service.initialize();
    vi.useFakeTimers();
    const preparing: string[] = [];

    const started = service.start({ microphone: true, live: { onPreparing: (id) => preparing.push(id) }, display, appVersion: "0.1.0" });
    await vi.advanceTimersByTimeAsync(5_000);
    const summary = await started;

    expect(preparing).toEqual([summary.id]);
  });

  it("starts the live conversation after the speech model and before the recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-hook-"));
    const order: string[] = [];
    const sidecar = fakeSidecar(async (command, payload) => {
      order.push(command);
      if (command === "live_prepare") return { type: "live_ready" };
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);
    let session: { id: string; directory: string } | undefined;

    const summary = await service.start({
      microphone: true,
      live: { beforeRecord: async (started) => { order.push("live_conversation"); session = started; } },
      display,
      appVersion: "0.1.0",
    });

    expect(order).toEqual(["live_prepare", "live_conversation", "record"]);
    expect(session).toEqual({ id: summary.id, directory: service.directory(summary.id) });
  });

  it("records nothing and reserves nothing when the live conversation cannot start", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-hook-failed-"));
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "live_prepare") return { type: "live_ready" };
      await writeRecordingMetadata(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
    });
    const service = new SessionService(sidecar.client, root);
    const start = () => service.start({
      microphone: true,
      live: { beforeRecord: async () => { throw new Error("The tutor could not start."); } },
      display,
      appVersion: "0.1.0",
    });

    await expect(start()).rejects.toThrow("The tutor could not start.");
    // A second attempt is refused for the same reason, never as already active,
    // so the failed start left no reservation behind.
    await expect(start()).rejects.toThrow("The tutor could not start.");
    expect(sidecar.commands).toEqual(["live_prepare", "live_prepare"]);
  });

  it("rejects a live start with the sidecar's own reason when the speech model fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-prepare-failed-"));
    const sidecar = fakeSidecar(async (command) => {
      if (command === "live_prepare") throw new SidecarRequestError("unsupported", "Live audio needs macOS 26.");
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);
    const start = () => service.start({ microphone: true, live: {}, display, appVersion: "0.1.0" });

    await expect(start()).rejects.toThrow("Live audio needs macOS 26.");
    await expect(start()).rejects.toThrow("Live audio needs macOS 26.");
    expect(sidecar.commands).toEqual(["live_prepare", "live_prepare"]);
  });

  it("starts no conversation when the sidecar goes while the speech model is prepared", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-prepare-exit-"));
    const sidecar: FakeSidecar = fakeSidecar(async (command) => {
      if (command !== "live_prepare") throw new Error(`Unexpected ${command}`);
      // The capture process dies as the speech model becomes ready. A later
      // request would start a fresh one, whose capture clock begins again at
      // zero, so nothing more may be prepared for this recording.
      sidecar.emit("exit");
      return { type: "live_ready" };
    });
    const service = new SessionService(sidecar.client, root);
    let conversations = 0;

    await expect(service.start({
      microphone: true,
      live: { beforeRecord: async () => { conversations += 1; } },
      display,
      appVersion: "0.1.0",
    })).rejects.toMatchObject({ code: "exited" });

    expect(conversations).toBe(0);
    expect(sidecar.commands).toEqual(["live_prepare"]);
  });

  it("asks no more once the sidecar goes between two attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-prepare-gone-"));
    const sidecar: FakeSidecar = fakeSidecar(async (command) => {
      if (command !== "live_prepare") throw new Error(`Unexpected ${command}`);
      return { type: "live_preparing" };
    });
    const service = new SessionService(sidecar.client, root);
    await service.initialize();
    vi.useFakeTimers();
    let conversations = 0;

    const started = service.start({
      microphone: true,
      live: { beforeRecord: async () => { conversations += 1; } },
      display,
      appVersion: "0.1.0",
    });
    const rejected = expect(started).rejects.toMatchObject({ code: "exited" });
    // The first answer is in and the next ask is a second away when the capture
    // process dies. Asking again would start a fresh one, whose clock begins
    // again at zero.
    await vi.advanceTimersByTimeAsync(100);
    sidecar.emit("exit");
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;

    expect(sidecar.commands).toEqual(["live_prepare"]);
    expect(conversations).toBe(0);
  });

  it("gives up on the speech model after ten minutes and records nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-live-prepare-slow-"));
    const sidecar = fakeSidecar(async (command) => {
      if (command === "live_prepare") return { type: "live_preparing" };
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);
    await service.initialize();
    vi.useFakeTimers();

    const started = service.start({ microphone: true, live: {}, display, appVersion: "0.1.0" });
    const rejected = expect(started).rejects.toThrow("Preparing the speech model took too long.");
    await vi.advanceTimersByTimeAsync(600_000);
    await rejected;

    expect(sidecar.commands).not.toContain("record");
  });
});

describe("SessionService recording lifetime", () => {
  it("reports that the recording ended once it has stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-ended-stop-"));
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "record") {
        await writeRecordingMetadata(payload);
        return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
      }
      return { type: "recording_stopped", sessionId: String(payload.sessionId) };
    });
    const ended: string[] = [];
    const service = new SessionService(sidecar.client, root, { onRecordingEnded: (id) => ended.push(id) });

    const started = await service.start({ microphone: false, display, appVersion: "0.1.0" });
    expect(ended).toEqual([]);
    await service.stop();

    expect(ended).toEqual([started.id]);
  });

  it("reports that the recording ended when the sidecar is found idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-ended-idle-"));
    const sidecar = fakeSidecar(async (command, payload) => {
      if (command === "record") {
        await writeRecordingMetadata(payload);
        return { type: "recording_started", sessionId: String(payload.sessionId), state: "recording" };
      }
      if (command === "status") return { type: "status", state: "idle" };
      throw new SidecarRequestError("timeout", "The capture sidecar did not answer stop in time.");
    });
    const ended: string[] = [];
    const service = new SessionService(sidecar.client, root, { onRecordingEnded: (id) => ended.push(id) });

    const started = await service.start({ microphone: false, display, appVersion: "0.1.0" });
    await service.stop();

    expect(ended).toEqual([started.id]);
    expect((await service.readMetadata(started.id)).status).toBe("interrupted");
  });
});
