import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionService } from "./session-service.js";
import { recoverInterruptedVideo } from "./session-video-recovery.js";
import type { SidecarClient } from "./sidecar-client.js";

describe("desktop startup video recovery", () => {
  it("atomically promotes the unique AVAssetWriter sidecar before marking the session interrupted", async () => {
    const { root, sessionDirectory } = await makeInterruptedSession("startup");
    const videoPath = join(sessionDirectory, "video.mp4");
    const candidatePath = join(sessionDirectory, "video.mp4.sb-valid");
    const emptyCandidatePath = join(sessionDirectory, "video.mp4.sb-empty");
    const expectedVideo = recoveryVideo({ extendedFirstMediaData: true, finalMediaDataToEnd: true });
    await writeFile(videoPath, "");
    await writeFile(emptyCandidatePath, "");
    await writeFile(candidatePath, expectedVideo);
    await chmod(candidatePath, 0o644);
    const candidateInode = (await stat(candidatePath)).ino;

    const service = new SessionService(inertSidecar(), root);
    await service.initialize();

    expect(await readFile(videoPath)).toEqual(expectedVideo);
    expect((await stat(videoPath)).ino).toBe(candidateInode);
    expect((await stat(videoPath)).mode & 0o777).toBe(0o600);
    await expect(lstat(candidatePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(emptyCandidatePath)).resolves.toBeDefined();
    await expect(service.readMetadata("session-startup")).resolves.toMatchObject({
      status: "interrupted",
      partial: true,
      interruptionReason: "sidecar_terminated",
    });
  });

  it("also promotes a valid sidecar when the public video is missing", async () => {
    const { root, sessionDirectory } = await makeInterruptedSession("missing-video");
    const expectedVideo = recoveryVideo();
    await writeFile(join(sessionDirectory, "video.mp4.sb-valid"), expectedVideo);

    await new SessionService(inertSidecar(), root).initialize();

    expect(await readFile(join(sessionDirectory, "video.mp4"))).toEqual(expectedVideo);
  });

  it("does not touch the files of a recording whose start acknowledgement is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-start-race-"));
    let acknowledgeStart: (() => void) | undefined;
    let filesCreated: (() => void) | undefined;
    const created = new Promise<void>((resolve) => { filesCreated = resolve; });
    const acknowledged = new Promise<void>((resolve) => { acknowledgeStart = resolve; });
    let sessionDirectory = "";
    let sessionId = "";
    const sidecar = {
      on: () => () => {},
      async request(command: string, payload: Record<string, unknown>) {
        if (command !== "record") throw new Error("unexpected command");
        sessionDirectory = String(payload.sessionDirectory);
        sessionId = String(payload.sessionId);
        await mkdir(sessionDirectory, { recursive: true });
        await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify(metadata(sessionId)));
        await writeFile(join(sessionDirectory, "video.mp4"), "");
        await writeFile(join(sessionDirectory, "video.mp4.sb-live"), recoveryVideo());
        filesCreated?.();
        await acknowledged;
        return { type: "recording_started" };
      },
    } as unknown as SidecarClient;
    const service = new SessionService(sidecar, root);
    const starting = service.start({
      microphone: false,
      display: { width: 100, height: 100, scale: 2 },
      appVersion: "test",
    });
    await created;

    await service.recoverIncomplete();

    expect((await service.readMetadata(sessionId)).status).toBe("recording");
    await expect(readFile(join(sessionDirectory, "video.mp4"))).resolves.toHaveLength(0);
    await expect(lstat(join(sessionDirectory, "video.mp4.sb-live"))).resolves.toBeDefined();
    acknowledgeStart?.();
    await expect(starting).resolves.toMatchObject({ id: sessionId, state: "recording" });
  });
});

