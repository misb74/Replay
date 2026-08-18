import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeRecording } from "../renderer/recording-state.js";
import { SessionService } from "./session-service.js";
import { SidecarRequestError, type SidecarClient, type SidecarResult } from "./sidecar-client.js";

const options = {
  microphone: false,
  display: { width: 1512, height: 982, scale: 2 },
  appVersion: "test",
};

describe("live recording state resilience", () => {
  it("treats a timed-out start acknowledgement as successful when status confirms the same session", async () => {
    const root = await temporaryRoot("start-confirmed");
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command === "record") {
        await createRecording(payload);
        throw timeout("record");
      }
      if (command === "status") return status("recording", sidecar.sessionId);
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);

    const started = await service.start(options);
    expect(started).toMatchObject({ id: sidecar.sessionId, state: "recording" });
    await expect(service.start(options)).rejects.toThrow("already active");
    expect(sidecar.commands).toEqual(["record", "status"]);
  });

  it("keeps the start reservation when both start and status time out", async () => {
    const root = await temporaryRoot("start-uncertain");
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command === "record") await createRecording(payload);
      throw timeout(command);
    });
    const service = new SessionService(sidecar.client, root);

    await expect(service.start(options)).rejects.toMatchObject({ code: "timeout" });
    await expect(service.start(options)).rejects.toThrow("already active");
    expect(sidecar.commands).toEqual(["record", "status"]);
  });

  it("retries uncertain status during session refresh and exposes the confirmed recording to the renderer", async () => {
    const root = await temporaryRoot("start-refresh");
    let statusAttempt = 0;
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command === "record") {
        await createRecording(payload);
        throw timeout("record");
      }
      if (command === "status" && statusAttempt++ === 0) throw timeout("status");
      if (command === "status") return status("recording", sidecar.sessionId);
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);

    await expect(service.start(options)).rejects.toMatchObject({ code: "timeout" });
    const refreshed = await service.list();

    expect(activeRecording(refreshed)?.id).toBe(sidecar.sessionId);
    await expect(service.start(options)).rejects.toThrow("already active");
    expect(sidecar.commands).toEqual(["record", "status", "status"]);
  });

  it("releases a timed-out start only when status confirms the sidecar is idle", async () => {
    const root = await temporaryRoot("start-idle");
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command === "record") {
        await createRecording(payload);
        throw timeout("record");
      }
      if (command === "status") return status("idle");
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);

    await expect(service.start(options)).rejects.toMatchObject({ code: "timeout" });
    await expect(service.stop()).rejects.toThrow("No recording is active");
  });

  it("releases a definitively rejected start even if the follow-up status also times out", async () => {
    const root = await temporaryRoot("start-rejected");
    let recordAttempt = 0;
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command === "record" && recordAttempt++ === 0) {
        throw new SidecarRequestError("permission_denied", "Screen Recording is not granted.");
      }
      if (command === "status") throw timeout("status");
      if (command === "record") {
        await createRecording(payload);
        return { type: "recording_started", sessionId: String(payload.sessionId) };
      }
      throw new Error(`Unexpected ${command}`);
    });
    const service = new SessionService(sidecar.client, root);

    await expect(service.start(options)).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.start(options)).resolves.toMatchObject({ state: "recording" });
  });

  it("serializes concurrent starts before either can create a second recording", async () => {
    const root = await temporaryRoot("double-start");
    let entered!: () => void;
    let release!: () => void;
    const startedRequest = new Promise<void>((resolve) => { entered = resolve; });
    const acknowledgement = new Promise<void>((resolve) => { release = resolve; });
    const sidecar = new FakeSidecar(async (command, payload) => {
      if (command !== "record") throw new Error(`Unexpected ${command}`);
      await createRecording(payload);
      entered();
      await acknowledgement;
      return { type: "recording_started", sessionId: String(payload.sessionId) };
    });
    const service = new SessionService(sidecar.client, root);

    const first = service.start(options);
    await startedRequest;
    await expect(service.start(options)).rejects.toThrow("already active");
    release();
    await expect(first).resolves.toMatchObject({ state: "recording" });
    expect(sidecar.commands).toEqual(["record"]);
  });

  it("keeps Stop available when a timed-out stop is confirmed to still be recording", async () => {
    const { service, sidecar } = await startedService("stop-still-recording", async (command) => {
      if (command === "stop") throw timeout("stop");
      if (command === "status") return status("recording", sidecar.sessionId);
      throw new Error(`Unexpected ${command}`);
    });

    await expect(service.stop()).rejects.toMatchObject({ code: "timeout" });
    const sessions = await service.list();

    expect(activeRecording(sessions)?.id).toBe(sidecar.sessionId);
    await expect(service.start(options)).rejects.toThrow("already active");
  });

  it("keeps the active state when stop and its status check both time out", async () => {
    const { service } = await startedService("stop-uncertain", async (command) => {
      throw timeout(command);
    });

    await expect(service.stop()).rejects.toMatchObject({ code: "timeout" });
    await expect(service.start(options)).rejects.toThrow("already active");
  });

  it("does not let an older status reply remove the lock from a newer stop retry", async () => {
    let statusAttempt = 0;
    let stopAttempt = 0;
    let statusEntered!: () => void;
    let releaseStatus!: () => void;
    let stopEntered!: () => void;
    let releaseStop!: () => void;
    const statusPending = new Promise<void>((resolve) => { statusEntered = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const stopPending = new Promise<void>((resolve) => { stopEntered = resolve; });
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    const { service, sidecar } = await startedService("stale-status", async (command) => {
      if (command === "stop" && stopAttempt++ === 0) throw timeout("stop");
      if (command === "status" && statusAttempt++ === 0) throw timeout("status");
      if (command === "status") {
        statusEntered();
        await statusGate;
        return status("recording", sidecar.sessionId);
      }
      if (command === "stop") {
        stopEntered();
        await stopGate;
        await finishRecording(sidecar.sessionDirectory);
        return { type: "recording_stopped", state: "idle", sessionId: sidecar.sessionId };
      }
      throw new Error(`Unexpected ${command}`);
    });

    await expect(service.stop()).rejects.toMatchObject({ code: "timeout" });
    const listing = service.list();
    await statusPending;
    const stopping = service.stop();
    await stopPending;
    releaseStatus();
    await listing;

    await expect(service.stop()).rejects.toThrow("already stopping");
    expect(sidecar.commands.filter((command) => command === "stop")).toHaveLength(2);

    releaseStop();
    await expect(stopping).resolves.toMatchObject({ state: "ready" });
  });

  it("finishes a timed-out stop when status confirms idle", async () => {
    const { service, sidecar } = await startedService("stop-idle", async (command) => {
      if (command === "stop") {
        await finishRecording(sidecar.sessionDirectory);
        throw timeout("stop");
      }
      if (command === "status") return status("idle");
      throw new Error(`Unexpected ${command}`);
    });

    await expect(service.stop()).resolves.toMatchObject({ id: sidecar.sessionId, state: "ready" });
    await expect(service.stop()).rejects.toThrow("No recording is active");
  });

  it("waits for exit recovery before a refresh can present the recording as live", async () => {
    let blockingService: BlockingRecoverySessionService | undefined;
    const { service, sidecar } = await startedService(
      "sidecar-exit",
      async (command) => { throw new Error(`Unexpected ${command}`); },
      (client, root) => {
        blockingService = new BlockingRecoverySessionService(client, root);
        return blockingService;
      },
    );

    blockingService!.blockRecovery = true;
    sidecar.emitExit();
    await blockingService!.recoveryEntered;
    let refreshFinished = false;
    const refreshing = service.list().then((sessions) => {
      refreshFinished = true;
      return sessions;
    });
    await Promise.resolve();
    expect(refreshFinished).toBe(false);
    blockingService!.releaseRecovery();
    const sessions = await refreshing;

    expect(activeRecording(sessions)).toBeUndefined();
    expect(sessions.find((session) => session.id === sidecar.sessionId)?.state).toBe("partial");
    await expect(service.stop()).rejects.toThrow("No recording is active");
  });
});

