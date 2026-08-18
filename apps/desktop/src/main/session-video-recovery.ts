import { constants } from "node:fs";
import { lstat, open, readdir, rename, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const VIDEO_FILE_NAME = "video.mp4";
const WRITER_SIDECAR_PREFIX = `${VIDEO_FILE_NAME}.sb-`;
const MAXIMUM_BOX_COUNT = 100_000;

const boxType = {
  ftyp: 0x6674_7970,
  mdat: 0x6D64_6174,
  moov: 0x6D6F_6F76,
  mvhd: 0x6D76_6864,
  trak: 0x7472_616B,
  mdia: 0x6D64_6961,
  hdlr: 0x6864_6C72,
  vide: 0x7669_6465,
  minf: 0x6D69_6E66,
  stbl: 0x7374_626C,
  stsd: 0x7374_7364,
  avc1: 0x6176_6331,
  avc3: 0x6176_6333,
  avcC: 0x6176_6343,
} as const;

interface FileIdentity {
  device: number;
  inode: number;
  size: number;
}

interface RecoveryCandidate extends FileIdentity {
  name: string;
  path: string;
}

interface MediaBox {
  type: number;
  payloadStart: number;
  end: number;
}

interface BoxBudget {
  remaining: number;
}

type DestinationState = { kind: "missing" } | ({ kind: "empty" } & FileIdentity) | { kind: "blocked" };

/**
 * AVAssetWriter keeps its durable output in a private `video.mp4.sb-*` sibling
 * until a normal finish publishes it. If the process is killed, recover the
 * unique safe, structurally valid sibling before the session is marked partial.
 */
export async function recoverInterruptedVideo(sessionDirectory: string): Promise<boolean> {
  try {
    const videoPath = join(sessionDirectory, VIDEO_FILE_NAME);
    const destination = await destinationState(videoPath);
    if (destination.kind === "blocked") return false;

    const candidates = await recoveryCandidates(sessionDirectory);
    if (candidates === undefined || candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (!candidate) return false;

    const handle = await open(candidate.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size <= 0 || !sameFile(candidate, opened)) return false;
      if (!await isValidAVAssetWriterVideo(handle, opened.size)) return false;

      // Recheck both names after validation so a file changed during the scan is
      // never published. The final operation is one same-directory atomic rename.
      if (!await candidateIsStillUnique(sessionDirectory, candidate, opened.size)) return false;
      if (!await destinationIsUnchanged(videoPath, destination)) return false;

      // Tighten permissions on the opened inode before it can become public.
      await handle.chmod(0o600);
      if (!await candidatePathStillNames(candidate, opened.size)) return false;
      if (!await destinationIsUnchanged(videoPath, destination)) return false;

      await rename(candidate.path, videoPath);
      await handle.chmod(0o600);
      return await destinationNamesOpenedFile(videoPath, identity(opened));
    } finally {
      await handle.close();
    }
  } catch {
    // Recovery is best effort. Unsafe, unreadable, or concurrently changing
    // files are retained in place for manual inspection.
    return false;
  }
}

async function destinationState(path: string): Promise<DestinationState> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size !== 0) return { kind: "blocked" };
    return { kind: "empty", ...identity(stats) };
  } catch (error) {
    if (isMissingFileError(error)) return { kind: "missing" };
    return { kind: "blocked" };
  }
}

async function destinationIsUnchanged(path: string, expected: DestinationState): Promise<boolean> {
  if (expected.kind === "blocked") return false;
  try {
    const stats = await lstat(path);
    return expected.kind === "empty"
      && !stats.isSymbolicLink()
      && stats.isFile()
      && stats.size === 0
      && sameFile(expected, stats);
  } catch (error) {
    return expected.kind === "missing" && isMissingFileError(error);
  }
}

