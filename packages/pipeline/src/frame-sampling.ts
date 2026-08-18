import type { CondensedAction, CondensedActionKind } from "./condense.js";
import type { Bounds } from "./events.js";

export type FrameSampleReason =
  | "before_action"
  | "after_significant_action"
  | "observed_screen_change";

export interface ScreenChangeObservation {
  timestampMs: number;
  score: number;
  /** The action that caused the observed change, when known. */
  actionId?: string;
}

export interface PlannedFrame {
  id: string;
  timestampMs: number;
  reasons: FrameSampleReason[];
  actionIds: string[];
}

export interface FrameSamplingPlan {
  version: 1;
  durationMs: number;
  frames: PlannedFrame[];
}

export interface FrameSamplingOptions {
  preActionLeadMs?: number;
  postActionLagMs?: number;
  minimumSpacingMs?: number;
  screenChangeThreshold?: number;
  significantActionKinds?: readonly CondensedActionKind[];
}

export interface SampledFrame {
  id: string;
  timestampMs: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  dataBase64: string;
  sha256?: string;
  /**
   * Session-relative element images produced while decoding this frame.
   * They remain local assets; only their safe references enter workflow IR.
   */
  elementCrops?: ElementCropEvidence[];
}

export interface ElementCropEvidence {
  actionId: string;
  path: string;
  region?: "target" | "from" | "to";
  bounds?: Bounds;
}

export interface FrameProviderRequest {
  sessionId: string;
  videoPath: string;
  plan: FrameSamplingPlan;
  actions?: readonly CondensedAction[];
  displayScale?: number;
  displayWidth?: number;
  displayHeight?: number;
  signal?: AbortSignal;
}

export interface FrameProvider {
  sample(request: FrameProviderRequest): Promise<SampledFrame[]>;
}

interface CandidateFrame {
  timestampMs: number;
  reason: FrameSampleReason;
  actionId?: string;
}

const SIGNIFICANT_ACTIONS: readonly CondensedActionKind[] = [
  "click",
  "select",
  "navigate",
  "scroll",
  "drag",
  "app_switch",
  "window_switch",
  "key_press",
];

