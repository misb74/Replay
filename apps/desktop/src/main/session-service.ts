import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { LiveTranscriptSegmentView, PermissionName, PermissionState, PermissionStatus, SessionSummary } from "../shared/contracts.js";
import { recordingVideoUrl } from "./recording-video-protocol.js";
import { recoverInterruptedVideo } from "./session-video-recovery.js";
import { SidecarClient, SidecarRequestError, type SidecarResult } from "./sidecar-client.js";

interface SessionMetadata {
  schemaVersion: number;
  sessionId: string;
  status: "recording" | "completed" | "interrupted";
  partial: boolean;
  startedAt: string;
  stoppedAt?: string;
  display: { width: number; height: number; scale: number; displayId?: number };
  narration: boolean;
  appVersions: Record<string, string>;
  eventCount: number;
  lastEventTimestampMs?: number;
  interruptionReason?: string;
}

export interface DisplayConfiguration {
  width: number;
  height: number;
  scale: number;
  displayId?: number;
}

/**
 * What a recording with live audio needs beyond an ordinary one. Its presence
 * is what makes the recording live: the sidecar prepares the speech model
 * first, and `record` carries the `live` block.
 */
export interface LiveStartOptions {
  /**
   * Called with the reserved session id each time the sidecar answers that it
   * is still preparing the speech model, so the record card can show the wait.
   * No recording exists yet.
   */
  onPreparing?: (sessionId: string) => void;
  /**
   * Runs once the speech model is ready and immediately before `record` is
   * sent, so that the conversation's clocks start with the recording. A
   * failure here fails the start, and nothing is recorded.
   */
  beforeRecord?: (session: { id: string; directory: string }) => Promise<void>;
}

export interface SessionServiceOptions {
  /**
   * Called once the active recording is no longer running, however that
   * happened: stopped, refused, or found already over. Live audio and its
   * panel belong to the recording, so they end here too. The sidecar exiting
   * is not reported here — its own `exit` event already says so, and it ends
   * the live conversation in failure rather than merely ending it.
   */
  onRecordingEnded?: (sessionId: string) => void;
}

/** How long a live start waits for the speech model before it gives up (spec §8). */
const LIVE_PREPARE_DEADLINE_MS = 600_000;

/** How often the sidecar is asked again while it is still preparing the model. */
const LIVE_PREPARE_POLL_MS = 1_000;

export class SessionService {
  readonly #sessionsDirectory: string;
  #activeSessionId: string | undefined;
  #activePhase: "starting" | "recording" | "stopping" | "uncertain" | undefined;
  #activeGeneration = 0;
  #initialization: Promise<void> | undefined;
  #exitRecovery: Promise<void> = Promise.resolve();
  readonly #options: SessionServiceOptions;

  constructor(readonly sidecar: SidecarClient, dataDirectory: string, options: SessionServiceOptions = {}) {
    this.#options = options;
    this.#sessionsDirectory = join(dataDirectory, "sessions");
    sidecar.on("exit", () => {
      this.#activeSessionId = undefined;
      this.#activePhase = undefined;
      this.#activeGeneration += 1;
      this.#exitRecovery = this.#exitRecovery
        .then(async () => {
          await this.initialize();
          await this.recoverIncomplete();
        })
        .catch(() => undefined);
    });
  }

  async initialize(): Promise<void> {
    this.#initialization ??= this.#initializeOnce();
    await this.#initialization;
  }

  async list(): Promise<SessionSummary[]> {
    await this.initialize();
    await this.#exitRecovery;
    const activeSessionId = this.#activeSessionId;
    if (activeSessionId && this.#activePhase === "uncertain") {
      const outcome = await this.#reconcileActiveSession(activeSessionId, this.#activeGeneration);
      if (outcome === "idle") await this.recoverIncomplete();
    }
    const entries = await readdir(this.#sessionsDirectory, { withFileTypes: true });
    const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map(async (entry) => {
      try { return await this.summary(entry.name); } catch { return undefined; }
    }));
    return sessions.filter((session): session is SessionSummary => session !== undefined)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  }

