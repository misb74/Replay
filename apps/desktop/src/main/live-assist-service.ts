import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveState, LiveUpdate } from "../shared/contracts.js";
import type { ObservedAction } from "./live-events-tail.js";
import { LiveModelError, type LiveHistoryItem, type LiveModelTransport, type LiveReplyRequest } from "./live-model.js";

export interface LiveTranscriptSignal {
  segmentId: string;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
}

export interface LiveSpeechSignal {
  utteranceId: string;
  phase: "started" | "finished" | "cancelled";
}

export interface LiveStateSignal {
  state: "preparing_model" | "listening" | "paused" | "failed";
  reason?: string;
}

/**
 * The only capability the tutor has over the Mac. It can look and talk; there
 * is deliberately no path here to click, type, press keys, scroll, drag, or
 * navigate.
 */
export interface LiveSidecar {
  screenshot(outputPath: string): Promise<{ path: string }>;
  speak(utteranceId: string, text: string): Promise<void>;
  stopSpeaking(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  onTranscript(listener: (event: LiveTranscriptSignal) => void): () => void;
  onSpeech(listener: (event: LiveSpeechSignal) => void): () => void;
  onState(listener: (event: LiveStateSignal) => void): () => void;
}

export interface LiveAssistOptions {
  sessionId: string;
  sessionDirectory: string;
  sidecar: LiveSidecar;
  transport: LiveModelTransport;
  events: { read(): Promise<ObservedAction[]> };
  onUpdate: (update: LiveUpdate) => void;
  /** Reads a screenshot from disk and returns base64 JPEG. */
  readImage: (path: string) => Promise<string>;
  /** Deletes a screenshot from disk once it has been read. Defaults to `unlink`. */
  removeImage?: (path: string) => Promise<void>;
  now?: () => number;
  turnSilenceMs?: number;
  requestTimeoutMs?: number;
}

const SENTENCE_LIMIT = 200;

const REFUSAL_REPLY = "I can't help with that one.";

export function splitSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = /([.!?])(\s+)/u.exec(rest);
    if (match) {
      sentences.push(rest.slice(0, match.index + 1).trim());
      rest = rest.slice(match.index + match[0].length);
      continue;
    }
    if (rest.length >= SENTENCE_LIMIT) {
      sentences.push(rest.trim());
      rest = "";
    }
    break;
  }
  return { sentences, rest };
}

/** One closed turn's request to the model, and the speech it produces. */
interface Reply {
  readonly userText: string;
  readonly controller: AbortController;
  /** True once any sentence of this reply has been handed to the sidecar. */
  spoke: boolean;
  /** True once the request has run past `requestTimeoutMs`. */
  timedOut: boolean;
}

/**
 * Assembles turns from streamed speech, sends one request per turn, speaks
 * the reply sentence by sentence, and yields to the user the moment they
 * speak again.
 *
 * Event handlers and control calls run while a reply is suspended at any of
 * its awaits (the screenshot, the next streamed chunk, the sidecar's speak),
 * so the class keeps these invariants. Code that extends a reply must keep
 * them too: call `#shouldContinue` after each of its own awaits, and speak
 * only through `#speak`.
 *
 * 1. Only the current reply acts. The user speaking, `setPaused`, `end`, and
 *    a sidecar failure each supersede the current reply synchronously and
 *    abort its request. After every await, a reply re-checks that it is
 *    still current, and `#speak` checks again in the same synchronous stretch
 *    as the `sidecar.speak` call it guards. A superseded reply therefore
 *    never speaks again, and never sends a request it had not yet sent.
 * 2. A stop belongs to the speech it stops. `stopSpeaking` is issued at the
 *    moment of the decision, never after an await, and the utterances it
 *    stops are forgotten in the same synchronous step. It is on its way to
 *    the sidecar before any later speech, and late speech events about the
 *    utterances it stopped change nothing.
 * 3. The published state is never stale. It is derived from the facts at the
 *    moment of publishing, with `ended`, `failed`, and `paused` taking
 *    precedence, and a superseded reply publishes nothing. Once paused, the
 *    state stays `paused` until resumed; once failed or ended, it stays so.
 * 4. `end()` is final and waits for the work. Before its first await it
 *    supersedes the reply, stops speech, detaches from the sidecar, and
 *    publishes `ended`; it resolves only once every reply has unwound. It
 *    must therefore never be awaited from inside a reply. A reply is tracked
 *    before it is announced, so this holds even for an `end()` called from
 *    that announcement.
 * 5. A screenshot is removed from disk in a `finally` as soon as it has been
 *    read, so before any request carries it, and whether or not reading it
 *    succeeded. Every screenshot is written inside one owner-only directory
 *    made at `start()`, which `end()` removes whole, sweeping any screenshot
 *    the sidecar wrote after its request had stopped waiting for it.
 */
