import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionService } from "./session-service.js";
import { createRecordingVideoHandler, recordingVideoPrivileges, recordingVideoUrl } from "./recording-video-protocol.js";
import type { SidecarClient } from "./sidecar-client.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recording video protocol", () => {
  it("streams media without enabling CSP bypasses, script fetches, or service workers", () => {
    expect(recordingVideoPrivileges).toEqual({
      standard: true,
      secure: true,
      stream: true,
      bypassCSP: false,
      supportFetchAPI: false,
      corsEnabled: false,
      allowServiceWorkers: false,
    });
  });

  it("streams only a completed recording at its fixed private route", async () => {
    const { service, sessionId } = await completedSession("0123456789");
    const handler = createRecordingVideoHandler(service);

    const response = await handler(new Request(recordingVideoUrl(sessionId)));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("10");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("0123456789");
  });

  it("supports bounded, open-ended, suffix, and HEAD byte ranges for seeking", async () => {
    const { service, sessionId } = await completedSession("0123456789");
    const handler = createRecordingVideoHandler(service);
    const url = recordingVideoUrl(sessionId);

    const bounded = await handler(new Request(url, { headers: { Range: "bytes=2-5" } }));
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(bounded.headers.get("content-length")).toBe("4");
    expect(await bounded.text()).toBe("2345");

    const openEnded = await handler(new Request(url, { headers: { Range: "bytes=7-" } }));
    expect(openEnded.status).toBe(206);
    expect(await openEnded.text()).toBe("789");

    const suffix = await handler(new Request(url, { headers: { Range: "bytes=-3" } }));
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");

    const head = await handler(new Request(url, { method: "HEAD", headers: { Range: "bytes=0-3" } }));
    expect(head.status).toBe(206);
    expect(head.headers.get("content-range")).toBe("bytes 0-3/10");
    expect(head.headers.get("content-length")).toBe("4");
    expect(await head.text()).toBe("");
  });

  it("rejects malformed, multiple, reversed, and unsatisfiable ranges", async () => {
    const { service, sessionId } = await completedSession("0123456789");
    const handler = createRecordingVideoHandler(service);
    const url = recordingVideoUrl(sessionId);

    for (const range of ["bytes=", "bytes=0-1,4-5", "bytes=7-2", "bytes=10-", "items=0-1", "bytes=-0"]) {
      const response = await handler(new Request(url, { headers: { Range: range } }));
      expect(response.status, range).toBe(416);
      expect(response.headers.get("content-range"), range).toBe("bytes */10");
    }
  });

  it("rejects traversal-shaped and expanded routes before opening any file", async () => {
    let opens = 0;
    const handler = createRecordingVideoHandler({
      async openVideoForPlayback() {
        opens += 1;
        throw new Error("must not be reached");
      },
    });
    const invalidUrls = [
      "replay-video://recording/session-safe%2F..%2Fsecret/video.mp4",
      "replay-video://recording/%2Fetc%2Fpasswd/video.mp4",
      "replay-video://recording/session-safe/video.mp4?path=/etc/passwd",
      "replay-video://recording/session-safe/video.mp4/extra",
      "replay-video://elsewhere/session-safe/video.mp4",
      "https://recording/session-safe/video.mp4",
    ];

    for (const url of invalidUrls) {
      expect((await handler(new Request(url))).status, url).toBe(404);
    }
    expect(opens).toBe(0);
  });

  it("does not follow a video symlink outside the session", async () => {
    const root = await temporaryRoot("replay-video-link-");
    const sessionId = "session-linked-video";
    const sessionDirectory = join(root, "sessions", sessionId);
    const outsideVideo = join(root, "outside.mp4");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(outsideVideo, "outside private bytes");
    await symlink(outsideVideo, join(sessionDirectory, "video.mp4"));
    await writeMetadata(sessionDirectory, sessionId);
    const handler = createRecordingVideoHandler(sessionService(root));

    const response = await handler(new Request(recordingVideoUrl(sessionId)));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("outside private bytes");
  });

  it("does not follow a session-directory symlink outside Replay storage", async () => {
    const root = await temporaryRoot("replay-session-link-");
    const sessionId = "session-linked-directory";
    const outsideDirectory = join(root, "outside", sessionId);
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "video.mp4"), "outside private bytes");
    await writeMetadata(outsideDirectory, sessionId);
    await mkdir(join(root, "sessions"), { recursive: true });
    await symlink(outsideDirectory, join(root, "sessions", sessionId));
    const handler = createRecordingVideoHandler(sessionService(root));

    const response = await handler(new Request(recordingVideoUrl(sessionId)));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("outside private bytes");
  });

  it("does not serve through a replaced sessions directory", async () => {
    const root = await temporaryRoot("replay-sessions-link-");
    const sessionId = "session-linked-root";
    const outsideDirectory = join(root, "outside-sessions", sessionId);
    await mkdir(outsideDirectory, { recursive: true });
    await writeFile(join(outsideDirectory, "video.mp4"), "outside private bytes");
    await writeMetadata(outsideDirectory, sessionId);
    await symlink(join(root, "outside-sessions"), join(root, "sessions"));
    const handler = createRecordingVideoHandler(sessionService(root));

    const response = await handler(new Request(recordingVideoUrl(sessionId)));

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("outside private bytes");
  });

  it("does not serve a recording until capture completed successfully", async () => {
    const root = await temporaryRoot("replay-incomplete-video-");
    const sessionId = "session-incomplete";
    const sessionDirectory = join(root, "sessions", sessionId);
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "video.mp4"), "unfinished bytes");
    await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify({
      schemaVersion: 1,
      sessionId,
      status: "interrupted",
      partial: true,
      startedAt: "2026-08-17T10:00:00Z",
      display: { width: 100, height: 100, scale: 2 },
      narration: false,
      appVersions: {},
      eventCount: 0,
    }));
    const handler = createRecordingVideoHandler(sessionService(root));

    expect((await handler(new Request(recordingVideoUrl(sessionId)))).status).toBe(404);
  });

  it("rejects non-read methods and invalid generated session ids", async () => {
    const { service, sessionId } = await completedSession("video");
    const handler = createRecordingVideoHandler(service);

    const response = await handler(new Request(recordingVideoUrl(sessionId), { method: "POST" }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expect(() => recordingVideoUrl("../outside")).toThrow("Invalid session id");
  });
});

async function completedSession(video: string): Promise<{ service: SessionService; sessionId: string }> {
  const root = await temporaryRoot("replay-video-protocol-");
  const sessionId = "session-video";
  const sessionDirectory = join(root, "sessions", sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "video.mp4"), video, { mode: 0o600 });
  await writeMetadata(sessionDirectory, sessionId);
  return { service: sessionService(root), sessionId };
}

function sessionService(root: string): SessionService {
  return new SessionService({ on: () => () => {} } as unknown as SidecarClient, root);
}

async function writeMetadata(directory: string, sessionId: string): Promise<void> {
  await writeFile(join(directory, "meta.json"), JSON.stringify({
    schemaVersion: 1,
    sessionId,
    status: "completed",
    partial: false,
    startedAt: "2026-08-17T10:00:00Z",
    stoppedAt: "2026-08-17T10:00:10Z",
    display: { width: 100, height: 100, scale: 2 },
    narration: false,
    appVersions: {},
    eventCount: 0,
  }), { mode: 0o600 });
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
