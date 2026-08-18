import type { BranchNode, DecisionNode, Workflow, WorkflowStep } from "@replay/ir";

import {
  describeAction,
  formatProvenance,
  prepareWorkflow,
  printableValue,
  quoteMarkdown,
  slugify,
  textFile,
} from "./common.js";
import type { Compiler, CompileResult, PlaybookCompilerOptions } from "./types.js";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function renderBranchNode(
  node: BranchNode,
  indent: string,
  provenance: string[],
  includeProvenance: boolean,
): string[] {
  if (node.kind === "ask_user") {
    const marker = addProvenance(node.id, node.provenance, provenance, includeProvenance);
    return [`${indent}- **Ask the user:** ${node.message}${marker}`];
  }
  if (node.kind === "stop_and_flag") {
    const marker = addProvenance(node.id, node.provenance, provenance, includeProvenance);
    return [`${indent}- **Stop and flag:** ${node.reason}${marker}`];
  }
  return renderStep(node, indent, provenance, includeProvenance);
}

function addProvenance(
  id: string,
  source: WorkflowStep["provenance"],
  provenance: string[],
  include: boolean,
): string {
  if (!include) return "";
  const footnote = `source-${String(provenance.length + 1)}`;
  provenance.push(`[^${footnote}]: \`${id}\` — ${formatProvenance(source)}`);
  return ` [^${footnote}]`;
}

function renderDecision(
  decision: DecisionNode,
  indent: string,
  provenance: string[],
  includeProvenance: boolean,
): string[] {
  const marker = addProvenance(
    decision.id,
    decision.provenance,
    provenance,
    includeProvenance,
  );
  const lines = [
    `${indent}- **Decision:** If ${decision.condition}${marker}`,
    `${indent}  - **Then:**`,
  ];
  decision.then.forEach((node) => {
    lines.push(...renderBranchNode(node, `${indent}    `, provenance, includeProvenance));
  });
  lines.push(`${indent}  - **Else:**`);
  decision.else.forEach((node) => {
    lines.push(...renderBranchNode(node, `${indent}    `, provenance, includeProvenance));
  });
  return lines;
}

function renderStep(
  step: WorkflowStep,
  indent: string,
  provenance: string[],
  includeProvenance: boolean,
): string[] {
  const marker = addProvenance(step.id, step.provenance, provenance, includeProvenance);
  const lines = [`${indent}- **${step.intent}**${marker}`];
  if (step.actions.length === 0) {
    lines.push(`${indent}  - No recorded action; use judgment to satisfy the intent.`);
  } else {
    step.actions.forEach((action) => {
      lines.push(`${indent}  - ${describeAction(action)}`);
    });
  }
  step.expects.forEach((expectation) => {
    lines.push(`${indent}  - **Check:** ${expectation}`);
  });
  step.decisions?.forEach((decision) => {
    lines.push(...renderDecision(decision, `${indent}  `, provenance, includeProvenance));
  });
  return lines;
}

export function compilePlaybook(
  candidate: Workflow,
  options: PlaybookCompilerOptions = {},
): CompileResult {
  const workflow = prepareWorkflow(candidate);
  const includeProvenance = options.includeProvenance ?? true;
  const provenance: string[] = [];
  const slug = slugify(options.outputName ?? workflow.name);
  const lines = [
    "---",
    `name: ${yamlString(slug)}`,
    `description: ${yamlString(workflow.goal)}`,
    "metadata:",
    `  replay-workflow-id: ${yamlString(workflow.metadata.workflowId)}`,
    `  replay-workflow-revision: ${String(workflow.metadata.revision)}`,
    "---",
    "",
    `# ${workflow.name}`,
    "",
    "## Goal",
    "",
    workflow.goal,
    "",
    "## Inputs",
    "",
    "| Name | Type | Required | Description | Recorded example |",
    "| --- | --- | --- | --- | --- |",
  ];

  if (workflow.parameters.length === 0) {
    lines.push("| _None_ | — | — | This workflow has no declared inputs. | — |");
  } else {
    workflow.parameters.forEach((parameter) => {
      lines.push(
        `| \`${quoteMarkdown(parameter.name)}\` | ${parameter.type} | ${parameter.required ? "yes" : "no"} | ${quoteMarkdown(parameter.description)} | ${quoteMarkdown(printableValue(parameter.example))} |`,
      );
    });
  }

  lines.push("", "## Steps", "");
  workflow.steps.forEach((step) => {
    lines.push(...renderStep(step, "", provenance, includeProvenance));
  });

  if (includeProvenance) {
    lines.push("", "## Provenance", "", ...provenance);
  }

  return {
    files: [
      textFile(options.outputName === undefined ? "SKILL.md" : `${slug}/SKILL.md`, "text/markdown", `${lines.join("\n")}\n`),
    ],
    warnings: [],
  };
}

export const playbookCompiler: Compiler<PlaybookCompilerOptions> = {
  target: "playbook",
  compile: compilePlaybook,
};