export class LiveAssistService {
  readonly #options: LiveAssistOptions &
    Required<Pick<LiveAssistOptions, "now" | "turnSilenceMs" | "requestTimeoutMs" | "removeImage">>;
  #started = false;
  #paused = false;
  #ended = false;
  #failed = false;
  #preparingModel = false;
  #heard: { text: string; final: boolean } | undefined;
  #said: string | undefined;
  #error: string | undefined;
  #turn = "";
  #turnTimer: NodeJS.Timeout | undefined;
  /** The reply that holds the floor, if any. */
  #reply: Reply | undefined;
  /** Utterances handed to the sidecar that have neither finished nor been stopped. */
  readonly #utterances = new Set<string>();
  /** Every reply still running, current or superseded. */
  readonly #running = new Set<Promise<void>>();
  #starting: Promise<void> | undefined;
  #ending: Promise<void> | undefined;
  /** The owner-only directory every screenshot is written into, and that `end()` removes. */
  #screenshotDirectory: string | undefined;
  #detach: Array<() => void> = [];
  #history: LiveHistoryItem[] = [];

  constructor(options: LiveAssistOptions) {
    this.#options = {
      now: () => Date.now(),
      turnSilenceMs: 700,
      requestTimeoutMs: 20_000,
      removeImage: (path) => unlink(path),
      ...options,
    };
  }

  get state(): LiveState {
    if (this.#ended) return "ended";
    if (this.#failed) return "failed";
    if (this.#paused) return "paused";
    if (!this.#started) return "starting";
    if (this.#utterances.size > 0 || this.#reply?.spoke === true) return "speaking";
    if (this.#reply !== undefined) return "thinking";
    if (this.#preparingModel) return "preparing_model";
    return "listening";
  }

  async start(): Promise<void> {
    this.#starting ??= this.#start();
    await this.#starting;
  }

  async #start(): Promise<void> {
    if (this.#ended) return;
    // Recorded as soon as it exists, so that `end()`, which waits for
    // starting to settle, removes it even when ending arrived meanwhile.
    this.#screenshotDirectory = await mkdtemp(join(tmpdir(), "replay-live-"));
    await chmod(this.#screenshotDirectory, 0o700);
    if (this.#ended) return;
    this.#started = true;
    const { sidecar } = this.#options;
    this.#detach.push(
      sidecar.onTranscript((event) => this.#onTranscript(event)),
      sidecar.onSpeech((event) => this.#onSpeech(event)),
      sidecar.onState((event) => this.#onSidecarState(event)),
    );
    this.#publish();
  }

  async setPaused(paused: boolean): Promise<void> {
    if (this.#ended || this.#paused === paused) return;
    this.#paused = paused;
    this.#clearTurn();
    this.#supersedeReply();
    // Both commands are issued before the first await, so nothing issued
    // later, such as a resume or the next reply's speech, can overtake them.
    const stopping = this.#stopSpeaking();
    const pausing = this.#options.sidecar.setPaused(paused);
    this.#publish();
    await Promise.all([stopping, pausing]);
  }

  async end(): Promise<void> {
    if (this.#ending === undefined) {
      this.#ended = true;
      this.#clearTurn();
      this.#supersedeReply();
      const stopping = this.#stopSpeaking();
      for (const detach of this.#detach.splice(0)) detach();
      this.#publish();
      this.#ending = this.#finishEnding(stopping);
    }
    await this.#ending;
  }

  /**
   * The recording stops once `end()` resolves, so this waits for the stop, for
   * starting, and for every reply to unwind, but never fails because one of
   * them did. Only then does it remove the screenshot directory whole, which
   * also sweeps a screenshot the sidecar finished writing after its request
   * had stopped waiting for it.
   */
  async #finishEnding(stopping: Promise<void> | undefined): Promise<void> {
    await Promise.allSettled([stopping, this.#starting, ...this.#running]);
    if (this.#screenshotDirectory === undefined) return;
    // Nothing is left to report a failed removal to.
    await rm(this.#screenshotDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  #onTranscript(event: LiveTranscriptSignal): void {
    if (this.#paused || this.#ended || this.#failed) return;
    this.#heard = { text: event.text, final: event.isFinal };
    this.#yieldToUser();
    if (event.isFinal) this.#turn = joinWords(this.#turn, event.text);
    this.#restartTurnTimer();
    this.#publish();
  }

  /** Whatever the tutor is doing, the user speaking takes precedence. */
  #yieldToUser(): void {
    const reply = this.#supersedeReply();
    if (reply !== undefined && !reply.spoke) {
      // Nothing has been said yet, so the user is still in the same turn:
      // their earlier words are sent again with the rest when it closes.
      this.#turn = joinWords(reply.userText, this.#turn);
    }
    // An event handler has no caller to report a failed stop to, and nothing
    // further it could do about one.
    void this.#stopSpeaking()?.catch(() => undefined);
  }

  #restartTurnTimer(): void {
    if (this.#turnTimer !== undefined) clearTimeout(this.#turnTimer);
    this.#turnTimer = setTimeout(() => this.#closeTurn(), this.#options.turnSilenceMs);
  }

  #clearTurn(): void {
    if (this.#turnTimer !== undefined) clearTimeout(this.#turnTimer);
    this.#turnTimer = undefined;
    this.#turn = "";
  }

  #closeTurn(): void {
    this.#turnTimer = undefined;
    const userText = this.#turn;
    if (userText === "" || this.#paused || this.#ended || this.#failed) return;
    this.#turn = "";
    const reply: Reply = { userText, controller: new AbortController(), spoke: false, timedOut: false };
    this.#reply = reply;
    // The reply is tracked before `thinking` is published but starts only
    // after, so a control call made from that update both supersedes it before
    // any screenshot is taken and, if it is `end()`, waits for it.
    const running = Promise.resolve().then(() => this.#respond(reply));
    this.#running.add(running);
    const forget = () => { this.#running.delete(running); };
    running.then(forget, forget);
    this.#publish();
  }

  async #respond(reply: Reply): Promise<void> {
    if (!this.#shouldContinue(reply)) return;
    const timeout = setTimeout(() => {
      reply.timedOut = true;
      reply.controller.abort();
    }, this.#options.requestTimeoutMs);
    try {
      const request = await this.composeReplyRequest(reply.userText, reply.controller.signal);
      if (!this.#shouldContinue(reply)) return;
      let buffer = "";
      for await (const chunk of this.#options.transport.reply(request)) {
        if (!this.#shouldContinue(reply)) return;
        if (chunk.kind === "text") {
          const { sentences, rest } = splitSentences(buffer + chunk.text);
          buffer = rest;
          for (const sentence of sentences) {
            await this.#speak(reply, sentence);
            if (!this.#shouldContinue(reply)) return;
          }
        } else if (chunk.kind === "refusal") {
          // Whatever the model began before refusing is never said.
          buffer = "";
          await this.#speak(reply, REFUSAL_REPLY);
          if (!this.#shouldContinue(reply)) return;
        }
      }
      if (!this.#shouldContinue(reply)) return;
      await this.#speak(reply, buffer.trim());
      if (!this.#shouldContinue(reply)) return;
      this.#error = undefined;
      this.#history.push({ speaker: "user", text: reply.userText });
    } catch (cause) {
      // A superseded reply's failure, such as its own aborted request, is no
      // longer anyone's concern.
      if (this.#reply === reply) this.#error = failureCode(reply, cause);
    } finally {
      clearTimeout(timeout);
      // However the reply ends, its request ends with it.
      reply.controller.abort();
      if (this.#reply === reply) {
        this.#reply = undefined;
        this.#publish();
      }
    }
  }

  /**
   * Called by a reply after each of its awaits. Answers false once the reply
   * has been superseded, so it returns without acting. Throws once its own
   * request has timed out, so that a timeout fails the turn through the same
   * path as any other failed request; the reply still holds the floor there,
   * so a failure path may yet speak for it.
   */
  #shouldContinue(reply: Reply): boolean {
    if (this.#reply !== reply) return false;
    if (reply.timedOut) throw new LiveModelError("timeout");
    return true;
  }

  /** Placeholder composition: the screenshot and the user's words only. */
  protected async composeReplyRequest(userText: string, signal: AbortSignal): Promise<LiveReplyRequest> {
    const screenshot = await this.#captureScreenshot();
    return {
      system: "You are Replay's live tutor.",
      actions: [],
      history: [...this.#history],
      screenshot,
      userText,
      signal,
    };
  }

  async #captureScreenshot(): Promise<{ base64: string }> {
    if (this.#screenshotDirectory === undefined) throw new Error("The live conversation has not started.");
    const path = join(this.#screenshotDirectory, `${randomUUID()}.png`);
    try {
      await this.#options.sidecar.screenshot(path);
      return { base64: await this.#options.readImage(path) };
    } finally {
      // The screenshot exists only until it has been read into memory, and is
      // removed even when taking or reading it failed. A removal that fails
      // cannot usefully be retried here, and is no reason to fail the turn.
      await this.#options.removeImage(path).catch(() => undefined);
    }
  }

  /**
   * Hands one sentence to the sidecar for `reply`, unless another has taken
   * the floor. The check and the hand-over share one synchronous stretch.
   * Callers re-check with `#shouldContinue` once this resolves.
   */
  async #speak(reply: Reply, sentence: string): Promise<void> {
    if (this.#reply !== reply || sentence === "") return;
    const utteranceId = randomUUID();
    this.#utterances.add(utteranceId);
    reply.spoke = true;
    this.#said = sentence;
    const queued = this.#options.sidecar.speak(utteranceId, sentence);
    this.#publish();
    try {
      await queued;
    } catch (cause) {
      // Never queued, so no speech event will ever settle it.
      this.#utterances.delete(utteranceId);
      throw cause;
    }
  }

  #onSpeech(event: LiveSpeechSignal): void {
    if (event.phase === "started") return;
    // Only speech the service is still waiting on affects its state; a late
    // report about an utterance it has already stopped changes nothing.
    if (this.#utterances.delete(event.utteranceId)) this.#publish();
  }

  #onSidecarState(event: LiveStateSignal): void {
    if (this.#ended || this.#failed) return;
    if (event.state === "failed") {
      this.#failed = true;
      this.#error = event.reason ?? "live_audio_failed";
      this.#clearTurn();
      this.#supersedeReply();
      // The tutor falls silent with the failure; there is no one to report a
      // failed stop to.
      void this.#stopSpeaking()?.catch(() => undefined);
    } else {
      this.#preparingModel = event.state === "preparing_model";
    }
    this.#publish();
  }

  /**
   * Takes the floor from the current reply, if there is one, and aborts its
   * request. The reply notices at its next check and returns.
   */
  #supersedeReply(): Reply | undefined {
    const reply = this.#reply;
    this.#reply = undefined;
    reply?.controller.abort();
    return reply;
  }

  /**
   * Stops every utterance still outstanding and forgets them in the same
   * synchronous step. Answers undefined when there is nothing to stop.
   */
  #stopSpeaking(): Promise<void> | undefined {
    if (this.#utterances.size === 0) return undefined;
    this.#utterances.clear();
    return this.#options.sidecar.stopSpeaking();
  }

  #publish(): void {
    this.#options.onUpdate({
      sessionId: this.#options.sessionId,
      state: this.state,
      ...(this.#heard === undefined ? {} : { heard: this.#heard }),
      ...(this.#said === undefined ? {} : { said: this.#said }),
      sharing: this.#reply !== undefined,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    });
  }
}

/**
 * What a failed turn reports. Its own timeout comes first, because the Claude
 * transport reports the request it aborted as a plain failure.
 */
function failureCode(reply: Reply, cause: unknown): string {
  if (reply.timedOut) return "timeout";
  return cause instanceof LiveModelError ? cause.code : "failed";
}

function joinWords(...parts: string[]): string {
  return parts.map((part) => part.trim()).filter((part) => part !== "").join(" ");
}
