import type {
  BranchNode,
  DecisionNode,
  Workflow,
  WorkflowAction,
  WorkflowParameter,
  WorkflowStep,
  WorkflowStringValue,
  WorkflowTarget,
  WorkflowValue,
} from "@replay/ir";
import type {
  ActionView,
  BranchPathView,
  DecisionView,
  ParameterView,
  StepView,
  WorkflowView,
} from "../shared/contracts.js";

export function workflowToView(workflow: Workflow, sessionId?: string): WorkflowView {
  const approval = workflow.metadata.approval;
  const firstSessionId = sessionId ?? findSessionId(workflow) ?? "unknown-session";
  return {
    id: workflow.metadata.workflowId,
    sessionId: firstSessionId,
    name: workflow.name,
    goal: workflow.goal,
    schemaVersion: `${workflow.version}.0.0`,
    revision: workflow.metadata.revision,
    status: approval.status,
    ...(approval.status === "approved" ? { approvedAt: approval.approvedAt } : {}),
    parameters: workflow.parameters.map(parameterToView),
    steps: workflow.steps.map(stepToView),
  };
}

export function applyViewEdits(current: Workflow, view: WorkflowView, at: Date): Workflow {
  if (current.metadata.workflowId !== view.id) throw new Error("The workflow view does not match the stored workflow");
  const indexes = indexWorkflow(current);
  const parameterPlan = buildParameterPlan(current.parameters, view.parameters);
  const editedSteps = view.steps.map((stepView) => buildEditedStep(stepView, view.sessionId, indexes, parameterPlan));
  if (editedSteps.length === 0) throw new Error("A workflow needs at least one step");
  const nextRevision = current.metadata.revision + 1;
  const updatedAt = at.toISOString();
  return {
    ...current,
    name: view.name.trim(),
    goal: view.goal.trim(),
    parameters: parameterPlan.parameters,
    steps: editedSteps,
    metadata: {
      ...current.metadata,
      revision: nextRevision,
      previousRevision: current.metadata.revision,
      updatedAt,
      approval: { status: "draft" },
    },
  };
}

interface WorkflowIndexes {
  steps: Map<string, WorkflowStep>;
  actions: Map<string, WorkflowAction>;
  decisions: Map<string, DecisionNode>;
}

interface ParameterPlan {
  parameters: WorkflowParameter[];
  byViewName: Map<string, WorkflowParameter>;
  replacementByOriginalName: Map<string, WorkflowParameter | undefined>;
  originalByName: Map<string, WorkflowParameter>;
  viewByName: Map<string, ParameterView>;
}

function indexWorkflow(workflow: Workflow): WorkflowIndexes {
  const indexes: WorkflowIndexes = { steps: new Map(), actions: new Map(), decisions: new Map() };
  const visit = (nodes: BranchNode[]) => {
    for (const node of nodes) {
      if (node.kind !== "step") continue;
      indexes.steps.set(node.id, node);
      node.actions.forEach((action) => indexes.actions.set(action.id, action));
      for (const decision of node.decisions ?? []) {
        indexes.decisions.set(decision.id, decision);
        visit(decision.then);
        visit(decision.else);
      }
    }
  };
  visit(workflow.steps);
  return indexes;
}

