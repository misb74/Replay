import { sanitizeCaptureEvent } from "./redaction.js";

export const CAPTURE_EVENT_SCHEMA_VERSION = 1 as const;

export type CaptureEventType =
  | "click"
  | "key"
  | "scroll"
  | "drag"
  | "app_switch"
  | "window_switch"
  | "select"
  | "navigate";

export interface Point {
  x: number;
  y: number;
}

export interface Bounds extends Point {
  width: number;
  height: number;
}

export interface AccessibilityTarget {
  role?: string;
  subrole?: string;
  label?: string;
  value?: string;
  bounds?: Bounds;
  bundleId?: string;
  appName?: string;
  windowTitle?: string;
  url?: string;
  identifier?: string;
  isSecure?: boolean;
}

export interface CaptureKeyPayload {
  keyCode: number;
  text?: string;
  modifiers: string[];
  redacted: boolean;
}

export interface CaptureScrollPayload {
  deltaX: number;
  deltaY: number;
}

export interface CaptureDragPayload {
  start: Point;
  end: Point;
}

export interface CaptureSelectionPayload {
  value?: string;
}

export interface CaptureNavigationPayload {
  url: string;
}

/** Reserved browser detail. The native sidecar currently emits selector/role/name. */
export interface DomContext {
  selector?: string;
  role?: string;
  name?: string;
  testId?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface RedactedDomContext {
  redacted: true;
}

/**
 * The canonical v1 object written by the capture sidecar. `select` and
 * `navigate` are reserved pipeline inputs for richer capture sources.
 */
export interface CaptureEvent {
  schemaVersion: typeof CAPTURE_EVENT_SCHEMA_VERSION;
  id: string;
  sessionId: string;
  timestampMs: number;
  type: CaptureEventType;
  position?: Point;
  button?: string;
  clickCount?: number;
  key?: CaptureKeyPayload;
  scroll?: CaptureScrollPayload;
  drag?: CaptureDragPayload;
  selection?: CaptureSelectionPayload;
  navigation?: CaptureNavigationPayload;
  target?: AccessibilityTarget;
  dom?: DomContext | RedactedDomContext;
}

export type EventParseIssueCode =
  | "empty_input"
  | "line_too_large"
  | "input_too_large"
  | "invalid_json"
  | "invalid_event"
  | "unsupported_schema"
  | "duplicate_id"
  | "mixed_session"
  | "unexpected_session"
  | "non_monotonic_timestamp";

export interface EventParseIssue {
  line: number;
  code: EventParseIssueCode;
  severity: "error" | "warning";
  /** Deliberately never includes source text or field values. */
  message: string;
}

export interface EventParseResult {
  events: CaptureEvent[];
  issues: EventParseIssue[];
}

export interface EventParseOptions {
  maxLineBytes?: number;
  maxInputBytes?: number;
  maxEvents?: number;
  expectedSessionId?: string;
}

export class EventsJsonlError extends Error {
  readonly issues: readonly EventParseIssue[];

  constructor(issues: readonly EventParseIssue[]) {
    const errors = issues.filter((issue) => issue.severity === "error").length;
    super(`Could not ingest capture events (${errors} invalid line${errors === 1 ? "" : "s"}).`);
    this.name = "EventsJsonlError";
    this.issues = issues;
  }
}

const EVENT_TYPES = new Set<CaptureEventType>([
  "click",
  "key",
  "scroll",
  "drag",
  "app_switch",
  "window_switch",
  "select",
  "navigate",
]);

const DEFAULT_MAX_LINE_BYTES = 1_000_000;
const DEFAULT_MAX_INPUT_BYTES = 128_000_000;
const DEFAULT_MAX_EVENTS = 250_000;

/** Parse and validate newline-delimited capture events without throwing. */
export function safeParseEventsJsonl(
  jsonl: string,
  options: EventParseOptions = {},
): EventParseResult {
  const issues: EventParseIssue[] = [];
  const events: CaptureEvent[] = [];
  const ids = new Set<string>();
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxInputBytes = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  let previousTimestamp = -Infinity;
  let observedSessionId: string | undefined;

  if (new TextEncoder().encode(jsonl).byteLength > maxInputBytes) {
    return {
      events: [],
      issues: [
        {
          line: 0,
          code: "input_too_large",
          severity: "error",
          message: "The event stream exceeds the configured size limit.",
        },
      ],
    };
  }

  const lines = jsonl.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (line === undefined || line.trim() === "") {
      continue;
    }

    if (events.length >= maxEvents) {
      issues.push({
        line: lineNumber,
        code: "invalid_event",
        severity: "error",
        message: "The event limit was exceeded.",
      });
      break;
    }

    if (new TextEncoder().encode(line).byteLength > maxLineBytes) {
      issues.push({
        line: lineNumber,
        code: "line_too_large",
        severity: "error",
        message: "The event line exceeds the configured size limit.",
      });
      continue;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      issues.push({
        line: lineNumber,
        code: "invalid_json",
        severity: "error",
        message: "The event line is not valid JSON.",
      });
      continue;
    }

    const parsed = parseCaptureEvent(value);
    if (!parsed.ok) {
      issues.push({
        line: lineNumber,
        code: parsed.code,
        severity: "error",
        message: parsed.message,
      });
      continue;
    }

    const event = sanitizeCaptureEvent(parsed.event);
    if (options.expectedSessionId !== undefined && event.sessionId !== options.expectedSessionId) {
      issues.push({
        line: lineNumber,
        code: "unexpected_session",
        severity: "error",
        message: "The event does not belong to the requested session.",
      });
      continue;
    }
    if (observedSessionId !== undefined && event.sessionId !== observedSessionId) {
      issues.push({
        line: lineNumber,
        code: "mixed_session",
        severity: "error",
        message: "The event stream contains more than one session.",
      });
      continue;
    }
    observedSessionId ??= event.sessionId;
    if (ids.has(event.id)) {
      issues.push({
        line: lineNumber,
        code: "duplicate_id",
        severity: "error",
        message: "The event id is duplicated.",
      });
      continue;
    }
    ids.add(event.id);

    if (event.timestampMs < previousTimestamp) {
      issues.push({
        line: lineNumber,
        code: "non_monotonic_timestamp",
        severity: "warning",
        message: "The event timestamp is earlier than the preceding event.",
      });
    }
    previousTimestamp = event.timestampMs;
    events.push(event);
  }

