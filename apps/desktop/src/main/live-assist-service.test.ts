import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveUpdate } from "../shared/contracts.js";
import {
  LiveAssistService,
  splitSentences,
  type LiveAssistOptions,
  type LiveSidecar,
  type LiveSpeechSignal,
  type LiveStateSignal,
  type LiveTranscriptSignal,
} from "./live-assist-service.js";
import { LiveModelError, type LiveModelTransport, type LiveReplyChunk, type LiveReplyRequest } from "./live-model.js";

interface Harness {
  service: LiveAssistService;
  sidecar: FakeSidecar;
  updates: LiveUpdate[];
  /** Every screenshot path the service removed, in order. */
  removedImages: string[];
  emitTranscript: (text: string, isFinal: boolean) => void;
  finishUtterances: () => void;
  emitSpeech: (utteranceId: string, phase: LiveSpeechSignal["phase"]) => void;
  emitSidecarState: (state: LiveStateSignal["state"], reason?: string) => void;
  /** Runs `listener` synchronously on every update, the instant the service publishes it. */
  whenUpdated: (listener: (update: LiveUpdate) => void) => void;
  /** Runs every callback already waiting on a promise, without moving the fake clock. */
  settle: () => Promise<void>;
}

/** A sidecar command whose reply a test can hold back, to act while the service awaits it. */
type HeldCommand = "screenshot" | "speak" | "setPaused";

class FakeSidecar implements LiveSidecar {
  spoken: Array<{ utteranceId: string; text: string }> = [];
  stopSpeakingCount = 0;
  paused: boolean[] = [];
  /** The output path of every screenshot taken. */
  screenshots: string[] = [];
  /** The speech and pause commands, in the order the service issued them. */
  commands: string[] = [];
  transcriptListeners: Array<(event: LiveTranscriptSignal) => void> = [];
  speechListeners: Array<(event: LiveSpeechSignal) => void> = [];
  stateListeners: Array<(event: LiveStateSignal) => void> = [];
  readonly #held = new Map<HeldCommand, Array<() => void>>();

  /** Holds back the replies to `command` until `release(command)`. */
  hold(command: HeldCommand) {
    this.#held.set(command, []);
  }

  release(command: HeldCommand) {
    const waiting = this.#held.get(command) ?? [];
    this.#held.delete(command);
    for (const resume of waiting) resume();
  }

  async screenshot(outputPath: string) {
    this.screenshots.push(outputPath);
    await this.#reply("screenshot");
    return { path: outputPath };
  }
  async speak(utteranceId: string, text: string) {
    this.spoken.push({ utteranceId, text });
    this.commands.push(`speak ${text}`);
    for (const listener of this.speechListeners) listener({ utteranceId, phase: "started" });
    await this.#reply("speak");
  }
  async stopSpeaking() {
    this.stopSpeakingCount += 1;
    this.commands.push("stopSpeaking");
  }
  async setPaused(paused: boolean) {
    this.paused.push(paused);
    this.commands.push(`setPaused ${paused}`);
    await this.#reply("setPaused");
  }
  onTranscript(listener: (event: LiveTranscriptSignal) => void) {
    this.transcriptListeners.push(listener);
    return () => {};
  }
  onSpeech(listener: (event: LiveSpeechSignal) => void) {
    this.speechListeners.push(listener);
    return () => {};
  }
  onState(listener: (event: LiveStateSignal) => void) {
    this.stateListeners.push(listener);
    return () => {};
  }

  async #reply(command: HeldCommand) {
    const waiting = this.#held.get(command);
    if (waiting) await new Promise<void>((resolve) => { waiting.push(() => resolve()); });
  }
}

function transportYielding(chunks: LiveReplyChunk[]): LiveModelTransport {
  return {
    async *reply(request) {
      for (const chunk of chunks) {
        if (request.signal.aborted) return;
        yield chunk;
        await Promise.resolve();
      }
    },
    async check() { return { ask: false }; },
  };
}

/**
 * A transport whose stream waits, as a request on the network does, until the
 * test releases its next chunk or the request is aborted. An aborted stream
 * with nothing left to deliver fails as the Claude transport's does (the SDK's
 * abort error classifies as "failed"). Chunks released before the stream
 * notices the abort are still delivered, as buffered events can be, so a test
 * can land a chunk on a reply that has just been superseded.
 */
