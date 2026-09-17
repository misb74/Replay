import { afterEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate, PermissionStatus } from "../shared/contracts.js";
import {
  createLiveSidecar,
  liveAvailability,
  LiveTutor,
  withDeadline,
  withoutFailing,
  type LiveConversation,
  type LivePanelWindow,
  type LiveStart,
} from "./live-lifecycle.js";
import type { SidecarClient } from "./sidecar-client.js";

function permissions(microphone: PermissionStatus["state"]): PermissionStatus[] {
  return [
    { name: "screen", state: "granted", required: true, explanation: "" },
    { name: "microphone", state: microphone, required: false, explanation: "" },
  ];
}

describe("liveAvailability", () => {
  it("needs macOS 26 before anything else", () => {
    // The key and the microphone are missing too; the oldest Mac is still the
    // first thing the record card says.
    expect(liveAvailability("15.6.1", undefined, permissions("denied"))).toEqual({
      available: false,
      reason: "Needs macOS 26",
    });
  });

  it("fails closed when the system version cannot be read", () => {
    for (const version of ["", "unknown", "Version 26"]) {
      expect(liveAvailability(version, "key", permissions("granted"))).toEqual({
        available: false,
        reason: "Needs macOS 26",
      });
    }
  });

  it("asks for the API key once the Mac is new enough", () => {
    expect(liveAvailability("26.0.1", undefined, permissions("denied"))).toEqual({
      available: false,
      reason: "Set ANTHROPIC_API_KEY in .env",
    });
    expect(liveAvailability("26.0.1", "", permissions("granted"))).toMatchObject({ reason: "Set ANTHROPIC_API_KEY in .env" });
  });

  it("asks for the microphone once the key is there", () => {
    expect(liveAvailability("26.0", "key", permissions("notDetermined"))).toEqual({
      available: false,
      reason: "Grant Microphone in System Settings",
    });
    expect(liveAvailability("26.0", "key", [])).toMatchObject({ reason: "Grant Microphone in System Settings" });
  });

  it("is available once all three checks pass", () => {
    expect(liveAvailability("27.1", "key", permissions("granted"))).toEqual({ available: true });
  });
});

describe("withDeadline", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves as soon as the work does, and says nothing", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();

    const waited = withDeadline(Promise.resolve("done"), 5_000, expired);
    await vi.advanceTimersByTimeAsync(0);
    await waited;

    expect(expired).not.toHaveBeenCalled();
  });

  it("resolves at the ceiling when the work has not finished, and says so", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();

    const waited = withDeadline(new Promise<void>(() => {}), 5_000, expired);
    await vi.advanceTimersByTimeAsync(5_000);
    await waited;

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("never fails because the work failed", async () => {
    await expect(withDeadline(Promise.reject(new Error("the tutor could not end")), 5_000)).resolves.toBeUndefined();
  });

  it("never fails because the work failed after the ceiling had passed", async () => {
    vi.useFakeTimers();
    let fail: (cause: Error) => void = () => {};
    const work = new Promise<void>((_resolve, reject) => { fail = reject; });

    const waited = withDeadline(work, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waited).resolves.toBeUndefined();
    // A rejection nobody is waiting for any more must not reach the process;
    // vitest fails this run if it does.
    fail(new Error("the tutor failed late"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never fails because saying so failed", async () => {
    vi.useFakeTimers();

    const waited = withDeadline(new Promise<void>(() => {}), 1_000, () => { throw new Error("the panel is gone"); });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waited).resolves.toBeUndefined();
  });
});

