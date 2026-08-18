import type {
  BranchNode,
  DecisionNode,
  Workflow,
  WorkflowAction,
  WorkflowStep,
  WorkflowTarget,
} from "@replay/ir";

import { prepareWorkflow, slugify, stableJson, textFile } from "./common.js";
import type {
  CompileResult,
  CompileWarning,
  Compiler,
  ComputerUseCompilerOptions,
  ComputerUseRunPolicy,
  GeneratedBinaryFile,
} from "./types.js";

function mediaTypeFor(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

function bundledAssetPath(sourcePath: string): string {
  // Encoding the full normalized path avoids basename and separator collisions.
  const safe = encodeURIComponent(sourcePath.replaceAll("\\", "/"));
  return `assets/${safe || "screenshot.png"}`;
}

function targetsForAction(action: WorkflowAction): WorkflowTarget[] {
  switch (action.type) {
    case "click":
    case "type":
    case "select":
      return [action.target];
    case "scroll":
    case "key":
    case "custom":
      return action.target === undefined ? [] : [action.target];
    case "drag":
      return [action.from, action.to];
    case "navigate":
    case "wait":
      return [];
  }
}

function visitWorkflow(
  workflow: Workflow,
  visitors: {
    target?: (target: WorkflowTarget) => void;
    branchNode?: (node: BranchNode) => void;
    decision?: (decision: DecisionNode) => void;
  },
): void {
  const visitStep = (step: WorkflowStep): void => {
    step.actions.forEach((action) => {
      targetsForAction(action).forEach((target) => visitors.target?.(target));
    });
    step.expectationChecks?.forEach((check) => visitors.target?.(check.target));
    step.decisions?.forEach((decision) => {
      visitors.decision?.(decision);
      if (decision.deterministicCheck !== undefined) {
        visitors.target?.(decision.deterministicCheck.target);
      }
      [...decision.then, ...decision.else].forEach((node) => {
        visitors.branchNode?.(node);
        if (node.kind === "step") visitStep(node);
      });
    });
  };
  workflow.steps.forEach(visitStep);
}

function runPolicy(
  workflow: Workflow,
  options: ComputerUseCompilerOptions,
  warnings: CompileWarning[],
): ComputerUseRunPolicy {
  const maxRetriesPerStep = options.policy?.maxRetriesPerStep ?? 1;
  if (!Number.isInteger(maxRetriesPerStep) || maxRetriesPerStep < 0) {
    throw new RangeError("maxRetriesPerStep must be a non-negative integer.");
  }

  const askUserNodeIds: string[] = [];
  const stopAndFlagNodeIds: string[] = [];
  visitWorkflow(workflow, {
    branchNode(node) {
      if (node.kind === "ask_user") askUserNodeIds.push(node.id);
      if (node.kind === "stop_and_flag") stopAndFlagNodeIds.push(node.id);
    },
  });

  if (options.policy?.firstRunRequiresTest === false) {
    warnings.push({
      code: "first-test-run-enforced",
      message:
        "The first supervised test run is a mandatory safety requirement and cannot be disabled; the requested override was ignored.",
    });
  }

  return {
    maxRetriesPerStep,
    firstRunRequiresTest: true,
    secureFields: "human-only",
    onExpectationFailure: maxRetriesPerStep === 0 ? "pause" : "retry-then-pause",
    askUserNodeIds,
    stopAndFlagNodeIds,
    allowedModes: ["test", "supervised", "autonomous"],
  };
}

function systemPrompt(workflow: Workflow, policy: ComputerUseRunPolicy): string {
  return `# Replay computer-use task

You are running **${workflow.name}**. Your goal is: ${workflow.goal}

The approved workflow in \`workflow.json\` is your leash. Walk it in order. Do not add, skip, reorder, or improvise actions unless the workflow explicitly asks the user for judgment.

For every step:

1. Read the step intent and perform only its listed actions.
2. Prefer accessibility identity. If it has drifted, re-ground from the semantic target description and bundled screenshot crop.
3. Take a fresh screenshot and verify every \`expects\` statement before continuing.
4. If verification fails, re-ground and retry at most ${String(policy.maxRetriesPerStep)} time${policy.maxRetriesPerStep === 1 ? "" : "s"}. Then pause with the screenshot and step context. Never improvise past a failed expectation.

At each decision, judge the written, screen-observable condition against a fresh screenshot. Follow exactly one of its \`then\` or \`else\` paths. An \`ask_user\` node pauses for the user's answer. A \`stop_and_flag\` node ends the run and records its reason.

Values shaped like \`{ "param": "name", "vault": true }\` are not secrets. They are instructions to pause and let the user type the protected value. Never request, read, log, paste, screenshot, or persist that value.

The first run must use test mode: pause before every step and offer approve, skip, or abort. Supervised mode pauses at decisions and failed expectations. Autonomous mode is allowed only after a clean test run. User mouse movement, the global hotkey, or the menu-bar stop command pauses or ends execution immediately.
`;
}

export function compileComputerUse(
  candidate: Workflow,
  options: ComputerUseCompilerOptions = {},
): CompileResult {
  const workflow = structuredClone(prepareWorkflow(candidate));
  const warnings: CompileWarning[] = [];
  const policy = runPolicy(workflow, options, warnings);
  const assetFiles: GeneratedBinaryFile[] = [];
  const bundled = new Map<string, string>();
  const root = slugify(options.outputName ?? workflow.name);

  visitWorkflow(workflow, {
    target(target) {
      const screenshot = target.screenshotCrop;
      if (screenshot === undefined) return;
      const sourcePath = screenshot.path;
      const existing = bundled.get(sourcePath);
      if (existing !== undefined) {
        screenshot.path = existing;
        return;
      }

      const destination = bundledAssetPath(sourcePath);
      const content = options.assets?.[sourcePath] ?? options.resolveAsset?.(sourcePath);
      if (content === undefined) {
        warnings.push({
          code: "missing-screenshot-asset",
          message: `Screenshot crop '${sourcePath}' was referenced by the workflow but was not provided to the compiler.`,
          assetPath: sourcePath,
        });
        return;
      }

      bundled.set(sourcePath, destination);
      screenshot.path = destination;
      assetFiles.push({
        path: `${root}/${destination}`,
        mediaType: mediaTypeFor(sourcePath),
        content: new Uint8Array(content),
      });
    },
  });

  const manifest = {
    formatVersion: 1,
    target: "computer-use",
    workflowId: workflow.metadata.workflowId,
    workflowRevision: workflow.metadata.revision,
    entrypoints: {
      prompt: "system-prompt.md",
      workflow: "workflow.json",
      policy: "run-policy.json",
    },
    assets: assetFiles.map((file) => file.path.slice(root.length + 1)),
  };

  return {
    files: [
      textFile(`${root}/system-prompt.md`, "text/markdown", systemPrompt(workflow, policy)),
      textFile(`${root}/workflow.json`, "application/json", stableJson(workflow)),
      textFile(`${root}/run-policy.json`, "application/json", stableJson(policy)),
      textFile(`${root}/manifest.json`, "application/json", stableJson(manifest)),
      ...assetFiles,
    ],
    warnings,
  };
}

export const computerUseCompiler: Compiler<ComputerUseCompilerOptions> = {
  target: "computer-use",
  compile: compileComputerUse,
};
