import type {
  BranchNode,
  DecisionNode,
  DeterministicCondition,
  Workflow,
  WorkflowAction,
  WorkflowStep,
  WorkflowTarget,
  WorkflowValue,
} from "@replay/ir";

import {
  describeAction,
  isReference,
  prepareWorkflow,
  slugify,
  stableJson,
  textFile,
  warningReport,
} from "./common.js";
import type {
  Compiler,
  CompileResult,
  CompileWarning,
  PlaywrightCompilerOptions,
  ScriptFallback,
} from "./types.js";

interface ScriptContext {
  warnings: CompileWarning[];
  semanticFallback: ScriptFallback;
  nativeFallback: ScriptFallback;
  nativeAgentCheckRequested: boolean;
  usesAgentCheck: boolean;
  usesDeterministicWait: boolean;
}

const AX_TO_PLAYWRIGHT_ROLE: Readonly<Record<string, string>> = {
  AXButton: "button",
  AXCheckBox: "checkbox",
  AXComboBox: "combobox",
  AXHeading: "heading",
  AXLink: "link",
  AXPopUpButton: "combobox",
  AXRadioButton: "radio",
  AXSearchField: "searchbox",
  AXSecureTextField: "textbox",
  AXTextField: "textbox",
};

function js(value: string): string {
  return JSON.stringify(value);
}

function valueExpression(value: WorkflowValue): string {
  if (!isReference(value)) return js(String(value ?? ""));
  if (value.vault) {
    throw new Error("Vault values must be compiled as a secure checkpoint.");
  }
  return `getInput(${js(value.param)})`;
}

function isVaultValue(value: WorkflowValue): boolean {
  return isReference(value) && value.vault;
}

function isBrowserTarget(target: WorkflowTarget): boolean {
  return target.url !== undefined || target.dom !== undefined;
}

function locatorExpression(
  target: WorkflowTarget,
  context: ScriptContext,
  location: { stepId: string; actionId?: string; decisionId?: string },
): string {
  if (target.dom?.testId !== undefined) return `page.getByTestId(${js(target.dom.testId)})`;
  if (target.dom?.selector !== undefined) return `page.locator(${js(target.dom.selector)})`;

  const role = target.accessibility?.role;
  const label = target.accessibility?.label;
  const mappedRole = role === undefined ? undefined : AX_TO_PLAYWRIGHT_ROLE[role];
  if (mappedRole !== undefined && label !== undefined) {
    return `page.getByRole(${js(mappedRole)}, { name: ${js(label)}, exact: true })`;
  }
  if (mappedRole !== undefined) {
    context.warnings.push({
      code: "imprecise-browser-locator",
      message: `The browser target '${target.description}' has no accessible label; its role-only locator may match the wrong ${mappedRole}.`,
      ...location,
    });
    return `page.getByRole(${js(mappedRole)})`;
  }
  if (label !== undefined || target.dom?.text !== undefined) {
    const reason =
      role === undefined
        ? "has no usable AX role"
        : `uses unsupported AX role '${role}'`;
    context.warnings.push({
      code: "imprecise-browser-locator",
      message: `The browser target '${target.description}' ${reason}; generated code falls back to visible text.`,
      ...location,
    });
    return `page.getByText(${js(label ?? target.dom?.text ?? target.description)}, { exact: true })`;
  }

  const roleDetail = role === undefined ? "no usable AX role or label" : `unsupported AX role '${role}' and no label`;
  context.warnings.push({
    code: "imprecise-browser-locator",
    message: `The browser target '${target.description}' has ${roleDetail}; generated code falls back to its description as visible text.`,
    ...location,
  });
  return `page.getByText(${js(target.description)}, { exact: true })`;
}

function addSemanticCheck(
  lines: string[],
  indent: string,
  prompt: string,
  context: ScriptContext,
): void {
  if (context.semanticFallback === "agent-check") {
    context.usesAgentCheck = true;
    lines.push(
      `${indent}if (!(await agentCheck(page, ${js(prompt)}))) throw new Error(${js(`Check failed: ${prompt}`)});`,
    );
  } else {
    lines.push(`${indent}await humanVerify(${js(prompt)});`);
  }
}