describe("withoutFailing", () => {
  it("runs the step", () => {
    const step = vi.fn();
    withoutFailing(step);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("lets a failing step go", () => {
    expect(() => withoutFailing(() => { throw new Error("the panel is gone"); })).not.toThrow();
  });
});

class FakePanel implements LivePanelWindow {
  destroyed = false;
  readonly sent: Array<{ channel: string; value: unknown }> = [];
  readonly #load: Array<() => void> = [];
  isDestroyed() { return this.destroyed; }
  close() { this.destroyed = true; }
  send(channel: string, value: unknown) { this.sent.push({ channel, value }); }
  onLoad(listener: () => void) { this.#load.push(listener); }
  /** What Electron's `did-finish-load` does, including on a reload. */
  finishLoading() { this.#load.forEach((listener) => listener()); }
}

class FakeConversation implements LiveConversation {
  started = false;
  ended = 0;
  paused: boolean | undefined;
  startFailure: Error | undefined;
  endFailure: Error | undefined;
  neverEnds = false;
  constructor(readonly session: { id: string; directory: string }, readonly onUpdate: (update: LiveUpdate) => void) {}
  async start() {
    if (this.startFailure) throw this.startFailure;
    this.started = true;
  }
  async end() {
    this.ended += 1;
    if (this.neverEnds) await new Promise<void>(() => {});
    if (this.endFailure) throw this.endFailure;
  }
  async setPaused(paused: boolean) { this.paused = paused; }
}

function harness(prepare?: (conversation: FakeConversation) => void) {
  const panels: FakePanel[] = [];
  const conversations: FakeConversation[] = [];
  const published: LiveUpdate[] = [];
  const timeouts: number[] = [];
  const tutor = new LiveTutor({
    createPanelWindow: () => {
      const panel = new FakePanel();
      panels.push(panel);
      return panel;
    },
    publish: (update) => published.push(update),
    createConversation: (session, onUpdate) => {
      const conversation = new FakeConversation(session, onUpdate);
      prepare?.(conversation);
      conversations.push(conversation);
      return conversation;
    },
    endDeadlineMs: 5_000,
    onEndTimeout: () => timeouts.push(1),
  });
  return { tutor, panels, conversations, published, timeouts };
}

/** Brings a conversation up exactly as `SessionService.start` does, and opens its panel. */
async function startLive(tutor: LiveTutor, id = "session-1"): Promise<LiveStart> {
  const start = tutor.startFor();
  await start.beforeRecord!({ id, directory: `/tmp/${id}` });
  tutor.openPanel();
  return start;
}

describe("LiveTutor", () => {
  afterEach(() => vi.useRealTimers());

  it("brings the conversation up and reports it is running", async () => {
    const { tutor, conversations, panels } = harness();

    await startLive(tutor);

    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({ started: true, session: { id: "session-1", directory: "/tmp/session-1" } });
    expect(tutor.isRunning).toBe(true);
    expect(panels).toHaveLength(1);
  });

  it("shows the speech model being prepared before any conversation exists", () => {
    const { tutor, published, conversations } = harness();

    tutor.startFor().onPreparing!("session-1");

    expect(published).toEqual([{ sessionId: "session-1", state: "preparing_model", sharing: false }]);
    expect(conversations).toHaveLength(0);
  });

  it("ends the conversation and closes the panel", async () => {
    const { tutor, conversations, panels } = harness();
    await startLive(tutor);

    await tutor.end();

    expect(conversations[0]!.ended).toBe(1);
    expect(panels[0]!.destroyed).toBe(true);
    expect(tutor.isRunning).toBe(false);
  });

  it("ends only the session it is asked about", async () => {
    const { tutor, conversations } = harness();
    await startLive(tutor);

    await tutor.endSession("session-elsewhere");
    expect(conversations[0]!.ended).toBe(0);

    await tutor.endSession("session-1");
    expect(conversations[0]!.ended).toBe(1);
  });

  it("keeps the panel open on a failure, showing the reason", async () => {
    const { tutor, panels, published } = harness();
    await startLive(tutor);

    await tutor.end("capture stopped");

    expect(panels[0]!.destroyed).toBe(false);
    expect(published.at(-1)).toEqual({ sessionId: "session-1", state: "failed", sharing: false, error: "capture stopped" });
    expect(panels[0]!.sent.at(-1)?.value).toMatchObject({ state: "failed", error: "capture stopped" });
  });

  it("closes the panel a failure left open when End Live dismisses it", async () => {
    const { tutor, panels } = harness();
    await startLive(tutor);
    await tutor.end("capture stopped");

    await tutor.end();

    expect(panels[0]!.destroyed).toBe(true);
  });

  it("tells a panel that opens late the state it missed, and again when it reloads", async () => {
    const { tutor, conversations, panels } = harness();
    const start = tutor.startFor();
    await start.beforeRecord!({ id: "session-1", directory: "/tmp/session-1" });
    conversations[0]!.onUpdate({ sessionId: "session-1", state: "listening", sharing: false });

    tutor.openPanel();
    panels[0]!.finishLoading();
    panels[0]!.finishLoading();

    expect(panels[0]!.sent).toEqual([
      { channel: "live:update", value: { sessionId: "session-1", state: "listening", sharing: false } },
      { channel: "live:update", value: { sessionId: "session-1", state: "listening", sharing: false } },
    ]);
  });

  it("forgets what it was showing when the panel closes", async () => {
    const { tutor, conversations, panels } = harness();
    await startLive(tutor);
    conversations[0]!.onUpdate({ sessionId: "session-1", state: "listening", sharing: false });
    await tutor.end();

    tutor.openPanel();
    panels[1]!.finishLoading();

    expect(panels[1]!.sent).toEqual([]);
  });

  it("opens one panel however often it is asked", async () => {
    const { tutor, panels } = harness();
    await startLive(tutor);

    tutor.openPanel();
    tutor.openPanel();

    expect(panels).toHaveLength(1);
  });

  it("never ends the conversation a start of its own did not bring up", async () => {
    const { tutor, conversations } = harness();
    await startLive(tutor);

    // A second Record click is refused by `SessionService.start` before any
    // live work, so this start brought nothing up and must tear nothing down.
    const refused = tutor.startFor();
    await refused.abandon();

    expect(conversations[0]!.ended).toBe(0);
    expect(tutor.isRunning).toBe(true);
  });

  it("ends what its own start brought up when the recording fails", async () => {
    const { tutor, conversations, panels } = harness();
    const start = await startLive(tutor);

    await start.abandon();

    expect(conversations[0]!.ended).toBe(1);
    expect(panels[0]!.destroyed).toBe(true);
    expect(tutor.isRunning).toBe(false);
  });

  it("ends a conversation that cannot start, and fails the start", async () => {
    const { tutor, conversations } = harness((conversation) => {
      conversation.startFailure = new Error("the microphone is busy");
    });

    await expect(tutor.startFor().beforeRecord!({ id: "session-1", directory: "/tmp/session-1" }))
      .rejects.toThrow("the microphone is busy");

    expect(conversations[0]!.ended).toBe(1);
    expect(tutor.isRunning).toBe(false);
  });

  it("never leaves a conversation running when another takes its place", async () => {
    const { tutor, conversations } = harness();
    await startLive(tutor);

    await tutor.startFor().beforeRecord!({ id: "session-2", directory: "/tmp/session-2" });

    expect(conversations[0]!.ended).toBe(1);
    expect(conversations[1]!.ended).toBe(0);
  });

  it("never fails because the conversation failed to end", async () => {
    const { tutor, conversations, panels } = harness();
    await startLive(tutor);
    conversations[0]!.endFailure = new Error("the files could not be written");

    await expect(tutor.end()).resolves.toBeUndefined();

    expect(panels[0]!.destroyed).toBe(true);
  });

  it("gives up on an end that will not finish, and says so", async () => {
    const { tutor, conversations, panels, timeouts } = harness();
    await startLive(tutor);
    conversations[0]!.neverEnds = true;
    vi.useFakeTimers();

    const ending = tutor.end();
    await vi.advanceTimersByTimeAsync(5_000);
    await ending;

    expect(timeouts).toEqual([1]);
    expect(panels[0]!.destroyed).toBe(true);
  });

  it("pauses the conversation, and lets a pause with none running go", async () => {
    const { tutor, conversations } = harness();
    await startLive(tutor);

    await tutor.setPaused(true);
    expect(conversations[0]!.paused).toBe(true);

    await tutor.end();
    await expect(tutor.setPaused(false)).resolves.toBeUndefined();
  });

  it("never fails because the panel cannot say whether it is still there", async () => {
    const { tutor, panels } = harness();
    await startLive(tutor);
    panels[0]!.isDestroyed = () => { throw new Error("the panel is gone"); };

    // `end()` is what a quit waits on, and a rejection there would leave the
    // app deferring its own quit for ever.
    await expect(tutor.end("capture stopped")).resolves.toBeUndefined();
    await expect(tutor.end()).resolves.toBeUndefined();
  });

  it("never lets a window failure reach the conversation", async () => {
    const panels: FakePanel[] = [];
    const conversations: FakeConversation[] = [];
    const tutor = new LiveTutor({
      createPanelWindow: () => {
        const panel = new FakePanel();
        panel.send = () => { throw new Error("the panel is gone"); };
        panels.push(panel);
        return panel;
      },
      publish: () => { throw new Error("the window is gone"); },
      createConversation: (session, onUpdate) => {
        const conversation = new FakeConversation(session, onUpdate);
        conversations.push(conversation);
        return conversation;
      },
      endDeadlineMs: 5_000,
    });
    await startLive(tutor);

    // `onUpdate` is called from inside the conversation, including from a reply
    // that is mid-sentence, so neither window may throw back into it.
    expect(() => conversations[0]!.onUpdate({ sessionId: "session-1", state: "listening", sharing: false })).not.toThrow();
    await expect(tutor.end("capture stopped")).resolves.toBeUndefined();
  });
});

describe("createLiveSidecar", () => {
  function fakeClient(running = true) {
    const commands: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const subscribed: string[] = [];
    const client = {
      isRunning: () => running,
      async request(command: string, payload: Record<string, unknown> = {}) {
        commands.push(command);
        payloads.push(payload);
        return { type: "screenshot", screenshot: { path: "/tmp/taken.png", width: 1, height: 1, scale: 1 } };
      },
      on(event: string) {
        subscribed.push(event);
        return () => {};
      },
    } as unknown as SidecarClient;
    return { client, commands, payloads, subscribed };
  }

  it("can name a screenshot and nothing else the tutor could act with", async () => {
    const { client, commands, payloads, subscribed } = fakeClient();
    const sidecar = createLiveSidecar(client);

    // The interface is the only thing between the tutor and the act commands,
    // so its shape is asserted, not just its behaviour.
    expect(Object.keys(sidecar).sort()).toEqual([
      "onSpeech", "onState", "onTranscript", "screenshot", "setPaused", "speak", "stopSpeaking",
    ]);

    await sidecar.screenshot("/tmp/wanted.png");
    await sidecar.speak("utterance-1", "Hello");
    await sidecar.stopSpeaking();
    await sidecar.setPaused(true);
    sidecar.onTranscript(() => {});
    sidecar.onSpeech(() => {});
    sidecar.onState(() => {});

    expect(commands).toEqual(["act_screenshot", "live_speak", "live_stop_speaking", "live_set_paused"]);
    expect(commands.filter((command) => command.startsWith("act_"))).toEqual(["act_screenshot"]);
    expect(payloads[0]).toEqual({ outputPath: "/tmp/wanted.png", excludeProcessIds: [process.pid], createDirectories: false });
    expect(subscribed.sort()).toEqual(["live_speech", "live_state", "live_transcript"]);
  });

  it("never revives a sidecar that has gone", async () => {
    const { client, commands } = fakeClient(false);
    const sidecar = createLiveSidecar(client);

    await expect(sidecar.screenshot("/tmp/wanted.png")).rejects.toMatchObject({ code: "exited" });
    await expect(sidecar.speak("utterance-1", "Hello")).rejects.toMatchObject({ code: "exited" });

    expect(commands).toEqual([]);
  });
});
