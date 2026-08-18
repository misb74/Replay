import type { AccessibilityTarget, CaptureEvent } from "./events.js";

export const REDACTED_TEXT = "[REDACTED]" as const;

export interface VaultParameterReference {
  param: string;
  vault: true;
}

/** Capture APIs occasionally disagree on the secure-field flag. */
export function isSecureTarget(target: AccessibilityTarget | undefined): boolean {
  if (target?.isSecure === true) {
    return true;
  }
  const roles = [target?.role, target?.subrole]
    .filter((role): role is string => role !== undefined)
    .map((role) => role.replaceAll(/[^a-z]/giu, "").toLowerCase());
  return roles.some(
    (role) =>
      role === "axsecuretextfield" ||
      role === "securetextfield" ||
      role === "passwordfield",
  );
}

/**
 * A second redaction boundary after capture. This must run before validation
 * errors, logging, condensation, model requests, or cache writes can retain a
 * secure field's contents.
 */
export function sanitizeCaptureEvent(event: CaptureEvent): CaptureEvent {
  const secure = isSecureTarget(event.target) || event.key?.redacted === true;
  if (!secure) {
    return event;
  }

  const target = event.target;
  return {
    ...event,
    ...(event.key === undefined
      ? {}
      : { key: { ...event.key, text: REDACTED_TEXT, redacted: true } }),
    ...(event.selection === undefined
      ? {}
      : { selection: { ...event.selection, value: REDACTED_TEXT } }),
    ...(target === undefined
      ? {}
      : {
          target: {
            ...target,
            isSecure: true,
            ...(target.value === undefined ? {} : { value: REDACTED_TEXT }),
          },
        }),
    // A future browser capture could otherwise duplicate a password in a DOM
    // snapshot. Keep only the fact that data was deliberately removed.
    ...(event.dom === undefined ? {} : { dom: { redacted: true } }),
  };
}

export function vaultReferenceForTarget(
  target: AccessibilityTarget | undefined,
): VaultParameterReference {
  const preferredName = target?.label ?? target?.identifier ?? "secret";
  const param = preferredName
    .normalize("NFKD")
    .replaceAll(/[^a-zA-Z0-9]+/gu, "_")
    .replaceAll(/^_+|_+$/gu, "")
    .toLowerCase();
  return { param: param.length > 0 ? param : "secret", vault: true };
}

/** Safe for assertions at any boundary that may persist or transmit data. */
export function containsUnredactedSecureText(events: readonly CaptureEvent[]): boolean {
  return events.some((event) => {
    if (!isSecureTarget(event.target) && event.key?.redacted !== true) {
      return false;
    }
    return (
      (event.key?.text !== undefined && event.key.text !== REDACTED_TEXT) ||
      (event.target?.value !== undefined && event.target.value !== REDACTED_TEXT) ||
      (event.dom !== undefined && !isRedactedMarker(event.dom))
    );
  });
}

function isRedactedMarker(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).redacted === true
  );
}