  if (events.length === 0 && issues.length === 0) {
    issues.push({
      line: 0,
      code: "empty_input",
      severity: "warning",
      message: "The capture contains no events.",
    });
  }

  // A partially flushed sidecar can leave events slightly out of order. A
  // stable sort makes deterministic preprocessing possible while preserving
  // the warning above for diagnostics.
  events.sort((left, right) => left.timestampMs - right.timestampMs);
  return { events, issues };
}

/** Parse JSONL and reject any invalid event while retaining warning metadata. */
export function parseEventsJsonl(
  jsonl: string,
  options: EventParseOptions = {},
): CaptureEvent[] {
  const result = safeParseEventsJsonl(jsonl, options);
  if (result.issues.some((issue) => issue.severity === "error")) {
    throw new EventsJsonlError(result.issues);
  }
  return result.events;
}

type CaptureEventParseResult =
  | { ok: true; event: CaptureEvent }
  | {
      ok: false;
      code: "invalid_event" | "unsupported_schema";
      message: string;
    };

function parseCaptureEvent(value: unknown): CaptureEventParseResult {
  if (!isRecord(value)) {
    return invalid("The event must be a JSON object.");
  }
  if (value.schemaVersion !== CAPTURE_EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "unsupported_schema",
      message: "The event uses an unsupported schema version.",
    };
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.sessionId)) {
    return invalid("The event is missing a valid id or session id.");
  }
  if (!isFiniteNonNegativeNumber(value.timestampMs)) {
    return invalid("The event timestamp must be a finite, non-negative number.");
  }
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type as CaptureEventType)) {
    return invalid("The event type is not supported.");
  }

  const type = value.type as CaptureEventType;
  const target = value.target === undefined ? undefined : parseTarget(value.target);
  if (value.target !== undefined && target === undefined) {
    return invalid("The accessibility target is malformed.");
  }
  const position = value.position === undefined ? undefined : parsePoint(value.position);
  if (value.position !== undefined && position === undefined) {
    return invalid("The pointer position is malformed.");
  }
  if (
    value.button !== undefined &&
    (typeof value.button !== "string" || !["left", "right", "middle", "other"].includes(value.button))
  ) {
    return invalid("The pointer button is malformed.");
  }
  if (
    value.clickCount !== undefined &&
    (!isFiniteNonNegativeNumber(value.clickCount) || !Number.isInteger(value.clickCount) || value.clickCount < 1)
  ) {
    return invalid("The click count must be a positive integer.");
  }
  const dom = value.dom === undefined ? undefined : parseDomContext(value.dom);
  if (value.dom !== undefined && dom === undefined) {
    return invalid("The browser target context is malformed.");
  }

  const common: CaptureEvent = {
    schemaVersion: CAPTURE_EVENT_SCHEMA_VERSION,
    id: value.id,
    sessionId: value.sessionId,
    timestampMs: value.timestampMs,
    type,
    ...(position === undefined ? {} : { position }),
    ...(typeof value.button === "string" ? { button: value.button } : {}),
    ...(isFiniteNonNegativeNumber(value.clickCount) ? { clickCount: value.clickCount } : {}),
    ...(target === undefined ? {} : { target }),
    ...(dom === undefined ? {} : { dom }),
  };

  if (type === "key") {
    const key = parseKey(value.key);
    return key === undefined
      ? invalid("The keyboard event payload is malformed.")
      : { ok: true, event: { ...common, key } };
  }
  if (type === "scroll") {
    const scroll = parseScroll(value.scroll);
    return scroll === undefined
      ? invalid("The scroll event payload is malformed.")
      : { ok: true, event: { ...common, scroll } };
  }
  if (type === "drag") {
    const drag = parseDrag(value.drag);
    return drag === undefined
      ? invalid("The drag event payload is malformed.")
      : { ok: true, event: { ...common, drag } };
  }
  if (type === "select") {
    const selection = parseSelection(value.selection);
    return selection === undefined
      ? invalid("The selection event payload is malformed.")
      : { ok: true, event: { ...common, selection } };
  }
  if (type === "navigate") {
    const navigation = parseNavigation(value.navigation);
    return navigation === undefined
      ? invalid("The navigation event payload is malformed.")
      : { ok: true, event: { ...common, navigation } };
  }

  return { ok: true, event: common };
}

