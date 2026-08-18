import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionName, PermissionState, PermissionStatus, SessionSummary } from "../shared/contracts.js";
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

export class SessionService {
  readonly #sessionsDirectory: string;
  #activeSessionId: string | undefined;
  #activePhase: "starting" | "recording" | "stopping" | "uncertain" | undefined;
  #activeGeneration = 0;
  #initialization: Promise<void> | undefined;
  #exitRecovery: Promise<void> = Promise.resolve();

  constructor(readonly sidecar: SidecarClient, dataDirectory: string) {
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

  async start(options: { microphone: boolean; display: DisplayConfiguration; appVersion: string }): Promise<SessionSummary> {
    await this.initialize();
    if (this.#activeSessionId) throw new Error("A recording is already active");
    const sessionId = `session-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const sessionDirectory = this.directory(sessionId);
    // Reserve the ID before the sidecar creates any files. Recovery can run in
    // response to a refresh or exit while the start acknowledgement is pending.
    this.#activeSessionId = sessionId;
    this.#activePhase = "starting";
    const generation = ++this.#activeGeneration;
    try {
      const result = await this.sidecar.request("record", {
        sessionId,
        sessionDirectory,
        includeAudio: options.microphone,
        display: options.display,
        appVersions: { replay: options.appVersion },
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
