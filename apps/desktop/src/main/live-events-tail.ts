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

/**
 * Follows a session's `events.jsonl` from wherever the previous read left
 * off. The recorder flushes and fsyncs the file after every event, so
 * re-opening it and reading only the newly appended bytes is reliable even
 * while a recording is still in progress.
 */
export class LiveEventsTail {
  #offset = 0;
  #carry = "";

  constructor(private readonly path: string) {}

  /** Every action appended to the log since the previous call to `read`. */
  async read(): Promise<ObservedAction[]> {
    let handle: FileHandle;
    try {
      handle = await open(this.path, "r");
    } catch {
      // Recording may not have started yet, or the session directory has
      // not been created. Either way there is nothing new to report.
      return [];
    }
    try {
      const stats = await handle.stat();
      if (stats.size <= this.#offset) return [];
      const length = stats.size - this.#offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.#offset);
      this.#offset = stats.size;
      const text = this.#carry + buffer.toString("utf8");
      const lines = text.split("\n");
      // The writer fsyncs after every whole event, so a trailing entry with
      // no newline yet is a line still being written. Hold it back until a
      // later read completes it, rather than risk parsing a half event.
      this.#carry = lines.pop() ?? "";
      return lines
        .map((line) => toAction(line))
        .filter((action): action is ObservedAction => action !== undefined);
    } finally {
      await handle.close();
    }
  }
}

/**
 * The descriptions of the last `limit` actions, oldest first. Pure and
 * history-free: callers that need a rolling window (such as the conversation
 * service) keep their own list of observed actions across reads and pass it
 * in here, rather than the tail keeping a second, unbounded copy.
 */
export function describeActions(actions: readonly ObservedAction[], limit: number): string[] {
  return actions.slice(-limit).map((action) => action.description);
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
