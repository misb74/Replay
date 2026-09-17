import type { LiveAvailability, LiveUpdate, PermissionStatus } from "../shared/contracts.js";
import { ipcChannels } from "../shared/contracts.js";
import type { LiveSidecar, LiveSpeechSignal, LiveStateSignal, LiveTranscriptSignal } from "./live-assist-service.js";
import type { LiveStartOptions } from "./session-service.js";
import { SidecarRequestError, type SidecarClient } from "./sidecar-client.js";

/**
 * Whether the live tutor can run on this Mac, and the first reason it cannot
 * (spec §6.1): macOS 26, then the API key, then the microphone permission.
 * The first failing check is the reason the record card shows.
 *
 * A system version whose major number cannot be read fails closed. An
 * unreadable version is no evidence that the Mac is new enough, and letting
 * it through would offer Live where the sidecar can only refuse it.
 */
export function liveAvailability(
  systemVersion: string,
  apiKey: string | undefined,
  permissions: readonly PermissionStatus[],
): LiveAvailability {
  const major = Number.parseInt(systemVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 26) return { available: false, reason: "Needs macOS 26" };
  if (!apiKey) return { available: false, reason: "Set ANTHROPIC_API_KEY in .env" };
  if (permissions.find((permission) => permission.name === "microphone")?.state !== "granted") {
    return { available: false, reason: "Grant Microphone in System Settings" };
  }
  return { available: true };
}

/**
 * Waits for `work`, but never longer than `ms`, and never fails. A caller that
 * must not be held up — or brought down — by what it is waiting for gets a
 * ceiling rather than a wait: stopping a recording, and quitting, both wait
 * for the tutor this way. `onExpired` is called when the ceiling comes first,
 * so nothing is given up on silently. The work itself carries on either way,
 * and its failure, whenever it arrives, reaches nobody.
 */
export function withDeadline(work: Promise<unknown>, ms: number, onExpired?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (onExpired) withoutFailing(onExpired);
      resolve();
    }, ms);
    void work.catch(() => undefined).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Runs `step` and lets a failure go. For the last steps of a shutdown, where
 * there is nothing left to report a failure to, and where the step after it
 * still has to run.
 */
export function withoutFailing(step: () => void): void {
  try {
    step();
  } catch {
    // Deliberately quiet: see above.
  }
}

/**
 * The only capability the tutor has over the Mac: it can look at the screen,
 * speak, stop speaking, and be paused. There is deliberately no path here to
 * any `act_*` command other than the screenshot.
 */
export function createLiveSidecar(client: SidecarClient): LiveSidecar {
  // A sidecar that has gone is never revived for the tutor. `request` starts a
  // capture process when none is running, and a fresh one would begin its
  // clock again at zero, while this conversation belongs to the recording that
  // went with the old one.
  const request = async (command: string, payload: Record<string, unknown> = {}) => {
    if (!client.isRunning()) throw new SidecarRequestError("exited", "The capture sidecar is no longer running.");
    return client.request(command, payload);
  };
  return {
    screenshot: async (outputPath) => {
      // Replay's own windows are never in what the tutor sees, and
      // `createDirectories: false` stops a late screenshot from recreating the
      // private directory the conversation has already swept.
      const result = await request("act_screenshot", { outputPath, excludeProcessIds: [process.pid], createDirectories: false });
      return { path: result.screenshot?.path ?? outputPath };
    },
    speak: async (utteranceId, text) => { await request("live_speak", { utteranceId, text }); },
    stopSpeaking: async () => { await request("live_stop_speaking"); },
    setPaused: async (paused) => { await request("live_set_paused", { paused }); },
    onTranscript: (listener) => client.on("live_transcript", (event) => listener(event as LiveTranscriptSignal)),
    onSpeech: (listener) => client.on("live_speech", (event) => listener(event as LiveSpeechSignal)),
    onState: (listener) => client.on("live_state", (event) => listener(event as LiveStateSignal)),
  };
}

