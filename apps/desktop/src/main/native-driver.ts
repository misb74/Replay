import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowAction, WorkflowTarget } from "@replay/ir";
import type { ActionReceipt, NativeDriver, ResolvedAction, Screenshot, SemanticJudge } from "@replay/runner";
import { SidecarClient, SidecarRequestError } from "./sidecar-client.js";

export class UnsupportedNativeActionError extends Error {
  constructor(action: WorkflowAction["type"]) {
    super(`The native sidecar cannot safely perform the ${action} action`);
    this.name = "UnsupportedNativeActionError";
  }
}

export class NativeSidecarDriver implements NativeDriver {
  constructor(
    private readonly sidecar: SidecarClient,
    private readonly screenshotsDirectory: string,
    private readonly judge: SemanticJudge,
  ) {}

  async startGuardrails(): Promise<void> {
    const result = await this.sidecar.request("guardrails_subscribe", {
      killSwitch: { keyCode: 53, modifiers: ["command", "shift"] },
      mouseMovementThreshold: 3,
    });
    if (result.type !== "guardrails_subscribed" || result.guardrailsActive !== true) {
      throw new Error("The native safety monitor did not start");
    }
  }

  async stopGuardrails(): Promise<void> {
    if (!this.sidecar.isRunning()) return;
    const result = await this.sidecar.request("guardrails_unsubscribe", {});
    if (result.type !== "guardrails_unsubscribed") throw new Error("The native safety monitor did not stop");
  }

  async resumeAfterUserActivity(): Promise<void> {
    await this.stopGuardrails();
    await this.startGuardrails();
  }

  isUserActivityInterruption(cause: unknown): boolean {
    return cause instanceof SidecarRequestError && cause.code === "safety_interlock_engaged";
  }

  async screenshot(label: string): Promise<Screenshot> {
    await mkdir(this.screenshotsDirectory, { recursive: true, mode: 0o700 });
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/gu, "-").slice(0, 80) || "screen";
    const path = join(this.screenshotsDirectory, `${safeLabel}-${randomUUID().slice(0, 8)}.png`);
    const result = await this.sidecar.request("act_screenshot", { outputPath: path });
    if (result.type !== "screenshot" || !result.screenshot) throw new Error("The sidecar returned no screenshot");
    return {
      id: randomUUID(),
      path: result.screenshot.path,
      capturedAt: new Date().toISOString(),
      width: result.screenshot.width,
      height: result.screenshot.height,
      scale: result.screenshot.scale,
    };
  }

  async perform(resolved: ResolvedAction): Promise<ActionReceipt> {
    const { action } = resolved;
    switch (action.type) {
      case "click": {
        const payload = clickPayload(action.target);
        await this.sidecar.request("act_click", { ...payload, button: action.button === "middle" ? "other" : action.button ?? "left", clickCount: action.clickCount ?? 1 });
        return receipt(action, payload.target ? "accessibility" : "coordinate", action.target.description);
      }
      case "type": {
        if (action.secure || (typeof action.value === "object" && action.value.vault)) throw new Error("Secure values must be typed by the operator");
        const text = String(resolved.value ?? "");
        const target = selector(action.target);
        try {
          await this.sidecar.request("act_type", { text, ...(target ? { target } : {}) });
          return receipt(action, target ? "accessibility" : "keyboard", action.target.description);
        } catch (cause) {
          const position = center(action.target);
          if (!(cause instanceof SidecarRequestError) || cause.code !== "target_not_found" || !position) throw cause;
          await this.sidecar.request("act_click", { position, button: "left", clickCount: 1 });
          await this.sidecar.request("act_type", { text });
          return receipt(action, "vision", action.target.description, "Focused a visually re-grounded target before typing");
        }
      }
      case "select": {
        const payload = clickPayload(action.target);
        await this.sidecar.request("act_click", { ...payload, button: "left", clickCount: 1 });
        await this.sidecar.request("act_type", { text: String(resolved.value ?? "") });
        await this.sidecar.request("act_key", { key: "Enter", modifiers: [] });
        return receipt(action, payload.target ? "accessibility" : "coordinate", action.target.description);
      }
      case "navigate":
        await this.sidecar.request("act_navigate", { url: String(resolved.value ?? "") });
        return receipt(action, "keyboard", "browser address bar");
      case "scroll": {
        const distance = action.distance ?? 480;
        const deltaX = action.direction === "left" ? distance : action.direction === "right" ? -distance : 0;
        const deltaY = action.direction === "up" ? distance : action.direction === "down" ? -distance : 0;
        await this.sidecar.request("act_scroll", { deltaX, deltaY, ...(center(action.target) ? { position: center(action.target) } : {}) });
        return receipt(action, "coordinate", action.target?.description);
      }
      case "drag": {
        const start = center(action.from);
        const end = center(action.to);
        if (!start || !end) throw new UnsupportedNativeActionError(action.type);
        await this.sidecar.request("act_drag", { start, end, button: "left" });
        return receipt(action, "coordinate", `${action.from.description} → ${action.to.description}`);
      }
      case "key": {
        const parts = action.key.split("+").map((part) => part.trim()).filter(Boolean);
        const key = parts.pop();
        if (!key) throw new UnsupportedNativeActionError(action.type);
        await this.sidecar.request("act_key", { keyCode: macKeyCode(key), modifiers: parts.map(normalizeModifier) });
        return receipt(action, "keyboard", action.target?.description);
      }
      case "wait":
        await delay(action.durationMs ?? 250);
        return receipt(action, "none", undefined, action.until ? `Waited before checking: ${action.until}` : "Wait completed");
      case "custom":
        return this.#performSemanticAction(action);
    }
  }

  async #performSemanticAction(action: Extract<WorkflowAction, { type: "custom" }>): Promise<ActionReceipt> {
    if (!this.judge.customAction) throw new UnsupportedNativeActionError(action.type);
    const screenshot = await this.screenshot(`${action.id}-semantic-action`);
    const plan = await this.judge.customAction({ description: action.description, screenshot });
    if (plan.kind === "stop") throw new Error(`The visual action planner stopped safely: ${plan.reason}`);
    if (plan.kind === "click") {
      if (![plan.x, plan.y].every((value) => Number.isFinite(value))) throw new Error("The visual action planner returned invalid coordinates");
      if (plan.x < 0 || plan.y < 0 || (screenshot.width !== undefined && plan.x > screenshot.width) || (screenshot.height !== undefined && plan.y > screenshot.height)) throw new Error("The visual action planner returned coordinates outside the screenshot");
      const scale = screenshot.scale && screenshot.scale > 0 ? screenshot.scale : 1;
      await this.sidecar.request("act_click", { position: { x: plan.x / scale, y: plan.y / scale }, button: "left", clickCount: 1 });
      return receipt(action, "vision", action.description, plan.reason);
    }
    await this.sidecar.request("act_key", { keyCode: macKeyCode(plan.key), modifiers: plan.modifiers.map(normalizeModifier) });
    return receipt(action, "vision", action.description, plan.reason);
  }

  async reground(target: WorkflowTarget, screenshot: Screenshot): Promise<WorkflowTarget> {
    const grounded = await this.judge.reground?.({ target, screenshot });
    if (!grounded?.accessibility?.bounds) return target;
    const scale = screenshot.scale && screenshot.scale > 0 ? screenshot.scale : 1;
    const bounds = grounded.accessibility.bounds;
    return {
      ...grounded,
      accessibility: {
        ...grounded.accessibility,
        bounds: { x: bounds.x / scale, y: bounds.y / scale, width: bounds.width / scale, height: bounds.height / scale },
      },
    };
  }

  onUserActivity(listener: () => void): () => void {
    return this.sidecar.on("user_activity", listener);
  }

  onKillSwitch(listener: () => void): () => void {
    return this.sidecar.on("kill_switch", listener);
  }
}