function buildParameterPlan(originals: WorkflowParameter[], views: ParameterView[]): ParameterPlan {
  const originalByName = new Map(originals.map((parameter) => [parameter.name, parameter]));
  const replacementByOriginalName = new Map<string, WorkflowParameter | undefined>();
  const byViewName = new Map<string, WorkflowParameter>();
  const viewByName = new Map<string, ParameterView>();
  const parameters: WorkflowParameter[] = [];
  for (const view of views) {
    const original = originalByName.get(view.id);
    if (!view.confirmed) {
      if (original?.type === "secret") throw new Error("Secure inputs cannot be removed; they must remain operator-provided vault references");
      if (original) replacementByOriginalName.set(original.name, undefined);
      continue;
    }
    const name = view.name.trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/u.test(name)) throw new Error(`Input name ${JSON.stringify(name)} must start with a letter and use only letters, numbers, underscores, or dashes`);
    if (byViewName.has(name)) throw new Error(`Input name ${JSON.stringify(name)} is used more than once`);
    const type = original?.type ?? view.type;
    const parameter: WorkflowParameter = {
      name,
      type,
      description: view.description.trim() || `Value supplied for ${name}`,
      required: original?.required ?? true,
      example: type === "secret"
        ? { param: name, vault: true }
        : original?.example ?? scalarExample(view.example, view.type),
    };
    parameters.push(parameter);
    byViewName.set(name, parameter);
    viewByName.set(name, view);
    if (original) replacementByOriginalName.set(original.name, parameter);
  }
  for (const original of originals) {
    if (!replacementByOriginalName.has(original.name)) replacementByOriginalName.set(original.name, undefined);
  }
  return { parameters, byViewName, replacementByOriginalName, originalByName, viewByName };
}

