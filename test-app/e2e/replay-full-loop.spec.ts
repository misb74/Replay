import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import type { WorkflowAction } from "@replay/ir";
import { FixtureModelAdapter, type FrameProvider } from "@replay/pipeline";
import { WorkflowRunner, type ActionReceipt, type NativeDriver, type ResolvedAction, type Screenshot, type SemanticJudge } from "@replay/runner";
import { DesktopPipelineService } from "../../apps/desktop/src/main/pipeline-service.js";
import { SessionService } from "../../apps/desktop/src/main/session-service.js";
import type { SidecarClient } from "../../apps/desktop/src/main/sidecar-client.js";
import { WorkflowRepository } from "../../apps/desktop/src/main/workflow-repository.js";

const fixtures = fileURLToPath(new URL("../../packages/fixtures/", import.meta.url));

interface FullLoopCase {
  invoiceId: string;
  expectedReviewState: string;
  actionLabel: string;
}

const contract = JSON.parse(await readFile(join(fixtures, "recordings/invoice-match/full-loop-cases.json"), "utf8")) as { sessionId: string; cases: FullLoopCase[] };

const frames: FrameProvider = {
  async sample({ plan }) {
    return plan.frames.map((frame) => ({ id: frame.id, timestampMs: frame.timestampMs, mimeType: "image/png", dataBase64: "AA==" }));
  },
};

for (const scenario of contract.cases) {
  test(`Replay learns, approves, and runs ${scenario.invoiceId} to ${scenario.expectedReviewState}`, async ({ page }) => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "replay-browser-spine-"));
    const sessionDirectory = join(dataDirectory, "sessions", contract.sessionId);
    await mkdir(join(dataDirectory, "sessions"), { recursive: true });
    await cp(join(fixtures, "recordings/invoice-match"), sessionDirectory, { recursive: true });

    const cache = JSON.parse(await readFile(join(fixtures, "model-outputs/invoice-match.cache.json"), "utf8")) as Record<string, unknown>;
    const sessions = new SessionService({ on: () => () => {} } as unknown as SidecarClient, dataDirectory);
    const workflows = new WorkflowRepository(dataDirectory);
    const draft = await new DesktopPipelineService(sessions, workflows, {
      modelAdapter: new FixtureModelAdapter(cache),
      frameProvider: frames,
      screenChangeProvider: { async detect() { return [{ timestampMs: 2_400, score: 0.91 }]; } },
      // This hermetic fixture deliberately supplies cached frames instead of a
      // real MP4. Production omits this stub and always runs the FFmpeg validator.
      videoValidator: { async validate(videoPath) { expect(videoPath).toBe(join(sessionDirectory, "video.mp4")); } },
    }).process(contract.sessionId);
    await workflows.approve(draft.id);
    const approved = await workflows.get(draft.id);

    await page.goto("/");
    await page.getByRole("button", { name: new RegExp(scenario.invoiceId, "u") }).click();
    const driver = new PlaywrightInvoiceDriver(page, join(dataDirectory, "run-screenshots"));
    const judge = invoiceJudge(page);
    const log = await new WorkflowRunner().start({
      workflow: approved,
      driver,
      judge,
      options: { mode: "autonomous", runId: `full-loop-${scenario.invoiceId}` },
    }).result;

    await expect(page.getByTestId("review-state")).toHaveText(scenario.expectedReviewState);
    expect(log.outcome).toBe("completed");
    expect(log.steps.flatMap((step) => step.decisions)).toContainEqual(expect.objectContaining({
      decisionId: "decision-001",
      result: scenario.invoiceId === "INV-1048",
    }));
    expect(driver.performedLabels).toContain(scenario.actionLabel);
  });
}

class PlaywrightInvoiceDriver implements NativeDriver {
  readonly performedLabels: string[] = [];

  constructor(private readonly page: Page, private readonly screenshotsDirectory: string) {}

  async screenshot(label: string): Promise<Screenshot> {
    await mkdir(this.screenshotsDirectory, { recursive: true });
    const path = join(this.screenshotsDirectory, `${label.replace(/[^A-Za-z0-9_-]/gu, "-")}.png`);
    await this.page.screenshot({ path });
    return { id: label, path, capturedAt: new Date().toISOString() };
  }

  async perform({ action }: ResolvedAction): Promise<ActionReceipt> {
    if (action.type === "custom") {
      const label = /flag difference/iu.test(action.description) ? "Flag difference" : action.description;
      await this.page.getByRole("button", { name: label }).click();
      this.performedLabels.push(label);
      return receipt(action, "vision", label);
    }
    if (action.type !== "click") throw new Error(`The full-loop fixture unexpectedly requested ${action.type}`);
    const identifier = action.target.dom?.testId ?? action.target.accessibility?.identifier;
    const label = action.target.accessibility?.label ?? action.target.description;
    if (/approve invoice/iu.test(label)) await this.page.getByRole("button", { name: "Approve invoice" }).click();
    else if (identifier) await this.page.getByTestId(identifier).click();
    else await this.page.getByText(label, { exact: false }).first().click();
    this.performedLabels.push(/approve invoice/iu.test(label) ? "Approve invoice" : label);
    return receipt(action, "accessibility", label);
  }
}

function invoiceJudge(page: Page): SemanticJudge {
  return {
    async condition() {
      const text = await page.getByTestId("comparison-result").innerText();
      return { result: text.includes("Totals match"), reason: text };
    },
    async expectation({ expectation }) {
      if (/comparison result/iu.test(expectation)) {
        return { met: await page.getByTestId("comparison-result").isVisible(), reason: "The comparison result is visible" };
      }
      const state = await page.getByTestId("review-state").innerText();
      const wanted = /needs attention/iu.test(expectation) ? "Needs attention" : /approved/iu.test(expectation) ? "Approved" : undefined;
      return { met: wanted === undefined || state === wanted, reason: `Review state is ${state}` };
    },
  };
}

function receipt(action: WorkflowAction, method: ActionReceipt["method"], targetDescription: string): ActionReceipt {
  return { actionId: action.id, method, targetDescription };
}