/** What the tutor needs of a conversation. `LiveAssistService` provides it. */
export interface LiveConversation {
  start(): Promise<void>;
  end(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
}

/**
 * What the tutor needs of the panel's window, so that this module never
 * imports Electron and can be tested without one. `BrowserWindow` provides
 * all of it.
 */
export interface LivePanelWindow {
  isDestroyed(): boolean;
  close(): void;
  send(channel: string, value: unknown): void;
  /** Runs `listener` every time the panel's page finishes loading, a reload included. */
  onLoad(listener: () => void): void;
}

export interface LiveTutorOptions {
  /** Opens the panel's window. Called only when no panel of this tutor's is open. */
  createPanelWindow: () => LivePanelWindow;
  /** Sends an update to the main window's record card. */
  publish: (update: LiveUpdate) => void;
  /** Makes the conversation for a recording that is about to start. */
  createConversation: (
    session: { id: string; directory: string },
    onUpdate: (update: LiveUpdate) => void,
  ) => LiveConversation;
  /** How long any end waits for the conversation to finish its files. */
  endDeadlineMs: number;
  /** Told when that wait runs out, so the ceiling is an observable branch rather than a silent one. */
  onEndTimeout?: () => void;
}

/**
 * One start's claim on the tutor. `SessionService.start` drives the options;
 * the handler that owns the start abandons it if the recording never happens.
 */
export interface LiveStart extends LiveStartOptions {
  /** Ends whatever this start brought up, and nothing else. */
  abandon(): Promise<void>;
}

/**
 * Owns the live conversation's lifetime in the main process: one conversation
 * at a time, one panel showing it, and one way out.
 *
 * The conversation never outlives its recording, so every path that ends a
 * recording ends it here: Stop, End Live, the sidecar exiting, a quit, a start
 * that failed, and a recording the app has found is no longer its own.
 *
 * Ending never fails and never waits beyond `endDeadlineMs`, because the
 * recording is never the casualty (spec §8): Stop ends the tutor before it
 * stops the recording, and a tutor that cannot end must not keep the recorder
 * running. Every caller that must fail rethrows its own cause instead.
 */
export class LiveTutor {
  readonly #options: LiveTutorOptions;
  #session: { id: string; conversation: LiveConversation } | undefined;
  #panel: LivePanelWindow | undefined;
  /** The latest update, kept while a panel is open so a panel that opens or reloads can be told it. */
  #lastUpdate: LiveUpdate | undefined;

  constructor(options: LiveTutorOptions) {
    this.#options = options;
  }

  /** Whether a conversation is running, which is what makes a quit wait. */
  get isRunning(): boolean {
    return this.#session !== undefined;
  }

  /**
   * The options `SessionService.start` needs to bring the tutor up with a
   * recording. The conversation is made and started in the moment before
   * `record` is sent, so its clocks begin with the recording rather than
   * minutes earlier, while the speech model was being prepared.
   */
  startFor(): LiveStart {
    // Remembered so that this start tears down only what it brought up. A
    // second Record click is refused before any live work, and must not end
    // the conversation the first click is still bringing up.
    let startedId: string | undefined;
    return {
      onPreparing: (sessionId) => this.#show({ sessionId, state: "preparing_model", sharing: false }),
      beforeRecord: async ({ id, directory }) => {
        // A conversation is never overwritten: an orphan would go on listening
        // to the sidecar with nobody left to end it.
        await this.end();
        const conversation = this.#options.createConversation({ id, directory }, (update) => this.#show(update));
        this.#session = { id, conversation };
        startedId = id;
        try {
          await conversation.start();
        } catch (cause) {
          await this.end();
          throw cause;
        }
      },
      abandon: async () => {
        if (startedId !== undefined) await this.endSession(startedId);
      },
    };
  }

  /** Ends the conversation only if it is the one belonging to `sessionId`. */
  async endSession(sessionId: string): Promise<void> {
    if (this.#session?.id === sessionId) await this.end();
  }

  /**
   * Ends the conversation, if one is running. A `failure` is published after
   * the conversation's own `ended` update and leaves the panel open showing
   * that reason: `Failed · capture stopped` would otherwise be gone before
   * anyone had read it. End Live is what dismisses such a panel — it calls
   * this again, finds nothing running, and closes it in the branch below.
   */
  async end(failure?: string): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (!session) {
      this.closePanel();
      return;
    }
    await withDeadline(session.conversation.end(), this.#options.endDeadlineMs, this.#options.onEndTimeout);
    if (failure !== undefined) {
      this.#show({ sessionId: session.id, state: "failed", sharing: false, error: failure });
      return;
    }
    this.closePanel();
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.#session?.conversation.setPaused(paused);
  }

  openPanel(): void {
    if (this.#panel && !this.#panel.isDestroyed()) return;
    const panel = this.#options.createPanelWindow();
    this.#panel = panel;
    // The panel's own subscription starts empty, so without this it would say
    // "Starting" until the next change, however far into the conversation it
    // opened — and again after any reload of its page.
    panel.onLoad(() => {
      const update = this.#lastUpdate;
      if (update) withoutFailing(() => panel.send(ipcChannels.liveUpdate, update));
    });
  }

  closePanel(): void {
    const panel = this.#panel;
    this.#panel = undefined;
    // Forgotten with the panel it was for, so the panel of whatever recording
    // comes next never briefly replays a line that belonged to this one.
    this.#lastUpdate = undefined;
    if (panel && !panel.isDestroyed()) withoutFailing(() => panel.close());
  }

  /**
   * Shows one update on both windows. Neither window's failure is the
   * conversation's problem: this is called from inside it, including from a
   * reply that is mid-sentence.
   */
  #show(update: LiveUpdate): void {
    this.#lastUpdate = update;
    withoutFailing(() => this.#options.publish(update));
    const panel = this.#panel;
    if (panel && !panel.isDestroyed()) withoutFailing(() => panel.send(ipcChannels.liveUpdate, update));
  }
}