function heldTransport(options: { onAbort?: () => void } = {}) {
  const requests: LiveReplyRequest[] = [];
  const streams: Array<(chunk: LiveReplyChunk | "end") => void> = [];
  const transport: LiveModelTransport = {
    async *reply(request) {
      requests.push(request);
      const released: Array<LiveReplyChunk | "end"> = [];
      let wake = () => {};
      streams.push((chunk) => { released.push(chunk); wake(); });
      const onAbort = () => { options.onAbort?.(); wake(); };
      request.signal.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          const next = released.shift();
          if (next === "end") return;
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (request.signal.aborted) throw new LiveModelError("failed");
          await new Promise<void>((resolve) => { wake = () => resolve(); });
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
    async check() { return { ask: false }; },
  };
  return {
    transport,
    requests,
    /** Delivers chunks to the newest request's stream. */
    release: (...chunks: LiveReplyChunk[]) => { for (const chunk of chunks) streams.at(-1)?.(chunk); },
    /** Ends the newest request's stream. */
    finish: () => { streams.at(-1)?.("end"); },
  };
}

/** Every service option the harness does not own passes straight through. */
type HarnessOverrides = Partial<Omit<LiveAssistOptions, "sessionId" | "sessionDirectory" | "sidecar" | "onUpdate">>;

async function makeHarness(overrides: HarnessOverrides = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "replay-live-"));
  const sidecar = new FakeSidecar();
  const updates: LiveUpdate[] = [];
  const removedImages: string[] = [];
  const updateListeners: Array<(update: LiveUpdate) => void> = [];
  const service = new LiveAssistService({
    transport: transportYielding([]),
    events: { read: async () => [] },
    readImage: async () => "ZmFrZS1qcGVn",
    // Kept in memory: a request that waited on real file I/O could not be
    // flushed by fake timers, and would land after the test's assertions.
    removeImage: async (path) => { removedImages.push(path); },
    ...overrides,
    sessionId: "session-1",
    sessionDirectory: directory,
    sidecar,
    onUpdate: (update) => {
      updates.push(update);
      for (const listener of updateListeners) listener(update);
    },
  });
  await service.start();
  let segment = 0;
  return {
    service,
    sidecar,
    updates,
    removedImages,
    emitTranscript(text, isFinal) {
      segment += 1;
      for (const listener of sidecar.transcriptListeners) {
        listener({ segmentId: `segment-${segment}`, text, isFinal, startMs: segment * 1_000, endMs: segment * 1_000 + 500 });
      }
    },
    finishUtterances() {
      for (const { utteranceId } of sidecar.spoken) {
        for (const listener of sidecar.speechListeners) listener({ utteranceId, phase: "finished" });
      }
    },
    emitSpeech(utteranceId, phase) {
      for (const listener of sidecar.speechListeners) listener({ utteranceId, phase });
    },
    emitSidecarState(state, reason) {
      for (const listener of sidecar.stateListeners) listener(reason === undefined ? { state } : { state, reason });
    },
    whenUpdated(listener) {
      updateListeners.push(listener);
    },
    async settle() {
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

function spokenTexts(harness: Harness): string[] {
  return harness.sidecar.spoken.map((item) => item.text);
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("splitSentences", () => {
  it("splits on sentence ends and keeps the remainder", () => {
    expect(splitSentences("Both totals match. Approve it")).toEqual({
      sentences: ["Both totals match."],
      rest: "Approve it",
    });
  });

  it("flushes an over-long run with no sentence end", () => {
    const long = "a".repeat(205);
    const result = splitSentences(long);
    expect(result.sentences).toHaveLength(1);
    expect(result.rest).toBe("");
  });
});

describe("LiveAssistService turns", () => {
  it("closes a turn after the silence window and speaks sentence by sentence", async () => {
    const harness = await makeHarness({
      transport: transportYielding([
        { kind: "text", text: "Both totals match. " },
        { kind: "text", text: "You can approve it." },
        { kind: "usage", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
      ]),
    });

    harness.emitTranscript("Which field is the purchase order total?", true);
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTicks();

    expect(harness.sidecar.spoken.map((item) => item.text)).toEqual([
      "Both totals match.",
      "You can approve it.",
    ]);
  });

  it("keeps the turn open while the user is still speaking", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });

    harness.emitTranscript("Which field", true);
    await vi.advanceTimersByTimeAsync(500);
    harness.emitTranscript(" is the total?", true);
    await vi.advanceTimersByTimeAsync(500);
    expect(harness.sidecar.spoken).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(200);
    await vi.runAllTicks();
    expect(harness.sidecar.spoken).toHaveLength(1);
  });

  it("cancels a pending request when the user carries on talking", async () => {
    let aborted = false;
    // The request must still be pending when the user carries on: a transport
    // that streams its whole reply at once has finished by then.
    const harness = await makeHarness({ transport: heldTransport({ onAbort: () => { aborted = true; } }).transport });

    harness.emitTranscript("Which field", true);
    await vi.advanceTimersByTimeAsync(700);
    harness.emitTranscript("no wait, which column?", false);
    await vi.runAllTicks();

    expect(aborted).toBe(true);
  });

  it("stops speaking the moment the user interrupts", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "A long answer. " }]) });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTicks();
    expect(harness.sidecar.spoken).toHaveLength(1);

    harness.emitTranscript("actually", false);
    await vi.runAllTicks();

    expect(harness.sidecar.stopSpeakingCount).toBe(1);
  });

  it("reports the states the panel shows", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    await vi.runAllTicks();
    harness.finishUtterances();
    await vi.runAllTicks();

    const states = harness.updates.map((update) => update.state);
    expect(states).toContain("listening");
    expect(states).toContain("thinking");
    expect(states).toContain("speaking");
    expect(harness.updates.some((update) => update.sharing)).toBe(true);
    expect(harness.updates.at(-1)?.sharing).toBe(false);
  });

  it("stops listening and speaking while paused", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });

    await harness.service.setPaused(true);
    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.runAllTicks();

    expect(harness.sidecar.paused).toEqual([true]);
    expect(harness.sidecar.spoken).toHaveLength(0);
    expect(harness.updates.at(-1)?.state).toBe("paused");
  });

  it("shows the speech model being prepared, then listens once the sidecar is ready", async () => {
    const harness = await makeHarness();

    harness.emitSidecarState("preparing_model");
    expect(harness.updates.at(-1)?.state).toBe("preparing_model");
    harness.emitSidecarState("listening");
    expect(harness.updates.at(-1)?.state).toBe("listening");
  });

  it("re-sends the whole turn when the user carries on before the reply has said anything", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("Which field is the total?", true);
    await vi.advanceTimersByTimeAsync(700);
    harness.emitTranscript("on the second page", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(model.requests.map((request) => request.userText)).toEqual([
      "Which field is the total?",
      "Which field is the total? on the second page",
    ]);
    // The abandoned request fails as it unwinds; that is not an error to report.
    expect(harness.updates.filter((update) => update.error !== undefined)).toEqual([]);
  });

  it("starts a fresh turn when the user interrupts a reply that has begun speaking", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("Which column?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "The third one. " });
    await harness.settle();
    harness.emitTranscript("And the total?", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(model.requests.map((request) => request.userText)).toEqual(["Which column?", "And the total?"]);
  });

  it("answers a refusal with one plain line and never says the refused text", async () => {
    const harness = await makeHarness({
      transport: transportYielding([
        { kind: "text", text: "The password on screen is" },
        { kind: "refusal" },
      ]),
    });

    harness.emitTranscript("Read me that password.", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(spokenTexts(harness)).toEqual(["I can't help with that one."]);
  });

  it("goes back to listening when the sidecar cannot queue a sentence", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });
    harness.sidecar.speak = async () => { throw new Error("The capture sidecar did not answer."); };

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(harness.updates.at(-1)).toMatchObject({ state: "listening", sharing: false, error: "failed" });
  });

  it("gives up on a request that outlives its timeout and reports a timeout", async () => {
    // The Claude transport reports its own aborted request as "failed", so the
    // service must know the abort was its timeout.
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    expect(harness.service.state).toBe("thinking");
    await vi.advanceTimersByTimeAsync(20_000);

    expect(harness.updates.at(-1)).toMatchObject({ state: "listening", sharing: false, error: "timeout" });
  });

  it("says nothing more once its request times out mid-reply", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });
    harness.sidecar.hold("speak");

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "First. Second. " });
    await harness.settle();
    expect(spokenTexts(harness)).toEqual(["First."]);

    await vi.advanceTimersByTimeAsync(20_000);
    harness.sidecar.release("speak");
    await harness.settle();

    expect(spokenTexts(harness)).toEqual(["First."]);
    expect(harness.updates.at(-1)).toMatchObject({ sharing: false, error: "timeout" });
  });
});

