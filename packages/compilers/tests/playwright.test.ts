import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compilePlaywright } from "../src/index.js";
import { approvedWorkflow } from "./fixture.js";
import { golden, textOutput } from "./helpers.js";

function expectGeneratedTypeScriptToCompile(source: string): void {
  const temporaryDirectory = mkdtempSync(join(process.cwd(), ".generated-playwright-"));
  const scriptPath = join(temporaryDirectory, "workflow.ts");
  writeFileSync(scriptPath, source, "utf8");
  try {
    const compiler = join(process.cwd(), "../../node_modules/typescript/lib/tsc.js");
    const checked = spawnSync(
      process.execPath,
      [
        compiler,
        "--ignoreConfig",
        "--noEmit",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--strict",
        "--skipLibCheck",
        scriptPath,
      ],
      { encoding: "utf8" },
    );
    expect(`${checked.stdout}${checked.stderr}`).toBe("");
    expect(checked.status).toBe(0);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

describe("Playwright compiler", () => {
  it("matches the reviewed script and compile-report goldens", () => {
    const result = compilePlaywright(approvedWorkflow());

    expect(textOutput(result, "workflow.ts")).toBe(golden("invoice.playwright.ts"));
    expect(textOutput(result, "compile-report.json")).toBe(
      golden("invoice.compile-report.json"),
    );
  });

  it("emits syntactically valid TypeScript", () => {
    const source = textOutput(compilePlaywright(approvedWorkflow()), "workflow.ts");
    expectGeneratedTypeScriptToCompile(source);
  });

  it("maps AX browser identities to role-based locators", () => {
    const workflow = approvedWorkflow();
    const nested = workflow.steps[0]!.decisions![0]!.then[0]!;
    if (nested.kind !== "step") throw new Error("fixture is wrong");
    const target = nested.actions[0];
    if (target?.type !== "click") throw new Error("fixture is wrong");
    delete target.target.dom;

    const source = textOutput(compilePlaywright(workflow), "workflow.ts");
    expect(source).toContain(
      'page.getByRole("button", { name: "Approve invoice", exact: true })',
    );
  });

  it("compiles structured browser decisions without a decision checkpoint", () => {
    const workflow = approvedWorkflow();
    const decision = workflow.steps[0]!.decisions![0]!;
    decision.deterministicCheck = {
      kind: "text-contains",
      target: {
        description: "Comparison result",
        url: "http://127.0.0.1:4173/invoices/1001",
        dom: { testId: "comparison-result" },
      },
      expected: "Totals match",
    };

    const result = compilePlaywright(workflow);
    const source = textOutput(result, "workflow.ts");
    expect(source).toContain(
      'await waitForCondition(page, async () => (await page.getByTestId("comparison-result").textContent())?.includes("Totals match") === true)',
    );
    expect(source).toContain("while (Date.now() <= deadline)");
    expect(result.warnings.map((warning) => warning.code)).not.toContain(
      "semantic-condition-degraded",
    );
  });

  it("compiles structured expectation checks instead of pausing", () => {
    const workflow = approvedWorkflow();
    const root = workflow.steps[0]!;
    root.expectationChecks = [
      {
        expectation: root.expects[0]!,
        kind: "visible",
        target: {
          description: "Invoice details",
          url: "http://127.0.0.1:4173",
          dom: { selector: "[aria-label='Invoice details']" },
        },
      },
    ];
    const nested = root.decisions![0]!.then[0]!;
    if (nested.kind !== "step") throw new Error("fixture is wrong");
    nested.expectationChecks = [
      {
        expectation: nested.expects[0]!,
        kind: "text-equals",
        target: {
          description: "Review state",
          url: "http://127.0.0.1:4173",
          dom: { testId: "review-state" },
        },
        expected: "Approved",
      },
    ];

    const result = compilePlaywright(workflow);
    const source = textOutput(result, "workflow.ts");
    expect(source).toContain(
      'if (!(await waitForCondition(page, async () => await page.locator("[aria-label=\'Invoice details\']").isVisible())))',
    );
    expect(source).toContain(
      'await waitForCondition(page, async () => (await page.getByTestId("review-state").textContent())?.trim() === "Approved")',
    );
    expect(source).not.toContain(
      'if (!(await page.locator("[aria-label=\'Invoice details\']").isVisible()))',
    );
    expect(result.warnings.filter((warning) => warning.code === "semantic-expectation-degraded"))
      .toEqual([]);
    expectGeneratedTypeScriptToCompile(source);
  });

  it("warns when browser targets degrade to weak locators", () => {
    const workflow = approvedWorkflow();
    workflow.steps[0]!.actions.push(
      {
        id: "unsupported-role",
        type: "click",
        target: {
          description: "Payment total",
          url: "http://127.0.0.1:4173/invoices/1001",
          accessibility: { role: "AXGroup", label: "Payment total" },
        },
      },
      {
        id: "role-only",
        type: "click",
        target: {
          description: "Unlabelled action",
          url: "http://127.0.0.1:4173/invoices/1001",
          accessibility: { role: "AXButton" },
        },
      },
    );

    const result = compilePlaywright(workflow);
    const source = textOutput(result, "workflow.ts");
    expect(source).toContain('page.getByText("Payment total", { exact: true })');
    expect(source).toContain('page.getByRole("button")');
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "imprecise-browser-locator",
          actionId: "unsupported-role",
          message: expect.stringContaining("unsupported AX role 'AXGroup'"),
        }),
        expect.objectContaining({
          code: "imprecise-browser-locator",
          actionId: "role-only",
          message: expect.stringContaining("has no accessible label"),
        }),
      ]),
    );
  });

  it("covers typed input, selection, scrolling, dragging, keys, and waits", () => {
    const workflow = approvedWorkflow();
    workflow.steps[0]!.actions.push(
      {
        id: "type-note",
        type: "type",
        target: {
          description: "Note",
          url: "http://127.0.0.1:4173",
          dom: { selector: "#note" },
        },
        value: "Reviewed",
        clearFirst: false,
      },
      {
        id: "select-status",
        type: "select",
        target: {
          description: "Status",
          url: "http://127.0.0.1:4173",
          dom: { selector: "#status" },
        },
        value: "approved",
      },
      { id: "scroll-down", type: "scroll", direction: "down", distance: 240 },
      {
        id: "drag-card",
        type: "drag",
        from: {
          description: "Card",
          url: "http://127.0.0.1:4173",
          dom: { selector: "#card" },
        },
        to: {
          description: "Done lane",
          url: "http://127.0.0.1:4173",
          dom: { selector: "#done" },
        },
      },
      { id: "press-enter", type: "key", key: "Enter" },
      { id: "settle", type: "wait", durationMs: 250 },
    );

    const source = textOutput(compilePlaywright(workflow), "workflow.ts");
    expect(source).toContain('page.locator("#note").pressSequentially("Reviewed")');
    expect(source).toContain('page.locator("#status").selectOption("approved")');
    expect(source).toContain("page.mouse.wheel(0, 240)");
    expect(source).toContain('page.locator("#card").dragTo(page.locator("#done"))');
    expect(source).toContain('page.keyboard.press("Enter")');
    expect(source).toContain("page.waitForTimeout(250)");
    expectGeneratedTypeScriptToCompile(source);
  });

  it("turns native actions and secure inputs into explicit checkpoints", () => {
    const workflow = approvedWorkflow();
    workflow.parameters.push({
      name: "password",
      type: "secret",
      description: "Invoice password",
      required: true,
      example: { param: "password", vault: true },
    });
    workflow.steps[0]!.actions.push(
      {
        id: "native-click",
        type: "click",
        target: {
          description: "Save in Preview",
          accessibility: {
            role: "AXButton",
            label: "Save",
            appBundleId: "com.apple.Preview",
          },
        },
      },
      {
        id: "secret-type",
        type: "type",
        target: {
          description: "Password field",
          url: "http://127.0.0.1:4173/login",
          accessibility: { role: "AXSecureTextField", label: "Password" },
        },
        value: { param: "password", vault: true },
        secure: true,
      },
    );

    const result = compilePlaywright(workflow);
    const source = textOutput(result, "workflow.ts");
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["native-action-degraded", "secure-input-checkpoint"]),
    );
    expect(source).toContain("Complete outside the browser: Click Save in Preview");
    expect(source).toContain("Replay never reads or stores it");
    expect(source).not.toContain("--password");
  });

  it("degrades a requested native agent check to a human checkpoint", () => {
    const workflow = approvedWorkflow();
    delete workflow.steps[0]!.decisions;
    workflow.steps[0]!.actions.push({
      id: "native-save",
      type: "click",
      target: {
        description: "Save in Preview",
        accessibility: {
          role: "AXButton",
          label: "Save",
          appBundleId: "com.apple.Preview",
        },
      },
    });

    const result = compilePlaywright(workflow, { nativeFallback: "agent-check" });
    const source = textOutput(result, "workflow.ts");
    const report = JSON.parse(textOutput(result, "compile-report.json")) as {
      fallback: { native: string };
    };

    expect(source).toContain("Complete outside the browser: Click Save in Preview");
    expect(source).not.toContain("Confirm the result after this native-app action");
    expect(source).not.toContain("async function agentCheck(page: Page");
    expect(report.fallback.native).toBe("human-checkpoint");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "native-agent-check-unavailable",
        actionId: "native-save",
        message: expect.stringContaining("cannot observe a native desktop app"),
      }),
    );
  });

  it("keeps agent verification for a page-observable custom browser action", () => {
    const workflow = approvedWorkflow();
    workflow.steps[0]!.actions.push({
      id: "browser-custom",
      type: "custom",
      description: "Complete the browser challenge",
      target: {
        description: "Browser challenge",
        url: "http://127.0.0.1:4173/invoices/1001",
        dom: { testId: "browser-challenge" },
      },
    });

    const result = compilePlaywright(workflow, { nativeFallback: "agent-check" });
    const source = textOutput(result, "workflow.ts");

    expect(source).toContain("Complete in the browser: Complete the browser challenge");
    expect(source).toContain("Confirm the result after this browser action");
    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({
        code: "native-agent-check-unavailable",
        actionId: "browser-custom",
      }),
    );
    expectGeneratedTypeScriptToCompile(source);
  });

  it("emits a one-shot Claude vision check when selected", () => {
    const result = compilePlaywright(approvedWorkflow(), {
      semanticFallback: "agent-check",
    });
    const source = textOutput(result, "workflow.ts");

    expect(source).toContain("async function agentCheck(page: Page");
    expect(source).toContain("https://api.anthropic.com/v1/messages");
    expect(source).toContain("REPLAY_AGENT_CHECK_MODEL");
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "agent-check-configuration-required",
    );
    expectGeneratedTypeScriptToCompile(source);
  });
});
