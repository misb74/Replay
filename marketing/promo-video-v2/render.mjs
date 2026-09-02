// Deterministic renderer for the Replay film v2.
//
//   node marketing/promo-video-v2/render.mjs --stills          review stills + contact sheet
//   node marketing/promo-video-v2/render.mjs                   silent 1080p30 master
//   node marketing/promo-video-v2/render.mjs --poster          poster frame only
//
// Every frame is produced by calling window.ReplayFilm.renderAt(seconds) in headless Chromium
// and piping PNGs to ffmpeg, so the result is identical on every run.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";
import { chromium } from "playwright";

const projectDir = dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(projectDir, "output");
const pageUrl = new URL("./index.html?t=0", import.meta.url).href;
const ffmpegPath = process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const width = 1920;
const height = 1080;
const fps = 30;
const duration = 82;
const frameCount = duration * fps;
const previewTimes = [1.2, 3.6, 7.0, 10.4, 13.6, 17.2, 19.8, 21.4, 24.4, 27.4, 30.4, 33.0, 38.4, 42.6, 45.9, 48.0, 53.2, 57.9, 61.2, 64.3, 66.8, 71.2, 74.4, 79.6];
const posterTime = 30.4;
const args = new Set(process.argv.slice(2));
const mode = args.has("--stills") ? "stills" : args.has("--poster") ? "poster" : "video";

await mkdir(outputDir, { recursive: true, mode: 0o755 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  reducedMotion: "no-preference",
});
const page = await context.newPage();
await page.goto(pageUrl, { waitUntil: "load" });
await page.waitForFunction(() => window.filmReady === true);
await page.evaluate(() => document.fonts.ready);

const stillName = (time) => `film-${time.toFixed(1).padStart(5, "0").replace(".", "-")}s.png`;

async function runFfmpeg(ffmpegArgs) {
  const child = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...ffmpegArgs], { stdio: "inherit" });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
}

if (mode === "stills") {
  const stillDir = path.join(outputDir, "stills");
  await rm(stillDir, { recursive: true, force: true });
  await mkdir(stillDir, { recursive: true, mode: 0o755 });
  for (const time of previewTimes) {
    await page.evaluate((seconds) => window.ReplayFilm.renderAt(seconds), time);
    await page.screenshot({ path: path.join(stillDir, stillName(time)), type: "png" });
  }
  await browser.close();
  // Contact sheet: 4 columns, scaled to 480px wide each.
  await runFfmpeg([
    "-framerate", "1", "-pattern_type", "glob", "-i", path.join(stillDir, "film-*.png"),
    "-vf", `scale=480:-1,tile=4x${Math.ceil(previewTimes.length / 4)}:padding=6:margin=6:color=0x06090f`,
    "-frames:v", "1", "-q:v", "3", path.join(outputDir, "contact-sheet.jpg"),
  ]);
  console.log(`Rendered ${previewTimes.length} stills and contact-sheet.jpg to ${outputDir}`);
  process.exit(0);
}

if (mode === "poster") {
  await page.evaluate((seconds) => window.ReplayFilm.renderAt(seconds), posterTime);
  const posterPng = path.join(outputDir, "poster.png");
  await page.screenshot({ path: posterPng, type: "png" });
  await browser.close();
  await runFfmpeg(["-i", posterPng, "-q:v", "2", path.join(outputDir, "replay-film-poster.jpg")]);
  await rm(posterPng, { force: true });
  console.log(`Rendered poster frame at ${posterTime}s`);
  process.exit(0);
}

const silentPath = path.join(outputDir, "replay-film-silent.mp4");
const ffmpeg = spawn(ffmpegPath, [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "png", "-i", "pipe:0",
  "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "18",
  "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2",
  "-x264-params", "aq-mode=3:aq-strength=1.0:deblock=-1,-1",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-tag:v", "avc1", "-movflags", "+faststart", silentPath,
], { stdio: ["pipe", "inherit", "inherit"] });

const startedAt = Date.now();
for (let frame = 0; frame < frameCount; frame += 1) {
  await page.evaluate((seconds) => window.ReplayFilm.renderAt(seconds), frame / fps);
  let png;
  try {
    png = await page.screenshot({ type: "png", timeout: 120_000 });
  } catch (error) {
    process.stdout.write(`Screenshot of frame ${frame} failed once (${error.message.split("\n")[0]}); retrying\n`);
    await page.evaluate((seconds) => window.ReplayFilm.renderAt(seconds), frame / fps);
    png = await page.screenshot({ type: "png", timeout: 120_000 });
  }
  if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, "drain");
  if (frame > 0 && frame % (fps * 5) === 0) {
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = frame / elapsed;
    process.stdout.write(`Rendered ${Math.floor(frame / fps)}s / ${duration}s  (${rate.toFixed(1)} fps, ~${Math.round((frameCount - frame) / rate)}s left)\n`);
  }
}

ffmpeg.stdin.end();
const [exitCode] = await once(ffmpeg, "close");
await browser.close();
if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);
console.log(`Rendered ${silentPath} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