describe("LiveAssistService screenshots", () => {
  it("removes the screenshot before the request is sent", async () => {
    const removed: string[] = [];
    const removedWhenSent: number[] = [];
    const harness = await makeHarness({
      removeImage: async (path) => { removed.push(path); },
      transport: {
        async *reply() {
          removedWhenSent.push(removed.length);
          yield { kind: "text", text: "Answer." };
        },
        async check() { return { ask: false }; },
      },
    });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(harness.sidecar.screenshots).toHaveLength(1);
    expect(removed).toEqual(harness.sidecar.screenshots);
    expect(removedWhenSent).toEqual([1]);
  });

  it("removes the screenshot even when reading it fails, and goes back to listening", async () => {
    const model = heldTransport();
    const harness = await makeHarness({
      transport: model.transport,
      readImage: async () => { throw new Error("The screenshot could not be read."); },
    });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(harness.sidecar.screenshots).toHaveLength(1);
    expect(harness.removedImages).toEqual(harness.sidecar.screenshots);
    expect(model.requests).toHaveLength(0);
    expect(harness.updates.at(-1)).toMatchObject({ state: "listening", sharing: false, error: "failed" });
  });

  it("sends nothing to Claude when a pause lands while the screenshot is being taken", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });
    harness.sidecar.hold("screenshot");

    harness.emitTranscript("Is this the right account?", true);
    await vi.advanceTimersByTimeAsync(700);
    expect(harness.sidecar.screenshots).toHaveLength(1);

    await harness.service.setPaused(true);
    harness.sidecar.release("screenshot");
    await harness.settle();

    expect(model.requests).toHaveLength(0);
    expect(harness.removedImages).toEqual(harness.sidecar.screenshots);
    expect(harness.updates.at(-1)).toMatchObject({ state: "paused", sharing: false });
  });
});