function addNativeFallback(
  lines: string[],
  indent: string,
  action: WorkflowAction,
  step: WorkflowStep,
  context: ScriptContext,
): void {
  const instruction = describeAction(action);
  const pageObservableCustomAction =
    action.type === "custom" &&
    action.target !== undefined &&
    isBrowserTarget(action.target);
  context.warnings.push({
    code: action.type === "custom" ? "custom-action-degraded" : "native-action-degraded",
    message:
      context.nativeAgentCheckRequested && pageObservableCustomAction
        ? `Step '${step.intent}' cannot run deterministically in Playwright; it becomes a human handoff followed by an agent visual check of the browser page.`
        : `Step '${step.intent}' cannot run in Playwright; it becomes a human checkpoint.`,
    stepId: step.id,
    actionId: action.id,
  });

  if (context.nativeAgentCheckRequested && !pageObservableCustomAction) {
    context.warnings.push({
      code: "native-agent-check-unavailable",
      message:
        "A Playwright page screenshot cannot observe a native desktop app, so the requested native agent check was disabled and replaced with a human checkpoint.",
      stepId: step.id,
      actionId: action.id,
    });
  }

  lines.push(
    `${indent}await humanCheckpoint(${js(`${pageObservableCustomAction ? "Complete in" : "Complete outside"} the browser: ${instruction}`)});`,
  );
  if (context.nativeAgentCheckRequested && pageObservableCustomAction) {
    context.usesAgentCheck = true;
    lines.push(
      `${indent}if (!(await agentCheck(page, ${js(`Confirm the result after this browser action: ${instruction}`)}))) throw new Error(${js(`Agent check failed after browser action: ${instruction}`)});`,
    );
  }
}

function renderSecureAction(
  lines: string[],
  indent: string,
  action: WorkflowAction & { type: "type" | "select" | "navigate" },
  step: WorkflowStep,
  context: ScriptContext,
): void {
  const value = action.type === "navigate" ? action.url : action.value;
  if (!isReference(value) || !value.vault) return;

  context.warnings.push({
    code: "secure-input-checkpoint",
    message: `Vault value '${value.param}' is never embedded or read from command-line arguments; a human must enter it.`,
    stepId: step.id,
    actionId: action.id,
  });

  if (action.type !== "navigate" && isBrowserTarget(action.target)) {
    lines.push(
      `${indent}await ${locatorExpression(action.target, context, { stepId: step.id, actionId: action.id })}.click();`,
    );
  }
  lines.push(
    `${indent}await humanCheckpoint(${js(`Enter the protected value '${value.param}' now. Replay never reads or stores it.`)});`,
  );
}

