import { describe, expect, it } from "vitest";

import { WorkflowNotApprovedError } from "@replay/ir";

import { compilePlaybook } from "../src/index.js";
import { approvedWorkflow } from "./fixture.js";
import { golden, textOutput } from "./helpers.js";

describe("playbook compiler", () => {
  it("matches the reviewed golden skill", () => {
    const result = compilePlaybook(approvedWorkflow());

    expect(result.warnings).toEqual([]);
    expect(textOutput(result, "SKILL.md")).toBe(golden("invoice.SKILL.md"));
  });

  it("can omit provenance for a concise human SOP", () => {
    const markdown = textOutput(
      compilePlaybook(approvedWorkflow(), { includeProvenance: false }),
      "SKILL.md",
    );

    expect(markdown).not.toContain("## Provenance");
    expect(markdown).not.toContain("[^source-");
  });

  it("does not reveal vault content", () => {
    const workflow = approvedWorkflow();
    workflow.parameters.push({
      name: "password",
      type: "secret",
      description: "Invoice password",
      required: true,
      example: { param: "password", vault: true },
    });

    const markdown = textOutput(compilePlaybook(workflow), "SKILL.md");
    expect(markdown).toContain("<vault:password>");
  });

  it("refuses to compile an unapproved workflow", () => {
    const workflow = approvedWorkflow();
    workflow.metadata.approval = { status: "draft" };

    expect(() => compilePlaybook(workflow)).toThrow(WorkflowNotApprovedError);
  });
});
