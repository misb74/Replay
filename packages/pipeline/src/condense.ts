import type {
  AccessibilityTarget,
  CaptureEvent,
  CaptureKeyPayload,
  DomContext,
  Point,
} from "./events.js";
import {
  REDACTED_TEXT,
  isSecureTarget,
  type VaultParameterReference,
  vaultReferenceForTarget,
} from "./redaction.js";

export type CondensedActionKind =
  | "click"
  | "type"
  | "select"
  | "navigate"
  | "scroll"
  | "drag"
  | "app_switch"
  | "window_switch"
  | "key_press";

export interface CondensedAction {
  id: string;
  kind: CondensedActionKind;
  description: string;
  startMs: number;
  endMs: number;
  sourceEventIds: string[];
  target?: AccessibilityTarget;
  dom?: DomContext;
  value?: string | VaultParameterReference;
  key?: string;
  modifiers?: string[];
  url?: string;
  clickCount?: number;
  button?: string;
  scrollDelta?: { x: number; y: number };
  drag?: { start: Point; end: Point };
}

export interface CondensationOptions {
  keystrokeGapMs?: number;
  scrollBurstGapMs?: number;
  minimumScrollDistance?: number;
  inferNavigationsFromUrlChanges?: boolean;
}

interface TypeRun {
  startMs: number;
  endMs: number;
  target?: AccessibilityTarget;
  dom?: DomContext;
  sourceEventIds: string[];
  text: string;
  secure: boolean;
}

interface ScrollRun {
  startMs: number;
  endMs: number;
  target?: AccessibilityTarget;
  dom?: DomContext;
  sourceEventIds: string[];
  deltaX: number;
  deltaY: number;
}

const DEFAULT_KEYSTROKE_GAP_MS = 1_250;
const DEFAULT_SCROLL_BURST_GAP_MS = 350;
const DEFAULT_MINIMUM_SCROLL_DISTANCE = 24;
// The macOS event tap can report a dragged event for sub-point hand jitter.
// Keep this deliberately small so even short, intentional drags remain drags.
const MAXIMUM_CLICK_JITTER_DISTANCE = 2;

/**
 * Convert noisy event-tap output into a compact, deterministic action stream.
 * No model calls or environment state are involved.
 */