describe("AVAssetWriter sidecar validation", () => {
  it("leaves ambiguous nonempty candidates in place", async () => {
    const directory = await makeVideoDirectory("ambiguous");
    const videoPath = join(directory, "video.mp4");
    const first = join(directory, "video.mp4.sb-first");
    const second = join(directory, "video.mp4.sb-second");
    await writeFile(videoPath, "");
    await writeFile(first, recoveryVideo());
    await writeFile(second, recoveryVideo());

    await expect(recoverInterruptedVideo(directory)).resolves.toBe(false);

    await expect(readFile(videoPath)).resolves.toHaveLength(0);
    await expect(lstat(first)).resolves.toBeDefined();
    await expect(lstat(second)).resolves.toBeDefined();
  });

  it.each([
    ["malformed BMFF", Buffer.from("not a QuickTime movie")],
    ["non-video media", recoveryVideo({ handlerType: "soun" })],
    ["non-H.264 video", recoveryVideo({ sampleEntryType: "hvc1" })],
    ["H.264 without configuration", recoveryVideo({ includeConfiguration: false })],
    ["invalid H.264 configuration", recoveryVideo({ configurationVersion: 2 })],
    ["a truncated box", Buffer.concat([uint32(200), Buffer.from("mdat"), Buffer.alloc(16)])],
  ])("refuses %s", async (_label, candidateContents) => {
    const directory = await makeVideoDirectory("invalid");
    const videoPath = join(directory, "video.mp4");
    const candidatePath = join(directory, "video.mp4.sb-invalid");
    await writeFile(videoPath, "");
    await writeFile(candidatePath, candidateContents);

    await expect(recoverInterruptedVideo(directory)).resolves.toBe(false);

    await expect(readFile(videoPath)).resolves.toHaveLength(0);
    await expect(readFile(candidatePath)).resolves.toEqual(candidateContents);
  });

  it("refuses a symbolic-link candidate without modifying its target", async () => {
    const directory = await makeVideoDirectory("candidate-link");
    const outside = join(directory, "outside.mp4");
    const candidatePath = join(directory, "video.mp4.sb-link");
    const contents = recoveryVideo();
    await writeFile(join(directory, "video.mp4"), "");
    await writeFile(outside, contents, { mode: 0o644 });
    await symlink(outside, candidatePath);

    await expect(recoverInterruptedVideo(directory)).resolves.toBe(false);

    expect((await lstat(candidatePath)).isSymbolicLink()).toBe(true);
    expect(await readFile(outside)).toEqual(contents);
    expect((await stat(outside)).mode & 0o777).toBe(0o644);
  });

  it("refuses a symbolic-link public video without replacing it", async () => {
    const directory = await makeVideoDirectory("video-link");
    const outside = join(directory, "outside-empty.mp4");
    const videoPath = join(directory, "video.mp4");
    const candidatePath = join(directory, "video.mp4.sb-valid");
    await writeFile(outside, "");
    await symlink(outside, videoPath);
    await writeFile(candidatePath, recoveryVideo());

    await expect(recoverInterruptedVideo(directory)).resolves.toBe(false);

    expect((await lstat(videoPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(outside)).resolves.toHaveLength(0);
    await expect(lstat(candidatePath)).resolves.toBeDefined();
  });

  it("ignores nonregular sidecars and refuses a nonregular public video", async () => {
    const candidateDirectory = await makeVideoDirectory("candidate-directory");
    await writeFile(join(candidateDirectory, "video.mp4"), "");
    await mkdir(join(candidateDirectory, "video.mp4.sb-directory"));
    await expect(recoverInterruptedVideo(candidateDirectory)).resolves.toBe(false);
    expect((await lstat(join(candidateDirectory, "video.mp4.sb-directory"))).isDirectory()).toBe(true);

    const videoDirectory = await makeVideoDirectory("video-directory");
    await mkdir(join(videoDirectory, "video.mp4"));
    const candidatePath = join(videoDirectory, "video.mp4.sb-valid");
    await writeFile(candidatePath, recoveryVideo());
    await expect(recoverInterruptedVideo(videoDirectory)).resolves.toBe(false);
    expect((await lstat(join(videoDirectory, "video.mp4"))).isDirectory()).toBe(true);
    await expect(lstat(candidatePath)).resolves.toBeDefined();
  });

  it("never overwrites an existing nonempty public video", async () => {
    const directory = await makeVideoDirectory("existing");
    const videoPath = join(directory, "video.mp4");
    const candidatePath = join(directory, "video.mp4.sb-valid");
    const existing = Buffer.from("already finalized");
    await writeFile(videoPath, existing);
    await writeFile(candidatePath, recoveryVideo());

    await expect(recoverInterruptedVideo(directory)).resolves.toBe(false);

    expect(await readFile(videoPath)).toEqual(existing);
    await expect(lstat(candidatePath)).resolves.toBeDefined();
  });
});

function inertSidecar(): SidecarClient {
  return { on: () => () => {} } as unknown as SidecarClient;
}

async function makeInterruptedSession(label: string): Promise<{ root: string; sessionDirectory: string }> {
  const root = await mkdtemp(join(tmpdir(), `replay-${label}-`));
  const sessionId = `session-${label}`;
  const sessionDirectory = join(root, "sessions", sessionId);
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(join(sessionDirectory, "events.jsonl"), "");
  await writeFile(join(sessionDirectory, "meta.json"), JSON.stringify(metadata(sessionId)));
  return { root, sessionDirectory };
}

async function makeVideoDirectory(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `replay-video-${label}-`));
}

