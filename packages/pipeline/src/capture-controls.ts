import type { Bounds, CaptureEvent, Point } from "./events.js";

export interface CaptureControlTailResult {
  events: CaptureEvent[];
  /** First millisecond owned by Replay's terminal recorder controls. */
  cutoffMs?: number;
}

const REPLAY_DEVELOPMENT_BUNDLE_ID = "com.github.Electron";
const REPLAY_WINDOW_TITLE = "replay";
const STOP_RECORDING_TEXT = "stop recording";
const MAX_CONTROL_PRELUDE_MS = 5_000;
const MAX_POINTER_JITTER_DISTANCE = 4;

/**
 * Remove only Replay's terminal stop-recording gesture and its mechanical
 * prelude. The stop control itself is the required anchor: a generic Electron
 * window, an earlier Replay action, or a non-terminal visit to Replay is never
 * enough to activate this filter.
 */
export function excludeReplayCaptureControlTail(
  events: readonly CaptureEvent[],
): CaptureControlTailResult {
  const copy = [...events];
  if (copy.length === 0 || !hasMonotonicTimestamps(copy)) {
    return { events: copy };
  }

  const finalIndex = copy.length - 1;
  const finalEvent = copy[finalIndex];
  if (
    finalEvent === undefined ||
    !isReplayEvent(finalEvent) ||
    !isPointerGesture(finalEvent) ||
    !isStopRecordingTarget(finalEvent)
  ) {
    return { events: copy };
  }

  const finalTimestampMs = finalEvent.timestampMs;
  let startIndex = finalIndex;
  while (startIndex > 0) {
    const previous = copy[startIndex - 1];
    if (
      previous === undefined ||
      finalTimestampMs - previous.timestampMs > MAX_CONTROL_PRELUDE_MS ||
      !isReplayEvent(previous) ||
      !isCaptureControlPrelude(previous)
    ) {
      break;
    }
    startIndex -= 1;
  }

  const cutoffMs = copy[startIndex]?.timestampMs;
  return cutoffMs === undefined
    ? { events: copy }
    : { events: copy.slice(0, startIndex), cutoffMs };
}

function hasMonotonicTimestamps(events: readonly CaptureEvent[]): boolean {
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1];
    const current = events[index];
    if (previous !== undefined && current !== undefined && current.timestampMs < previous.timestampMs) {
      return false;
    }
  }
  return true;
}

function isReplayEvent(event: CaptureEvent): boolean {
  return event.target?.bundleId === REPLAY_DEVELOPMENT_BUNDLE_ID
    && normalizeControlText(event.target.windowTitle) === REPLAY_WINDOW_TITLE;
}

function isStopRecordingTarget(event: CaptureEvent): boolean {
  const target = event.target;
  if (target === undefined) {
    return false;
  }
  const explicitlyNamed = [target.label, target.value, target.identifier]
    .some((value) => normalizeControlText(value) === STOP_RECORDING_TEXT);
  if (!explicitlyNamed) {
    return false;
  }
  const point = pointerEnd(event);
  return point !== undefined && (target.bounds === undefined || pointIsInside(point, target.bounds));
}

function isCaptureControlPrelude(event: CaptureEvent): boolean {
  if (event.type === "app_switch" || event.type === "window_switch") {
    return true;
  }
  if (isPointerGesture(event) && isStopRecordingTarget(event)) {
    return true;
  }
  if (event.type === "click") {
    return isReplayShellTarget(event);
  }
  if (event.type !== "drag" || event.drag === undefined || !isReplayShellTarget(event)) {
    return false;
  }
  return Math.hypot(
    event.drag.end.x - event.drag.start.x,
    event.drag.end.y - event.drag.start.y,
  ) <= MAX_POINTER_JITTER_DISTANCE;
}

function isReplayShellTarget(event: CaptureEvent): boolean {
  const target = event.target;
  if (target === undefined || normalizeControlText(target.identifier) !== "") {
    return false;
  }
  const role = normalizeControlText(target.role);
  const subrole = normalizeControlText(target.subrole);
  const text = normalizeControlText(target.label) || normalizeControlText(target.value);
  const isStructuralRole = role === "axscrollarea"
    || (role === "axgroup" && [
      "axlandmarkmain",
      "axlandmarkcomplementary",
      "axlandmarknavigation",
    ].includes(subrole));
  return isStructuralRole && (text === "" || text === "workflows");
}

function isPointerGesture(event: CaptureEvent): boolean {
  return event.type === "click" || event.type === "drag";
}

function pointerEnd(event: CaptureEvent): Point | undefined {
  if (event.type === "click") {
    return event.position;
  }
  if (event.type === "drag") {
    return event.drag?.end;
  }
  return undefined;
}

function pointIsInside(point: Point, bounds: Bounds): boolean {
  if (
    ![point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  ) {
    return false;
  }
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function normalizeControlText(value: string | undefined): string {
  return value?.trim().replaceAll(/\s+/gu, " ").toLowerCase() ?? "";
}
