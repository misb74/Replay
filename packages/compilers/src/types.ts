import type { Workflow } from "@replay/ir";

export type CompilerTarget = "playbook" | "playwright" | "computer-use";

export interface GeneratedTextFile {
  path: string;
  mediaType: string;
  content: string;
}

export interface GeneratedBinaryFile {
  path: string;
  mediaType: string;
  content: Uint8Array;
}

export type GeneratedFile = GeneratedTextFile | GeneratedBinaryFile;

export type CompileWarningCode =
  | "native-action-degraded"
  | "custom-action-degraded"
  | "semantic-condition-degraded"
  | "semantic-expectation-degraded"
  | "secure-input-checkpoint"
  | "imprecise-browser-locator"
  | "native-agent-check-unavailable"
  | "agent-check-configuration-required"
  | "first-test-run-enforced"
  | "missing-screenshot-asset";

export interface CompileWarning {
  code: CompileWarningCode;
  message: string;
  stepId?: string;
  actionId?: string;
  decisionId?: string;
  assetPath?: string;
}

export interface CompileResult {
  files: GeneratedFile[];
  warnings: CompileWarning[];
}

export interface BaseCompilerOptions {
  outputName?: string;
}

export interface Compiler<TOptions extends BaseCompilerOptions = BaseCompilerOptions> {
  readonly target: CompilerTarget;
  compile(workflow: Workflow, options?: TOptions): CompileResult;
}

export interface PlaybookCompilerOptions extends BaseCompilerOptions {
  includeProvenance?: boolean;
}

export type ScriptFallback = "human-checkpoint" | "agent-check";

export interface PlaywrightCompilerOptions extends BaseCompilerOptions {
  semanticFallback?: ScriptFallback;
  nativeFallback?: ScriptFallback;
  /** Defaults to false because human checkpoints need a visible browser. */
  headless?: boolean;
}

export interface ComputerUseRunPolicyOptions {
  maxRetriesPerStep?: number;
  /** @deprecated The first test run is mandatory; false is ignored with a warning. */
  firstRunRequiresTest?: boolean;
}

export type AssetResolver = (path: string) => Uint8Array | undefined;

export interface ComputerUseCompilerOptions extends BaseCompilerOptions {
  policy?: ComputerUseRunPolicyOptions;
  assets?: Readonly<Record<string, Uint8Array>>;
  resolveAsset?: AssetResolver;
}

export interface ComputerUseRunPolicy {
  maxRetriesPerStep: number;
  firstRunRequiresTest: boolean;
  secureFields: "human-only";
  onExpectationFailure: "retry-then-pause" | "pause";
  askUserNodeIds: string[];
  stopAndFlagNodeIds: string[];
  allowedModes: ["test", "supervised", "autonomous"];
}
