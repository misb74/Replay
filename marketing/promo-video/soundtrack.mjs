import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(projectDir, "output", "replay-promo-score.wav");
const sampleRate = 48_000;
const duration = 74;
const channels = 2;
const samples = sampleRate * duration;
const left = new Float32Array(samples);
const right = new Float32Array(samples);
const tau = Math.PI * 2;
const beat = 60 / 96;

const chords = [
  [130.81, 164.81, 196.00, 246.94],
  [110.00, 130.81, 164.81, 196.00],
  [87.31, 130.81, 164.81, 220.00],
  [98.00, 146.83, 196.00, 220.00],
];
const melody = [329.63, 392.00, 440.00, 523.25, 440.00, 392.00, 329.63, 293.66];
const transitions = [8.6, 26.7, 35.3, 49.8, 55.0, 62.2, 67.1, 68.3];

let randomState = 0x51f15e;
const random = () => {
  randomState = (randomState * 1664525 + 1013904223) >>> 0;
  return randomState / 0xffffffff;
};

function addTone(time, frequency, length, volume, pan = 0, bell = false) {
  const start = Math.max(0, Math.floor(time * sampleRate));
  const end = Math.min(samples, Math.ceil((time + length) * sampleRate));
  for (let index = start; index < end; index += 1) {
    const local = index / sampleRate - time;
    const attack = Math.min(1, local / .018);
    const release = Math.exp(-local * (bell ? 3.7 : 1.3));
    const body = Math.sin(tau * frequency * local)
      + (bell ? .34 * Math.sin(tau * frequency * 2.01 * local) + .12 * Math.sin(tau * frequency * 3.98 * local) : .16 * Math.sin(tau * frequency * 2 * local));
    const value = body * attack * release * volume;
    left[index] += value * Math.sqrt((1 - pan) / 2);
    right[index] += value * Math.sqrt((1 + pan) / 2);
  }
}

function addWhoosh(time, length = .9, volume = .035) {
  const start = Math.floor(time * sampleRate);
  const end = Math.min(samples, Math.ceil((time + length) * sampleRate));
  let low = 0;
  for (let index = start; index < end; index += 1) {
    const local = (index - start) / (end - start);
    const envelope = Math.sin(Math.PI * local) ** 1.7;
    const noise = random() * 2 - 1;
    low += .08 * (noise - low);
    const airy = noise - low;
    const pan = Math.sin(local * Math.PI) * .55;
    left[index] += airy * envelope * volume * (1 - pan * .25);
    right[index] += airy * envelope * volume * (1 + pan * .25);
  }
}

// Slowly moving harmonic bed.
for (let index = 0; index < samples; index += 1) {
  const time = index / sampleRate;
  const chordPosition = Math.floor(time / 5) % chords.length;
  const chord = chords[chordPosition];
  const within = (time % 5) / 5;
  const chordEnvelope = Math.min(1, within / .35, (1 - within) / .45);
  const sceneLift = time < 26 ? .82 : time < 55 ? 1 : time < 68 ? 1.08 : .88;
  let l = 0;
  let r = 0;
  chord.forEach((frequency, voice) => {
    const drift = 1 + .0015 * Math.sin(time * .22 + voice * 1.4);
    const phase = tau * frequency * drift * time;
    const tone = Math.sin(phase) + .12 * Math.sin(phase * 2) + .05 * Math.sin(phase * .5);
    l += tone * (.012 + voice * .0018) * (1 - voice * .06);
    r += tone * (.012 + voice * .0018) * (1 + voice * .045);
  });
  const swell = .78 + .22 * Math.sin(time * .095) ** 2;
  left[index] += l * chordEnvelope * swell * sceneLift;
  right[index] += r * chordEnvelope * swell * sceneLift;
}

// Soft glass notes and bass pulses, locked to the reference's calm 96 BPM energy.
for (let note = 0; note * beat * 2 < duration - 3; note += 1) {
  const time = 1.1 + note * beat * 2;
  const frequency = melody[note % melody.length];
  addTone(time, frequency, 1.45, note % 4 === 0 ? .036 : .025, Math.sin(note * 1.7) * .42, true);
  if (note % 2 === 0) addTone(time, chords[Math.floor(time / 5) % chords.length][0] / 2, 2.2, .036, 0, false);
}

// Product interaction cues.
[9.0, 12.9, 16.7, 21.4, 29.2, 39.2, 44.5, 49.8, 55.7, 56.15, 56.6, 63.4, 64.3, 65.2, 66.1, 67.1].forEach((time, index) => {
  addTone(time, index === 7 || index === 15 ? 880 : 660, .34, index === 7 || index === 15 ? .055 : .027, index % 2 ? .18 : -.18, true);
});
transitions.forEach((time, index) => addWhoosh(time - .15, index === transitions.length - 1 ? 1.3 : .8, index === transitions.length - 1 ? .045 : .027));

// Master fade and gentle soft clipping.
let peak = 0;
for (let index = 0; index < samples; index += 1) {
  const time = index / sampleRate;
  const fadeIn = Math.min(1, time / 1.4);
  const fadeOut = Math.min(1, (duration - time) / 2.8);
  left[index] *= fadeIn * fadeOut;
  right[index] *= fadeIn * fadeOut;
  peak = Math.max(peak, Math.abs(left[index]), Math.abs(right[index]));
}
const gain = .83 / Math.max(.001, peak);
for (let index = 0; index < samples; index += 1) {
  left[index] = Math.tanh(left[index] * gain * .92);
  right[index] = Math.tanh(right[index] * gain * .92);
}

const bytesPerSample = 2;
const dataBytes = samples * channels * bytesPerSample;
const buffer = Buffer.alloc(44 + dataBytes);
buffer.write("RIFF", 0);
buffer.writeUInt32LE(36 + dataBytes, 4);
buffer.write("WAVE", 8);
buffer.write("fmt ", 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(sampleRate, 24);
buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
buffer.writeUInt16LE(channels * bytesPerSample, 32);
buffer.writeUInt16LE(16, 34);
buffer.write("data", 36);
buffer.writeUInt32LE(dataBytes, 40);
for (let index = 0; index < samples; index += 1) {
  buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[index])) * 32767), 44 + index * 4);
  buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[index])) * 32767), 46 + index * 4);
}
await writeFile(outputPath, buffer, { mode: 0o644 });
console.log(`Wrote original ${duration}s score to ${outputPath}`);
