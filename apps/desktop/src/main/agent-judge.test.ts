import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSdkSemanticJudge } from "./agent-judge.js";

describe("AgentSdkSemanticJudge", () => {
  it("allows the agent to read only the supplied screenshot", async () => {
    const fakeQuery = async function* (input: { prompt: string; options?: Options }): AsyncIterable<SDKMessage> {
      const permission = await input.options!.canUseTool!("Read", { file_path: "/tmp/replay-shot.png" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" });
      expect(permission).toMatchObject({ behavior: "allow" });
      const denied = await input.options!.canUseTool!("Read", { file_path: "/tmp/private.txt" }, { signal: new AbortController().signal, toolUseID: "tool-2", requestId: "request-2" });
      expect(denied).toMatchObject({ behavior: "deny", interrupt: true });
      yield { type: "result", subtype: "success", structured_output: { result: true, reason: "Visible" } } as SDKMessage;
    };
    const judge = new AgentSdkSemanticJudge("fixture", fakeQuery);
    await expect(judge.condition({ condition: "Totals match", screenshot: { id: "shot", path: "/tmp/replay-shot.png", capturedAt: "2026-08-17T00:00:00Z" } })).resolves.toEqual({ result: true, reason: "Visible" });
  });

  it("fails closed when no screenshot was read", async () => {
    const fakeQuery = async function* (): AsyncIterable<SDKMessage> {
      yield { type: "result", subtype: "success", structured_output: { result: true, reason: "Guessed" } } as SDKMessage;
    };
    const judge = new AgentSdkSemanticJudge("fixture", fakeQuery);
    await expect(judge.condition({ condition: "Visible", screenshot: { id: "shot", path: "/tmp/replay-shot.png", capturedAt: "2026-08-17T00:00:00Z" } })).rejects.toThrow("did not inspect");
  });

  it("constrains a narrated step to one visible click", async () => {
    const fakeQuery = async function* (input: { options?: Options }): AsyncIterable<SDKMessage> {
      await input.options!.canUseTool!("Read", { file_path: "/tmp/replay-shot.png" }, { signal: new AbortController().signal, toolUseID: "tool", requestId: "request" });
      yield { type: "result", subtype: "success", structured_output: { kind: "click", x: 410, y: 230, reason: "Visible Flag button" } } as SDKMessage;
    };
    const judge = new AgentSdkSemanticJudge("fixture", fakeQuery);
    await expect(judge.customAction({ description: "Flag the invoice", screenshot: { id: "shot", path: "/tmp/replay-shot.png", capturedAt: "2026-08-17T00:00:00Z" } })).resolves.toEqual({ kind: "click", x: 410, y: 230, reason: "Visible Flag button" });
  });
});
