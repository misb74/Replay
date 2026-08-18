import { Ajv, type ErrorObject } from "ajv";

import { workflowSchema } from "./schema.js";
import type {
  BranchNode,
  DecisionNode,
  InputReference,
  Provenance,
  Workflow,
  WorkflowAction,
  WorkflowStep,
  WorkflowTarget,
  WorkflowValue,
} from "./types.js";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export class WorkflowValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(
      `Workflow validation failed with ${String(issues.length)} issue${issues.length === 1 ? "" : "s"}.`,
    );
    this.name = "WorkflowValidationError";
    this.issues = issues;
  }
}

export class WorkflowNotApprovedError extends Error {
  constructor() {
    super("Only an approved workflow can be compiled or run.");
    this.name = "WorkflowNotApprovedError";
  }
}

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaValidator = ajv.compile<Workflow>(workflowSchema);

function schemaIssue(error: ErrorObject): ValidationIssue {
  const missingProperty =
    error.keyword === "required" && typeof error.params.missingProperty === "string"
      ? `/${escapeJsonPointer(error.params.missingProperty)}`
      : "";

  return {
    path: `${error.instancePath}${missingProperty}` || "/",
    code: `schema.${error.keyword}`,
    message: error.message ?? "does not match the workflow schema",
  };
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecureTarget(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.accessibility)) return false;
  return value.accessibility.role === "AXSecureTextField";
}

function isLiteralCharacterKey(value: string): boolean {
  return Array.from(value).length === 1;
}

/**
 * Detect secret-bearing shapes before schema validation. This keeps the
 * security error precise and guarantees validation errors never echo the
 * captured character or field value.
 */
function sensitivePersistenceIssues(candidate: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}/${String(index)}`));
      return;
    }
    if (!isRecord(value)) return;

    if (isRecord(value.accessibility)) {
      const accessibility = value.accessibility;
      if (
        accessibility.role === "AXSecureTextField"
        && Object.hasOwn(accessibility, "value")
      ) {
        issues.push({
          path: `${path}/accessibility/value`,
          code: "vault.secure-target-value",
          message: "secure targets cannot persist an accessibility value",
        });
      }
    }

    if (
      value.type === "key"
      && typeof value.key === "string"
      && isLiteralCharacterKey(value.key)
      && isSecureTarget(value.target)
    ) {
      issues.push({
        path: `${path}/key`,
        code: "vault.secure-key-literal",
        message: "literal character keys cannot be persisted for a secure target",
      });
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}/${escapeJsonPointer(key)}`);
    }
  };

  visit(candidate, "");
  return issues;
}

function isInputReference(value: WorkflowValue): value is InputReference {
  return typeof value === "object" && value !== null && "param" in value;
}

function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function addProvenanceIssues(
  provenance: Provenance,
  path: string,
  issues: ValidationIssue[],
): void {
  if (provenance.source !== "user-added-in-review" && provenance.timestampRefs.length === 0) {
    issues.push({
      path: `${path}/timestampRefs`,
      code: "provenance.timestamp-required",
      message: `${provenance.source} content must link to at least one recording timestamp`,
    });
  }

  provenance.timestampRefs.forEach((reference, index) => {
    if (reference.endMs !== undefined && reference.endMs < reference.startMs) {
      issues.push({
        path: `${path}/timestampRefs/${String(index)}/endMs`,
        code: "provenance.invalid-range",
        message: "endMs must be greater than or equal to startMs",
      });
    }
  });
}

function addTargetIssues(target: WorkflowTarget, path: string, issues: ValidationIssue[]): void {
  const cropPath = target.screenshotCrop?.path;
  if (
    cropPath !== undefined &&
    (cropPath.startsWith("/") || cropPath.split(/[\\/]/u).includes(".."))
  ) {
    issues.push({
      path: `${path}/screenshotCrop/path`,
      code: "asset.unsafe-path",
      message: "screenshot crop paths must be relative and cannot traverse parent folders",
    });
  }
}

function targetsForAction(action: WorkflowAction): Array<[WorkflowTarget, string]> {
  switch (action.type) {
    case "click":
    case "type":
    case "select":
      return [[action.target, "target"]];
    case "scroll":
    case "key":
    case "custom":
      return action.target === undefined ? [] : [[action.target, "target"]];
    case "drag":
      return [
        [action.from, "from"],
        [action.to, "to"],
      ];
    case "navigate":
    case "wait":
      return [];
  }
}