function selector(target: WorkflowTarget): Record<string, string> | undefined {
  const ax = target.accessibility;
  if (!ax) return undefined;
  const value = {
    ...(ax.identifier ? { identifier: ax.identifier } : {}),
    ...(ax.role ? { role: ax.role } : {}),
    ...(ax.label ? { label: ax.label } : {}),
    ...(ax.appBundleId ? { bundleId: ax.appBundleId } : {}),
    ...(ax.windowTitle ? { windowTitle: ax.windowTitle } : {}),
  };
  return Object.keys(value).length > 0 ? value : undefined;
}

function center(target: WorkflowTarget | undefined): { x: number; y: number } | undefined {
  const bounds = target?.accessibility?.bounds;
  return bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } : undefined;
}

function clickPayload(target: WorkflowTarget): { target?: Record<string, string>; position?: { x: number; y: number } } {
  const semantic = selector(target);
  const position = center(target);
  if (!semantic && !position) throw new Error(`No actionable identity or position exists for ${target.description}`);
  return { ...(semantic ? { target: semantic } : {}), ...(position ? { position } : {}) };
}

function receipt(action: WorkflowAction, method: ActionReceipt["method"], targetDescription?: string, detail?: string): ActionReceipt {
  return { actionId: action.id, method, ...(targetDescription ? { targetDescription } : {}), ...(detail ? { detail } : {}) };
}

function normalizeModifier(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "cmd") return "command";
  if (normalized === "alt") return "option";
  if (normalized === "ctrl") return "control";
  if (normalized === "command" || normalized === "option" || normalized === "control" || normalized === "shift") return normalized;
  throw new Error(`Replay cannot safely map the modifier ${JSON.stringify(value)} on macOS`);
}

function macKeyCode(value: string): number {
  const key = value.toLowerCase();
  const codes: Record<string, number> = {
    enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51,
    escape: 53, esc: 53, command: 55, shift: 56, capslock: 57, option: 58,
    control: 59, arrowleft: 123, left: 123, arrowright: 124, right: 124,
    arrowdown: 125, down: 125, arrowup: 126, up: 126,
    a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
    b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34,
    p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43,
    "/": 44, n: 45, m: 46, ".": 47, "`": 50,
  };
  const code = codes[key];
  if (code === undefined) throw new Error(`Replay cannot safely map the key ${JSON.stringify(value)} on macOS`);
  return code;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, Math.max(0, milliseconds)));
}