class FakeSidecar {
  readonly commands: string[] = [];
  sessionId = "";
  sessionDirectory = "";
  readonly client: SidecarClient;
  readonly #listeners = new Map<string, (...arguments_: unknown[]) => void>();

  constructor(handler: (command: string, payload: Record<string, unknown>) => Promise<SidecarResult>) {
    this.client = {
      on: (event: string, listener: (...arguments_: unknown[]) => void) => {
        this.#listeners.set(event, listener);
        return () => this.#listeners.delete(event);
      },
      request: async (command: string, payload: Record<string, unknown> = {}) => {
        this.commands.push(command);
        if (command === "record") {
          this.sessionId = String(payload.sessionId);
          this.sessionDirectory = String(payload.sessionDirectory);
        }
        return handler(command, payload);
      },
    } as unknown as SidecarClient;
  }

  emitExit(): void {
    this.#listeners.get("exit")?.({ code: 9, signal: null });
  }
}

class BlockingRecoverySessionService extends SessionService {
  blockRecovery = false;
  readonly recoveryEntered: Promise<void>;
  readonly #recoveryGate: Promise<void>;
  #markRecoveryEntered!: () => void;
  #releaseRecovery!: () => void;

  constructor(sidecar: SidecarClient, root: string) {
    super(sidecar, root);
    this.recoveryEntered = new Promise<void>((resolve) => { this.#markRecoveryEntered = resolve; });
    this.#recoveryGate = new Promise<void>((resolve) => { this.#releaseRecovery = resolve; });
  }

  override async recoverIncomplete(): Promise<void> {
    if (this.blockRecovery) {
      this.#markRecoveryEntered();
      await this.#recoveryGate;
    }
    await super.recoverIncomplete();
  }

  releaseRecovery(): void {
    this.#releaseRecovery();
  }
}

async function startedService(
  label: string,
  afterStart: (command: string, payload: Record<string, unknown>) => Promise<SidecarResult>,
  createService: (sidecar: SidecarClient, root: string) => SessionService = (sidecar, root) => new SessionService(sidecar, root),
): Promise<{ service: SessionService; sidecar: FakeSidecar }> {
  const root = await temporaryRoot(label);
  let started = false;
  const sidecar = new FakeSidecar(async (command, payload) => {
    if (!started && command === "record") {
      started = true;
      await createRecording(payload);
      return { type: "recording_started", sessionId: String(payload.sessionId) };
    }
    return afterStart(command, payload);
  });
  const service = createService(sidecar.client, root);
  await service.start(options);
  sidecar.commands.length = 0;
  return { service, sidecar };
}

async function createRecording(payload: Record<string, unknown>): Promise<void> {
  const sessionId = String(payload.sessionId);
  const directory = String(payload.sessionDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "events.jsonl"), "");
  await writeFile(join(directory, "meta.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    status: "recording",
    partial: true,
    startedAt: "2026-08-17T10:00:00.000Z",
    display: payload.display,
    narration: payload.includeAudio,
    appVersions: payload.appVersions,
    eventCount: 0,
  }));
}

async function finishRecording(directory: string): Promise<void> {
  const path = join(directory, "meta.json");
  const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(join(directory, "video.mp4"), "video bytes", { mode: 0o600 });
  await writeFile(path, JSON.stringify({
    ...metadata,
    status: "completed",
    partial: false,
    stoppedAt: "2026-08-17T10:01:00.000Z",
  }));
}

function status(state: "idle" | "recording", sessionId?: string): SidecarResult {
  return { type: "status", state, ...(sessionId ? { sessionId } : {}) };
}

function timeout(command: string): SidecarRequestError {
  return new SidecarRequestError("timeout", `The capture sidecar did not answer ${command} in time.`);
}

async function temporaryRoot(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `replay-${label}-`));
}
