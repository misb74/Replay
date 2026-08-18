import { describe, expect, it } from "vitest";

import {
  EventsJsonlError,
  containsUnredactedSecureText,
  parseEventsJsonl,
  safeParseEventsJsonl,
} from "../src/index.js";
import { fixtureText } from "./fixture.js";

describe("events.jsonl ingestion", () => {
  it("parses the canonical sidecar schema", () => {
    const events = parseEventsJsonl(fixtureText("recordings/invoice-match/events.jsonl"));

    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({
      schemaVersion: 1,
      id: "evt-001",
      sessionId: "invoice-match-demo",
      timestampMs: 200,
      type: "click",
      target: { label: "Invoice total $1,284.40", identifier: "invoice-total" },
    });
    expect(events.at(-1)).toMatchObject({ id: "evt-005", type: "click", target: { label: "Approved" } });
  });

  it("redacts a broken producer's secure values before returning events", () => {
    const source = fixtureText("security/adversarial-secure-leak.jsonl");
    const events = parseEventsJsonl(source);
    const serialized = JSON.stringify(events);

    expect(source).toContain("SHOULD_NOT_SURVIVE");
    expect(serialized).not.toContain("SHOULD_NOT_SURVIVE");
    expect(serialized).toContain("[REDACTED]");
    expect(events[1]?.dom).toEqual({ redacted: true });
    expect(containsUnredactedSecureText(events)).toBe(false);
  });

  it("never includes malformed source text in diagnostics", () => {
    const marker = "PRIVATE_VALUE_MUST_NOT_APPEAR";
    const result = safeParseEventsJsonl(`{"password":"${marker}"`);

    expect(result.issues).toEqual([
      {
        line: 1,
        code: "invalid_json",
        severity: "error",
        message: "The event line is not valid JSON.",
      },
    ]);
    expect(JSON.stringify(result.issues)).not.toContain(marker);
    expect(() => parseEventsJsonl(`{"password":"${marker}"`)).toThrow(EventsJsonlError);
    try {
      parseEventsJsonl(`{"password":"${marker}"`);
    } catch (error) {
      expect(String(error)).not.toContain(marker);
    }
  });

  it("reports duplicates and unsupported versions without returning them", () => {
    const base = {
      schemaVersion: 1,
      id: "duplicate",
      sessionId: "session",
      timestampMs: 20,
      type: "click",
    };
    const result = safeParseEventsJsonl(
      [JSON.stringify(base), JSON.stringify({ ...base, timestampMs: 10 }), JSON.stringify({ ...base, id: "v2", schemaVersion: 2 })].join("\n"),
    );

    expect(result.events).toHaveLength(1);
    expect(result.issues.map((issue) => issue.code)).toEqual(["duplicate_id", "unsupported_schema"]);
  });

  it("sorts a partially flushed capture but leaves a timestamp warning", () => {
    const event = (id: string, timestampMs: number) =>
      JSON.stringify({ schemaVersion: 1, id, sessionId: "partial", timestampMs, type: "click" });
    const result = safeParseEventsJsonl([event("late", 20), event("early", 10)].join("\n"));

    expect(result.events.map(({ id }) => id)).toEqual(["early", "late"]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ code: "non_monotonic_timestamp", severity: "warning" }),
    );
  });

  it("rejects events from another session and bounds the full input", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "foreign",
      sessionId: "another-session",
      timestampMs: 0,
      type: "click",
    });

    expect(safeParseEventsJsonl(event, { expectedSessionId: "expected" }).issues).toContainEqual(
      expect.objectContaining({ code: "unexpected_session", severity: "error" }),
    );
    expect(safeParseEventsJsonl(event, { maxInputBytes: 10 })).toEqual({
      events: [],
      issues: [
        {
          line: 0,
          code: "input_too_large",
          severity: "error",
          message: "The event stream exceeds the configured size limit.",
        },
      ],
    });
  });

  it("redacts future selection payloads when their target is secure", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "secure-selection",
      sessionId: "secure",
      timestampMs: 0,
      type: "select",
      selection: { value: "SHOULD_NOT_SURVIVE" },
      target: { role: "passwordField", label: "Passcode" },
    });

    const parsed = parseEventsJsonl(event);
    expect(parsed[0]?.selection).toEqual({ value: "[REDACTED]" });
    expect(JSON.stringify(parsed)).not.toContain("SHOULD_NOT_SURVIVE");
  });

  it("honors the macOS secure subrole even when the base role is ordinary", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "secure-subrole",
      sessionId: "secure",
      timestampMs: 0,
      type: "key",
      key: { keyCode: 0, text: "SHOULD_NOT_SURVIVE", modifiers: [], redacted: false },
      target: {
        role: "AXTextField",
        subrole: "AXSecureTextField",
        label: "Password",
        value: "SHOULD_NOT_SURVIVE",
        isSecure: false,
      },
    });

    const parsed = parseEventsJsonl(event);
    expect(parsed[0]?.key).toMatchObject({ text: "[REDACTED]", redacted: true });
    expect(parsed[0]?.target).toMatchObject({
      role: "AXTextField",
      subrole: "AXSecureTextField",
      value: "[REDACTED]",
      isSecure: true,
    });
  });
});