function metadata(sessionId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    sessionId,
    status: "recording",
    partial: true,
    startedAt: "2026-08-17T10:00:00Z",
    display: { width: 100, height: 100, scale: 2 },
    narration: false,
    appVersions: {},
    eventCount: 0,
  };
}

function recoveryVideo(options: {
  handlerType?: string;
  sampleEntryType?: string;
  includeConfiguration?: boolean;
  configurationVersion?: number;
  extendedFirstMediaData?: boolean;
  finalMediaDataToEnd?: boolean;
} = {}): Buffer {
  const handler = Buffer.concat([
    Buffer.alloc(8),
    Buffer.from(options.handlerType ?? "vide"),
    Buffer.alloc(12),
  ]);
  const visualSampleEntry = Buffer.concat([
    Buffer.alloc(78),
    ...(options.includeConfiguration === false ? [] : [mediaBox("avcC", Buffer.from([
      options.configurationVersion ?? 1,
      100,
      0,
      40,
      0xFF,
      0xE1,
      0,
    ]))]),
  ]);
  const sampleDescription = Buffer.concat([
    Buffer.alloc(4),
    uint32(1),
    mediaBox(options.sampleEntryType ?? "avc1", visualSampleEntry),
  ]);
  const movie = mediaBox("moov", Buffer.concat([
    mediaBox("mvhd", Buffer.alloc(20)),
    mediaBox("trak", mediaBox("mdia", Buffer.concat([
      mediaBox("hdlr", handler),
      mediaBox("minf", mediaBox("stbl", mediaBox("stsd", sampleDescription))),
    ]))),
  ]));
  const mediaPayload = Buffer.from([0, 0, 0, 1, 0x65]);
  const firstMediaData = options.extendedFirstMediaData
    ? extendedMediaBox("mdat", mediaPayload)
    : mediaBox("mdat", mediaPayload);
  const finalMediaData = options.finalMediaDataToEnd
    ? Buffer.concat([uint32(0), Buffer.from("mdat"), mediaPayload])
    : Buffer.alloc(0);
  return Buffer.concat([firstMediaData, movie, finalMediaData]);
}

function mediaBox(type: string, payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length + 8), Buffer.from(type), payload]);
}

function extendedMediaBox(type: string, payload: Buffer): Buffer {
  const size = Buffer.alloc(8);
  size.writeBigUInt64BE(BigInt(payload.length + 16));
  return Buffer.concat([uint32(1), Buffer.from(type), size, payload]);
}

function uint32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32BE(value);
  return data;
}