function invalid(message: string): CaptureEventParseResult {
  return { ok: false, code: "invalid_event", message };
}

function parseTarget(value: unknown): AccessibilityTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stringFields = [
    "role",
    "subrole",
    "label",
    "value",
    "bundleId",
    "appName",
    "windowTitle",
    "url",
    "identifier",
  ] as const;
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return undefined;
    }
  }
  if (value.isSecure !== undefined && typeof value.isSecure !== "boolean") {
    return undefined;
  }
  const bounds = value.bounds === undefined ? undefined : parseBounds(value.bounds);
  if (value.bounds !== undefined && bounds === undefined) {
    return undefined;
  }
  return {
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.subrole === "string" ? { subrole: value.subrole } : {}),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(typeof value.value === "string" ? { value: value.value } : {}),
    ...(bounds === undefined ? {} : { bounds }),
    ...(typeof value.bundleId === "string" ? { bundleId: value.bundleId } : {}),
    ...(typeof value.appName === "string" ? { appName: value.appName } : {}),
    ...(typeof value.windowTitle === "string" ? { windowTitle: value.windowTitle } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.identifier === "string" ? { identifier: value.identifier } : {}),
    ...(typeof value.isSecure === "boolean" ? { isSecure: value.isSecure } : {}),
  };
}

function parseKey(value: unknown): CaptureKeyPayload | undefined {
  if (
    !isRecord(value) ||
    !isFiniteNonNegativeNumber(value.keyCode) ||
    !Number.isInteger(value.keyCode) ||
    value.keyCode > 65_535
  ) {
    return undefined;
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    return undefined;
  }
  if (value.redacted !== undefined && typeof value.redacted !== "boolean") {
    return undefined;
  }
  if (
    value.modifiers !== undefined &&
    (!Array.isArray(value.modifiers) || value.modifiers.some((item) => typeof item !== "string"))
  ) {
    return undefined;
  }
  return {
    keyCode: value.keyCode,
    modifiers: Array.isArray(value.modifiers) ? [...value.modifiers] : [],
    redacted: value.redacted === true,
    ...(typeof value.text === "string" ? { text: value.text } : {}),
  };
}

function parseScroll(value: unknown): CaptureScrollPayload | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.deltaX) || !isFiniteNumber(value.deltaY)) {
    return undefined;
  }
  return { deltaX: value.deltaX, deltaY: value.deltaY };
}

function parseDrag(value: unknown): CaptureDragPayload | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const start = parsePoint(value.start);
  const end = parsePoint(value.end);
  return start === undefined || end === undefined ? undefined : { start, end };
}

function parseSelection(value: unknown): CaptureSelectionPayload | undefined {
  if (!isRecord(value) || (value.value !== undefined && typeof value.value !== "string")) {
    return undefined;
  }
  return typeof value.value === "string" ? { value: value.value } : {};
}

function parseNavigation(value: unknown): CaptureNavigationPayload | undefined {
  if (!isRecord(value) || !isNonEmptyString(value.url)) {
    return undefined;
  }
  return { url: value.url };
}

function parseDomContext(value: unknown): DomContext | RedactedDomContext | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (value.redacted === true) {
    return { redacted: true };
  }
  const stringFields = ["selector", "role", "name", "testId", "text"] as const;
  for (const field of stringFields) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      return undefined;
    }
  }
  let attributes: Record<string, string> | undefined;
  if (value.attributes !== undefined) {
    if (
      !isRecord(value.attributes) ||
      Object.values(value.attributes).some((attribute) => typeof attribute !== "string")
    ) {
      return undefined;
    }
    attributes = Object.fromEntries(
      Object.entries(value.attributes).map(([key, attribute]) => [key, attribute as string]),
    );
  }
  return {
    ...(typeof value.selector === "string" ? { selector: value.selector } : {}),
    ...(typeof value.role === "string" ? { role: value.role } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.testId === "string" ? { testId: value.testId } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(attributes === undefined ? {} : { attributes }),
  };
}

function parsePoint(value: unknown): Point | undefined {
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) {
    return undefined;
  }
  return { x: value.x, y: value.y };
}

function parseBounds(value: unknown): Bounds | undefined {
  const point = parsePoint(value);
  if (
    point === undefined ||
    !isRecord(value) ||
    !isFiniteNonNegativeNumber(value.width) ||
    !isFiniteNonNegativeNumber(value.height)
  ) {
    return undefined;
  }
  return { ...point, width: value.width, height: value.height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