export function condenseEvents(
  events: readonly CaptureEvent[],
  options: CondensationOptions = {},
): CondensedAction[] {
  const keystrokeGapMs = options.keystrokeGapMs ?? DEFAULT_KEYSTROKE_GAP_MS;
  const scrollBurstGapMs = options.scrollBurstGapMs ?? DEFAULT_SCROLL_BURST_GAP_MS;
  const minimumScrollDistance = options.minimumScrollDistance ?? DEFAULT_MINIMUM_SCROLL_DISTANCE;
  const inferNavigations = options.inferNavigationsFromUrlChanges ?? true;

  const sorted = [...events].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
  );
  const pending: Omit<CondensedAction, "id">[] = [];
  let typeRun: TypeRun | undefined;
  let scrollRun: ScrollRun | undefined;
  let previousBrowserLocation: { bundleId?: string; url: string } | undefined;
  let previousSwitchIdentity: string | undefined;

  const flushType = (): void => {
    if (typeRun === undefined) {
      return;
    }
    const run = typeRun;
    if (!run.secure && run.text.length === 0) {
      typeRun = undefined;
      return;
    }
    const value = run.secure ? vaultReferenceForTarget(run.target) : run.text;
    pending.push({
      kind: "type",
      description: run.secure
        ? `entered a protected value into ${describeTarget(run.target)}`
        : `typed ${quoteForDescription(run.text)} into ${describeTarget(run.target)}`,
      startMs: run.startMs,
      endMs: run.endMs,
      sourceEventIds: run.sourceEventIds,
      ...(run.target === undefined ? {} : { target: run.target }),
      ...(run.dom === undefined ? {} : { dom: run.dom }),
      value,
    });
    typeRun = undefined;
  };

  const flushScroll = (): void => {
    if (scrollRun === undefined) {
      return;
    }
    const run = scrollRun;
    const distance = Math.hypot(run.deltaX, run.deltaY);
    if (distance >= minimumScrollDistance) {
      pending.push({
        kind: "scroll",
        description: `scrolled ${scrollDirection(run.deltaX, run.deltaY)} in ${describeTarget(run.target)}`,
        startMs: run.startMs,
        endMs: run.endMs,
        sourceEventIds: run.sourceEventIds,
        ...(run.target === undefined ? {} : { target: run.target }),
        ...(run.dom === undefined ? {} : { dom: run.dom }),
        scrollDelta: { x: run.deltaX, y: run.deltaY },
      });
    }
    scrollRun = undefined;
  };

  const flushRuns = (): void => {
    flushType();
    flushScroll();
  };

  for (const event of sorted) {
    const dom = usableDomContext(event.dom);
    const currentUrl = event.target?.url;
    const currentBundleId = event.target?.bundleId;
    if (
      inferNavigations &&
      currentUrl !== undefined &&
      previousBrowserLocation !== undefined &&
      previousBrowserLocation.url !== currentUrl &&
      sameOptionalString(previousBrowserLocation.bundleId, currentBundleId) &&
      event.type !== "navigate"
    ) {
      flushRuns();
      pending.push({
        kind: "navigate",
        description: `navigated to ${currentUrl}`,
        startMs: event.timestampMs,
        endMs: event.timestampMs,
        sourceEventIds: [event.id],
        ...(event.target === undefined ? {} : { target: event.target }),
        ...(dom === undefined ? {} : { dom }),
        url: currentUrl,
      });
    }
    if (currentUrl !== undefined) {
      previousBrowserLocation = { url: currentUrl, ...(currentBundleId === undefined ? {} : { bundleId: currentBundleId }) };
    }

    switch (event.type) {
      case "key": {
        flushScroll();
        const key = event.key;
        if (key === undefined) {
          break;
        }
        const secure = isSecureTarget(event.target) || key.redacted || key.text === REDACTED_TEXT;
        const commandLike = key.modifiers.some((modifier) => isCommandModifier(modifier));
        const keyName = keyNameForPayload(key);

        if (commandLike || isNonTextKey(keyName)) {
          if (isBackspaceKey(keyName) && !commandLike) {
            if (
              typeRun !== undefined &&
              sameTarget(typeRun.target, event.target) &&
              sameDom(typeRun.dom, dom)
            ) {
              typeRun.text = removeLastGrapheme(typeRun.text);
              typeRun.endMs = event.timestampMs;
              typeRun.sourceEventIds.push(event.id);
              typeRun.secure ||= secure;
            } else {
              flushType();
              pushKeyPress(pending, event, keyName, key.modifiers);
            }
            break;
          }
          flushType();
          pushKeyPress(pending, event, keyName, key.modifiers);
          break;
        }

        const shouldContinue =
          typeRun !== undefined &&
          event.timestampMs - typeRun.endMs <= keystrokeGapMs &&
          sameTarget(typeRun.target, event.target) &&
          sameDom(typeRun.dom, dom);
        if (!shouldContinue) {
          flushType();
          typeRun = {
            startMs: event.timestampMs,
            endMs: event.timestampMs,
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(dom === undefined ? {} : { dom }),
            sourceEventIds: [event.id],
            text: "",
            secure,
          };
        }
        if (typeRun !== undefined) {
          typeRun.endMs = event.timestampMs;
          typeRun.sourceEventIds.push(...(typeRun.sourceEventIds.includes(event.id) ? [] : [event.id]));
          typeRun.secure ||= secure;
          if (!secure && key.text !== undefined && key.text !== REDACTED_TEXT) {
            typeRun.text += key.text;
          }
        }
        break;
      }

      case "scroll": {
        flushType();
        const scroll = event.scroll;
        if (scroll === undefined) {
          break;
        }
        const shouldContinue =
          scrollRun !== undefined &&
          event.timestampMs - scrollRun.endMs <= scrollBurstGapMs &&
          sameTarget(scrollRun.target, event.target) &&
          sameDom(scrollRun.dom, dom);
        if (!shouldContinue) {
          flushScroll();
          scrollRun = {
            startMs: event.timestampMs,
            endMs: event.timestampMs,
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(dom === undefined ? {} : { dom }),
            sourceEventIds: [],
            deltaX: 0,
            deltaY: 0,
          };
        }
        if (scrollRun !== undefined) {
          scrollRun.endMs = event.timestampMs;
          scrollRun.sourceEventIds.push(event.id);
          scrollRun.deltaX += scroll.deltaX;
          scrollRun.deltaY += scroll.deltaY;
        }
        break;
      }

      case "click": {
        flushRuns();
        pushPointerActivation(pending, event, dom);
        break;
      }

      case "select": {
        flushRuns();
        const selectedValue = event.selection?.value ?? event.target?.value ?? event.target?.label;
        const value = isSecureTarget(event.target)
          ? vaultReferenceForTarget(event.target)
          : selectedValue;
        pending.push({
          kind: "select",
          description: isSecureTarget(event.target)
            ? `selected a protected value in ${describeTarget(event.target)}`
            : `selected ${quoteForDescription(selectedValue ?? "option")} in ${describeTarget(event.target)}`,
          startMs: event.timestampMs,
          endMs: event.timestampMs,
          sourceEventIds: [event.id],
          ...(event.target === undefined ? {} : { target: event.target }),
          ...(dom === undefined ? {} : { dom }),
          ...(value === undefined ? {} : { value }),
        });
        break;
      }

      case "navigate": {
        flushRuns();
        const url = event.navigation?.url ?? event.target?.url;
        if (url !== undefined) {
          pending.push({
            kind: "navigate",
            description: `navigated to ${url}`,
            startMs: event.timestampMs,
            endMs: event.timestampMs,
            sourceEventIds: [event.id],
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(dom === undefined ? {} : { dom }),
            url,
          });
          previousBrowserLocation = {
            url,
            ...(event.target?.bundleId === undefined ? {} : { bundleId: event.target.bundleId }),
          };
        }
        break;
      }

      case "drag": {
        flushRuns();
        if (event.drag !== undefined) {
          if (isSameTargetClickJitter(event.drag, event.target)) {
            pushPointerActivation(pending, event, dom);
            break;
          }
          pending.push({
            kind: "drag",
            description: `dragged ${describeTarget(event.target)}`,
            startMs: event.timestampMs,
            endMs: event.timestampMs,
            sourceEventIds: [event.id],
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(dom === undefined ? {} : { dom }),
            drag: event.drag,
          });
        }
        break;
      }

      case "app_switch":
      case "window_switch": {
        flushRuns();
        const identity = `${event.type}:${event.target?.bundleId ?? ""}:${event.target?.windowTitle ?? ""}`;
        if (identity !== previousSwitchIdentity) {
          pending.push({
            kind: event.type,
            description:
              event.type === "app_switch"
                ? `switched to ${event.target?.appName ?? event.target?.bundleId ?? "another app"}`
                : `switched to ${event.target?.windowTitle ?? "another window"}`,
            startMs: event.timestampMs,
            endMs: event.timestampMs,
            sourceEventIds: [event.id],
            ...(event.target === undefined ? {} : { target: event.target }),
            ...(dom === undefined ? {} : { dom }),
          });
          previousSwitchIdentity = identity;
        }
        break;
      }

      default:
        assertNever(event.type);
    }
  }

  flushRuns();
  return pending.map((action, index) => ({
    id: `action-${String(index + 1).padStart(4, "0")}`,
    ...action,
  }));
}

