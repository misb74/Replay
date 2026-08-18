import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compilePlaywright } from "../src/index.js";
import { approvedWorkflow } from "./fixture.js";
import { textOutput } from "./helpers.js";

const SHOULD_RUN = process.env.REPLAY_RUN_COMPILER_E2E === "1";
const PORT = 4_199;
const TEST_APP_URL = `http://127.0.0.1:${String(PORT)}`;
const PACKAGE_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
let server: ChildProcess | undefined;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (server !== undefined && server.exitCode !== null) {
      throw new Error("The invoice test app exited before startup.");
    }
    try {
      const response = await fetch(TEST_APP_URL);
      if (response.ok) return;
    } catch {
      // Vite has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the invoice test app.");
}

describe.runIf(SHOULD_RUN)("generated Playwright script", () => {
  beforeAll(async () => {
    server = spawn(
      process.execPath,
      [
        join(REPOSITORY_ROOT, "node_modules/vite/bin/vite.js"),
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
        "--strictPort",
      ],
      { cwd: join(REPOSITORY_ROOT, "test-app"), stdio: "ignore" },
    );
    await waitForServer();
  }, 10_000);

  afterAll(async () => {
    if (server === undefined || server.exitCode !== null) return;
    server.kill("SIGTERM");
    await Promise.race([
      once(server, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });

  it("runs the matching-invoice branch to its verified final state", () => {
    const workflow = approvedWorkflow();
    const root = workflow.steps[0]!;
    const decision = root.decisions![0]!;
    const approval = decision.then[0]!;
    if (approval.kind !== "step") throw new Error("fixture is wrong");

    root.expectationChecks = [
      {
        expectation: root.expects[0]!,
        kind: "visible",
        target: {
          description: "Invoice details",
          url: TEST_APP_URL,
          dom: { selector: "[aria-label='Invoice details']" },
        },
      },
    ];
    decision.deterministicCheck = {
      kind: "text-contains",
      target: {
        description: "Comparison result",
        url: TEST_APP_URL,
        dom: { testId: "comparison-result" },
      },
      expected: "Totals match",
    };
    approval.expectationChecks = [
      {
        expectation: approval.expects[0]!,
        kind: "text-equals",
        target: {
          description: "Review state",
          url: TEST_APP_URL,
          dom: { testId: "review-state" },
        },
        expected: "Approved",
      },
    ];

    const compiled = compilePlaywright(workflow, { headless: true });
    expect(compiled.warnings).toEqual([]);
    const temporaryDirectory = mkdtempSync(join(PACKAGE_DIRECTORY, ".generated-e2e-"));
    const sourcePath = join(temporaryDirectory, "workflow.ts");
    const outputDirectory = join(temporaryDirectory, "out");
    writeFileSync(sourcePath, textOutput(compiled, "workflow.ts"), "utf8");

    try {
      const compiler = spawnSync(
        process.execPath,
        [
          join(REPOSITORY_ROOT, "node_modules/typescript/lib/tsc.js"),
          "--ignoreConfig",
          "--target",
          "ES2023",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--strict",
          "--skipLibCheck",
          "--outDir",
          outputDirectory,
          sourcePath,
        ],
        { encoding: "utf8" },
      );
      expect(`${compiler.stdout}${compiler.stderr}`).toBe("");
      expect(compiler.status).toBe(0);

      const execution = spawnSync(
        process.execPath,
        [join(outputDirectory, "workflow.js"), "--invoiceUrl", `${TEST_APP_URL}/`],
        { encoding: "utf8", timeout: 20_000 },
      );
      expect(execution.error).toBeUndefined();
      expect(execution.status, `${execution.stdout}${execution.stderr}`).toBe(0);
      expect(readFileSync(join(outputDirectory, "workflow.js"), "utf8")).toContain(
        "comparison-result",
      );
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
