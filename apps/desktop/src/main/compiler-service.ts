import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { compileWorkflow, type CompileResult, type ComputerUseCompilerOptions, type PlaywrightCompilerOptions } from "@replay/compilers";
import type { BranchNode, Workflow, WorkflowAction, WorkflowTarget } from "@replay/ir";
import type { CompileRequest, CompileResultView } from "../shared/contracts.js";
import { SessionService } from "./session-service.js";
import { WorkflowRepository } from "./workflow-repository.js";

export class CompilerService {
  readonly #exportsDirectory: string;

  constructor(
    private readonly workflows: WorkflowRepository,
    private readonly sessions: SessionService,
    dataDirectory: string,
  ) {
    this.#exportsDirectory = join(dataDirectory, "exports");
  }

  async compile(request: CompileRequest): Promise<CompileResultView> {
    const workflow = await this.workflows.get(request.workflowId);
    let result: CompileResult;
    if (request.target === "playbook") {
      result = compileWorkflow("playbook", workflow, { includeProvenance: true });
    } else if (request.target === "playwright") {
      const fallback = request.checkpointMode === "agent" ? "agent-check" : "human-checkpoint";
      const options: PlaywrightCompilerOptions = { semanticFallback: fallback, nativeFallback: fallback };
      result = compileWorkflow("playwright", workflow, options);
    } else {
      result = compileWorkflow("computer-use", workflow, await this.#computerUseOptions(workflow));
    }
    const outputDirectory = join(
      this.#exportsDirectory,
      workflow.metadata.workflowId,
      `v${String(workflow.metadata.revision).padStart(4, "0")}`,
      `${request.target}-${randomUUID().slice(0, 8)}`,
    );
    await this.#writeResult(outputDirectory, result);
    return {
      outputDirectory,
      files: result.files.map((file) => file.path),
      warnings: result.warnings.map((warning) => ({ ...(warning.stepId ? { stepId: warning.stepId } : {}), message: warning.message })),
    };
  }

  async #computerUseOptions(workflow: Workflow): Promise<ComputerUseCompilerOptions> {
    const sessionId = firstSessionId(workflow);
    if (!sessionId) return {};
    const assets: Record<string, Uint8Array> = {};
    for (const path of screenshotPaths(workflow)) {
      if (!isSafeRelativePath(path)) continue;
      try { assets[path] = await readFile(join(this.sessions.directory(sessionId), path)); } catch { /* Compiler emits a missing-asset warning. */ }
    }
    return { assets, policy: { maxRetriesPerStep: 1, firstRunRequiresTest: true } };
  }

  async #writeResult(directory: string, result: CompileResult): Promise<void> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const file of result.files) {
      if (!isSafeRelativePath(file.path)) throw new Error("A compiler produced an unsafe output path");
      const outputPath = join(directory, file.path);
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
      await writeFile(outputPath, file.content, { mode: 0o600 });
    }
  }
}

function screenshotPaths(workflow: Workflow): Set<string> {
  const paths = new Set<string>();
  const visitTarget = (target: WorkflowTarget | undefined) => { if (target?.screenshotCrop?.path) paths.add(target.screenshotCrop.path); };
  const visitAction = (action: WorkflowAction) => {
    if (action.type === "drag") { visitTarget(action.from); visitTarget(action.to); }
    else if ("target" in action) visitTarget(action.target);
  };
  const visitNodes = (nodes: BranchNode[]) => {
    for (const node of nodes) {
      if (node.kind !== "step") continue;
      node.actions.forEach(visitAction);
      node.expectationChecks?.forEach((check) => visitTarget(check.target));
      for (const decision of node.decisions ?? []) {
        visitTarget(decision.deterministicCheck?.target);
        visitNodes(decision.then);
        visitNodes(decision.else);
      }
    }
  };
  visitNodes(workflow.steps);
  return paths;
}

function firstSessionId(workflow: Workflow): string | undefined {
  let found: string | undefined;
  const visit = (nodes: BranchNode[]) => {
    for (const node of nodes) {
      found ??= node.provenance.timestampRefs[0]?.sessionId;
      if (node.kind === "step") for (const decision of node.decisions ?? []) { visit(decision.then); visit(decision.else); }
      if (found) return;
    }
  };
  visit(workflow.steps);
  return found;
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\0")) return false;
  const normalized = normalize(path);
  return normalized !== ".." && !normalized.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}
