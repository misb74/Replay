import type { Workflow } from "@replay/ir";

import { compileComputerUse, computerUseCompiler } from "./computer-use.js";
import { compilePlaybook, playbookCompiler } from "./playbook.js";
import { compilePlaywright, playwrightCompiler } from "./playwright.js";
import type {
  CompileResult,
  ComputerUseCompilerOptions,
  PlaybookCompilerOptions,
  PlaywrightCompilerOptions,
} from "./types.js";

export * from "./computer-use.js";
export * from "./playbook.js";
export * from "./playwright.js";
export * from "./types.js";

export const compilers = {
  playbook: playbookCompiler,
  playwright: playwrightCompiler,
  "computer-use": computerUseCompiler,
} as const;

export function compileWorkflow(
  target: "playbook",
  workflow: Workflow,
  options?: PlaybookCompilerOptions,
): CompileResult;
export function compileWorkflow(
  target: "playwright",
  workflow: Workflow,
  options?: PlaywrightCompilerOptions,
): CompileResult;
export function compileWorkflow(
  target: "computer-use",
  workflow: Workflow,
  options?: ComputerUseCompilerOptions,
): CompileResult;
export function compileWorkflow(
  target: keyof typeof compilers,
  workflow: Workflow,
  options: PlaybookCompilerOptions | PlaywrightCompilerOptions | ComputerUseCompilerOptions = {},
): CompileResult {
  switch (target) {
    case "playbook":
      return compilePlaybook(workflow, options as PlaybookCompilerOptions);
    case "playwright":
      return compilePlaywright(workflow, options as PlaywrightCompilerOptions);
    case "computer-use":
      return compileComputerUse(workflow, options as ComputerUseCompilerOptions);
  }
}
