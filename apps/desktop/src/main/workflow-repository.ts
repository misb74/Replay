import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadWorkflow, parseWorkflow, type Workflow } from "@replay/ir";
import type { WorkflowView } from "../shared/contracts.js";
import { applyViewEdits, workflowToView } from "./workflow-mapper.js";

interface TrustRecord {
  workflowRevision: number;
  cleanTestRunAt: string;
}

export class WorkflowRepository {
  readonly #workflowsDirectory: string;
  readonly #now: () => Date;

  constructor(dataDirectory: string, now: () => Date = () => new Date()) {
    this.#workflowsDirectory = join(dataDirectory, "workflows");
    this.#now = now;
  }

  async initialize(): Promise<void> {
    await mkdir(this.#workflowsDirectory, { recursive: true });
  }

  async list(): Promise<WorkflowView[]> {
    await this.initialize();
    const entries = await readdir(this.#workflowsDirectory, { withFileTypes: true });
    const workflows = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map(async (entry) => {
        try { return await this.getView(entry.name); } catch { return undefined; }
      }));
    return workflows.filter((workflow): workflow is WorkflowView => workflow !== undefined)
      .sort((left, right) => right.revision - left.revision || left.name.localeCompare(right.name));
  }

  async get(id: string): Promise<Workflow> {
    assertSafeId(id);
    const raw = await readFile(join(this.#workflowsDirectory, id, "workflow.json"), "utf8");
    const loaded = loadWorkflow(JSON.parse(raw) as unknown);
    const workflow = loaded.metadata.approval.status === "approved" && !loaded.metadata.approval.contentHash
      ? { ...loaded, metadata: { ...loaded.metadata, approval: { status: "draft" as const } } }
      : loaded;
    if (workflow.metadata.approval.status === "approved") {
      if (workflow.metadata.approval.contentHash !== workflowContentHash(workflow)) throw new Error("The approved workflow content no longer matches its approval stamp");
    }
    return workflow;
  }

  async getView(id: string): Promise<WorkflowView> {
    return (await this.getRunSnapshot(id)).view;
  }

  async getRunSnapshot(id: string): Promise<{ workflow: Workflow; view: WorkflowView }> {
    const workflow = await this.get(id);
    const view = workflowToView(workflow);
    const trust = await this.#readTrust(id);
    const trustedView = trust?.workflowRevision === workflow.metadata.revision
      ? { ...view, cleanTestRunAt: trust.cleanTestRunAt }
      : view;
    return { workflow, view: trustedView };
  }

  async create(workflow: Workflow): Promise<WorkflowView> {
    const candidate = parseWorkflow(workflow);
    const parsed = candidate.metadata.approval.status === "approved" && !candidate.metadata.approval.contentHash
      ? { ...candidate, metadata: { ...candidate.metadata, approval: { status: "draft" as const } } }
      : candidate;
    assertSafeId(parsed.metadata.workflowId);
    if (parsed.metadata.revision !== 1) throw new Error("A new workflow must start at revision 1");
    await this.#persistRevision(parsed, true);
    return workflowToView(parsed);
  }

  async saveView(view: WorkflowView): Promise<WorkflowView> {
    const current = await this.get(view.id);
    if (view.revision !== current.metadata.revision) throw new Error("This workflow changed after the review screen was opened. Reload it before saving.");
    const edited = parseWorkflow(applyViewEdits(current, view, this.#now()));
    await this.#persistRevision(edited, true);
    return workflowToView(edited);
  }

  async approve(id: string): Promise<WorkflowView> {
    const current = await this.get(id);
    if (current.metadata.approval.status === "approved") return this.getView(id);
    if (hasLowConfidenceDecision(current.steps)) throw new Error("Resolve every low-confidence decision question before approving this workflow");
    const now = this.#now().toISOString();
    const revision = current.metadata.revision + 1;
    const contentHash = workflowContentHash(current);
    const approved: Workflow = parseWorkflow({
      ...current,
      metadata: {
        ...current.metadata,
        revision,
        previousRevision: current.metadata.revision,
        updatedAt: now,
        approval: { status: "approved", approvedAt: now, approvedBy: "user", contentHash },
      },
    });
    await this.#persistRevision(approved, true);
    return workflowToView(approved);
  }

  async markCleanTestRun(id: string, workflowRevision: number): Promise<WorkflowView> {
    const workflow = await this.get(id);
    if (workflow.metadata.revision !== workflowRevision) throw new Error("The workflow changed during its test run");
    if (workflow.metadata.approval.status !== "approved") throw new Error("A draft workflow cannot be trusted for autonomous runs");
    const record: TrustRecord = { workflowRevision, cleanTestRunAt: this.#now().toISOString() };
    await atomicWrite(join(this.#workflowDirectory(id), "trust.json"), `${JSON.stringify(record, null, 2)}\n`);
    return { ...workflowToView(workflow), cleanTestRunAt: record.cleanTestRunAt };
  }

  async #persistRevision(workflow: Workflow, exclusiveRevision: boolean): Promise<void> {
    const id = workflow.metadata.workflowId;
    assertSafeId(id);
    const directory = this.#workflowDirectory(id);
    await mkdir(directory, { recursive: true });
    const serialized = `${JSON.stringify(workflow, null, 2)}\n`;
    const revisionPath = join(directory, `workflow.v${String(workflow.metadata.revision).padStart(4, "0")}.json`);
    await writeFile(revisionPath, serialized, { encoding: "utf8", flag: exclusiveRevision ? "wx" : "w", mode: 0o600 });
    await atomicWrite(join(directory, "workflow.json"), serialized);
  }

  async #readTrust(id: string): Promise<TrustRecord | undefined> {
    try {
      const parsed = JSON.parse(await readFile(join(this.#workflowDirectory(id), "trust.json"), "utf8")) as Partial<TrustRecord>;
      return typeof parsed.workflowRevision === "number" && typeof parsed.cleanTestRunAt === "string"
        ? { workflowRevision: parsed.workflowRevision, cleanTestRunAt: parsed.cleanTestRunAt }
        : undefined;
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
  }

  #workflowDirectory(id: string): string {
    assertSafeId(id);
    return join(this.#workflowsDirectory, id);
  }
}

function hasLowConfidenceDecision(nodes: Workflow["steps"]): boolean {
  for (const node of nodes) {
    for (const decision of node.decisions ?? []) {
      if (decision.confidence === "low" || hasLowConfidenceDecision(decision.then.filter((branch): branch is Workflow["steps"][number] => branch.kind === "step")) || hasLowConfidenceDecision(decision.else.filter((branch): branch is Workflow["steps"][number] => branch.kind === "step"))) return true;
    }
  }
  return false;
}

export function workflowContentHash(workflow: Workflow): string {
  const content = {
    version: workflow.version,
    name: workflow.name,
    goal: workflow.goal,
    parameters: workflow.parameters,
    steps: workflow.steps,
  };
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertSafeId(id: string): void {
  if (!isSafeId(id)) throw new Error("Invalid workflow id");
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id);
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}