function pushPointerActivation(
  actions: Omit<CondensedAction, "id">[],
  event: CaptureEvent,
  dom: DomContext | undefined,
): void {
  const kind = isSelectionTarget(event.target) ? "select" : "click";
  const selectedValue = kind === "select" ? event.target?.value ?? event.target?.label : undefined;
  const value =
    kind === "select" && isSecureTarget(event.target)
      ? vaultReferenceForTarget(event.target)
      : selectedValue;
  actions.push({
    kind,
    description:
      kind === "select"
        ? isSecureTarget(event.target)
          ? `selected a protected value in ${describeTarget(event.target)}`
          : `selected ${quoteForDescription(selectedValue ?? "option")} in ${describeTarget(event.target)}`
        : `clicked ${describeTarget(event.target)}`,
    startMs: event.timestampMs,
    endMs: event.timestampMs,
    sourceEventIds: [event.id],
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(dom === undefined ? {} : { dom }),
    ...(value === undefined ? {} : { value }),
    ...(event.clickCount === undefined ? {} : { clickCount: event.clickCount }),
    ...(event.button === undefined ? {} : { button: event.button }),
  });
}

function isSameTargetClickJitter(
  drag: NonNullable<CaptureEvent["drag"]>,
  target: AccessibilityTarget | undefined,
): boolean {
  const bounds = target?.bounds;
  const distance = Math.hypot(drag.end.x - drag.start.x, drag.end.y - drag.start.y);
  if (bounds === undefined || distance > MAXIMUM_CLICK_JITTER_DISTANCE) {
    return false;
  }
  return pointIsWithinBounds(drag.start, bounds) && pointIsWithinBounds(drag.end, bounds);
}