async function recoveryCandidates(sessionDirectory: string): Promise<RecoveryCandidate[] | undefined> {
  const entries = await readdir(sessionDirectory, { withFileTypes: true });
  const candidates: RecoveryCandidate[] = [];
  for (const entry of entries) {
    if (!entry.name.startsWith(WRITER_SIDECAR_PREFIX) || entry.name.length === WRITER_SIDECAR_PREFIX.length) continue;
    const path = join(sessionDirectory, entry.name);
    let stats;
    try {
      stats = await lstat(path);
    } catch {
      return undefined;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) continue;
    candidates.push({ name: entry.name, path, ...identity(stats) });
  }
  return candidates;
}

async function candidateIsStillUnique(
  sessionDirectory: string,
  expected: RecoveryCandidate,
  expectedSize: number,
): Promise<boolean> {
  const candidates = await recoveryCandidates(sessionDirectory);
  const candidate = candidates?.[0];
  return candidates?.length === 1
    && candidate !== undefined
    && candidate.name === expected.name
    && candidate.size === expectedSize
    && sameIdentity(candidate, expected);
}

async function candidatePathStillNames(expected: RecoveryCandidate, expectedSize: number): Promise<boolean> {
  try {
    const stats = await lstat(expected.path);
    return !stats.isSymbolicLink()
      && stats.isFile()
      && stats.size === expectedSize
      && sameFile(expected, stats);
  } catch {
    return false;
  }
}

