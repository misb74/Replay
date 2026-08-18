#!/usr/bin/env node

import {
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";

const FFMPEG = process.env.REPLAY_FFMPEG_BINARY || "/opt/homebrew/bin/ffmpeg";
const WHISPER = process.env.REPLAY_WHISPER_BINARY || "/opt/homebrew/bin/whisper-cli";
const MODEL = process.env.REPLAY_WHISPER_MODEL || "/opt/homebrew/opt/whisper-cpp/share/whisper-cpp/models/ggml-base.bin";
const MAX_WHISPER_JSON_BYTES = 32 * 1024 * 1024;

const exits = Object.freeze({
  usage: 64,
  audio: 65,
  whisper: 66,
  result: 67,
  output: 68,
  unavailable: 69,
});

let activeChild;
let forceKillTimer;
let terminationSignal;

async function main() {
  const input = requiredArgument("--input");
  const output = requiredArgument("--output-json");
  const language = (optionalArgument("--language") || "auto").toLowerCase();
  if (!isAbsolute(input) || (output !== "-" && !isAbsolute(output)) || !/^(?:auto|[a-z]{2,3})$/u.test(language)) {
    throw failure(exits.usage, "Replay's local transcription helper received invalid settings.");
  }

  requireExecutable(FFMPEG);
  requireExecutable(WHISPER);
  requireReadableFile(MODEL, exits.unavailable, "Replay cannot find a required local transcription component.");
  requireReadableFile(input, exits.audio, "Replay could not read this recording's narration audio.");

  const workingDirectory = mkdtempSync(join(tmpdir(), "replay-whisper-"));
  try {
    const wavePath = join(workingDirectory, "narration.wav");
    const outputPrefix = join(workingDirectory, "transcript");

    await run(FFMPEG, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", input,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavePath,
    ], exits.audio, "Replay could not decode this recording's narration audio.");
    await run(WHISPER, [
      "-ng", "-m", MODEL, "-f", wavePath, "-l", language,
      "-oj", "-of", outputPrefix, "-np",
    ], exits.whisper, "The local Whisper engine could not transcribe this recording.");

    throwIfTerminating();
    const raw = readWhisperResult(`${outputPrefix}.json`);
    const segments = normalizeSegments(raw.transcription);
    const detectedLanguage = typeof raw?.result?.language === "string" && raw.result.language.trim()
      ? raw.result.language.trim().toLowerCase()
      : language === "auto" ? undefined : language;
    const transcript = {
      version: 1,
      ...(detectedLanguage ? { language: detectedLanguage } : {}),
      segments,
    };
    const json = `${JSON.stringify(transcript)}\n`;
    await writeTranscript(output, json);
    throwIfTerminating();
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

class HelperFailure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

function failure(exitCode, message) {
  return new HelperFailure(exitCode, message);
}

function requiredArgument(name) {
  const value = optionalArgument(name);
  if (!value || value.startsWith("--")) {
    throw failure(exits.usage, "Replay's local transcription helper received invalid settings.");
  }
  return value;
}

function optionalArgument(name) {
  const indexes = process.argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) {
    throw failure(exits.usage, "Replay's local transcription helper received invalid settings.");
  }
  const index = indexes[0];
  return index === undefined || index + 1 >= process.argv.length ? undefined : process.argv[index + 1];
}

function requireExecutable(path) {
  if (!isAbsolute(path)) {
    throw failure(exits.usage, "Replay's local transcription helper received invalid settings.");
  }
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw failure(exits.unavailable, "Replay cannot find a required local transcription component.");
  }
}

function requireReadableFile(path, exitCode, message) {
  if (!isAbsolute(path)) throw failure(exits.usage, "Replay's local transcription helper received invalid settings.");
  try {
    accessSync(path, constants.R_OK);
    if (!statSync(path).isFile()) throw new Error("not a file");
  } catch {
    throw failure(exitCode, message);
  }
}

function readWhisperResult(path) {
  try {
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_WHISPER_JSON_BYTES) throw new Error("invalid size");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.transcription)) throw new Error("invalid shape");
    return raw;
  } catch {
    throw failure(exits.result, "The local Whisper engine returned an invalid timestamped result.");
  }
}

function normalizeSegments(entries) {
  const normalized = entries.flatMap((entry) => {
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    const startMs = finiteOffset(entry?.offsets?.from);
    const endMs = finiteOffset(entry?.offsets?.to);
    if (!text || startMs === undefined || endMs === undefined || endMs < startMs || isNonSpeech(text)) return [];
    return [{ startMs, endMs, text }];
  }).sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  return normalized.map((segment, index) => ({
    id: `transcript-${String(index + 1).padStart(3, "0")}`,
    ...segment,
  }));
}

function finiteOffset(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function isNonSpeech(text) {
  return /^\s*[[(](?:music|silence|blank[_ ]audio|no speech|noise|background noise|inaudible|unintelligible|applause|laughter|laughs|cough|coughing|breathing|static)[)\]]\s*[.!?]?\s*$/iu.test(text)
    || /^\s*[♪♫♬♩\s.]+$/u.test(text);
}

function writeTranscript(output, json) {
  throwIfTerminating();
  if (output === "-") {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (cause) => {
        if (settled) return;
        settled = true;
        process.stdout.removeListener("error", finish);
        if (cause) reject(failure(exits.output, "Replay could not return the local transcript safely."));
        else resolve();
      };
      process.stdout.once("error", finish);
      process.stdout.write(json, finish);
    });
  }

  let descriptor;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    descriptor = openSync(output, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, json, { encoding: "utf8" });
  } catch {
    throw failure(exits.output, "Replay could not save the local transcript safely.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function run(executable, args, exitCode, message) {
  throwIfTerminating();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "ignore"] });
    activeChild = child;
    if (terminationSignal) stopChild(child);

    child.once("error", () => {
      clearActiveChild(child);
      reject(terminationSignal ? new Error("cancelled") : failure(exits.unavailable, "Replay cannot find a required local transcription component."));
    });
    child.once("close", (code) => {
      clearActiveChild(child);
      if (terminationSignal) reject(new Error("cancelled"));
      else if (code === 0) resolve();
      else reject(failure(exitCode, message));
    });
  });
}

function requestTermination(signal) {
  if (terminationSignal) return;
  terminationSignal = signal;
  if (activeChild) stopChild(activeChild);
}

function stopChild(child) {
  child.kill("SIGTERM");
  if (forceKillTimer) clearTimeout(forceKillTimer);
  forceKillTimer = setTimeout(() => {
    if (activeChild === child) child.kill("SIGKILL");
  }, 2_000);
}

function clearActiveChild(child) {
  if (activeChild === child) activeChild = undefined;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  forceKillTimer = undefined;
}

function throwIfTerminating() {
  if (terminationSignal) throw new Error("cancelled");
}

process.once("SIGINT", () => requestTermination("SIGINT"));
process.once("SIGTERM", () => requestTermination("SIGTERM"));

try {
  await main();
} catch (cause) {
  if (terminationSignal) {
    process.exitCode = terminationSignal === "SIGINT" ? 130 : 143;
  } else {
    const safeFailure = cause instanceof HelperFailure
      ? cause
      : failure(1, "Replay's local transcription helper could not process this recording.");
    process.stderr.write(`${safeFailure.message}\n`);
    process.exitCode = safeFailure.exitCode;
  }
}
