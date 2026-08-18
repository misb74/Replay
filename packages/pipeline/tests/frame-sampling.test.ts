import { describe, expect, it } from "vitest";

import { planFrameSamples, validateSampledFrames, type CondensedAction } from "../src/index.js";

describe("frame sampling plans", () => {
  const actions: CondensedAction[] = [
    {
      id: "action-1",
      kind: "click",
      description: "clicked Search",
      startMs: 100,
      endMs: 100,
      sourceEventIds: ["event-1"],
    },
    {
      id: "action-2",
      kind: "type",
      description: "typed query",
      startMs: 260,
      endMs: 500,
      sourceEventIds: ["event-2"],
      value: "query",
    },
  ];

  it("samples before every action and after actions likely to change the screen", () => {
    const plan = planFrameSamples(actions, 1_000, [{ timestampMs: 800, score: 0.8, actionId: "action-1" }], {
      minimumSpacingMs: 50,
    });

    expect(plan).toEqual({
      version: 1,
      durationMs: 1_000,
      frames: [
        {
          id: "frame-0001",
          timestampMs: 0,
          reasons: ["before_action"],
          actionIds: ["action-1"],
        },
        {
          id: "frame-0002",
          timestampMs: 80,
          reasons: ["before_action"],
          actionIds: ["action-2"],
        },
        {
          id: "frame-0003",
          timestampMs: 550,
          reasons: ["after_significant_action"],
          actionIds: ["action-1"],
        },
        {
          id: "frame-0004",
          timestampMs: 800,
          reasons: ["observed_screen_change"],
          actionIds: ["action-1"],
        },
      ],
    });
  });

  it("merges nearby requests while retaining every reason and action link", () => {
    const plan = planFrameSamples(actions.slice(0, 1), 1_000, [{ timestampMs: 0, score: 0.7 }]);

    expect(plan.frames[0]).toMatchObject({
      timestampMs: 0,
      reasons: ["before_action", "observed_screen_change"],
      actionIds: ["action-1"],
    });
  });

  it("keeps rounded frame timestamps inside a fractional video duration", () => {
    const durationMs = 10_211.757167;
    const plan = planFrameSamples([{
      id: "tail-action",
      kind: "click",
      description: "clicked near the end",
      startMs: durationMs,
      endMs: durationMs,
      sourceEventIds: ["tail-event"],
    }], durationMs);
    const frames = plan.frames.map((frame) => ({
      id: frame.id,
      timestampMs: frame.timestampMs,
      mimeType: "image/png" as const,
      dataBase64: "AA==",
    }));

    expect(plan.frames.at(-1)?.timestampMs).toBe(10_211);
    expect(plan.frames.every((frame) => frame.timestampMs <= plan.durationMs)).toBe(true);
    expect(validateSampledFrames(plan, frames)).toEqual([]);
  });

  it("rejects missing and duplicate decoded frames", () => {
    const plan = planFrameSamples(actions.slice(0, 1), 1_000);
    const frames = [
      { id: "frame-0001", timestampMs: 0, mimeType: "image/png" as const, dataBase64: "AA==" },
      { id: "frame-0001", timestampMs: 0, mimeType: "image/png" as const, dataBase64: "AA==" },
    ];

    expect(validateSampledFrames(plan, frames)).toEqual([
      "Duplicate sampled frame id: frame-0001.",
      "Missing sampled frame id: frame-0002.",
    ]);
  });

  it("rejects invalid or ungrounded screen-change observations", () => {
    expect(() => planFrameSamples(actions, 1_000, [{ timestampMs: 1_001, score: 0.8 }]))
      .toThrow("timestamp");
    expect(() => planFrameSamples(actions, 1_000, [{ timestampMs: 800, score: 1.1 }]))
      .toThrow("score");
    expect(() => planFrameSamples(actions, 1_000, [{ timestampMs: 800, score: 0.8, actionId: "missing" }]))
      .toThrow("unknown action");
  });

  it("validates session-relative element crops against their planned action", () => {
    const plan = planFrameSamples(actions.slice(0, 1), 1_000);
    const frames = plan.frames.map((frame) => ({
      id: frame.id,
      timestampMs: frame.timestampMs,
      mimeType: "image/png" as const,
      dataBase64: "AA==",
      ...(frame.actionIds.includes("action-1")
        ? {
            elementCrops: [{
              actionId: "action-1",
              path: `crops/${frame.id}-action-1.png`,
              bounds: { x: 10, y: 20, width: 120, height: 40 },
            }],
          }
        : {}),
    }));

    expect(validateSampledFrames(plan, frames)).toEqual([]);
    frames[0]!.elementCrops = [{
      actionId: "missing",
      path: "../outside.png",
      bounds: { x: 10, y: 20, width: 120, height: 40 },
    }];
    expect(validateSampledFrames(plan, frames)).toEqual([
      "Element crop in frame-0001 references an action not linked to that frame: missing.",
      "Element crop in frame-0001 has an unsafe asset path.",
    ]);
  });
});