async function destinationNamesOpenedFile(path: string, opened: FileIdentity): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return !stats.isSymbolicLink()
      && stats.isFile()
      && stats.size === opened.size
      && sameFile(opened, stats)
      && (stats.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

function identity(stats: { dev: number; ino: number; size: number }): FileIdentity {
  return { device: stats.dev, inode: stats.ino, size: stats.size };
}

function sameFile(expected: FileIdentity, actual: { dev: number; ino: number }): boolean {
  return expected.device === actual.dev && expected.inode === actual.ino;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function isValidAVAssetWriterVideo(handle: FileHandle, byteCount: number): Promise<boolean> {
  if (!Number.isSafeInteger(byteCount) || byteCount < 24) return false;
  const budget: BoxBudget = { remaining: MAXIMUM_BOX_COUNT };
  const topLevel = await boxes(handle, 0, byteCount, budget, true);
  if (!topLevel || (topLevel[0]?.type !== boxType.ftyp && topLevel[0]?.type !== boxType.mdat)) return false;
  const movies = topLevel.filter((box) => box.type === boxType.moov);
  if (movies.length !== 1 || !topLevel.some((box) => box.type === boxType.mdat && box.end > box.payloadStart)) return false;
  const movie = movies[0];
  return movie !== undefined && containsExpectedVideoTrack(handle, movie, budget);
}

async function containsExpectedVideoTrack(handle: FileHandle, movie: MediaBox, budget: BoxBudget): Promise<boolean> {
  const children = await boxes(handle, movie.payloadStart, movie.end, budget);
  if (!children?.some((box) => box.type === boxType.mvhd && box.end - box.payloadStart >= 20)) return false;
  for (const track of children) {
    if (track.type === boxType.trak && await isExpectedVideoTrack(handle, track, budget)) return true;
  }
  return false;
}

async function isExpectedVideoTrack(handle: FileHandle, track: MediaBox, budget: BoxBudget): Promise<boolean> {
  const trackChildren = await boxes(handle, track.payloadStart, track.end, budget);
  if (!trackChildren) return false;
  for (const media of trackChildren) {
    if (media.type !== boxType.mdia) continue;
    const mediaChildren = await boxes(handle, media.payloadStart, media.end, budget);
    if (!mediaChildren) continue;
    const handler = mediaChildren.find((box) => box.type === boxType.hdlr);
    if (!handler || handler.end - handler.payloadStart < 12) continue;
    const handlerType = await readUInt32(handle, handler.payloadStart + 8);
    if (handlerType !== boxType.vide) continue;
    for (const mediaInfo of mediaChildren) {
      if (mediaInfo.type === boxType.minf && await containsH264SampleDescription(handle, mediaInfo, budget)) return true;
    }
  }
  return false;
}

async function containsH264SampleDescription(handle: FileHandle, mediaInfo: MediaBox, budget: BoxBudget): Promise<boolean> {
  const mediaInfoChildren = await boxes(handle, mediaInfo.payloadStart, mediaInfo.end, budget);
  if (!mediaInfoChildren) return false;
  for (const sampleTable of mediaInfoChildren) {
    if (sampleTable.type !== boxType.stbl) continue;
    const tableChildren = await boxes(handle, sampleTable.payloadStart, sampleTable.end, budget);
    if (!tableChildren) continue;
    for (const description of tableChildren) {
      if (description.type === boxType.stsd && await containsH264Entry(handle, description, budget)) return true;
    }
  }
  return false;
}

async function containsH264Entry(handle: FileHandle, description: MediaBox, budget: BoxBudget): Promise<boolean> {
  if (description.end - description.payloadStart < 8) return false;
  const prefix = await readExactly(handle, 8, description.payloadStart);
  if (!prefix) return false;
  const declaredEntryCount = prefix.readUInt32BE(4);
  if (declaredEntryCount === 0 || declaredEntryCount > 64) return false;
  const entries = await boxes(handle, description.payloadStart + 8, description.end, budget);
  if (!entries || entries.length !== declaredEntryCount) return false;

  for (const entry of entries) {
    if (entry.type !== boxType.avc1 && entry.type !== boxType.avc3) continue;
    const codecBoxesStart = entry.payloadStart + 78;
    if (codecBoxesStart > entry.end) continue;
    const codecBoxes = await boxes(handle, codecBoxesStart, entry.end, budget);
    const configuration = codecBoxes?.find((box) => box.type === boxType.avcC && box.end - box.payloadStart >= 7);
    if (!configuration) continue;
    const version = await readExactly(handle, 1, configuration.payloadStart);
    if (version?.[0] === 1) return true;
  }
  return false;
}

async function boxes(
  handle: FileHandle,
  start: number,
  end: number,
  budget: BoxBudget,
  allowFinalMediaDataToEnd = false,
): Promise<MediaBox[] | undefined> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return undefined;
  const parsed: MediaBox[] = [];
  let offset = start;
  while (offset < end) {
    if (budget.remaining <= 0 || end - offset < 8) return undefined;
    const header = await readExactly(handle, 8, offset);
    if (!header) return undefined;
    const shortSize = header.readUInt32BE(0);
    const type = header.readUInt32BE(4);
    let headerLength = 8;
    let boxLength: number;

    if (shortSize === 1) {
      if (end - offset < 16) return undefined;
      const extendedSize = await readExactly(handle, 8, offset + 8);
      if (!extendedSize) return undefined;
      const length = extendedSize.readBigUInt64BE(0);
      if (length > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      headerLength = 16;
      boxLength = Number(length);
    } else if (shortSize === 0) {
      if (!allowFinalMediaDataToEnd || type !== boxType.mdat) return undefined;
      boxLength = end - offset;
    } else {
      boxLength = shortSize;
    }

    if (boxLength < headerLength || boxLength > end - offset) return undefined;
    const boxEnd = offset + boxLength;
    budget.remaining -= 1;
    parsed.push({ type, payloadStart: offset + headerLength, end: boxEnd });
    offset = boxEnd;
  }
  return parsed;
}

async function readUInt32(handle: FileHandle, position: number): Promise<number | undefined> {
  const data = await readExactly(handle, 4, position);
  return data?.readUInt32BE(0);
}

async function readExactly(handle: FileHandle, count: number, position: number): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(count);
  let total = 0;
  while (total < count) {
    const result = await handle.read(buffer, total, count - total, position + total);
    if (result.bytesRead === 0) return undefined;
    total += result.bytesRead;
  }
  return buffer;
}
