import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";

export interface SidecarResult {
  type: "recording_started" | "recording_stopped" | "status" | "permissions" | "screenshot" | "action_completed" | "heartbeat" | "guardrails_subscribed" | "guardrails_unsubscribed";
  state?: "idle" | "recording";
  sessionId?: string;
  eventCount?: number;
  partial?: boolean;
  permissions?: { states: Record<string, string> };
  screenshot?: { path: string; width: number; height: number; scale: number };
  nonce?: string;
  uptimeMs?: number;
  guardrailsActive?: boolean;
  guardrailsTripped?: boolean;
}

interface SidecarResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  result?: SidecarResult;
  error?: { code: string; message: string };
}

export interface SidecarEvent {
  protocolVersion: number;
  event: "user_activity" | "kill_switch";
  timestampMs?: number;
  position?: { x: number; y: number };
}

interface PendingRequest {
  resolve: (result: SidecarResult) => void;
  reject: (cause: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface SidecarTransport {
  write(line: string, onFailure: () => void): void;
  close(): void;
  onLine(listener: (line: string) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
}

export interface SidecarClientOptions {
  binaryPath: string;
  transportFactory?: (binaryPath: string) => SidecarTransport;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
}

export class SidecarRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SidecarRequestError";
  }
}

export class SidecarClient {
  readonly #options: SidecarClientOptions;
  readonly #events = new EventEmitter();
  readonly #pending = new Map<string, PendingRequest>();
  #transport: SidecarTransport | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #lastHeartbeatAt = 0;
  #detachLine: (() => void) | undefined;
  #detachExit: (() => void) | undefined;
  #heartbeatInFlight = false;

  constructor(options: SidecarClientOptions) {
    this.#options = options;
  }

  isRunning(): boolean {
    return this.#transport !== undefined;
  }

