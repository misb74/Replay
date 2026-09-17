import type { LiveAvailability, PermissionStatus } from "../shared/contracts.js";

/**
 * Whether the live tutor can run on this Mac, and the first reason it cannot
 * (spec §6.1): macOS 26, then the API key, then the microphone permission.
 * The first failing check is the reason the record card shows.
 *
 * A system version whose major number cannot be read fails closed. An
 * unreadable version is no evidence that the Mac is new enough, and letting
 * it through would offer Live where the sidecar can only refuse it.
 */
export function liveAvailability(
  systemVersion: string,
  apiKey: string | undefined,
  permissions: readonly PermissionStatus[],
): LiveAvailability {
  const major = Number.parseInt(systemVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 26) return { available: false, reason: "Needs macOS 26" };
  if (!apiKey) return { available: false, reason: "Set ANTHROPIC_API_KEY in .env" };
  if (permissions.find((permission) => permission.name === "microphone")?.state !== "granted") {
    return { available: false, reason: "Grant Microphone in System Settings" };
  }
  return { available: true };
}

/**
 * Waits for `work`, but never longer than `ms`, and never fails. A caller that
 * must not be held up — or brought down — by what it is waiting for gets a
 * ceiling rather than a wait: stopping a recording, and quitting, both wait
 * for the tutor this way. `onExpired` is called when the ceiling comes first,
 * so nothing is given up on silently. The work itself carries on either way,
 * and its failure, whenever it arrives, reaches nobody.
 */
export function withDeadline(work: Promise<unknown>, ms: number, onExpired?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (onExpired) withoutFailing(onExpired);
      resolve();
    }, ms);
    void work.catch(() => undefined).finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Runs `step` and lets a failure go. For the last steps of a shutdown, where
 * there is nothing left to report a failure to, and where the step after it
 * still has to run.
 */
export function withoutFailing(step: () => void): void {
  try {
    step();
  } catch {
    // Deliberately quiet: see above.
  }
}
