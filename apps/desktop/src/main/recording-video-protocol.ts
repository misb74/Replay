import { Readable } from "node:stream";
import type { FileHandle } from "node:fs/promises";

export const recordingVideoScheme = "replay-video";
export const recordingVideoPrivileges = {
  standard: true,
  secure: true,
  stream: true,
  bypassCSP: false,
  supportFetchAPI: false,
  corsEnabled: false,
  allowServiceWorkers: false,
} as const;

const safeSessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/u;

export interface RecordingVideoSource {
  openVideoForPlayback(sessionId: string): Promise<FileHandle>;
}

export function recordingVideoUrl(sessionId: string): string {
  if (!safeSessionId.test(sessionId)) throw new Error("Invalid session id");
  return `${recordingVideoScheme}://recording/${sessionId}/video.mp4`;
}

export function createRecordingVideoHandler(source: RecordingVideoSource): (request: Request) => Promise<Response> {
  return async (request) => {
    const sessionId = sessionIdFromUrl(request.url);
    if (!sessionId) return responseWithStatus(404);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return responseWithStatus(405, { Allow: "GET, HEAD" });
    }

    let file: FileHandle;
    try {
      file = await source.openVideoForPlayback(sessionId);
    } catch {
      // Missing, incomplete, malformed, and unsafe recordings are deliberately
      // indistinguishable to the renderer.
      return responseWithStatus(404);
    }

    let size: number;
    try {
      const stats = await file.stat();
      if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0) throw new Error("Invalid recording video");
      size = stats.size;
    } catch {
      await file.close().catch(() => undefined);
      return responseWithStatus(404);
    }

    const requestedRange = request.headers.get("range");
    const range = requestedRange === null ? { start: 0, end: size - 1 } : parseSingleRange(requestedRange, size);
    if (!range) {
      await file.close().catch(() => undefined);
      return responseWithStatus(416, { "Content-Range": `bytes */${size}` });
    }

    const partial = requestedRange !== null;
    const contentLength = range.end - range.start + 1;
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Length": String(contentLength),
      "Content-Type": "video/mp4",
      "X-Content-Type-Options": "nosniff",
    });
    if (partial) headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);

    if (request.method === "HEAD") {
      await file.close().catch(() => undefined);
      return new Response(null, { status: partial ? 206 : 200, headers });
    }

    const stream = file.createReadStream({
      start: range.start,
      end: range.end,
      autoClose: true,
      signal: request.signal,
    });
    try {
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status: partial ? 206 : 200,
        headers,
      });
    } catch (cause) {
      stream.destroy();
      throw cause;
    }
  };
}

function sessionIdFromUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${recordingVideoScheme}:`
    || url.hostname !== "recording"
    || url.username !== ""
    || url.password !== ""
    || url.port !== ""
    || url.search !== ""
    || url.hash !== "") return undefined;
  const match = /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,160})\/video\.mp4$/u.exec(url.pathname);
  return match?.[1];
}

function parseSingleRange(value: string, size: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (match[1] === "" && match[2] === "")) return undefined;

  if (match[1] === "") {
    const suffixLength = numericRangePart(match[2]);
    if (suffixLength === undefined || suffixLength === 0) return undefined;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = numericRangePart(match[1]);
  if (start === undefined || start >= size) return undefined;
  if (match[2] === "") return { start, end: size - 1 };

  const requestedEnd = numericRangePart(match[2]);
  if (requestedEnd === undefined || requestedEnd < start) return undefined;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function numericRangePart(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function responseWithStatus(status: number, extraHeaders?: Record<string, string>): Response {
  return new Response(null, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}