  async start(): Promise<void> {
    if (this.#transport) return;
    if (!this.#options.transportFactory) await access(this.#options.binaryPath);
    if (this.#transport) return;
    this.#attachTransport((this.#options.transportFactory ?? createProcessTransport)(this.#options.binaryPath));
  }

  #attachTransport(transport: SidecarTransport): void {
    this.#transport = transport;
    this.#detachLine = this.#transport.onLine((line) => this.#handleLine(line));
    this.#detachExit = this.#transport.onExit((code, signal) => this.#handleExit(code, signal));
    this.#lastHeartbeatAt = Date.now();
    const intervalMs = this.#options.heartbeatIntervalMs ?? 2_000;
    if (intervalMs > 0) {
      this.#heartbeat = setInterval(() => { void this.#heartbeatTick(intervalMs); }, intervalMs);
      this.#heartbeat.unref();
    }
  }

  async request(command: string, payload: Record<string, unknown> = {}): Promise<SidecarResult> {
    if (!this.#transport && this.#options.transportFactory) {
      this.#attachTransport(this.#options.transportFactory(this.#options.binaryPath));
    } else {
      await this.start();
    }
    const transport = this.#transport;
    if (!transport) throw new SidecarRequestError("unavailable", "The capture sidecar did not start.");
    const requestId = randomUUID();
    const envelope = JSON.stringify({ protocolVersion: 1, requestId, command, payload });
    const result = new Promise<SidecarResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new SidecarRequestError("timeout", `The capture sidecar did not answer ${command} in time.`));
      }, this.#options.requestTimeoutMs ?? 15_000);
      timeout.unref();
      this.#pending.set(requestId, { resolve, reject, timeout });
    });
    const rejectWrite = () => {
      const pending = this.#pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.#pending.delete(requestId);
        pending.reject(new SidecarRequestError("write_failed", `The capture sidecar could not receive ${command}.`));
      }
    };
    try {
      transport.write(`${envelope}\n`, rejectWrite);
    } catch {
      rejectWrite();
    }
    return result;
  }

  on(event: "user_activity" | "kill_switch" | "exit", listener: (...arguments_: unknown[]) => void): () => void {
    this.#events.on(event, listener);
    return () => this.#events.off(event, listener);
  }

  close(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#detachLine?.();
    this.#detachExit?.();
    this.#detachLine = undefined;
    this.#detachExit = undefined;
    this.#transport?.close();
    this.#transport = undefined;
    this.#rejectAll(new SidecarRequestError("closed", "The capture sidecar was closed."));
  }

  #handleLine(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { return; }
    if (!isRecord(value) || value.protocolVersion !== 1) return;
    if (value.event === "user_activity" || value.event === "user_mouse_moved" || value.event === "kill_switch") {
      const event = value.event === "user_mouse_moved" ? "user_activity" : value.event;
      this.#events.emit(event, { ...value, event } as unknown as SidecarEvent);
      return;
    }
    if (typeof value.requestId !== "string" || typeof value.ok !== "boolean") return;
    const pending = this.#pending.get(value.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(value.requestId);
    const response = value as unknown as SidecarResponse;
    if (response.ok && response.result) {
      if (response.result.type === "heartbeat") this.#lastHeartbeatAt = Date.now();
      pending.resolve(response.result);
      return;
    }
    pending.reject(new SidecarRequestError(response.error?.code ?? "unknown", response.error?.message ?? "The capture sidecar rejected the request."));
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#detachLine?.();
    this.#detachExit?.();
    this.#detachLine = undefined;
    this.#detachExit = undefined;
    this.#transport = undefined;
    this.#heartbeatInFlight = false;
    const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
    this.#rejectAll(new SidecarRequestError("exited", `The capture sidecar exited unexpectedly (${detail}).`));
    this.#events.emit("exit", { code, signal });
  }

  async #heartbeatTick(intervalMs: number): Promise<void> {
    if (!this.#transport || this.#heartbeatInFlight) return;
    if (Date.now() - this.#lastHeartbeatAt > intervalMs * 3) {
      const transport = this.#transport;
      this.#handleExit(null, null);
      transport.close();
      return;
    }
    this.#heartbeatInFlight = true;
    try {
      await this.request("heartbeat", { nonce: randomUUID() });
    } catch {
      // The deadline above owns crash detection. A transient missed heartbeat
      // must not destroy a session that is still flushing to disk.
    } finally {
      this.#heartbeatInFlight = false;
    }
  }

  #rejectAll(cause: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(cause);
    }
    this.#pending.clear();
  }
}

export function createProcessTransport(binaryPath: string): SidecarTransport {
  const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "pipe"] });
  return childProcessTransport(child);
}

function childProcessTransport(child: ChildProcessWithoutNullStreams): SidecarTransport {
  const lines = new EventEmitter();
  const writeFailures = new Set<() => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim()) lines.emit("line", line);
    }
  });
  // stderr is deliberately drained but never persisted: macOS diagnostics can
  // contain window names or other private context.
  child.stderr.resume();
  // Broken pipes are normally reported asynchronously by Node. Keep a
  // permanent listener so an EPIPE cannot become an uncaught main-process
  // exception, and reject every write that was still awaiting its callback.
  child.stdin.on("error", () => {
    const pending = [...writeFailures];
    writeFailures.clear();
    pending.forEach((fail) => fail());
  });
  return {
    write: (line, onFailure) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        writeFailures.delete(fail);
        onFailure();
      };
      writeFailures.add(fail);
      try {
        child.stdin.write(line, (error) => {
          if (settled) return;
          if (error) {
            fail();
            return;
          }
          settled = true;
          writeFailures.delete(fail);
        });
      } catch {
        fail();
      }
    },
    close: () => { writeFailures.clear(); child.stdin.end(); child.kill("SIGTERM"); },
    onLine: (listener) => { lines.on("line", listener); return () => lines.off("line", listener); },
    onExit: (listener) => { child.on("exit", listener); return () => child.off("exit", listener); },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