// Each test below holds a reply at one of its awaits (the next streamed chunk,
// the sidecar's speak, the screenshot) and lands an event or a control call
// there, to prove an invariant stated on LiveAssistService.
describe("LiveAssistService interleavings", () => {
  it("says nothing more from a reply the user interrupts while it awaits its next chunk", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("Which total should I use?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "Use the invoice total. " });
    await harness.settle();
    expect(spokenTexts(harness)).toEqual(["Use the invoice total."]);

    // The reply is waiting for its next chunk. The user barges in, and a chunk
    // the stream had already buffered still arrives.
    harness.emitTranscript("wait", false);
    model.release({ kind: "text", text: "It includes tax. " });
    model.finish();
    await harness.settle();

    expect(spokenTexts(harness)).toEqual(["Use the invoice total."]);
    expect(harness.sidecar.stopSpeakingCount).toBe(1);
  });

  it("says nothing of a half-received sentence when the stream ends just after the user barges in", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("Which total should I use?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "Use the invoice total. It includes" });
    await harness.settle();
    expect(spokenTexts(harness)).toEqual(["Use the invoice total."]);

    harness.emitTranscript("wait", false);
    model.finish();
    await harness.settle();

    expect(spokenTexts(harness)).toEqual(["Use the invoice total."]);
  });

  it("says nothing more from a reply the user interrupts while a sentence is being queued", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });
    harness.sidecar.hold("speak");

    harness.emitTranscript("Do the totals match?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "They match. You can approve it. " });
    await harness.settle();
    expect(spokenTexts(harness)).toEqual(["They match."]);

    harness.emitTranscript("hang on", false);
    harness.sidecar.release("speak");
    await harness.settle();

    expect(spokenTexts(harness)).toEqual(["They match."]);
  });

  it("stays paused when a pause lands mid-reply, whatever the reply does next", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });

    harness.emitTranscript("What does this button do?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "It flags the invoice. " });
    await harness.settle();
    expect(harness.service.state).toBe("speaking");
    const [stopped] = harness.sidecar.spoken;

    const pausedFrom = harness.updates.length;
    const pausing = harness.service.setPaused(true);
    model.release({ kind: "text", text: "Then it emails the approver. " });
    model.finish();
    await pausing;
    // The sidecar's reports about the stopped sentence arrive late.
    harness.emitSpeech(stopped!.utteranceId, "started");
    harness.emitSpeech(stopped!.utteranceId, "finished");
    await vi.advanceTimersByTimeAsync(20_000);

    const statesSincePause = harness.updates.slice(pausedFrom).map((update) => update.state);
    expect(statesSincePause.length).toBeGreaterThan(0);
    expect(statesSincePause.filter((state) => state !== "paused")).toEqual([]);
    expect(harness.updates.at(-1)).toMatchObject({ state: "paused", sharing: false });
    expect(harness.sidecar.spoken).toHaveLength(1);
  });

  it("speaks nothing once end() is called mid-reply, and resolves only after the reply has stopped", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });
    harness.sidecar.hold("speak");

    harness.emitTranscript("Walk me through this form.", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "Start with the vendor. Then the amount. " });
    await harness.settle();
    expect(spokenTexts(harness)).toEqual(["Start with the vendor."]);

    let ended = false;
    const ending = harness.service.end().then(() => { ended = true; });
    await harness.settle();
    // The reply is still suspended in the sidecar's speak, so end() waits.
    expect(ended).toBe(false);

    harness.sidecar.release("speak");
    model.release({ kind: "text", text: "Finally the date. " });
    model.finish();
    await ending;

    expect(spokenTexts(harness)).toEqual(["Start with the vendor."]);
    expect(harness.sidecar.stopSpeakingCount).toBe(1);
    expect(harness.service.state).toBe("ended");
    expect(harness.updates.at(-1)).toMatchObject({ state: "ended", sharing: false });
  });

  it("checks and hands over a sentence in one step, so End pressed at that instant still silences it", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });
    let ending: Promise<void> | undefined;
    harness.whenUpdated((update) => {
      // End lands the instant the panel is told the tutor is speaking.
      if (update.state === "speaking" && ending === undefined) {
        harness.sidecar.commands.push("end");
        ending = harness.service.end();
      }
    });

    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    await ending;

    expect(harness.sidecar.commands).toEqual(["speak Answer.", "end", "stopSpeaking"]);
  });

  it("never lets a pause's stop land on speech queued after the resume", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });
    harness.emitTranscript("First question?", true);
    await vi.advanceTimersByTimeAsync(700);

    // The sidecar is slow to acknowledge pausing; meanwhile the user resumes
    // and asks again.
    harness.sidecar.hold("setPaused");
    const pausing = harness.service.setPaused(true);
    const resuming = harness.service.setPaused(false);
    harness.emitTranscript("Second question?", true);
    await vi.advanceTimersByTimeAsync(700);
    harness.sidecar.release("setPaused");
    await Promise.all([pausing, resuming]);

    expect(harness.sidecar.commands).toEqual([
      "speak Answer.",
      "stopSpeaking",
      "setPaused true",
      "setPaused false",
      "speak Answer.",
    ]);
    expect(harness.service.state).toBe("speaking");
  });

  it("forgets a sentence the moment it stops it, and ignores late reports about it", async () => {
    const harness = await makeHarness({ transport: transportYielding([{ kind: "text", text: "Answer." }]) });
    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    const [stopped] = harness.sidecar.spoken;

    harness.emitTranscript("actually", false);
    harness.emitTranscript("actually, no", false);
    // Stopped once, and listening straight away, before the sidecar reports back.
    expect(harness.sidecar.stopSpeakingCount).toBe(1);
    expect(harness.service.state).toBe("listening");

    const stoppedFrom = harness.updates.length;
    harness.emitSpeech(stopped!.utteranceId, "started");
    harness.emitSpeech(stopped!.utteranceId, "cancelled");
    await harness.settle();

    expect(harness.updates.slice(stoppedFrom).map((update) => update.state)).not.toContain("speaking");
    expect(harness.service.state).toBe("listening");
  });

  it("stays failed when live audio fails mid-reply", async () => {
    const model = heldTransport();
    const harness = await makeHarness({ transport: model.transport });
    harness.emitTranscript("Question?", true);
    await vi.advanceTimersByTimeAsync(700);
    model.release({ kind: "text", text: "First. " });
    await harness.settle();

    harness.emitSidecarState("failed", "live_audio_failed");
    model.release({ kind: "text", text: "Second. " });
    model.finish();
    harness.finishUtterances();
    harness.emitTranscript("Hello?", true);
    await vi.advanceTimersByTimeAsync(700);

    expect(spokenTexts(harness)).toEqual(["First."]);
    expect(model.requests).toHaveLength(1);
    expect(harness.service.state).toBe("failed");
    expect(harness.updates.at(-1)).toMatchObject({ state: "failed", sharing: false, error: "live_audio_failed" });
  });
});
