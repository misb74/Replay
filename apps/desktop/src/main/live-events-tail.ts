import { open, type FileHandle } from "node:fs/promises";

export interface ObservedAction {
  kind: string;
  description: string;
  role?: string;
  application?: string;
  windowTitle?: string;
  timestampMs: number;
  /** True for a click on a control that commits, or a switch to another application. */
  committed: boolean;
  /**
   * How many identical actions in a row this one stands for, once merged by
   * `appendActions`. Absent on an action read from the log, which is one.
   */
  count?: number;
}

/**
 * Accessibility roles whose activation commits to something: pressing a
 * button, ticking a box, choosing a radio option or menu item, or opening a
 * pop-up chooser. A click on anything else (static text, a text field, a
 * group) is not by itself worth interrupting the user about.
 */
const COMMITTING_ROLES = new Set(["AXButton", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton"]);

/** Past-tense verbs so a description reads naturally to a model, e.g. `clicked "Approve invoice"`. */
const VERBS_BY_KIND: Readonly<Record<string, string>> = {
  click: "clicked",
  key: "typed",
  scroll: "scrolled",
  drag: "dragged",
};

const NEWLINE_BYTE = 0x0a;

/**
 * Follows a session's `events.jsonl` from wherever the previous read left
 * off. The recorder flushes and fsyncs the file after every event, so
 * re-opening it and reading only the newly appended bytes is reliable even
 * while a recording is still in progress.
 */
export class LiveEventsTail {
  #offset = 0;
  /** Undecoded bytes after the last complete line seen so far. */
  #carry = Buffer.alloc(0);

  constructor(private readonly path: string) {}

  /**
   * Every action appended to the log since the previous call to `read`.
   * Resolves only once it has looked at the log, or found that the log does
   * not exist yet, and rejects if the log cannot be opened for any other
   * reason, or read, so that a caller never mistakes a read that could not
   * look for one that found nothing new.
   */
  async read(): Promise<ObservedAction[]> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch (cause) {
      // Only a log that does not exist yet has nothing new to report: the
      // recorder creates it once, with the session, and never replaces it.
      // Any other failure to open it, such as EMFILE or EIO, is passed on.
      if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return [];
      throw cause;
    }
    try {
      const stats = await handle.stat();
      if (stats.size <= this.#offset) return [];
      const length = stats.size - this.#offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
      this.#offset += bytesRead;
      const bytes = Buffer.concat([this.#carry, buffer.subarray(0, bytesRead)]);

      // Split on the raw newline byte, not on a decoded string. 0x0A never
      // occurs inside a multi-byte UTF-8 sequence, so this can never cut a
      // character in half. Decoding each read's bytes to a string before
      // recombining with the carry (as this used to) corrupts any
      // multi-byte character that straddles a read boundary: both halves
      // decode independently to U+FFFD, and once that has happened the
      // original bytes cannot be recovered from either side.
      const actions: ObservedAction[] = [];
      let start = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] !== NEWLINE_BYTE) continue;
        const action = toAction(bytes.toString("utf8", start, index));
        if (action !== undefined) actions.push(action);
        start = index + 1;
      }
      // Bytes after the last newline are a line still being written (the
      // writer fsyncs after every whole event); hold them back, still
      // undecoded, until a later read completes them.
      this.#carry = bytes.subarray(start);
      return actions;
    } finally {
      await handle.close();
    }
  }
}

/**
 * `recent` with `incoming` added after it, oldest first, keeping only the
 * newest `limit` entries. An action described exactly as the entry before it
 * is merged into that entry, which becomes the newer action with the two
 * counts added together. The input monitor reports a scroll gesture once per
 * scroll-wheel event, so without merging one gesture would push every older
 * action out. Merging happens before the limit is applied, and neither list
 * given is changed.
 *
 * Only the description of an entry is sure to survive merging, so a caller
 * that acts on a particular action, such as asking about a committed one,
 * must keep that action apart as it reads it.
 */
export function appendActions(
  recent: readonly ObservedAction[],
  incoming: readonly ObservedAction[],
  limit: number,
): ObservedAction[] {
  const merged = [...recent];
  for (const action of incoming) {
    const last = merged.at(-1);
    if (last?.description === action.description) {
      merged[merged.length - 1] = { ...action, count: (last.count ?? 1) + (action.count ?? 1) };
    } else {
      merged.push(action);
    }
  }
  return merged.slice(Math.max(0, merged.length - limit));
}

/**
 * One line for each of the newest `limit` entries, oldest first, after
 * merging identical actions in a row (see `appendActions`). A merged entry
 * says how many actions it stands for, as in `scrolled in Northstar Ledger
 * (23 times)`. Pure and history-free: callers that need a rolling window
 * (such as the conversation service) keep their own list of observed actions
 * across reads and pass it in here, rather than the tail keeping a second,
 * unbounded copy.
 */
export function describeActions(actions: readonly ObservedAction[], limit: number): string[] {
  return appendActions([], actions, limit).map((action) =>
    action.count !== undefined && action.count > 1 ? `${action.description} (${action.count} times)` : action.description,
  );
}

function toAction(line: string): ObservedAction | undefined {
  if (line.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  const kind = typeof event.type === "string" ? event.type : undefined;
  if (kind === undefined) return undefined;
  const timestampMs = typeof event.timestampMs === "number" ? event.timestampMs : 0;
  const target = (typeof event.target === "object" && event.target !== null ? event.target : {}) as Record<string, unknown>;
  const role = typeof target.role === "string" ? target.role : undefined;
  const label = typeof target.label === "string" ? target.label : undefined;
  const windowTitle = typeof target.windowTitle === "string" ? target.windowTitle : undefined;
  const application = typeof target.bundleId === "string" ? target.bundleId : undefined;

  // A switch to another application is a natural point to ask a question; a
  // switch between windows of the same application (`window_switch`) is
  // deliberately excluded below by not matching this branch or the "click
  // on a committing role" rule that sets `committed`.
  if (kind === "app_switch") {
    return {
      kind,
      description: `switched to ${windowTitle ?? application ?? "another application"}`,
      ...(role === undefined ? {} : { role }),
      ...(application === undefined ? {} : { application }),
      ...(windowTitle === undefined ? {} : { windowTitle }),
      timestampMs,
      committed: true,
    };
  }

  const verb = VERBS_BY_KIND[kind] ?? kind;
  const what = label ? ` "${label}"` : "";
  const where = windowTitle ? ` in ${windowTitle}` : "";
  return {
    kind,
    description: `${verb}${what}${where}`,
    ...(role === undefined ? {} : { role }),
    ...(application === undefined ? {} : { application }),
    ...(windowTitle === undefined ? {} : { windowTitle }),
    timestampMs,
    committed: kind === "click" && role !== undefined && COMMITTING_ROLES.has(role),
  };
}