function renderAction(
  action: WorkflowAction,
  step: WorkflowStep,
  indent: string,
  lines: string[],
  context: ScriptContext,
): void {
  if (
    (action.type === "type" && isVaultValue(action.value)) ||
    (action.type === "select" && isVaultValue(action.value)) ||
    (action.type === "navigate" && isVaultValue(action.url))
  ) {
    renderSecureAction(lines, indent, action, step, context);
    return;
  }

  switch (action.type) {
    case "navigate":
      lines.push(`${indent}await page.goto(${valueExpression(action.url)});`);
      return;
    case "click": {
      if (!isBrowserTarget(action.target)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      const locator = locatorExpression(action.target, context, {
        stepId: step.id,
        actionId: action.id,
      });
      const options = [
        action.button === undefined ? undefined : `button: ${js(action.button)}`,
        action.clickCount === undefined ? undefined : `clickCount: ${String(action.clickCount)}`,
      ].filter((part): part is string => part !== undefined);
      lines.push(
        `${indent}await ${locator}.click(${options.length === 0 ? "" : `{ ${options.join(", ")} }`});`,
      );
      return;
    }
    case "type": {
      if (!isBrowserTarget(action.target)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      const locator = locatorExpression(action.target, context, {
        stepId: step.id,
        actionId: action.id,
      });
      if (action.clearFirst === false) {
        lines.push(`${indent}await ${locator}.pressSequentially(${valueExpression(action.value)});`);
      } else {
        lines.push(`${indent}await ${locator}.fill(${valueExpression(action.value)});`);
      }
      return;
    }
    case "select": {
      if (!isBrowserTarget(action.target)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      lines.push(
        `${indent}await ${locatorExpression(action.target, context, { stepId: step.id, actionId: action.id })}.selectOption(${valueExpression(action.value)});`,
      );
      return;
    }
    case "scroll": {
      if (action.target !== undefined && !isBrowserTarget(action.target)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      if (action.target !== undefined) {
        lines.push(
          `${indent}await ${locatorExpression(action.target, context, { stepId: step.id, actionId: action.id })}.hover();`,
        );
      }
      const distance = action.distance ?? 600;
      const [x, y] =
        action.direction === "up"
          ? [0, -distance]
          : action.direction === "down"
            ? [0, distance]
            : action.direction === "left"
              ? [-distance, 0]
              : [distance, 0];
      lines.push(`${indent}await page.mouse.wheel(${String(x)}, ${String(y)});`);
      return;
    }
    case "drag": {
      if (!isBrowserTarget(action.from) || !isBrowserTarget(action.to)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      lines.push(
        `${indent}await ${locatorExpression(action.from, context, { stepId: step.id, actionId: action.id })}.dragTo(${locatorExpression(action.to, context, { stepId: step.id, actionId: action.id })});`,
      );
      return;
    }
    case "key": {
      if (action.target !== undefined && !isBrowserTarget(action.target)) {
        addNativeFallback(lines, indent, action, step, context);
        return;
      }
      lines.push(
        action.target === undefined
          ? `${indent}await page.keyboard.press(${js(action.key)});`
          : `${indent}await ${locatorExpression(action.target, context, { stepId: step.id, actionId: action.id })}.press(${js(action.key)});`,
      );
      return;
    }
    case "wait": {
      if (action.durationMs !== undefined) {
        lines.push(`${indent}await page.waitForTimeout(${String(action.durationMs)});`);
      }
      if (action.until !== undefined) {
        context.warnings.push({
          code: "semantic-expectation-degraded",
          message: `Wait condition '${action.until}' needs a ${context.semanticFallback}.`,
          stepId: step.id,
          actionId: action.id,
        });
        addSemanticCheck(lines, indent, `Wait until: ${action.until}`, context);
      }
      return;
    }
    case "custom":
      addNativeFallback(lines, indent, action, step, context);
  }
}

function renderDeterministicCondition(
  condition: DeterministicCondition,
  context: ScriptContext,
  location: { stepId: string; decisionId?: string },
): string | undefined {
  if (!isBrowserTarget(condition.target)) return undefined;
  const locator = locatorExpression(condition.target, context, location);
  const waitFor = (check: string): string => {
    context.usesDeterministicWait = true;
    return `await waitForCondition(page, async () => ${check})`;
  };
  switch (condition.kind) {
    case "visible":
      return waitFor(`await ${locator}.isVisible()`);
    case "hidden":
      return waitFor(`!(await ${locator}.isVisible())`);
    case "text-equals":
      if (condition.expected === undefined || isVaultValue(condition.expected)) return undefined;
      return waitFor(
        `(await ${locator}.textContent())?.trim() === ${valueExpression(condition.expected)}`,
      );
    case "text-contains":
      if (condition.expected === undefined || isVaultValue(condition.expected)) return undefined;
      return waitFor(
        `(await ${locator}.textContent())?.includes(${valueExpression(condition.expected)}) === true`,
      );
  }
}

function renderDecision(
  decision: DecisionNode,
  step: WorkflowStep,
  indent: string,
  lines: string[],
  context: ScriptContext,
): void {
  const deterministic =
    decision.deterministicCheck === undefined
      ? undefined
      : renderDeterministicCondition(decision.deterministicCheck, context, {
          stepId: step.id,
          decisionId: decision.id,
        });
  let expression: string;
  if (deterministic !== undefined) {
    expression = deterministic;
  } else {
    context.warnings.push({
      code: "semantic-condition-degraded",
      message: `Decision '${decision.condition}' has no browser-observable deterministic check; generated code uses a ${context.semanticFallback}.`,
      stepId: step.id,
      decisionId: decision.id,
    });
    if (context.semanticFallback === "agent-check") {
      context.usesAgentCheck = true;
      expression = `await agentCheck(page, ${js(decision.condition)})`;
    } else {
      expression = `await humanDecision(${js(decision.condition)})`;
    }
  }

  lines.push(`${indent}if (${expression}) {`);
  renderPath(decision.then, `${indent}  `, lines, context);
  lines.push(`${indent}} else {`);
  renderPath(decision.else, `${indent}  `, lines, context);
  lines.push(`${indent}}`);
}

function renderPath(
  path: BranchNode[],
  indent: string,
  lines: string[],
  context: ScriptContext,
): void {
  path.forEach((node) => {
    if (node.kind === "step") {
      renderStep(node, indent, lines, context);
    } else if (node.kind === "ask_user") {
      lines.push(`${indent}await humanCheckpoint(${js(node.message)});`);
    } else {
      lines.push(`${indent}stopAndFlag(${js(node.reason)});`);
    }
  });
}

function renderStep(
  step: WorkflowStep,
  indent: string,
  lines: string[],
  context: ScriptContext,
): void {
  lines.push(`${indent}console.log(${js(`Step: ${step.intent}`)});`);
  step.actions.forEach((action) => {
    renderAction(action, step, indent, lines, context);
  });
  step.expects.forEach((expectation) => {
    const check = step.expectationChecks?.find(
      (candidate) => candidate.expectation === expectation,
    );
    const deterministic =
      check === undefined
        ? undefined
        : renderDeterministicCondition(check, context, { stepId: step.id });
    if (deterministic === undefined) {
      context.warnings.push({
        code: "semantic-expectation-degraded",
        message: `Expectation '${expectation}' needs a ${context.semanticFallback}.`,
        stepId: step.id,
      });
      addSemanticCheck(lines, indent, `Verify: ${expectation}`, context);
    } else {
      lines.push(
        `${indent}if (!(${deterministic})) throw new Error(${js(`Check failed: ${expectation}`)});`,
      );
    }
  });
  step.decisions?.forEach((decision) => {
    renderDecision(decision, step, indent, lines, context);
  });
}

function humanHelpers(): string[] {
  return [
    "async function ask(prompt: string): Promise<string> {",
    "  const readline = createInterface({ input, output });",
    "  try {",
    "    return await readline.question(`${prompt} `);",
    "  } finally {",
    "    readline.close();",
    "  }",
    "}",
    "",
    "async function humanCheckpoint(instruction: string): Promise<void> {",
    "  console.warn(`CHECKPOINT: ${instruction}`);",
    "  await ask(\"Complete the instruction, then press Enter to continue.\");",
    "}",
    "",
    "async function humanDecision(condition: string): Promise<boolean> {",
    "  const answer = await ask(`DECISION: ${condition} [y/N]`);",
    "  return /^(y|yes)$/i.test(answer.trim());",
    "}",
    "",
    "async function humanVerify(expectation: string): Promise<void> {",
    "  if (!(await humanDecision(`${expectation} — is this true?`))) {",
    "    throw new Error(`Human check failed: ${expectation}`);",
    "  }",
    "}",
    "",
    "function stopAndFlag(reason: string): never {",
    "  throw new Error(`STOP_AND_FLAG: ${reason}`);",
    "}",
  ];
}

function agentHelper(): string[] {
  return [
    "",
    "interface AgentResponse {",
    "  content?: Array<{ type?: string; text?: string }>;",
    "}",
    "",
    "async function agentCheck(page: Page, condition: string): Promise<boolean> {",
    "  const apiKey = process.env.ANTHROPIC_API_KEY;",
    "  const model = process.env.REPLAY_AGENT_CHECK_MODEL;",
    "  if (!apiKey || !model) {",
    "    throw new Error(\"Agent checks require ANTHROPIC_API_KEY and REPLAY_AGENT_CHECK_MODEL.\");",
    "  }",
    "  const screenshot = (await page.screenshot({ type: \"png\" })).toString(\"base64\");",
    "  const response = await fetch(\"https://api.anthropic.com/v1/messages\", {",
    "    method: \"POST\",",
    "    headers: {",
    "      \"content-type\": \"application/json\",",
    "      \"x-api-key\": apiKey,",
    "      \"anthropic-version\": \"2023-06-01\",",
    "    },",
    "    body: JSON.stringify({",
    "      model,",
    "      max_tokens: 8,",
    "      messages: [{ role: \"user\", content: [",
    "        { type: \"image\", source: { type: \"base64\", media_type: \"image/png\", data: screenshot } },",
    "        { type: \"text\", text: `Look at the screenshot and answer only YES or NO: ${condition}` },",
    "      ] }],",
    "    }),",
    "  });",
    "  if (!response.ok) throw new Error(`Agent check failed with HTTP ${response.status}.`);",
    "  const payload = (await response.json()) as AgentResponse;",
    "  const answer = payload.content?.find((block) => block.type === \"text\")?.text?.trim() ?? \"\";",
    "  if (/^yes\\b/i.test(answer)) return true;",
    "  if (/^no\\b/i.test(answer)) return false;",
    "  throw new Error(`Agent check returned an ambiguous answer: ${answer}`);",
    "}",
  ];
}

function deterministicWaitHelper(): string[] {
  return [
    "",
    "async function waitForCondition(",
    "  page: Page,",
    "  check: () => Promise<boolean>,",
    "  timeoutMs = 5_000,",
    "  intervalMs = 100,",
    "): Promise<boolean> {",
    "  const deadline = Date.now() + timeoutMs;",
    "  while (Date.now() <= deadline) {",
    "    try {",
    "      if (await check()) return true;",
    "    } catch {",
    "      // The page may still be settling; retry until the deadline.",
    "    }",
    "    const remainingMs = deadline - Date.now();",
    "    if (remainingMs <= 0) break;",
    "    await page.waitForTimeout(Math.min(intervalMs, remainingMs));",
    "  }",
    "  return false;",
    "}",
  ];
}

function preamble(workflow: Workflow): string[] {
  const requiredParameters = workflow.parameters
    .filter((parameter) => parameter.required && parameter.type !== "secret")
    .map((parameter) => parameter.name);
  return [
    "// Generated by Replay. Review compile-report.json before running.",
    'import { chromium, type Page } from "playwright";',
    'import { createInterface } from "node:readline/promises";',
    'import { stdin as input, stdout as output } from "node:process";',
    "",
    "function parseArgs(argv: string[]): Map<string, string> {",
    "  const parsed = new Map<string, string>();",
    "  for (let index = 0; index < argv.length; index += 1) {",
    "    const token = argv[index];",
    "    if (!token?.startsWith(\"--\")) continue;",
    "    const equals = token.indexOf(\"=\");",
    "    if (equals >= 0) parsed.set(token.slice(2, equals), token.slice(equals + 1));",
    "    else {",
    "      const next = argv[index + 1];",
    "      if (next === undefined || next.startsWith(\"--\")) throw new Error(`Missing value for ${token}`);",
    "      parsed.set(token.slice(2), next);",
    "      index += 1;",
    "    }",
    "  }",
    "  return parsed;",
    "}",
    "",
    "const args = parseArgs(process.argv.slice(2));",
    "function getInput(name: string): string {",
    "  const value = args.get(name);",
    "  if (value === undefined) throw new Error(`Missing required input --${name}`);",
    "  return value;",
    "}",
    ...(requiredParameters.length === 0
      ? []
      : ["", `// Required CLI inputs: ${requiredParameters.map((name) => `--${name}`).join(", ")}`]),
    "",
    ...humanHelpers(),
  ];
}

export function compilePlaywright(
  candidate: Workflow,
  options: PlaywrightCompilerOptions = {},
): CompileResult {
  const workflow = prepareWorkflow(candidate);
  const requestedNativeFallback = options.nativeFallback ?? "human-checkpoint";
  const context: ScriptContext = {
    warnings: [],
    semanticFallback: options.semanticFallback ?? "human-checkpoint",
    nativeFallback: "human-checkpoint",
    nativeAgentCheckRequested: requestedNativeFallback === "agent-check",
    usesAgentCheck: false,
    usesDeterministicWait: false,
  };
  const body: string[] = ["async function runWorkflow(page: Page): Promise<void> {"];
  workflow.steps.forEach((step) => {
    renderStep(step, "  ", body, context);
  });
  body.push("}");

  if (context.usesAgentCheck) {
    context.warnings.push({
      code: "agent-check-configuration-required",
      message:
        "Generated agent checks call Claude once per check and require ANTHROPIC_API_KEY plus REPLAY_AGENT_CHECK_MODEL.",
    });
  }

  const script = [
    ...preamble(workflow),
    ...(context.usesAgentCheck ? agentHelper() : []),
    ...(context.usesDeterministicWait ? deterministicWaitHelper() : []),
    "",
    ...body,
    "",
    `const browser = await chromium.launch({ headless: ${String(options.headless ?? false)} });`,
    "try {",
    "  const page = await browser.newPage();",
    "  await runWorkflow(page);",
    "} finally {",
    "  await browser.close();",
    "}",
    "",
  ].join("\n");

  const report = warningReport(workflow, "playwright", context.warnings, {
    semantic: context.semanticFallback,
    native: context.nativeFallback,
  });
  const outputPath =
    options.outputName === undefined ? "workflow.ts" : `${slugify(options.outputName)}.ts`;

  return {
    files: [
      textFile(outputPath, "text/typescript", script),
      textFile("compile-report.json", "application/json", stableJson(report)),
    ],
    warnings: context.warnings,
  };
}

export const playwrightCompiler: Compiler<PlaywrightCompilerOptions> = {
  target: "playwright",
  compile: compilePlaywright,
};
