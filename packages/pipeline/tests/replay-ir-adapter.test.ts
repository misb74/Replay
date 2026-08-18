import { validateWorkflow } from "@replay/ir";
import { describe, expect, it } from "vitest";

import {
  assembleReplayWorkflow,
  condenseEvents,
  parseEventsJsonl,
  type PipelineDraftEvidence,
} from "../src/index.js";
import { fixtureText } from "./fixture.js";

describe("canonical IR assembly", () => {
  it("adds a secret parameter and keeps all secure values out of the workflow", () => {
    const actions = condenseEvents(
      parseEventsJsonl(fixtureText("security/adversarial-secure-leak.jsonl")),
    );
    const evidence: PipelineDraftEvidence = {
      sessionId: "secure-defense",
      actions,
      framePlan: { version: 1, durationMs: 500, frames: [] },
      frames: [{
        id: "frame-secure",
        timestampMs: 200,
        mimeType: "image/png",
        dataBase64: "AA==",
        elementCrops: [{ actionId: "action-0002", path: "crops/secure-field-must-not-link.png" }],
      }],
      segmentation: {
        name: "Sign in",
        goal: "Enter a protected value without storing it.",
        parameters: [],
        steps: [
          {
            id: "step-sign-in",
            intent: "Enter the protected password",
            actionIds: actions.map((action) => action.id),
            expects: ["The sign-in form accepts the protected value"],
            source: "recorded",
            timestampRefs: [{ startMs: 0, endMs: 150 }],
          },
        ],
      },
      decisions: { decisions: [], questions: [] },
    };

    const workflow = assembleReplayWorkflow(evidence, {
      workflowId: "workflow-secure",
      now: () => new Date("2026-08-16T18:00:00.000Z"),
    });

    expect(validateWorkflow(workflow)).toEqual({ ok: true, value: workflow });
    expect(workflow.parameters).toContainEqual({
      name: "password",
      type: "secret",
      description: "Protected value entered into Password.",
      required: true,
      example: { param: "password", vault: true },
    });
    expect(workflow.steps[0]?.actions[1]).toMatchObject({
      type: "type",
      secure: true,
      value: { param: "password", vault: true },
    });
    expect(JSON.stringify(workflow)).not.toContain("SHOULD_NOT_SURVIVE");
    expect(JSON.stringify(workflow)).not.toContain("[REDACTED]");
    expect(JSON.stringify(workflow)).not.toContain("secure-field-must-not-link");
  });

  it("carries DOM selectors into the layered IR target", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "dom-click",
      sessionId: "browser",
      timestampMs: 50,
      type: "click",
      target: { role: "AXButton", label: "Submit", url: "https://example.test/form" },
      dom: { selector: "button[type=submit]", testId: "submit", text: "Submit" },
    });
    const actions = condenseEvents(parseEventsJsonl(event));
    const workflow = assembleReplayWorkflow(
      {
        sessionId: "browser",
        actions,
        framePlan: { version: 1, durationMs: 100, frames: [] },
        frames: [{
          id: "frame-0001",
          timestampMs: 40,
          mimeType: "image/png",
          dataBase64: "AA==",
          elementCrops: [{
            actionId: "action-0001",
            path: "crops/frame-0001-action-0001.png",
            bounds: { x: 10, y: 20, width: 100, height: 30 },
          }],
        }],
        segmentation: {
          name: "Submit form",
          goal: "Submit the form.",
          parameters: [],
          steps: [
            {
              id: "step-submit",
              intent: "Submit the form",
              actionIds: ["action-0001"],
              expects: ["A confirmation is visible"],
              source: "recorded",
              timestampRefs: [{ startMs: 50, endMs: 50 }],
            },
          ],
        },
        decisions: { decisions: [], questions: [] },
      },
      { now: () => new Date("2026-08-16T18:00:00.000Z") },
    );

    expect(workflow.steps[0]?.actions[0]).toMatchObject({
      type: "click",
      target: {
        description: "Submit",
        url: "https://example.test/form",
        dom: { selector: "button[type=submit]", testId: "submit", text: "Submit" },
        screenshotCrop: {
          path: "crops/frame-0001-action-0001.png",
          capturedAtMs: 40,
          bounds: { x: 10, y: 20, width: 100, height: 30 },
        },
      },
    });
    expect(validateWorkflow(workflow).ok).toBe(true);
  });

  it("emits a click when macOS reports sub-point movement inside one control", () => {
    const event = JSON.stringify({
      schemaVersion: 1,
      id: "stop-control-jitter",
      sessionId: "native",
      timestampMs: 50,
      type: "drag",
      button: "left",
      drag: { start: { x: 180.125, y: 130.25 }, end: { x: 180.125, y: 130.375 } },
      target: {
        role: "AXStaticText",
        value: "Stop recording",
        bounds: { x: 100, y: 120, width: 120, height: 20 },
      },
    });
    const actions = condenseEvents(parseEventsJsonl(event));
    const workflow = assembleReplayWorkflow({
      sessionId: "native",
      actions,
      framePlan: { version: 1, durationMs: 100, frames: [] },
      segmentation: {
        name: "Stop capture",
        goal: "Stop the active capture.",
        parameters: [],
        steps: [{
          id: "stop",
          intent: "Stop the active capture",
          actionIds: ["action-0001"],
          expects: ["The capture has stopped"],
          source: "recorded",
          timestampRefs: [{ startMs: 50, endMs: 50 }],
        }],
      },
      decisions: { decisions: [], questions: [] },
    });

    expect(workflow.steps[0]?.actions[0]).toMatchObject({ type: "click", button: "left" });
    expect(validateWorkflow(workflow).ok).toBe(true);
  });

  it("keeps the recorded endpoints of a drag instead of turning it into a no-op", () => {
    const event = JSON.stringify({ schemaVersion: 1, id: "drag", sessionId: "native", timestampMs: 50, type: "drag", drag: { start: { x: 10, y: 20 }, end: { x: 210, y: 220 } }, target: { role: "AXScrollArea", label: "Document", bounds: { x: 0, y: 0, width: 300, height: 300 } } });
    const actions = condenseEvents(parseEventsJsonl(event));
    const workflow = assembleReplayWorkflow({
      sessionId: "native",
      actions,
      framePlan: { version: 1, durationMs: 100, frames: [] },
      segmentation: { name: "Move document", goal: "Move the document.", parameters: [], steps: [{ id: "move", intent: "Move the document", actionIds: ["action-0001"], expects: ["The document has moved"], source: "recorded", timestampRefs: [{ startMs: 50, endMs: 50 }] }] },
      decisions: { decisions: [], questions: [] },
    });
    expect(workflow.steps[0]?.actions[0]).toMatchObject({ type: "drag", from: { accessibility: { bounds: { x: 10, y: 20 } } }, to: { accessibility: { bounds: { x: 210, y: 220 } } } });
    expect(validateWorkflow(workflow).ok).toBe(true);
  });
});
