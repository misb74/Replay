import type { SessionSummary } from "../shared/contracts.js";

export function activeRecording(sessions: readonly SessionSummary[]): SessionSummary | undefined {
  return sessions.find((session) => session.state === "recording");
}

export function buildableRecording(session: SessionSummary | undefined): SessionSummary | undefined {
  return session?.state === "ready" ? session : undefined;
}

export function latestUnprocessedRecording(
  sessions: readonly SessionSummary[],
  workflowSessionIds: ReadonlySet<string>,
  dismissedSessionIds: ReadonlySet<string> = new Set(),
): SessionSummary | undefined {
  const latestCompleted = sessions
    .filter((session) => buildableRecording(session) !== undefined)
    .toSorted((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  if (
    latestCompleted === undefined
    || workflowSessionIds.has(latestCompleted.id)
    || dismissedSessionIds.has(latestCompleted.id)
  ) {
    return undefined;
  }
  return latestCompleted;
}
