import { afterEach, describe, expect, it, vi } from "vitest";
import { SidecarClient, SidecarRequestError, type SidecarTransport } from "./sidecar-client.js";

class FakeTransport implements SidecarTransport {
  written: string[] = [];
  writeError: Error | undefined;
  lastWriteFailure: (() => void) | undefined;
  lineListeners = new Set<(line: string) => void>();
  exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  write(line: string, onFailure: () => void) {
    if (this.writeError) throw this.writeError;
    this.written.push(line);
    this.lastWriteFailure = onFailure;
  }
  close() {}
  onLine(listener: (line: string) => void) { this.lineListeners.add(listener); return () => this.lineListeners.delete(listener); }
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void) { this.exitListeners.add(listener); return () => this.exitListeners.delete(listener); }
  respond(response: unknown) { this.lineListeners.forEach((listener) => listener(JSON.stringify(response))); }
  exit(code: number | null) { this.exitListeners.forEach((listener) => listener(code, null)); }
}

describe("SidecarClient", () => {
  afterEach(() => vi.useRealTimers());

  it("correlates newline protocol responses without logging payloads", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    const resultPromise = client.request("status");
    const request = JSON.parse(transport.written[0]!) as { requestId: string; protocolVersion: number };
    transport.respond({ protocolVersion: 1, requestId: request.requestId, ok: true, result: { type: "status", state: "idle" } });
    await expect(resultPromise).resolves.toMatchObject({ type: "status", state: "idle" });
    expect(request.protocolVersion).toBe(1);
    client.close();
  });

  it("turns sidecar errors into stable typed errors", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    const resultPromise = client.request("act_type", { text: "not echoed in error" });
    const request = JSON.parse(transport.written[0]!) as { requestId: string };
    transport.respond({ protocolVersion: 1, requestId: request.requestId, ok: false, error: { code: "secure_field_requires_human_input", message: "Secure fields must be typed by the user." } });
    await expect(resultPromise).rejects.toEqual(expect.objectContaining<Partial<SidecarRequestError>>({ code: "secure_field_requires_human_input" }));
    await expect(resultPromise).rejects.not.toThrow("not echoed in error");
    client.close();
  });

  it("rejects in-flight requests when the process exits", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    const resultPromise = client.request("record", {});
    transport.exit(9);
    await expect(resultPromise).rejects.toMatchObject({ code: "exited" });
  });

  it("keeps late acknowledgements from satisfying a later status request", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0, requestTimeoutMs: 10 });
    const recordPromise = client.request("record", {});
    const recordRequest = JSON.parse(transport.written[0]!) as { requestId: string };
    const timedOut = expect(recordPromise).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;

    const statusPromise = client.request("status");
    await Promise.resolve();
    const statusRequest = JSON.parse(transport.written[1]!) as { requestId: string };
    transport.respond({ protocolVersion: 1, requestId: recordRequest.requestId, ok: true, result: { type: "recording_started", state: "recording", sessionId: "session-late" } });
    transport.respond({ protocolVersion: 1, requestId: statusRequest.requestId, ok: true, result: { type: "status", state: "recording", sessionId: "session-late" } });

    await expect(statusPromise).resolves.toMatchObject({ type: "status", state: "recording", sessionId: "session-late" });
    client.close();
  });

  it("turns a synchronous transport write failure into a typed request error", async () => {
    const transport = new FakeTransport();
    transport.writeError = new Error("broken pipe with private detail");
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });

    await expect(client.request("record", {})).rejects.toMatchObject({ code: "write_failed", message: "The capture sidecar could not receive record." });
    client.close();
  });

  it("turns an asynchronous broken-pipe notification into the same typed request error", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    const request = client.request("record", {});

    transport.lastWriteFailure?.();
    transport.lastWriteFailure?.();

    await expect(request).rejects.toMatchObject({ code: "write_failed", message: "The capture sidecar could not receive record." });
    client.close();
  });

  it("forwards guardrail events", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    await client.start();
    let activity = false;
    client.on("user_activity", () => { activity = true; });
    transport.respond({ protocolVersion: 1, event: "user_activity" });
    expect(activity).toBe(true);
    client.close();
  });

  it("normalizes the native mouse-takeover event for the runner", async () => {
    const transport = new FakeTransport();
    const client = new SidecarClient({ binaryPath: "fake", transportFactory: () => transport, heartbeatIntervalMs: 0 });
    await client.start();
    let activity = false;
    client.on("user_activity", () => { activity = true; });
    transport.respond({ protocolVersion: 1, event: "user_mouse_moved", timestampMs: 12 });
    expect(activity).toBe(true);
    client.close();
  });
});
