import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionStatus } from "../shared/contracts.js";
import { liveAvailability, withDeadline, withoutFailing } from "./live-lifecycle.js";

function permissions(microphone: PermissionStatus["state"]): PermissionStatus[] {
  return [
    { name: "screen", state: "granted", required: true, explanation: "" },
    { name: "microphone", state: microphone, required: false, explanation: "" },
  ];
}

describe("liveAvailability", () => {
  it("needs macOS 26 before anything else", () => {
    // The key and the microphone are missing too; the oldest Mac is still the
    // first thing the record card says.
    expect(liveAvailability("15.6.1", undefined, permissions("denied"))).toEqual({
      available: false,
      reason: "Needs macOS 26",
    });
  });

  it("fails closed when the system version cannot be read", () => {
    for (const version of ["", "unknown", "Version 26"]) {
      expect(liveAvailability(version, "key", permissions("granted"))).toEqual({
        available: false,
        reason: "Needs macOS 26",
      });
    }
  });

  it("asks for the API key once the Mac is new enough", () => {
    expect(liveAvailability("26.0.1", undefined, permissions("denied"))).toEqual({
      available: false,
      reason: "Set ANTHROPIC_API_KEY in .env",
    });
    expect(liveAvailability("26.0.1", "", permissions("granted"))).toMatchObject({ reason: "Set ANTHROPIC_API_KEY in .env" });
  });

  it("asks for the microphone once the key is there", () => {
    expect(liveAvailability("26.0", "key", permissions("notDetermined"))).toEqual({
      available: false,
      reason: "Grant Microphone in System Settings",
    });
    expect(liveAvailability("26.0", "key", [])).toMatchObject({ reason: "Grant Microphone in System Settings" });
  });

  it("is available once all three checks pass", () => {
    expect(liveAvailability("27.1", "key", permissions("granted"))).toEqual({ available: true });
  });
});

describe("withDeadline", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves as soon as the work does, and says nothing", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();

    const waited = withDeadline(Promise.resolve("done"), 5_000, expired);
    await vi.advanceTimersByTimeAsync(0);
    await waited;

    expect(expired).not.toHaveBeenCalled();
  });

  it("resolves at the ceiling when the work has not finished, and says so", async () => {
    vi.useFakeTimers();
    const expired = vi.fn();

    const waited = withDeadline(new Promise<void>(() => {}), 5_000, expired);
    await vi.advanceTimersByTimeAsync(5_000);
    await waited;

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it("never fails because the work failed", async () => {
    await expect(withDeadline(Promise.reject(new Error("the tutor could not end")), 5_000)).resolves.toBeUndefined();
  });

  it("never fails because the work failed after the ceiling had passed", async () => {
    vi.useFakeTimers();
    let fail: (cause: Error) => void = () => {};
    const work = new Promise<void>((_resolve, reject) => { fail = reject; });

    const waited = withDeadline(work, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waited).resolves.toBeUndefined();
    // A rejection nobody is waiting for any more must not reach the process;
    // vitest fails this run if it does.
    fail(new Error("the tutor failed late"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("never fails because saying so failed", async () => {
    vi.useFakeTimers();

    const waited = withDeadline(new Promise<void>(() => {}), 1_000, () => { throw new Error("the panel is gone"); });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waited).resolves.toBeUndefined();
  });
});

describe("withoutFailing", () => {
  it("runs the step", () => {
    const step = vi.fn();
    withoutFailing(step);
    expect(step).toHaveBeenCalledTimes(1);
  });

  it("lets a failing step go", () => {
    expect(() => withoutFailing(() => { throw new Error("the panel is gone"); })).not.toThrow();
  });
});
