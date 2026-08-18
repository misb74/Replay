import { describe, expect, it } from "vitest";

import {
  excludeReplayCaptureControlTail,
  type AccessibilityTarget,
  type CaptureEvent,
} from "../src/index.js";

const sessionId = "capture-control-tail";
const replayShell: AccessibilityTarget = {
  bundleId: "com.github.Electron",
  windowTitle: "Replay",
  role: "AXGroup",
  subrole: "AXLandmarkMain",
  bounds: { x: 306, y: 32, width: 1_170, height: 920 },
};
const stopText: AccessibilityTarget = {
  bundleId: "com.github.Electron",
  windowTitle: "Replay",
  role: "AXStaticText",
  value: "Stop recording",
  bounds: { x: 97, y: 135, width: 116, height: 19 },
};

describe("Replay capture-control filtering", () => {
  it("removes the terminal recorder-control sequence emitted by the real Mac capture shape", () => {
    const events: CaptureEvent[] = [
      click("task-click", 6_236, {
        bundleId: "com.apple.TextEdit",
        windowTitle: "Untitled",
        role: "AXMenuItem",
        label: "Save",
      }, { x: 192, y: 156 }),
      context("replay-app", "app_switch", 8_736, replayShell),
      context("replay-window", "window_switch", 8_736, replayShell),
      drag("pointer-jitter", 8_875, replayShell, { x: 855.49, y: 661.59 }, { x: 855.49, y: 661.86 }),
      context("stop-focus", "app_switch", 8_968, {
        ...stopText,
        role: "AXButton",
        label: "Stop recording",
        bounds: { x: 63, y: 124, width: 215, height: 41 },
      }),
      drag("stop-gesture", 10_211, stopText, { x: 192.01, y: 137.33 }, { x: 192.01, y: 137.45 }),
    ];

    const result = excludeReplayCaptureControlTail(events);

    expect(result.events.map((event) => event.id)).toEqual(["task-click"]);
    expect(result.cutoffMs).toBe(8_736);
    expect(events).toHaveLength(6);
  });

  it("preserves meaningful Replay work before the stop-control prelude", () => {
    const events: CaptureEvent[] = [
      context("open-replay", "app_switch", 1_000, replayShell),
      click("real-replay-task", 5_000, {
        ...replayShell,
        role: "AXButton",
        label: "Open workflow",
      }, { x: 150, y: 300 }),
      drag("pointer-jitter", 8_900, replayShell, { x: 180, y: 140 }, { x: 181, y: 141 }),
      click("stop-gesture", 9_000, stopText, { x: 180, y: 145 }),
    ];

    const result = excludeReplayCaptureControlTail(events);

    expect(result.events.map((event) => event.id)).toEqual(["open-replay", "real-replay-task"]);
    expect(result.cutoffMs).toBe(8_900);
  });

  it("removes an unlabeled Replay shell click used only to bring the recorder forward", () => {
    const events: CaptureEvent[] = [
      click("task-click", 5_000, {
        bundleId: "com.apple.TextEdit",
        windowTitle: "Untitled",
        role: "AXButton",
        label: "Save",
      }, { x: 500, y: 500 }),
      context("open-replay", "app_switch", 8_000, replayShell),
      click("focus-shell", 8_100, replayShell, { x: 800, y: 700 }),
      click("stop-gesture", 9_000, stopText, { x: 180, y: 145 }),
    ];

    const result = excludeReplayCaptureControlTail(events);

    expect(result.events.map((event) => event.id)).toEqual(["task-click"]);
    expect(result.cutoffMs).toBe(8_000);
  });

  it("preserves a small drag on a meaningful Replay control", () => {
    const semanticTarget: AccessibilityTarget = {
      ...replayShell,
      role: "AXSlider",
      label: "Playback position",
      bounds: { x: 400, y: 700, width: 300, height: 20 },
    };
    const events: CaptureEvent[] = [
      context("open-replay", "app_switch", 1_000, replayShell),
      drag("real-replay-drag", 8_800, semanticTarget, { x: 500, y: 710 }, { x: 502, y: 710 }),
      click("stop-gesture", 9_000, stopText, { x: 180, y: 145 }),
    ];

    const result = excludeReplayCaptureControlTail(events);

    expect(result.events.map((event) => event.id)).toEqual(["open-replay", "real-replay-drag"]);
    expect(result.cutoffMs).toBe(9_000);
  });

  it("removes duplicate tiny gestures on the stop control", () => {
    const events: CaptureEvent[] = [
      context("open-replay", "app_switch", 8_000, replayShell),
      drag("stop-jitter", 8_900, stopText, { x: 180, y: 145 }, { x: 181, y: 145 }),
      click("stop-gesture", 9_000, stopText, { x: 180, y: 145 }),
    ];

    expect(excludeReplayCaptureControlTail(events)).toEqual({ events: [], cutoffMs: 8_000 });
  });

  it("does not treat another Electron window or a non-terminal stop visit as recorder cleanup", () => {
    const otherElectronStop = click("other-electron", 1_000, {
      ...stopText,
      windowTitle: "Another Electron app",
    }, { x: 180, y: 145 });
    const replayStop = click("replay-stop", 2_000, stopText, { x: 180, y: 145 });
    const laterTask = click("later-task", 3_000, {
      bundleId: "com.apple.TextEdit",
      windowTitle: "Untitled",
      role: "AXButton",
      label: "Continue",
    }, { x: 500, y: 500 });

    expect(excludeReplayCaptureControlTail([otherElectronStop]).events).toEqual([otherElectronStop]);
    expect(excludeReplayCaptureControlTail([replayStop, laterTask]).events).toEqual([replayStop, laterTask]);
  });

  it("requires the terminal pointer to land inside the named stop control", () => {
    const outside = click("outside", 1_000, stopText, { x: 500, y: 500 });

    expect(excludeReplayCaptureControlTail([outside])).toEqual({ events: [outside] });
  });
});

function base(id: string, timestampMs: number, type: CaptureEvent["type"], target: AccessibilityTarget): CaptureEvent {
  return { schemaVersion: 1, id, sessionId, timestampMs, type, target };
}

function context(
  id: string,
  type: "app_switch" | "window_switch",
  timestampMs: number,
  target: AccessibilityTarget,
): CaptureEvent {
  return base(id, timestampMs, type, target);
}

function click(
  id: string,
  timestampMs: number,
  target: AccessibilityTarget,
  position: { x: number; y: number },
): CaptureEvent {
  return { ...base(id, timestampMs, "click", target), position, button: "left", clickCount: 1 };
}

function drag(
  id: string,
  timestampMs: number,
  target: AccessibilityTarget,
  start: { x: number; y: number },
  end: { x: number; y: number },
): CaptureEvent {
  return { ...base(id, timestampMs, "drag", target), drag: { start, end }, button: "left" };
}