/** Build a deterministic extraction plan; actual video decoding stays injectable. */
export function planFrameSamples(
  actions: readonly CondensedAction[],
  durationMs: number,
  screenChanges: readonly ScreenChangeObservation[] = [],
  options: FrameSamplingOptions = {},
): FrameSamplingPlan {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error("Video duration must be a finite, non-negative number.");
  }
  const preActionLeadMs = options.preActionLeadMs ?? 180;
  const postActionLagMs = options.postActionLagMs ?? 450;
  const minimumSpacingMs = options.minimumSpacingMs ?? 120;
  const screenChangeThreshold = options.screenChangeThreshold ?? 0.2;
  const significantKinds = new Set(options.significantActionKinds ?? SIGNIFICANT_ACTIONS);
  const candidates: CandidateFrame[] = [];
  const actionIds = new Set(actions.map((action) => action.id));

  for (const [name, value] of [
    ["pre-action lead", preActionLeadMs],
    ["post-action lag", postActionLagMs],
    ["minimum frame spacing", minimumSpacingMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`The ${name} must be a finite, non-negative number.`);
    }
  }
  if (!Number.isFinite(screenChangeThreshold) || screenChangeThreshold < 0 || screenChangeThreshold > 1) {
    throw new Error("The screen-change threshold must be between 0 and 1.");
  }

  for (const observation of screenChanges) {
    if (!Number.isFinite(observation.timestampMs) || observation.timestampMs < 0 || observation.timestampMs > durationMs) {
      throw new Error("A screen-change observation has an invalid timestamp.");
    }
    if (!Number.isFinite(observation.score) || observation.score < 0 || observation.score > 1) {
      throw new Error("A screen-change observation has an invalid score.");
    }
    if (observation.actionId !== undefined && !actionIds.has(observation.actionId)) {
      throw new Error("A screen-change observation references an unknown action.");
    }
  }

  for (const action of actions) {
    candidates.push({
      timestampMs: clamp(action.startMs - preActionLeadMs, 0, durationMs),
      reason: "before_action",
      actionId: action.id,
    });
    if (significantKinds.has(action.kind)) {
      candidates.push({
        timestampMs: clamp(action.endMs + postActionLagMs, 0, durationMs),
        reason: "after_significant_action",
        actionId: action.id,
      });
    }
  }
  for (const observation of screenChanges) {
    if (
      Number.isFinite(observation.timestampMs) &&
      Number.isFinite(observation.score) &&
      observation.score >= screenChangeThreshold
    ) {
      candidates.push({
        timestampMs: clamp(observation.timestampMs, 0, durationMs),
        reason: "observed_screen_change",
        ...(observation.actionId === undefined ? {} : { actionId: observation.actionId }),
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.timestampMs - right.timestampMs ||
      left.reason.localeCompare(right.reason) ||
      (left.actionId ?? "").localeCompare(right.actionId ?? ""),
  );

  const merged: Array<Omit<PlannedFrame, "id">> = [];
  for (const candidate of candidates) {
    const previous = merged.at(-1);
    if (previous !== undefined && candidate.timestampMs - previous.timestampMs < minimumSpacingMs) {
      if (!previous.reasons.includes(candidate.reason)) {
        previous.reasons.push(candidate.reason);
      }
      if (candidate.actionId !== undefined && !previous.actionIds.includes(candidate.actionId)) {
        previous.actionIds.push(candidate.actionId);
      }
      continue;
    }
    merged.push({
      // Keep whole-millisecond seek points inside a fractional media duration.
      // A candidate clamped to 10_211.757ms must not round up to 10_212ms,
      // which would make the planner's own output fail frame validation.
      timestampMs: Math.min(Math.round(candidate.timestampMs), Math.floor(durationMs)),
      reasons: [candidate.reason],
      actionIds: candidate.actionId === undefined ? [] : [candidate.actionId],
    });
  }

  return {
    version: 1,
    durationMs,
    frames: merged.map((frame, index) => ({
      id: `frame-${String(index + 1).padStart(4, "0")}`,
      ...frame,
    })),
  };
}

export function validateSampledFrames(
  plan: FrameSamplingPlan,
  frames: readonly SampledFrame[],
): string[] {
  const issues: string[] = [];
  const expected = new Map(plan.frames.map((frame) => [frame.id, frame]));
  const seen = new Set<string>();
  for (const frame of frames) {
    if (!expected.has(frame.id)) {
      issues.push(`Unexpected sampled frame id: ${frame.id}.`);
    }
    if (seen.has(frame.id)) {
      issues.push(`Duplicate sampled frame id: ${frame.id}.`);
    }
    seen.add(frame.id);
    if (!Number.isFinite(frame.timestampMs) || frame.timestampMs < 0 || frame.timestampMs > plan.durationMs) {
      issues.push(`Sampled frame ${frame.id} has an invalid timestamp.`);
    }
    const planned = expected.get(frame.id);
    if (planned !== undefined && Math.abs(frame.timestampMs - planned.timestampMs) > 1) {
      issues.push(`Sampled frame ${frame.id} does not match its planned timestamp.`);
    }
    if (frame.dataBase64.trim() === "") {
      issues.push(`Sampled frame ${frame.id} has no image data.`);
    }
    for (const crop of frame.elementCrops ?? []) {
      if (planned !== undefined && !planned.actionIds.includes(crop.actionId)) {
        issues.push(`Element crop in ${frame.id} references an action not linked to that frame: ${crop.actionId}.`);
      }
      if (!isSafeRelativeAssetPath(crop.path)) {
        issues.push(`Element crop in ${frame.id} has an unsafe asset path.`);
      }
      if (crop.region !== undefined && crop.region !== "target" && crop.region !== "from" && crop.region !== "to") {
        issues.push(`Element crop in ${frame.id} has an invalid target region.`);
      }
      if (crop.bounds !== undefined && !isValidBounds(crop.bounds)) {
        issues.push(`Element crop in ${frame.id} has invalid bounds.`);
      }
    }
  }
  for (const id of expected.keys()) {
    if (!seen.has(id)) {
      issues.push(`Missing sampled frame id: ${id}.`);
    }
  }
  return issues;
}

function isSafeRelativeAssetPath(path: string): boolean {
  if (path.trim() === "" || path.includes("\0") || path.startsWith("/") || path.startsWith("\\")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/u.test(path)) {
    return false;
  }
  const segments = path.split(/[\\/]/u);
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isValidBounds(bounds: Bounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width > 0 && bounds.height > 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
