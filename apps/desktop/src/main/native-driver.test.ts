import { describe, expect, it } from "vitest";
import type { SidecarClient, SidecarResult } from "./sidecar-client.js";
import { NativeSidecarDriver } from "./native-driver.js";

class FakeSidecar {
  requests: Array<{ command: string; payload: Record<string, unknown> }> = [];
  async request(command: string, payload: Record<string, unknown>): Promise<SidecarResult> {
    this.requests.push({ command, payload });
    return command === "act_screenshot"
      ? { type: "screenshot", screenshot: { path: String(payload.outputPath), width: 2000, height: 1200, scale: 2 } }
      : command === "guardrails_subscribe"
        ? { type: "guardrails_subscribed", guardrailsActive: true }
        : command === "guardrails_unsubscribe"
          ? { type: "guardrails_unsubscribed", guardrailsActive: false }
          : { type: "action_completed" };
  }
  on() { return () => {}; }
  isRunning() { return true; }
}

const judge = { async expectation() { return { met: true, reason: "fixture" }; }, async condition() { return { result: true, reason: "fixture" }; } };

describe("NativeSidecarDriver", () => {
  it("sends layered accessibility and coordinate identity for clicks", async () => {
    const sidecar = new FakeSidecar();
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", judge);
    await driver.perform({ action: { id: "click", type: "click", target: { description: "Approve", accessibility: { role: "AXButton", label: "Approve", bounds: { x: 10, y: 20, width: 100, height: 40 } } } } });
    expect(sidecar.requests[0]).toMatchObject({ command: "act_click", payload: { target: { role: "AXButton", label: "Approve" }, position: { x: 60, y: 40 } } });
  });

  it("refuses secure text even if called outside the runner guard", async () => {
    const sidecar = new FakeSidecar();
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", judge);
    await expect(driver.perform({ action: { id: "secret", type: "type", target: { description: "Password" }, value: { param: "password", vault: true }, secure: true }, value: "must-not-send" })).rejects.toThrow("Secure values");
    expect(sidecar.requests).toHaveLength(0);
  });

  it("converts screenshot pixels back to logical screen coordinates after visual grounding", async () => {
    const sidecar = new FakeSidecar();
    const groundingJudge = { ...judge, async reground({ target }: { target: { description: string } }) { return { ...target, accessibility: { bounds: { x: 200, y: 100, width: 80, height: 40 } } }; } };
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", groundingJudge);
    const target = await driver.reground({ description: "Approve" }, { id: "shot", path: "/tmp/shot.png", capturedAt: "2026-08-17T00:00:00Z", scale: 2 });
    expect(target.accessibility?.bounds).toEqual({ x: 100, y: 50, width: 40, height: 20 });
  });

  it("keeps coordinates unchanged when a Retina capture is encoded at logical resolution", async () => {
    const sidecar = new FakeSidecar();
    const groundingJudge = { ...judge, async reground({ target }: { target: { description: string } }) { return { ...target, accessibility: { bounds: { x: 306, y: 32, width: 1_170, height: 920 } } }; } };
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", groundingJudge);
    const target = await driver.reground({ description: "Window" }, { id: "shot", path: "/tmp/shot.png", capturedAt: "2026-08-17T00:00:00Z", width: 1_512, height: 982, scale: 1 });
    expect(target.accessibility?.bounds).toEqual({ x: 306, y: 32, width: 1_170, height: 920 });
  });

  it("starts native guardrails with the emergency shortcut shown by the app", async () => {
    const sidecar = new FakeSidecar();
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", judge);
    await driver.startGuardrails();
    await driver.stopGuardrails();
    expect(sidecar.requests).toEqual([
      { command: "guardrails_subscribe", payload: { killSwitch: { keyCode: 53, modifiers: ["command", "shift"] }, mouseMovementThreshold: 3 } },
      { command: "guardrails_unsubscribe", payload: {} },
    ]);
  });

  it("maps readable workflow keys to macOS virtual key codes", async () => {
    const sidecar = new FakeSidecar();
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", judge);
    await driver.perform({ action: { id: "submit", type: "key", key: "Command+Enter" } });
    expect(sidecar.requests[0]).toEqual({ command: "act_key", payload: { keyCode: 36, modifiers: ["command"] } });
  });

  it("preserves macOS wheel direction when replaying a downward scroll", async () => {
    const sidecar = new FakeSidecar();
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", judge);
    await driver.perform({ action: { id: "scroll", type: "scroll", direction: "down", distance: 240 } });
    expect(sidecar.requests[0]).toEqual({ command: "act_scroll", payload: { deltaX: 0, deltaY: -240 } });
  });

  it("executes a narrated branch as one constrained visual action", async () => {
    const sidecar = new FakeSidecar();
    const customJudge = { ...judge, async customAction() { return { kind: "click" as const, x: 400, y: 220, reason: "Flag button is visible" }; } };
    const driver = new NativeSidecarDriver(sidecar as unknown as SidecarClient, "/tmp/replay-driver", customJudge);
    await driver.perform({ action: { id: "flag", type: "custom", description: "Flag this invoice for review" } });
    expect(sidecar.requests.map((request) => request.command)).toEqual(["act_screenshot", "act_click"]);
    expect(sidecar.requests[1]?.payload).toMatchObject({ position: { x: 200, y: 110 }, clickCount: 1 });
  });
});
