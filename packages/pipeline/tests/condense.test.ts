import { describe, expect, it } from "vitest";

import { condenseEvents, parseEventsJsonl } from "../src/index.js";
import { fixtureJson, fixtureText } from "./fixture.js";

interface ExpectedActionSummary {
  id: string;
  kind: string;
  value?: unknown;
  key?: string;
  url?: string;
  scrollDelta?: { x: number; y: number };
  sourceEventIds: string[];
}

describe("event condensation", () => {
  it("matches the invoice recording golden action stream", () => {
    const events = parseEventsJsonl(fixtureText("recordings/invoice-match/events.jsonl"));
    const actions = condenseEvents(events);
    const actual: ExpectedActionSummary[] = actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      ...(action.value === undefined ? {} : { value: action.value }),
      ...(action.key === undefined ? {} : { key: action.key }),
      ...(action.url === undefined ? {} : { url: action.url }),
      ...(action.scrollDelta === undefined ? {} : { scrollDelta: action.scrollDelta }),
      sourceEventIds: action.sourceEventIds,
    }));

    expect(actual).toEqual(
      fixtureJson("recordings/invoice-match/expected-actions.json") as ExpectedActionSummary[],
    );
    expect(actions).toHaveLength(5);
  });

  it("shares the real invoice app's two outcomes with the full-loop harness", () => {
    const cases = fixtureJson("recordings/invoice-match/full-loop-cases.json") as {
      cases: Array<{ invoiceId: string; expectedReviewState: string; actionLabel: string }>;
    };
    const events = parseEventsJsonl(fixtureText("recordings/invoice-match/events.jsonl"));
    const labels = events.flatMap((event) => event.target?.label ?? []);

    expect(cases.cases).toEqual([
      { invoiceId: "INV-1048", expectedReviewState: "Approved", actionLabel: "Approve invoice" },
      { invoiceId: "INV-1049", expectedReviewState: "Needs attention", actionLabel: "Flag difference" },
    ]);
    expect(labels).toContain("Approve invoice");
    expect(JSON.stringify(fixtureJson("model-outputs/invoice-match.decision-extraction.v1.json"))).toContain("Flag difference");
  });

  it("turns every secure keystroke run into one vault reference", () => {
    const events = parseEventsJsonl(fixtureText("security/adversarial-secure-leak.jsonl"));
    const actions = condenseEvents(events);
    const typing = actions.find((action) => action.kind === "type");

    expect(typing).toMatchObject({
      kind: "type",
      value: { param: "password", vault: true },
      sourceEventIds: ["secure-002", "secure-003"],
    });
    expect(JSON.stringify(actions)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(typing?.description).not.toContain("[REDACTED]");
  });

  it("keeps command shortcuts separate from typed text", () => {
    const lines = [
      key("a", 0, 0, "a", []),
      key("b", 1, 20, "b", []),
      key("copy", 8, 40, "c", ["command"]),
      key("c", 2, 60, "c", []),
    ];
    const actions = condenseEvents(parseEventsJsonl(lines.join("\n")));

    expect(actions.map((action) => [action.kind, action.value ?? action.key])).toEqual([
      ["type", "ab"],
      ["key_press", "c"],
      ["type", "c"],
    ]);
  });

  it("uses a vault reference for secure selection values", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "secure-select",
      sessionId: "secure",
      timestampMs: 0,
      type: "select",
      selection: { value: "SHOULD_NOT_SURVIVE" },
      target: { role: "AXSecureTextField", label: "Recovery answer", isSecure: true },
    });
    const actions = condenseEvents(parseEventsJsonl(event));

    expect(actions[0]).toMatchObject({
      kind: "select",
      value: { param: "recovery_answer", vault: true },
    });
    expect(JSON.stringify(actions)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(actions)).not.toContain("[REDACTED]");
  });

  it("preserves reserved DOM targeting detail for future browser capture", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "dom-click",
      sessionId: "browser",
      timestampMs: 0,
      type: "click",
      target: { role: "AXButton", label: "Submit" },
      dom: {
        selector: "button[type=submit]",
        testId: "submit",
        text: "Submit",
        attributes: { type: "submit" },
      },
    });

    const actions = condenseEvents(parseEventsJsonl(event));
    expect(actions[0]?.dom).toEqual({
      selector: "button[type=submit]",
      testId: "submit",
      text: "Submit",
      attributes: { type: "submit" },
    });
  });

  it("treats sub-point movement inside one control as an activation", () => {
    const events = [
      drag("menu-save", { x: 120.25, y: 150.125 }, { x: 120.375, y: 150.25 }, {
        role: "AXMenuItem",
        label: "Save",
        bounds: { x: 100, y: 140, width: 200, height: 24 },
      }),
      drag("stop-control", { x: 180.125, y: 130.25 }, { x: 180.125, y: 130.375 }, {
        role: "AXStaticText",
        value: "Stop recording",
        bounds: { x: 100, y: 120, width: 120, height: 20 },
      }),
    ];

    const actions = condenseEvents(parseEventsJsonl(events.join("\n")));

    expect(actions).toMatchObject([
      { kind: "select", value: "Save", sourceEventIds: ["menu-save"], button: "left" },
      { kind: "click", sourceEventIds: ["stop-control"], button: "left" },
    ]);
    expect(actions.every((action) => action.drag === undefined)).toBe(true);
  });

  it("preserves real drags and short movements that leave the resolved target", () => {
    const target = {
      role: "AXTextArea",
      label: "Document",
      bounds: { x: 10, y: 10, width: 200, height: 100 },
    };
    const events = [
      drag("real-drag", { x: 20, y: 20 }, { x: 120, y: 20 }, target),
      drag("cross-target", { x: 9.5, y: 20 }, { x: 10.5, y: 20 }, target),
    ];

    const actions = condenseEvents(parseEventsJsonl(events.join("\n")));

    expect(actions).toMatchObject([
      { kind: "drag", drag: { start: { x: 20, y: 20 }, end: { x: 120, y: 20 } } },
      { kind: "drag", drag: { start: { x: 9.5, y: 20 }, end: { x: 10.5, y: 20 } } },
    ]);
  });
});

function key(
  id: string,
  keyCode: number,
  timestampMs: number,
  text: string,
  modifiers: string[],
): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    sessionId: "keyboard",
    timestampMs,
    type: "key",
    key: { keyCode, text, modifiers, redacted: false },
    target: { role: "AXTextField", label: "Query", identifier: "query" },
  });
}

function drag(
  id: string,
  start: { x: number; y: number },
  end: { x: number; y: number },
  target: Record<string, unknown>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    sessionId: "pointer",
    timestampMs: id === "menu-save" || id === "real-drag" ? 0 : 10,
    type: "drag",
    button: "left",
    drag: { start, end },
    target,
  });
}