function scalarExample(value: string | undefined, type: ParameterView["type"]): WorkflowValue {
  if (type === "number") {
    const parsed = Number(value ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (type === "boolean") return value === "true";
  return value ?? "";
}

function buildEditedStep(stepView: StepView, sessionId: string, indexes: WorkflowIndexes, parameters: ParameterPlan): WorkflowStep {
  const original = indexes.steps.get(stepView.id);
  const actions = stepView.actions.map((actionView) => {
    const action = indexes.actions.get(actionView.id);
    if (!action) throw new Error(`The review references an unknown action: ${actionView.id}`);
    return editAction(action, actionView, parameters);
  });
  const expects = splitExpectations(stepView.expects);
  if (expects.length === 0) throw new Error(`Describe what success looks like for ${stepView.intent || "each step"}`);
  const stepWasEdited = !original
    || stepView.source === "user-added-in-review"
    || stepView.intent.trim() !== original.intent
    || JSON.stringify(expects) !== JSON.stringify(original.expects)
    || JSON.stringify(actions) !== JSON.stringify(original.actions);
  const provenance = original && !stepWasEdited
    ? original.provenance
    : { source: "user-added-in-review" as const, timestampRefs: [{ sessionId, startMs: stepView.time.startMs, endMs: stepView.time.endMs }] };
  const removed = new Set(stepView.removedDecisionIds ?? []);
  const decisionViews = new Map(stepView.decisions.map((decision) => [decision.id, decision]));
  const decisions = (original?.decisions ?? [])
    .filter((decision) => !removed.has(decision.id))
    .map((decision) => editDecision(decision, decisionViews.get(decision.id), sessionId, parameters));
  for (const decisionView of stepView.decisions) {
    if (decisions.some((decision) => decision.id === decisionView.id)) continue;
    const source = indexes.decisions.get(decisionView.id);
    if (!source) throw new Error(`The review references an unknown decision: ${decisionView.id}`);
    decisions.push(editDecision(source, decisionView, sessionId, parameters));
  }
  const expectationChecks = original?.expectationChecks?.filter((check) => expects.includes(check.expectation));
  return {
    kind: "step",
    id: stepView.id,
    intent: stepView.intent.trim(),
    actions,
    expects,
    ...(expectationChecks && expectationChecks.length > 0 ? { expectationChecks } : {}),
    ...(decisions.length > 0 ? { decisions } : {}),
    provenance,
  };
}

function editDecision(decision: DecisionNode, view: DecisionView | undefined, sessionId: string, parameters: ParameterPlan): DecisionNode {
  const thenView = view?.then;
  const elseView = view?.else;
  const changed = view !== undefined && (
    view.source === "user-added-in-review"
    || view.condition.trim() !== decision.condition
    || view.confidence !== decision.confidence
    || !sameBranchView(view.then, branchToView(decision.then))
    || !sameBranchView(view.else, branchToView(decision.else))
  );
  return {
    ...decision,
    ...(view ? { condition: view.condition.trim(), confidence: view.confidence } : {}),
    then: thenView && !sameBranchView(thenView, branchToView(decision.then))
      ? branchFromView(decision.id, "then", thenView, sessionId)
      : decision.then.map((node) => rewriteBranchNode(node, parameters)),
    else: elseView && !sameBranchView(elseView, branchToView(decision.else))
      ? branchFromView(decision.id, "else", elseView, sessionId)
      : decision.else.map((node) => rewriteBranchNode(node, parameters)),
    provenance: changed
      ? { source: "user-added-in-review", timestampRefs: decision.provenance.timestampRefs.length > 0 ? decision.provenance.timestampRefs : [{ sessionId, startMs: 0 }], note: "Decision updated during review" }
      : decision.provenance,
  };
}

function sameBranchView(left: BranchPathView, right: BranchPathView): boolean {
  return left.kind === right.kind && left.summary.trim() === right.summary.trim();
}

function branchFromView(decisionId: string, side: "then" | "else", view: BranchPathView, sessionId: string): BranchNode[] {
  const summary = view.summary.trim();
  if (!summary) throw new Error(`Describe the ${side} path for this decision`);
  const provenance = { source: "user-added-in-review" as const, timestampRefs: [{ sessionId, startMs: 0 }], note: `Filled during review for the ${side} path` };
  if (view.kind === "ask_user") return [{ kind: "ask_user", id: `${decisionId}-${side}-ask-review`, message: summary, provenance }];
  if (view.kind === "stop_and_flag") return [{ kind: "stop_and_flag", id: `${decisionId}-${side}-stop-review`, reason: summary, provenance }];
  return [{
    kind: "step",
    id: `${decisionId}-${side}-review-step`,
    intent: summary,
    actions: [{ id: `${decisionId}-${side}-review-action`, type: "custom", description: summary }],
    expects: [`The ${side} path is complete`],
    provenance,
  }];
}

function rewriteBranchNode(node: BranchNode, parameters: ParameterPlan): BranchNode {
  if (node.kind !== "step") return node;
  return {
    ...node,
    actions: node.actions.map((action) => editAction(action, undefined, parameters)),
    ...(node.decisions ? { decisions: node.decisions.map((decision) => editDecision(decision, undefined, findNodeSession(node), parameters)) } : {}),
  };
}

function findNodeSession(step: WorkflowStep): string {
  return step.provenance.timestampRefs[0]?.sessionId ?? "review";
}

function editAction(action: WorkflowAction, view: ActionView | undefined, parameters: ParameterPlan): WorkflowAction {
  let edited = view?.target ? replaceTargetDescription(action, view.target.trim()) : action;
  if (view?.parameter) {
    const parameterView = parameters.viewByName.get(view.parameter);
    const parameter = parameters.byViewName.get(view.parameter);
    if (parameterView?.confirmed && parameter) {
      edited = replaceActionValue(edited, { param: parameter.name, vault: parameter.type === "secret" });
      return edited;
    }
  }
  return rewriteActionReference(edited, parameters);
}

function rewriteActionReference(action: WorkflowAction, parameters: ParameterPlan): WorkflowAction {
  if (action.type === "type" || action.type === "select") return { ...action, value: rewriteValue(action.value, parameters) };
  if (action.type === "navigate") return { ...action, url: rewriteValue(action.url, parameters) };
  return action;
}

function rewriteValue(value: WorkflowStringValue, parameters: ParameterPlan): WorkflowStringValue {
  if (typeof value !== "object" || value === null) return value;
  const replacement = parameters.replacementByOriginalName.get(value.param);
  if (replacement) return { param: replacement.name, vault: replacement.type === "secret" };
  const original = parameters.originalByName.get(value.param);
  if (!original) return value;
  if (value.vault || original.type === "secret") throw new Error(`Secure input ${value.param} cannot be removed`);
  return typeof original.example === "object" && original.example !== null ? "" : String(original.example ?? "");
}

function replaceActionValue(action: WorkflowAction, value: Extract<WorkflowValue, object>): WorkflowAction {
  if (action.type === "type" || action.type === "select") return { ...action, value };
  if (action.type === "navigate") return { ...action, url: value };
  throw new Error(`Only typed, selected, or navigated values can become inputs (${action.id})`);
}

function parameterToView(parameter: WorkflowParameter): ParameterView {
  const example = typeof parameter.example === "object" && parameter.example !== null ? undefined : String(parameter.example ?? "");
  return {
    id: parameter.name,
    name: parameter.name,
    type: parameter.type === "secret" ? "secret" : parameter.type === "number" ? "number" : parameter.type === "boolean" ? "boolean" : "string",
    ...(example === undefined ? {} : { example }),
    description: parameter.description,
    confirmed: true,
    vault: parameter.type === "secret",
  };
}

function stepToView(step: WorkflowStep): StepView {
  const range = step.provenance.timestampRefs[0] ?? { startMs: 0, endMs: 0 };
  return {
    id: step.id,
    intent: step.intent,
    expects: step.expects.join("\n"),
    source: step.provenance.source,
    time: { startMs: range.startMs, endMs: range.endMs ?? range.startMs },
    actions: step.actions.map(actionToView),
    decisions: (step.decisions ?? []).map(decisionToView),
  };
}

function actionToView(action: WorkflowAction): ActionView {
  const target = targetForAction(action);
  const description = action.type === "custom" ? action.description : describeAction(action, target?.description);
  const value = action.type === "type" || action.type === "select"
    ? typeof action.value === "string" ? action.value : action.value.vault ? "[SECURE INPUT]" : `{${action.value.param}}`
    : undefined;
  const kind = action.type === "key" ? "keypress" : action.type === "custom" ? "wait" : action.type;
  const parameter = (action.type === "type" || action.type === "select") && typeof action.value === "object" ? action.value.param : undefined;
  return { id: action.id, kind, description, ...(target ? { target: target.description } : {}), ...(value === undefined ? {} : { value }), ...(parameter ? { parameter } : {}), timestampMs: 0 };
}

function decisionToView(decision: DecisionNode): DecisionView {
  return {
    id: decision.id,
    condition: decision.condition,
    confidence: decision.confidence,
    source: decision.provenance.source,
    then: branchToView(decision.then),
    else: branchToView(decision.else),
  };
}

function branchToView(nodes: BranchNode[]): BranchPathView {
  if (nodes[0]?.kind === "ask_user") return { kind: "ask_user", summary: nodes[0].message };
  if (nodes[0]?.kind === "stop_and_flag") return { kind: "stop_and_flag", summary: nodes[0].reason };
  return { kind: "steps", summary: nodes.map((node) => node.kind === "step" ? node.intent : node.kind === "ask_user" ? node.message : node.reason).join("; ") };
}

function targetForAction(action: WorkflowAction): WorkflowTarget | undefined {
  if (action.type === "drag") return action.from;
  if ("target" in action) return action.target;
  return undefined;
}

function describeAction(action: WorkflowAction, target?: string): string {
  const place = target ? ` ${target}` : "";
  switch (action.type) {
    case "click": return `Click${place}`;
    case "type": return `Type into${place}`;
    case "select": return `Select from${place}`;
    case "navigate": return `Navigate to ${typeof action.url === "string" ? action.url : `{${action.url.param}}`}`;
    case "scroll": return `Scroll ${action.direction}${place}`;
    case "drag": return `Drag ${action.from.description} to ${action.to.description}`;
    case "key": return `Press ${action.key}`;
    case "wait": return action.until ? `Wait until ${action.until}` : "Wait";
    case "custom": return action.description;
  }
}

function replaceTargetDescription(action: WorkflowAction, description: string): WorkflowAction {
  if (action.type === "drag") return { ...action, from: { ...action.from, description } };
  if ("target" in action && action.target) return { ...action, target: { ...action.target, description } } as WorkflowAction;
  return action;
}

function splitExpectations(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function findSessionId(workflow: Workflow): string | undefined {
  return workflow.steps.flatMap((step) => step.provenance.timestampRefs).find(Boolean)?.sessionId;
}
