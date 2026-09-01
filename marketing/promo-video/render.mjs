import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";
import { chromium } from "playwright";

const projectDir = dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(projectDir, "output");
const pageUrl = new URL("./index.html?t=0", import.meta.url).href;
const width = 1920;
const height = 1080;
const fps = 24;
const duration = 74;
const frameCount = duration * fps;
const previewTimes = [1.5, 5.5, 10.5, 14, 18, 23, 29, 33, 37, 42, 46, 50.5, 57.5, 60.5, 64, 67.5, 70, 72.5];
const mode = process.argv.includes("--stills") ? "stills" : "video";

await mkdir(outputDir, { recursive: true, mode: 0o755 });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: "light",
  reducedMotion: "no-preference",
});
const page = await context.newPage();
await page.goto(pageUrl, { waitUntil: "load" });
await page.waitForFunction(() => window.promoReady === true);
await page.evaluate(() => document.fonts.ready);

if (mode === "stills") {
  const stillDir = path.join(outputDir, "stills");
  await mkdir(stillDir, { recursive: true, mode: 0o755 });
  for (const timestamp of previewTimes) {
    await page.evaluate((time) => window.ReplayPromo.renderAt(time), timestamp);
    const filename = `replay-${timestamp.toFixed(1).padStart(4, "0").replace(".", "-")}s.png`;
    await page.screenshot({ path: path.join(stillDir, filename), type: "png" });
  }
  await browser.close();
  console.log(`Rendered ${previewTimes.length} review stills to ${stillDir}`);
  process.exit(0);
}

const silentPath = path.join(outputDir, "replay-promo-silent.mp4");
const ffmpeg = spawn("/opt/homebrew/bin/ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-f", "image2pipe", "-framerate", String(fps), "-vcodec", "png", "-i", "pipe:0",
  "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "16",
  "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.1",
  "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-tag:v", "avc1", "-movflags", "+faststart", silentPath,
], { stdio: ["pipe", "inherit", "inherit"] });

const startedAt = Date.now();
for (let frame = 0; frame < frameCount; frame += 1) {
  await page.evaluate((time) => window.ReplayPromo.renderAt(time), frame / fps);
  const png = await page.screenshot({ type: "png" });
  if (!ffmpeg.stdin.write(png)) await once(ffmpeg.stdin, "drain");
  if (frame > 0 && frame % (fps * 5) === 0) {
    const renderedSeconds = Math.floor(frame / fps);
    process.stdout.write(`Rendered ${renderedSeconds}s / ${duration}s\n`);
  }
}

ffmpeg.stdin.end();
const [exitCode] = await once(ffmpeg, "close");
await browser.close();
if (exitCode !== 0) throw new Error(`FFmpeg exited with code ${exitCode}`);
console.log(`Rendered ${silentPath} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
