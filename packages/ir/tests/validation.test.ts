import { describe, expect, it } from "vitest";

import {
  WorkflowNotApprovedError,
  WorkflowValidationError,
  assertApprovedWorkflow,
  parseWorkflow,
  validateWorkflow,
  workflowSchema,
} from "../src/index.js";
import { validWorkflow } from "./fixture.js";

function mutate(workflow: unknown, change: (copy: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(workflow) as Record<string, unknown>;
  change(copy);
  return copy;
}

describe("workflow JSON Schema", () => {
  it("accepts a complete version-1 workflow", () => {
    expect(validateWorkflow(validWorkflow())).toEqual({
      ok: true,
      value: validWorkflow(),
    });
    expect(workflowSchema.$id).toContain("workflow-v1");
  });

  it("rejects unknown fields instead of silently discarding them", () => {
    const candidate = mutate(validWorkflow(), (copy) => {
      copy.unexpected = true;
    });
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "schema.additionalProperties" }),
        ]),
      );
    }
  });

  it("reports useful JSON-pointer paths for missing data", () => {
    const candidate = mutate(validWorkflow(), (copy) => {
      const metadata = copy.metadata as Record<string, unknown>;
      delete metadata.workflowId;
    });
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: "/metadata/workflowId", code: "schema.required" }),
      );
    }
  });
});

describe("workflow safety and consistency validation", () => {
  it("never permits a literal example for a secret", () => {
    const candidate = validWorkflow();
    candidate.parameters[1]!.example = "this must not reach disk";
    const result = validateWorkflow(candidate);

    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({
          path: "/parameters/1/example",
          code: "vault.literal-secret",
        }),
      ],
    });
  });

  it("never permits literal text in a secure typing action", () => {
    const candidate = validWorkflow();
    const action = candidate.steps[0]!.actions[1]!;
    if (action.type !== "type") throw new Error("fixture is wrong");
    action.value = "plaintext";
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "vault.secure-action-literal" }),
      );
    }
  });

  it("recognizes an AX secure field even if the secure flag was omitted", () => {
    const candidate = validWorkflow();
    const action = candidate.steps[0]!.actions[1]!;
    if (action.type !== "type") throw new Error("fixture is wrong");
    delete action.secure;
    action.value = "plaintext";
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "vault.secure-action-literal" }),
      );
    }
  });

  it("rejects a captured accessibility value from a secure target without echoing it", () => {
    const candidate = validWorkflow();
    const action = candidate.steps[0]!.actions[1]!;
    if (action.type !== "type" || action.target.accessibility === undefined) {
      throw new Error("fixture is wrong");
    }
    action.target.accessibility.value = "must-never-reach-disk";

    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({
        path: "/steps/0/actions/1/target/accessibility/value",
        code: "vault.secure-target-value",
      }));
      expect(JSON.stringify(result.issues)).not.toContain("must-never-reach-disk");
    }
  });

  it.each(["p", "7", "💣"])(
    "rejects a literal %s key aimed at a secure target without echoing it",
    (key) => {
      const candidate = validWorkflow();
      candidate.steps[0]!.actions.push({
        id: "password-character",
        type: "key",
        key,
        target: {
          description: "Password field",
          accessibility: { role: "AXSecureTextField", label: "Password" },
        },
      });

      const result = validateWorkflow(candidate);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues).toContainEqual(expect.objectContaining({
          path: "/steps/0/actions/2/key",
          code: "vault.secure-key-literal",
        }));
        expect(JSON.stringify(result.issues)).not.toContain(`\"${key}\"`);
      }
    },
  );

  it.each(["Tab", "Enter", "Backspace", "ArrowLeft"])(
    "allows the named control key %s on a secure target",
    (key) => {
      const candidate = validWorkflow();
      candidate.steps[0]!.actions.push({
        id: `password-${key}`,
        type: "key",
        key,
        target: {
          description: "Password field",
          accessibility: { role: "AXSecureTextField", label: "Password" },
        },
      });

      expect(validateWorkflow(candidate).ok).toBe(true);
    },
  );

  it("rejects references to missing or incorrectly classified parameters", () => {
    const unknown = validWorkflow();
    const firstAction = unknown.steps[0]!.actions[0]!;
    if (firstAction.type !== "navigate") throw new Error("fixture is wrong");
    firstAction.url = { param: "missing", vault: false };

    const wrongVault = validWorkflow();
    const secondAction = wrongVault.steps[0]!.actions[1]!;
    if (secondAction.type !== "type") throw new Error("fixture is wrong");
    secondAction.value = { param: "invoiceUrl", vault: true };

    const unknownResult = validateWorkflow(unknown);
    const wrongVaultResult = validateWorkflow(wrongVault);
    expect(unknownResult.ok).toBe(false);
    expect(wrongVaultResult.ok).toBe(false);
    if (!unknownResult.ok && !wrongVaultResult.ok) {
      expect(unknownResult.issues.map((issue) => issue.code)).toContain(
        "parameter.unknown-reference",
      );
      expect(wrongVaultResult.issues.map((issue) => issue.code)).toContain(
        "vault.non-secret-parameter",
      );
    }
  });

  it("requires recording links for recorded and narrated nodes", () => {
    const candidate = validWorkflow();
    candidate.steps[0]!.provenance.timestampRefs = [];
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "provenance.timestamp-required" }),
      );
    }
  });

  it("requires globally unique IDs, including nested branches", () => {
    const candidate = validWorkflow();
    const decision = candidate.steps[0]!.decisions![0]!;
    decision.then[0]!.id = "open-invoice";
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(expect.objectContaining({ code: "id.duplicate" }));
    }
  });

  it("rejects stale approvals after a workflow edit", () => {
    const candidate = validWorkflow();
    if (candidate.metadata.approval.status !== "approved") throw new Error("fixture is wrong");
    candidate.metadata.approval.approvedAt = "2026-08-16T18:20:00.000Z";
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "approval.stale" }),
      );
    }
  });

  it("rejects unsafe screenshot paths", () => {
    const candidate = validWorkflow();
    const action = candidate.steps[0]!.actions[1]!;
    if (action.type !== "type" || action.target.screenshotCrop === undefined) {
      throw new Error("fixture is wrong");
    }
    action.target.screenshotCrop.path = "../../secret.png";
    const result = validateWorkflow(candidate);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "asset.unsafe-path" }),
      );
    }
  });

  it("ties deterministic expectation checks to plain-language expectations", () => {
    const valid = validWorkflow();
    valid.steps[0]!.expectationChecks = [
      {
        expectation: "The invoice details are visible",
        kind: "visible",
        target: {
          description: "Invoice details",
          url: "http://127.0.0.1:4173/invoices/1001",
          dom: { selector: "[aria-label='Invoice details']" },
        },
      },
    ];
    expect(validateWorkflow(valid).ok).toBe(true);

    valid.steps[0]!.expectationChecks[0]!.expectation = "An invented expectation";
    const result = validateWorkflow(valid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({ code: "expectation.unknown-check" }),
      );
    }
  });
});

describe("parsing and approval guards", () => {
  it("throws one typed error with all validation issues", () => {
    expect(() => parseWorkflow({ version: 1 })).toThrow(WorkflowValidationError);
  });

  it("allows approved workflows and refuses drafts", () => {
    expect(() => assertApprovedWorkflow(validWorkflow())).not.toThrow();

    const draft = validWorkflow();
    draft.metadata.approval = { status: "draft" };
    expect(() => assertApprovedWorkflow(draft)).toThrow(WorkflowNotApprovedError);
  });
});