function valuesForAction(action: WorkflowAction): Array<[WorkflowValue, string]> {
  switch (action.type) {
    case "type":
    case "select":
      return [[action.value, "value"]];
    case "navigate":
      return [[action.url, "url"]];
    default:
      return [];
  }
}

function addSemanticIssues(workflow: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parameters = new Map(workflow.parameters.map((parameter) => [parameter.name, parameter]));

  if (parameters.size !== workflow.parameters.length) {
    const seen = new Set<string>();
    workflow.parameters.forEach((parameter, index) => {
      if (seen.has(parameter.name)) {
        issues.push({
          path: `/parameters/${String(index)}/name`,
          code: "parameter.duplicate",
          message: `parameter '${parameter.name}' is declared more than once`,
        });
      }
      seen.add(parameter.name);
    });
  }

  const validateReference = (value: WorkflowValue, path: string): void => {
    if (!isInputReference(value)) return;
    const parameter = parameters.get(value.param);
    if (parameter === undefined) {
      issues.push({
        path,
        code: "parameter.unknown-reference",
        message: `references undeclared parameter '${value.param}'`,
      });
      return;
    }
    if (value.vault && parameter.type !== "secret") {
      issues.push({
        path,
        code: "vault.non-secret-parameter",
        message: `vault reference '${value.param}' must point to a secret parameter`,
      });
    }
    if (!value.vault && parameter.type === "secret") {
      issues.push({
        path,
        code: "vault.required",
        message: `secret parameter '${value.param}' must be referenced through the vault`,
      });
    }
  };

  workflow.parameters.forEach((parameter, index) => {
    const path = `/parameters/${String(index)}/example`;
    if (parameter.type === "secret") {
      if (!isInputReference(parameter.example) || !parameter.example.vault) {
        issues.push({
          path,
          code: "vault.literal-secret",
          message: "secret parameter examples must be vault references, never literal values",
        });
      } else if (parameter.example.param !== parameter.name) {
        issues.push({
          path,
          code: "vault.mismatched-example",
          message: "a secret parameter example must refer to its own vault entry",
        });
      }
    } else if (isInputReference(parameter.example) && parameter.example.vault) {
      issues.push({
        path,
        code: "vault.non-secret-example",
        message: "only secret parameters may use vault-backed examples",
      });
    }
  });

  const ids = new Map<string, string>();
  const addId = (id: string, path: string): void => {
    const firstPath = ids.get(id);
    if (firstPath !== undefined) {
      issues.push({
        path,
        code: "id.duplicate",
        message: `id '${id}' is already used at ${firstPath}`,
      });
    } else {
      ids.set(id, path);
    }
  };

  const visitBranchNode = (node: BranchNode, path: string): void => {
    if (node.kind === "step") {
      visitStep(node, path);
      return;
    }
    addId(node.id, `${path}/id`);
    addProvenanceIssues(node.provenance, `${path}/provenance`, issues);
  };

  const visitDecision = (decision: DecisionNode, path: string): void => {
    addId(decision.id, `${path}/id`);
    addProvenanceIssues(decision.provenance, `${path}/provenance`, issues);
    if (decision.confidence === "low" && decision.confidenceRationale === undefined) {
      issues.push({
        path: `${path}/confidenceRationale`,
        code: "decision.low-confidence-rationale-required",
        message: "low-confidence decisions must explain what needs confirmation",
      });
    }
    if (decision.deterministicCheck !== undefined) {
      addTargetIssues(
        decision.deterministicCheck.target,
        `${path}/deterministicCheck/target`,
        issues,
      );
      if (decision.deterministicCheck.expected !== undefined) {
        validateReference(
          decision.deterministicCheck.expected,
          `${path}/deterministicCheck/expected`,
        );
      }
    }
    decision.then.forEach((node, index) => {
      visitBranchNode(node, `${path}/then/${String(index)}`);
    });
    decision.else.forEach((node, index) => {
      visitBranchNode(node, `${path}/else/${String(index)}`);
    });
  };

  const visitStep = (step: WorkflowStep, path: string): void => {
    addId(step.id, `${path}/id`);
    addProvenanceIssues(step.provenance, `${path}/provenance`, issues);
    step.actions.forEach((action, actionIndex) => {
      const actionPath = `${path}/actions/${String(actionIndex)}`;
      addId(action.id, `${actionPath}/id`);
      targetsForAction(action).forEach(([target, key]) => {
        addTargetIssues(target, `${actionPath}/${key}`, issues);
      });
      valuesForAction(action).forEach(([value, key]) => {
        validateReference(value, `${actionPath}/${key}`);
      });
      if (
        action.type === "type" &&
        (action.secure === true ||
          action.target.accessibility?.role === "AXSecureTextField") &&
        (!isInputReference(action.value) || !action.value.vault)
      ) {
        issues.push({
          path: `${actionPath}/value`,
          code: "vault.secure-action-literal",
          message: "secure typing actions must contain a vault reference",
        });
      }
    });
    const checkedExpectations = new Set<string>();
    step.expectationChecks?.forEach((check, checkIndex) => {
      const checkPath = `${path}/expectationChecks/${String(checkIndex)}`;
      if (!step.expects.includes(check.expectation)) {
        issues.push({
          path: `${checkPath}/expectation`,
          code: "expectation.unknown-check",
          message: "expectation checks must name one of the step's expects entries",
        });
      }
      if (checkedExpectations.has(check.expectation)) {
        issues.push({
          path: `${checkPath}/expectation`,
          code: "expectation.duplicate-check",
          message: "an expects entry can have at most one deterministic check",
        });
      }
      checkedExpectations.add(check.expectation);
      addTargetIssues(check.target, `${checkPath}/target`, issues);
      if (check.expected !== undefined) {
        validateReference(check.expected, `${checkPath}/expected`);
      }
    });
    step.decisions?.forEach((decision, decisionIndex) => {
      visitDecision(decision, `${path}/decisions/${String(decisionIndex)}`);
    });
  };

  workflow.steps.forEach((step, index) => {
    visitStep(step, `/steps/${String(index)}`);
  });

  const { metadata } = workflow;
  if (!isIsoDate(metadata.createdAt)) {
    issues.push({
      path: "/metadata/createdAt",
      code: "metadata.invalid-date",
      message: "createdAt must be an ISO-8601 UTC timestamp",
    });
  }
  if (!isIsoDate(metadata.updatedAt)) {
    issues.push({
      path: "/metadata/updatedAt",
      code: "metadata.invalid-date",
      message: "updatedAt must be an ISO-8601 UTC timestamp",
    });
  }
  if (Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) {
    issues.push({
      path: "/metadata/updatedAt",
      code: "metadata.invalid-order",
      message: "updatedAt cannot be earlier than createdAt",
    });
  }
  if (
    metadata.previousRevision !== undefined &&
    metadata.previousRevision >= metadata.revision
  ) {
    issues.push({
      path: "/metadata/previousRevision",
      code: "metadata.invalid-previous-revision",
      message: "previousRevision must be lower than revision",
    });
  }
  if (metadata.approval.status === "approved") {
    if (!isIsoDate(metadata.approval.approvedAt)) {
      issues.push({
        path: "/metadata/approval/approvedAt",
        code: "metadata.invalid-date",
        message: "approvedAt must be an ISO-8601 UTC timestamp",
      });
    }
    if (Date.parse(metadata.approval.approvedAt) < Date.parse(metadata.updatedAt)) {
      issues.push({
        path: "/metadata/approval/approvedAt",
        code: "approval.stale",
        message: "approval cannot predate the latest workflow edit",
      });
    }
  }

  return issues;
}

export function validateWorkflow(candidate: unknown): ValidationResult<Workflow> {
  const securityIssues = sensitivePersistenceIssues(candidate);
  if (!schemaValidator(candidate)) {
    return {
      ok: false,
      issues: [
        ...securityIssues,
        ...(schemaValidator.errors ?? []).map(schemaIssue),
      ],
    };
  }

  const semanticIssues = [...securityIssues, ...addSemanticIssues(candidate)];
  return semanticIssues.length === 0
    ? { ok: true, value: candidate }
    : { ok: false, issues: semanticIssues };
}

export function parseWorkflow(candidate: unknown): Workflow {
  const result = validateWorkflow(candidate);
  if (!result.ok) throw new WorkflowValidationError(result.issues);
  return result.value;
}

export function isApprovedWorkflow(
  workflow: Workflow,
): workflow is Workflow & { metadata: { approval: { status: "approved" } } } {
  return workflow.metadata.approval.status === "approved";
}

export function assertApprovedWorkflow(workflow: Workflow): void {
  if (!isApprovedWorkflow(workflow)) throw new WorkflowNotApprovedError();
}