function pointIsWithinBounds(
  point: Point,
  bounds: NonNullable<AccessibilityTarget["bounds"]>,
): boolean {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function pushKeyPress(
  actions: Omit<CondensedAction, "id">[],
  event: CaptureEvent,
  key: string,
  modifiers: readonly string[],
): void {
  const prefix = modifiers.length > 0 ? `${modifiers.join("+")}+` : "";
  const dom = usableDomContext(event.dom);
  actions.push({
    kind: "key_press",
    description: `pressed ${prefix}${key} in ${describeTarget(event.target)}`,
    startMs: event.timestampMs,
    endMs: event.timestampMs,
    sourceEventIds: [event.id],
    ...(event.target === undefined ? {} : { target: event.target }),
    ...(dom === undefined ? {} : { dom }),
    key,
    modifiers: [...modifiers],
  });
}

function keyNameForPayload(payload: CaptureKeyPayload): string {
  const mapped = MAC_KEY_NAMES[payload.keyCode];
  if (mapped !== undefined) {
    return mapped;
  }
  if (payload.text === "\b" || payload.text === "\u007f") {
    return "Backspace";
  }
  if (payload.text === "\r" || payload.text === "\n") {
    return "Enter";
  }
  if (payload.text === "\t") {
    return "Tab";
  }
  return payload.text ?? `KeyCode${payload.keyCode}`;
}

const MAC_KEY_NAMES: Readonly<Record<number, string>> = {
  36: "Enter",
  48: "Tab",
  51: "Backspace",
  53: "Escape",
  115: "Home",
  116: "PageUp",
  117: "Delete",
  119: "End",
  121: "PageDown",
  123: "ArrowLeft",
  124: "ArrowRight",
  125: "ArrowDown",
  126: "ArrowUp",
};

function isCommandModifier(modifier: string): boolean {
  const normalized = modifier.toLowerCase();
  return ["command", "cmd", "control", "ctrl", "option", "alt", "fn", "function"].includes(normalized);
}

function isNonTextKey(key: string): boolean {
  return (
    key === "Enter" ||
    key === "Tab" ||
    key === "Backspace" ||
    key === "Delete" ||
    key === "Escape" ||
    key.startsWith("Arrow") ||
    key.startsWith("Page") ||
    key.startsWith("KeyCode") ||
    key === "Home" ||
    key === "End"
  );
}

function isBackspaceKey(key: string): boolean {
  return key === "Backspace" || key === "Delete";
}

function removeLastGrapheme(value: string): string {
  const graphemes = [...value];
  graphemes.pop();
  return graphemes.join("");
}

function sameTarget(
  left: AccessibilityTarget | undefined,
  right: AccessibilityTarget | undefined,
): boolean {
  return targetIdentity(left) === targetIdentity(right);
}

function sameDom(left: DomContext | undefined, right: DomContext | undefined): boolean {
  return (left?.selector ?? left?.testId ?? "") === (right?.selector ?? right?.testId ?? "");
}

function usableDomContext(value: CaptureEvent["dom"]): DomContext | undefined {
  return value !== undefined && !("redacted" in value) ? value : undefined;
}

function targetIdentity(target: AccessibilityTarget | undefined): string {
  if (target === undefined) {
    return "<none>";
  }
  return [
    target.bundleId,
    target.windowTitle,
    target.identifier,
    target.role,
    target.subrole,
    target.label,
  ]
    .map((part) => part ?? "")
    .join("\u001f");
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return left === undefined || right === undefined || left === right;
}

function isSelectionTarget(target: AccessibilityTarget | undefined): boolean {
  const role = target?.role?.toLowerCase() ?? "";
  return (
    role.includes("menuitem") ||
    role.includes("option") ||
    role.includes("radiobutton") ||
    role.includes("checkbox")
  );
}

function describeTarget(target: AccessibilityTarget | undefined): string {
  if (target === undefined) {
    return "the current screen";
  }
  const element =
    target.label ?? target.identifier ?? readableRole(target.subrole ?? target.role) ?? "element";
  const context = target.windowTitle ?? target.appName ?? target.bundleId;
  return context === undefined ? element : `${element} in ${context}`;
}

function readableRole(role: string | undefined): string | undefined {
  if (role === undefined) {
    return undefined;
  }
  const withoutPrefix = role.replace(/^AX/u, "");
  return withoutPrefix.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").toLowerCase();
}

function quoteForDescription(value: string): string {
  const compact = value.replaceAll(/\s+/gu, " ").trim();
  const truncated = compact.length > 80 ? `${compact.slice(0, 77)}…` : compact;
  return `“${truncated}”`;
}

function scrollDirection(deltaX: number, deltaY: number): string {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) {
    return deltaY >= 0 ? "up" : "down";
  }
  return deltaX >= 0 ? "left" : "right";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled capture event type: ${String(value)}`);
}