  async start(options: {
    microphone: boolean;
    live?: LiveStartOptions;
    display: DisplayConfiguration;
    appVersion: string;
    excludeProcessIds?: readonly number[];
  }): Promise<SessionSummary> {
    await this.initialize();
    if (this.#activeSessionId) throw new Error("A recording is already active");
    const sessionId = `session-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const sessionDirectory = this.directory(sessionId);
    // Reserve the ID before the sidecar creates any files. Recovery can run in
    // response to a refresh or exit while the start acknowledgement is pending.
    this.#activeSessionId = sessionId;
    this.#activePhase = "starting";
    const generation = ++this.#activeGeneration;
    if (options.live) {
      try {
        await this.#prepareLiveAudio(sessionId, options.live);
        await options.live.beforeRecord?.({ id: sessionId, directory: sessionDirectory });
      } catch (cause) {
        // Nothing was recorded, so the reservation goes with it and the user
        // may try again at once.
        this.#clearActiveSession(sessionId, generation);
        throw cause;
      }
    }
    try {
      const result = await this.sidecar.request("record", {
        sessionId,
        sessionDirectory,
        includeAudio: options.microphone,
        display: options.display,
        appVersions: { replay: options.appVersion },
        ...(options.live ? { live: {} } : {}),
        ...(options.excludeProcessIds?.length ? { excludeProcessIds: [...options.excludeProcessIds] } : {}),
      });
      if (result.type !== "recording_started" || (result.sessionId !== undefined && result.sessionId !== sessionId)) {
        throw new SidecarRequestError("unexpected_response", "The capture sidecar did not confirm the requested recording.");
      }
      if (this.#activeSessionId !== sessionId) {
        throw new SidecarRequestError("exited", "The capture sidecar exited while starting the recording.");
      }
      if (this.#activeGeneration === generation) this.#activePhase = "recording";
    } catch (error) {
      if (this.#activeSessionId !== sessionId || this.#activeGeneration !== generation) throw error;
      if (isSidecarGone(error)) {
        this.#clearActiveSession(sessionId, generation);
        throw error;
      }
      const outcome = await this.#reconcileActiveSession(sessionId, generation);
      if (outcome === "expected_active") return this.summary(sessionId);
      if (outcome === "unknown" && isDefiniteStartFailure(error)) this.#clearActiveSession(sessionId, generation);
      throw error;
    }
    return this.summary(sessionId);
  }

  /**
   * Waits for the sidecar's speech model, asking again about once a second
   * while it answers that it is still preparing. The sidecar answers at once
   * and never waits for a download of its own, so the wait is bounded here:
   * after `LIVE_PREPARE_DEADLINE_MS` the start gives up rather than leaving
   * the user in front of a button that never fires. A refusal — an
   * unsupported language, a microphone that cannot be opened — comes back as
   * the sidecar's own error, and its message is what the record card shows.
   */
  async #prepareLiveAudio(sessionId: string, live: LiveStartOptions): Promise<void> {
    const deadline = Date.now() + LIVE_PREPARE_DEADLINE_MS;
    for (;;) {
      // Asked before the request, because `SidecarClient.request` starts a
      // capture process when none is running: a sidecar that exited during the
      // wait between two asks would be replaced by a fresh one, whose capture
      // clock begins again at zero.
      this.#assertStillReserved(sessionId);
      const result = await this.sidecar.request("live_prepare");
      // Asked again, because the recording can go while the answer is in
      // flight, and nothing more is prepared for one that has.
      this.#assertStillReserved(sessionId);
      if (result.type === "live_ready") return;
      if (result.type !== "live_preparing") {
        throw new SidecarRequestError("unexpected_response", "The capture sidecar did not confirm the speech model.");
      }
      if (Date.now() >= deadline) throw new Error("Preparing the speech model took too long.");
      live.onPreparing?.(sessionId);
      await new Promise((resolve) => { setTimeout(resolve, LIVE_PREPARE_POLL_MS); });
    }
  }

  /** Fails once the reservation this start made has been dropped, as a sidecar exit drops it. */
  #assertStillReserved(sessionId: string): void {
    if (this.#activeSessionId !== sessionId) {
      throw new SidecarRequestError("exited", "The capture sidecar exited while starting the recording.");
    }
  }

  async stop(): Promise<SessionSummary> {
    if (!this.#activeSessionId) throw new Error("No recording is active");
    if (this.#activePhase === "stopping") throw new Error("The recording is already stopping");
    const sessionId = this.#activeSessionId;
    this.#activePhase = "stopping";
    const generation = ++this.#activeGeneration;
    try {
      const result = await this.sidecar.request("stop", { sessionId });
      if (result.type !== "recording_stopped" || (result.sessionId !== undefined && result.sessionId !== sessionId)) {
        throw new SidecarRequestError("unexpected_response", "The capture sidecar did not confirm that the recording stopped.");
      }
    } catch (error) {
      if (this.#activeSessionId !== sessionId || this.#activeGeneration !== generation) throw error;
      if (isSidecarGone(error)) {
        this.#clearActiveSession(sessionId, generation);
        throw error;
      }
      const outcome = await this.#reconcileActiveSession(sessionId, generation);
      if (outcome !== "idle") throw error;
      await this.recoverIncomplete();
      return this.summary(sessionId);
    }
    this.#clearActiveSession(sessionId, generation);
    return this.summary(sessionId);
  }

  async summary(id: string): Promise<SessionSummary> {
    const meta = await this.readMetadata(id);
    const stoppedAt = meta.stoppedAt ? Date.parse(meta.stoppedAt) : undefined;
    const startedAt = Date.parse(meta.startedAt);
    const videoIsUsable = await this.#hasPrivateVideo(id);
    const state: SessionSummary["state"] = meta.status === "recording"
      ? "recording"
      : meta.status === "completed" && !meta.partial
        ? videoIsUsable ? "ready" : "failed"
        : "partial";
    return {
      id: meta.sessionId,
      name: `Recording · ${new Date(meta.startedAt).toLocaleString()}`,
      // The capture status is authoritative. A contradictory legacy or damaged
      // `partial: false` flag must never make an interrupted session buildable.
      // A completed marker is also insufficient unless video bytes exist in a
      // regular file inside the private session directory.
      state,
      startedAt: meta.startedAt,
      ...(stoppedAt === undefined || !Number.isFinite(startedAt) ? {} : { durationMs: Math.max(0, stoppedAt - startedAt) }),
      ...(state === "ready" ? { videoUrl: recordingVideoUrl(id) } : {}),
    };
  }

  async openVideoForPlayback(id: string): Promise<FileHandle> {
    assertSafeId(id);
    const directory = await this.#privateSessionDirectory(id);
    const parsed = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as unknown;
    if (!isSessionMetadata(parsed)
      || parsed.sessionId !== id
      || parsed.status !== "completed"
      || parsed.partial) throw new Error("The recording is not available for playback");
    return this.#openPrivateVideo(directory);
  }

  async readMetadata(id: string): Promise<SessionMetadata> {
    assertSafeId(id);
    const parsed = JSON.parse(await readFile(join(this.directory(id), "meta.json"), "utf8")) as unknown;
    if (!isSessionMetadata(parsed) || parsed.sessionId !== id) throw new Error("The session metadata is invalid");
    return parsed;
  }

  async readEvents(id: string): Promise<string> {
    assertSafeId(id);
    return readFile(join(this.directory(id), "events.jsonl"), "utf8");
  }

  /**
   * Reads the live tutor conversation saved alongside a recording. A missing
   * file, unreadable JSON, or the wrong top-level shape is not an error here —
   * most sessions have no live conversation at all — so this returns
   * `undefined` rather than throwing. Segments that are not well-formed are
   * dropped individually so one bad entry cannot hide the rest of the
   * conversation from review.
   */
  async readLiveTranscript(id: string): Promise<{ version: 1; segments: LiveTranscriptSegmentView[] } | undefined> {
    assertSafeId(id);
    try {
      const parsed = JSON.parse(await readFile(join(this.directory(id), "transcript.json"), "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { segments?: unknown }).segments)) return undefined;
      const segments = (parsed as { segments: unknown[] }).segments.filter(isLiveTranscriptSegment);
      return { version: 1, segments };
    } catch {
      return undefined;
    }
  }

  videoPath(id: string): string {
    assertSafeId(id);
    return join(this.directory(id), "video.mp4");
  }

  audioPath(id: string): string {
    assertSafeId(id);
    return join(this.directory(id), "audio.m4a");
  }

  directory(id: string): string {
    assertSafeId(id);
    return join(this.#sessionsDirectory, id);
  }

  async recoverIncomplete(): Promise<void> {
    await mkdir(this.#sessionsDirectory, { recursive: true });
    const entries = await readdir(this.#sessionsDirectory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory() && isSafeId(entry.name)).map(async (entry) => {
      const path = join(this.directory(entry.name), "meta.json");
      try {
        const meta = await this.readMetadata(entry.name);
        if (meta.status !== "recording" || meta.sessionId === this.#activeSessionId) return;
        await recoverInterruptedVideo(this.directory(entry.name));
        const current = await this.readMetadata(entry.name);
        if (current.status !== "recording" || current.sessionId === this.#activeSessionId) return;
        const recovered: SessionMetadata = { ...current, status: "interrupted", partial: true, stoppedAt: new Date().toISOString(), interruptionReason: "sidecar_terminated" };
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(recovered)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, path);
      } catch {
        // A directory with no complete metadata is ignored; its source files are
        // retained for manual recovery and are never deleted automatically.
      }
    }));
  }

  async #initializeOnce(): Promise<void> {
    await mkdir(this.#sessionsDirectory, { recursive: true });
    await this.recoverIncomplete();
  }

  async #hasPrivateVideo(id: string): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      const directory = await this.#privateSessionDirectory(id);
      handle = await this.#openPrivateVideo(directory);
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async #privateSessionDirectory(id: string): Promise<string> {
    const rootStats = await lstat(this.#sessionsDirectory);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error("The sessions directory is invalid");
    const sessionsDirectory = await realpath(this.#sessionsDirectory);
    const directory = await realpath(this.directory(id));
    if (directory !== join(sessionsDirectory, id)) throw new Error("The session directory is outside Replay storage");
    const stats = await lstat(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("The session directory is invalid");
    return directory;
  }

  async #openPrivateVideo(directory: string): Promise<FileHandle> {
    const videoPath = join(directory, "video.mp4");
    const handle = await open(videoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) throw new Error("The recording video is invalid");
      const resolvedVideoPath = await realpath(videoPath);
      const namedStats = await lstat(resolvedVideoPath);
      if (resolvedVideoPath !== videoPath
        || namedStats.isSymbolicLink()
        || namedStats.dev !== stats.dev
        || namedStats.ino !== stats.ino) throw new Error("The recording video moved outside Replay storage");
      return handle;
    } catch (cause) {
      await handle.close().catch(() => undefined);
      throw cause;
    }
  }

  async #reconcileActiveSession(expectedSessionId: string, expectedGeneration: number): Promise<"expected_active" | "other_active" | "idle" | "unknown"> {
    let result: SidecarResult;
    try {
      result = await this.sidecar.request("status");
    } catch (error) {
      if (this.#activeSessionId !== expectedSessionId || this.#activeGeneration !== expectedGeneration) return "unknown";
      if (isSidecarGone(error)) {
        this.#clearActiveSession(expectedSessionId, expectedGeneration);
        return "idle";
      }
      this.#activePhase = "uncertain";
      return "unknown";
    }
    if (this.#activeSessionId !== expectedSessionId || this.#activeGeneration !== expectedGeneration) return "unknown";
    if (result.type !== "status") {
      this.#activePhase = "uncertain";
      return "unknown";
    }
    if (result.state === "idle") {
      this.#clearActiveSession(expectedSessionId, expectedGeneration);
      return "idle";
    }
    if (result.state !== "recording" || typeof result.sessionId !== "string" || !isSafeId(result.sessionId)) {
      this.#activePhase = "uncertain";
      return "unknown";
    }
    this.#activeSessionId = result.sessionId;
    this.#activePhase = "recording";
    if (result.sessionId === expectedSessionId) return "expected_active";
    this.#activeGeneration += 1;
    return "other_active";
  }

  #clearActiveSession(expectedSessionId: string, expectedGeneration: number): void {
    if (this.#activeSessionId !== expectedSessionId || this.#activeGeneration !== expectedGeneration) return;
    this.#activeSessionId = undefined;
    this.#activePhase = undefined;
    this.#activeGeneration += 1;
    this.#options.onRecordingEnded?.(expectedSessionId);
  }
}

const permissionDetails: Record<PermissionName, { native: string; required: boolean; explanation: string }> = {
  screen: { native: "screen_recording", required: true, explanation: "Records the display so Replay can understand what happened." },
  accessibility: { native: "accessibility", required: true, explanation: "Reads interface labels and lets approved workflows click controls." },
  inputMonitoring: { native: "input_monitoring", required: true, explanation: "Records clicks and typing; secure fields are always redacted." },
  microphone: { native: "microphone", required: false, explanation: "Adds optional narration to explain intent and decision points." },
};

export class PermissionService {
  constructor(private readonly sidecar: SidecarClient) {}

  async get(): Promise<PermissionStatus[]> {
    return this.#map(await this.sidecar.request("permissions", { operation: "status" }));
  }

  async request(name: PermissionName): Promise<PermissionStatus[]> {
    return this.#map(await this.sidecar.request("permissions", { operation: "request", permission: permissionDetails[name].native }));
  }

  async openSettings(name: PermissionName): Promise<void> {
    await this.sidecar.request("permissions", { operation: "open_settings", permission: permissionDetails[name].native });
  }

  #map(result: SidecarResult): PermissionStatus[] {
    if (result.type !== "permissions" || !result.permissions) throw new Error("The capture sidecar returned no permission status");
    return (Object.keys(permissionDetails) as PermissionName[]).map((name) => {
      const detail = permissionDetails[name];
      const native = result.permissions!.states[detail.native];
      return { name, state: mapPermissionState(native), required: detail.required, explanation: detail.explanation };
    });
  }
}

function mapPermissionState(value: string | undefined): PermissionState {
  if (value === "granted" || value === "denied" || value === "restricted") return value;
  if (value === "not_determined") return "notDetermined";
  return "unavailable";
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SessionMetadata>;
  const display = item.display;
  return item.schemaVersion === 1
    && typeof item.sessionId === "string"
    && isSafeId(item.sessionId)
    && (item.status === "recording" || item.status === "completed" || item.status === "interrupted")
    && typeof item.partial === "boolean"
    && typeof item.startedAt === "string"
    && Number.isFinite(Date.parse(item.startedAt))
    && typeof item.narration === "boolean"
    && typeof item.eventCount === "number"
    && Number.isInteger(item.eventCount)
    && item.eventCount >= 0
    && typeof display === "object"
    && display !== null
    && [display.width, display.height, display.scale].every((number) => Number.isFinite(number) && number > 0);
}

/** Guards what a parsed transcript.json entry may pass across IPC to the renderer. */
function isLiveTranscriptSegment(value: unknown): value is LiveTranscriptSegmentView {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<LiveTranscriptSegmentView>;
  return typeof item.id === "string"
    && typeof item.text === "string"
    && typeof item.startMs === "number" && Number.isFinite(item.startMs) && item.startMs >= 0
    && typeof item.endMs === "number" && Number.isFinite(item.endMs) && item.endMs >= 0
    && (item.speaker === undefined || item.speaker === "user" || item.speaker === "assistant");
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error("Invalid session id");
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u.test(id);
}

function isSidecarGone(error: unknown): boolean {
  if (error instanceof SidecarRequestError) return error.code === "closed" || error.code === "exited" || error.code === "unavailable";
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES";
}

function isDefiniteStartFailure(error: unknown): boolean {
  if (!(error instanceof SidecarRequestError)) return true;
  return error.code !== "timeout" && error.code !== "invalid_state" && error.code !== "unexpected_response";
}
