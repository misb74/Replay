// Original score for the Replay film v2, synthesised from scratch in Node with no samples.
//
//   node marketing/promo-video-v2/soundtrack.mjs
//
// 84 BPM in D minor, resolving to D major on the brand lockup. A plucked-string motif
// (Karplus–Strong), a filtered saw arpeggio, a detuned saw pad through a state-variable
// filter, a sub bass, and a small kit (kick, rim, hat) sit under sound design that is
// locked to the picture: clicks, the record beep, the "develop" whooshes, the amber
// question alert, keystrokes, hash ticks, the approval stamp, receipts, and the final
// D-major arrival with the lockup. Nothing here is shared with the 2026 launch film.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path, { dirname } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(projectDir, "output", "replay-film-score.wav");
const SR = 48_000;
const DUR = 82;
const N = SR * DUR;
const TAU = Math.PI * 2;
const BPM = 84;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const bar = (b) => b * BAR;
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Buses. Pad/arp get side-chained; pluck goes to a ping-pong delay; most things send to one reverb.
const L = new Float32Array(N), R = new Float32Array(N);
const PL = new Float32Array(N), PR = new Float32Array(N);   // side-chained
const DL = new Float32Array(N), DR = new Float32Array(N);   // delay send
const VL = new Float32Array(N), VR = new Float32Array(N);   // reverb send

let seed = 0x2f6e2b1;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const noise = () => rnd() * 2 - 1;
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const panLR = (v, p) => { const a = (p + 1) * Math.PI / 4; return [v * Math.cos(a), v * Math.sin(a)]; };

/* ---------- film timing (mirrors timeline.js) ---------- */
const REC = { start: 8.57, end: 20.0, len: 21 };
const RUN = { start: 58.5, end: 65.5, len: 12 };
const tcT = (tc) => REC.start + (tc / REC.len) * (REC.end - REC.start);
const rtcT = (r) => RUN.start + (r / RUN.len) * (RUN.end - RUN.start);

/* ---------- energy curve: how much of the kit and how open the filters are ---------- */
const ENERGY_POINTS = [[0, .08], [8.3, .08], [8.57, .35], [20, .5], [20.3, .28], [22.6, .18], [25.7, .18], [26.1, .55], [33.6, .62], [34.3, .3], [41.4, .3], [43.6, .45], [45.6, .55], [45.71, .8], [57.1, .85], [57.3, .9], [68.5, .92], [68.6, .32], [72.6, .32], [74.3, .14], [82, .04]];
const ENERGY = new Float32Array(DUR * 100 + 1);
for (let i = 0; i < ENERGY.length; i += 1) {
  const t = i / 100;
  let k = 1;
  while (k < ENERGY_POINTS.length - 1 && ENERGY_POINTS[k][0] < t) k += 1;
  const [t1, e1] = ENERGY_POINTS[k - 1], [t2, e2] = ENERGY_POINTS[k];
  ENERGY[i] = e1 + (e2 - e1) * clamp((t - t1) / (t2 - t1));
}
const energy = (t) => ENERGY[Math.min(ENERGY.length - 1, Math.max(0, Math.floor(t * 100)))];

/* ---------- harmony ---------- */
const CHORDS = { Dm: [50, 57, 60, 65], Bb: [46, 53, 58, 62], F: [45, 53, 57, 60], C: [48, 55, 60, 64], Gm: [43, 50, 55, 58], Asus: [45, 52, 57, 62], A: [45, 52, 57, 61], Dmaj: [50, 57, 62, 66] };
const ROOTS = { Dm: 38, Bb: 34, F: 41, C: 36, Gm: 31, Asus: 33, A: 33, Dmaj: 38 };
const PROG = [
  [bar(0), "Dm"], [bar(3), "Dm"], [bar(4), "Bb"], [bar(5), "F"], [bar(6), "C"],
  [bar(7), "Dm"], [bar(8), "Bb"], [bar(9), "F"], [bar(10), "C"], [bar(11), "Gm"],
  [bar(12), "Gm"], [bar(13), "Asus"], [bar(14), "A"], [bar(15), "Asus"],
  [bar(16), "F"], [bar(17), "C"], [bar(18), "Dm"], [bar(19), "Bb"],
  [bar(20), "Dm"], [bar(21), "Bb"], [bar(22), "F"], [bar(23), "C"],
  [bar(24), "Bb"], [bar(25), "C"], [bar(26), "Dm"], [77.0, "Dmaj"],
];
const chordAt = (t) => { let name = PROG[0][1]; for (const [start, n] of PROG) if (t >= start) name = n; return name; };
const segments = PROG.map(([start, name], i) => [start, i + 1 < PROG.length ? PROG[i + 1][0] : DUR, name]);

/* ---------- primitives ---------- */
let currentLabel = "init";
function render(t0, len, fn, { send = 0, bus = "main", delay = 0 } = {}) {
  const start = Math.max(0, Math.floor(t0 * SR));
  const end = Math.min(N, Math.ceil((t0 + len) * SR));
  const [OL, OR] = bus === "pad" ? [PL, PR] : [L, R];
  for (let i = start; i < end; i += 1) {
    const tl = Math.max(0, i / SR - t0);
    const [l, r] = fn(tl, i / SR);
    if (!Number.isFinite(l) || !Number.isFinite(r)) throw new Error(`non-finite sample from ${currentLabel} at ${(i / SR).toFixed(3)}s`);
    OL[i] += l; OR[i] += r;
    if (send) { VL[i] += l * send; VR[i] += r * send; }
    if (delay) { DL[i] += l * delay; DR[i] += r * delay; }
  }
}
const polyblep = (ph, dt) => {
  if (ph < dt) { ph /= dt; return ph + ph - ph * ph - 1; }
  if (ph > 1 - dt) { ph = (ph - 1) / dt; return ph * ph + ph + ph + 1; }
  return 0;
};
// Chamberlin state-variable low-pass.
function svf() {
  let low = 0, band = 0;
  return (x, fc, q) => {
    const f = 2 * Math.sin(Math.PI * Math.min(Math.max(fc, 20), 7000) / SR);
    // two half-steps per sample keeps the Chamberlin form stable up to the clamped cutoff
    for (let k = 0; k < 2; k += 1) { low += (f * .5) * band; const high = x - low - q * band; band += (f * .5) * high; }
    return low;
  };
}

function pad(t0, t1, notes, { attack = .7, release = 1.6, vol = .05, send = .45 } = {}) {
  currentLabel = 'pad';
  const voices = notes.map((midi, v) => ({
    f: hz(midi), ph: [rnd(), rnd(), rnd()], filt: svf(), pan: (v - 1.5) * .35, hp: 0,
  }));
  render(t0, t1 - t0 + release, (tl, t) => {
    const gate = t < t1 ? 1 : Math.max(0, 1 - (t - t1) / release);
    const env = Math.min(1, tl / attack) * gate * gate;
    const e = energy(t);
    const cutoff = 220 + 2100 * e + 260 * Math.sin(t * .37);
    let l = 0, r = 0;
    for (const voice of voices) {
      let s = 0;
      for (let k = 0; k < 3; k += 1) {
        const detune = [.9965, 1, 1.0038][k];
        const dt = voice.f * detune / SR;
        voice.ph[k] += dt; if (voice.ph[k] >= 1) voice.ph[k] -= 1;
        s += (2 * voice.ph[k] - 1 - polyblep(voice.ph[k], dt)) * (k === 1 ? .5 : .32);
      }
      const raw = voice.filt(s, cutoff, .95) * vol * env;
      voice.hp += .0288 * (raw - voice.hp);
      const y = raw - voice.hp;
      const [pl, pr] = panLR(y, voice.pan);
      l += pl; r += pr;
    }
    return [l, r];
  }, { bus: "pad", send });
}

function sub(t0, t1, midi, { vol = .06 } = {}) {
  currentLabel = 'sub';
  const f = hz(midi);
  render(t0, t1 - t0 + .25, (tl, t) => {
    const gate = t < t1 ? 1 : Math.max(0, 1 - (t - t1) / .25);
    const env = Math.min(1, tl / .04) * gate;
    const e = energy(t);
    const pulse = e > .62 ? .72 + .28 * Math.max(0, Math.cos(TAU * (t / (BEAT / 2)))) : 1;
    const s = Math.sin(TAU * f * t) + .18 * Math.sin(TAU * f * 2 * t);
    const y = Math.tanh(s * 1.3) * vol * env * pulse * (.55 + .45 * e);
    return [y, y];
  });
}

function arpNote(t0, midi, len, e, pan) {
  currentLabel = 'arpNote';
  const f = hz(midi); let ph = 0; const filt = svf();
  render(t0, len + .05, (tl) => {
    const dt = f / SR; ph += dt; if (ph >= 1) ph -= 1;
    const s = 2 * ph - 1 - polyblep(ph, dt);
    const amp = Math.min(1, tl / .004) * Math.exp(-tl * 9) * (tl < len ? 1 : Math.max(0, 1 - (tl - len) / .05));
    const cutoff = 260 + (500 + 3400 * e) * Math.exp(-tl * 11);
    const y = filt(s, cutoff, 1.15) * amp * (.1 + .1 * e);
    return panLR(y, pan);
  }, { bus: "pad", send: .2 });
}

function pluck(t0, midi, len, vol = .3, pan = 0, bright = .55) {
  currentLabel = 'pluck';
  const f = hz(midi);
  const period = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(period);
  let lp = 0;
  for (let i = 0; i < period; i += 1) { const n = noise(); lp += (bright) * (n - lp); buf[i] = lp; }
  let idx = 0;
  const decay = Math.min(.9992, .996 + f / 900000);
  render(t0, len, (tl) => {
    const out = buf[idx];
    const next = buf[(idx + 1) % period];
    buf[idx] = (out + next) * .5 * decay;
    idx = (idx + 1) % period;
    const fade = tl > len * .75 ? Math.max(0, 1 - (tl - len * .75) / (len * .25)) : 1;
    return panLR(out * vol * 1.9 * fade, pan);
  }, { send: .4, delay: .32 });
}

const kickTimes = [];
function kick(t0, vol = .9) {
  currentLabel = 'kick';
  kickTimes.push(t0);
  let ph = 0;
  render(t0, .42, (tl) => {
    const f = 44 + 130 * Math.exp(-tl * 34);
    ph += f / SR;
    const body = Math.sin(TAU * ph);
    const amp = Math.exp(-tl * 8.5) * Math.min(1, tl / .0015);
    const click = tl < .004 ? noise() * .35 * (1 - tl / .004) : 0;
    const y = (Math.tanh(body * 1.7) * .9 + click) * amp * vol * .4;
    return [y, y];
  }, { send: .06 });
}
function rim(t0, vol = .5) {
  currentLabel = 'rim';
  let lp = 0, lp2 = 0;
  render(t0, .09, (tl) => {
    const n = noise(); lp += .35 * (n - lp); lp2 += .08 * (lp - lp2);
    const band = lp - lp2;
    const amp = Math.exp(-tl * 70);
    const ping = Math.sin(TAU * 1900 * tl) * Math.exp(-tl * 160) * .5;
    const y = (band * 1.4 + ping) * amp * vol * .46;
    return panLR(y, .18);
  }, { send: .25 });
}
function hat(t0, vol = .3, len = .05) {
  currentLabel = 'hat';
  let lp = 0;
  render(t0, len * 2, (tl) => {
    const n = noise(); lp += .22 * (n - lp);
    const hp = n - lp;
    const amp = Math.exp(-tl / len * 4.5);
    const y = hp * amp * vol * .46;
    return panLR(y, -.22);
  }, { send: .12 });
}

/* sound design */
function click(t0, vol = .5, f = 2600) {
  currentLabel = 'click';
  render(t0, .05, (tl) => {
    const burst = tl < .003 ? noise() * (1 - tl / .003) : 0;
    const ping = Math.sin(TAU * f * tl) * Math.exp(-tl * 140);
    const y = (burst * .7 + ping * .6) * vol * .22;
    return [y, y];
  }, { send: .15 });
}
function key(t0, vol = .35) {
  currentLabel = 'key';
  const f = 3200 + rnd() * 900;
  render(t0, .03, (tl) => {
    const burst = tl < .0025 ? noise() * (1 - tl / .0025) : 0;
    const ping = Math.sin(TAU * f * tl) * Math.exp(-tl * 260);
    const y = (burst * .9 + ping * .35) * vol * .16;
    return panLR(y, (rnd() - .5) * .3);
  });
}
function bell(t0, midi, len = .9, vol = .16, pan = 0) {
  currentLabel = 'bell';
  const f = hz(midi);
  render(t0, len, (tl) => {
    const env = Math.min(1, tl / .006) * Math.exp(-tl * (3.2 / len) * 1.6);
    const s = Math.sin(TAU * f * tl) + .28 * Math.sin(TAU * f * 2.002 * tl) * Math.exp(-tl * 5) + .1 * Math.sin(TAU * f * 3.01 * tl) * Math.exp(-tl * 9);
    return panLR(s * env * vol * 1.3, pan);
  }, { send: .5 });
}
function whoosh(t0, len = .7, vol = .25, dir = 1) {
  currentLabel = 'whoosh';
  let lp = 0, lp2 = 0;
  render(t0, len, (tl) => {
    const p = tl / len;
    const env = Math.pow(Math.sin(Math.PI * p), 1.6);
    const cutoff = dir > 0 ? .02 + .3 * p * p : .32 - .3 * p;
    const n = noise(); lp += cutoff * (n - lp); lp2 += .03 * (lp - lp2);
    const y = (lp - lp2) * env * vol * .6;
    return panLR(y, Math.sin(p * Math.PI) * .5 * dir);
  }, { send: .35 });
}
function riser(t0, len, vol = .3) {
  currentLabel = 'riser';
  let lp = 0;
  render(t0, len, (tl) => {
    const p = tl / len;
    const n = noise(); lp += (.01 + .45 * p * p * p) * (n - lp);
    const y = lp * p * p * vol * .7;
    return panLR(y, Math.sin(tl * 7) * .4);
  }, { send: .4 });
}
function beep(t0, notes, len = .07, vol = .18) {
  currentLabel = 'beep';
  notes.forEach((f, i) => render(t0 + i * len, len, (tl) => {
    const env = Math.min(1, tl / .004) * Math.min(1, (len - tl) / .01);
    const y = Math.sin(TAU * f * tl) * env * vol * .5;
    return [y, y];
  }, { send: .2 }));
}
function thump(t0, vol = .8) {
  currentLabel = 'thump';
  let ph = 0;
  render(t0, .8, (tl) => {
    const f = 36 + 60 * Math.exp(-tl * 18);
    ph += f / SR;
    const amp = Math.exp(-tl * 4.5) * Math.min(1, tl / .003);
    const y = Math.tanh(Math.sin(TAU * ph) * 1.6) * amp * vol * .5;
    return [y, y];
  }, { send: .3 });
}

/* ---------- arrangement ---------- */
// Tape hiss and a low D drone: the film opens on a machine listening.
let hissA = 0, hissB = 0;
render(0, DUR, (tl, t) => {
  const e = energy(t);
  const level = t < 8.57 ? .0055 : .0022 * (1 - e * .5);
  const n = noise();
  hissA += .12 * (n - hissA); hissB += .03 * (hissA - hissB);
  const hiss = (hissA - hissB * .5) * level * (1 + .2 * Math.sin(t * .8));
  const drone = t < 22 ? Math.sin(TAU * 36.71 * t) * .028 * Math.min(1, t / 3) * (t < 8.57 ? 1 : Math.max(.35, 1 - (t - 8.57) / 4)) : 0;
  return [hiss + drone, hiss * .9 + drone];
}, {});

// Harmony: pad and sub follow the chord schedule; the approval hit and the final D major get fast attacks.
for (const [t0, t1, name] of segments) {
  const fast = t0 === bar(16) || t0 === 77.0;
  pad(t0, t1, CHORDS[name], { attack: fast ? .03 : t0 < 8.57 ? 2.5 : .8, release: t0 === 77.0 ? 5 : 1.6, vol: fast ? .065 : .05 });
  if (t0 >= bar(3)) sub(t0, t1, ROOTS[name]);
}

// Drums: half-time heartbeat that grows with energy and disappears for the reveal.
for (let b = 0; ; b += 1) {
  const t = bar(3) + b * BEAT;
  if (t >= bar(24)) break;
  const e = energy(t + .01);
  const beatInBar = b % 4, barIndex = Math.floor(b / 4) + 3;
  if (e >= .3 && (beatInBar === 0 || beatInBar === 2)) kick(t, .7 + e * .3);
  if (e >= .72 && beatInBar === 3 && barIndex % 2 === 1) kick(t + BEAT / 2, .55);
  if (e >= .6 && (beatInBar === 1 || beatInBar === 3)) rim(t, .35 + e * .3);
  if (e >= .45) { hat(t + BEAT / 2, .18 + e * .25); if (e >= .8) { hat(t + BEAT / 4, .1); hat(t + BEAT * 3 / 4, .12); } }
}
riser(43.6, 45.71 - 43.6, .28);

// Arpeggio: 16ths over chord tones, thinning to 8ths when the room gets tense.
{
  let i = 0;
  for (let t = bar(3); t < bar(24); t += BEAT / 4, i += 1) {
    const e = energy(t + .005);
    if (e < .25) continue;
    if (e < .5 && i % 2 === 1) continue;
    const chord = CHORDS[chordAt(t + .001)];
    const pattern = [chord[1], chord[2], chord[3], chord[1] + 12, chord[3], chord[2] + 12, chord[1] + 12, chord[2]];
    arpNote(t, pattern[i % 8], BEAT / 4 * .9, e, i % 2 ? .3 : -.3);
  }
}

// Plucked motif: the human line of the score.
const PHRASE = [[0, 74, 1], [1.5, 77, .5], [2, 81, 1], [3, 79, 1], [4, 77, 1], [5, 74, 1.5], [6.5, 72, 1], [8, 69, 1], [9, 72, 1], [10, 74, 1], [11, 77, 1], [12, 76, 2], [13.5, 74, 2.5]];
function phrase(t0, { octave = 0, vol = .2, echo = false, pan = 0 } = {}) {
  for (const [beatOffset, midi, beats] of PHRASE) {
    const t = t0 + beatOffset * BEAT;
    pluck(t, midi + octave, beats * BEAT * 1.4, vol, pan, .55);
    if (echo) pluck(t + BEAT / 4, midi + 12, beats * BEAT, vol * .35, -pan, .35);
  }
}
phrase(bar(4), { vol: .17, pan: -.15 });
phrase(bar(8), { vol: .2, echo: true, pan: .15 });
phrase(bar(16), { vol: .22, echo: true, pan: -.1 });
phrase(bar(20), { vol: .24, echo: true, pan: .1 });
phrase(bar(20), { octave: -12, vol: .1, pan: -.3 });
[[0, 74, 3], [2, 72, 3], [4, 69, 5]].forEach(([b, m, len]) => pluck(bar(24) + b * BEAT, m, len * BEAT, .2, 0, .5));
[[0, 74], [0.7, 78], [1.4, 81]].forEach(([dt, m]) => pluck(77.9 + dt, m, 3.5, .22, (m - 78) / 14, .6));
pluck(80.7, 86, 4, .12, .2, .45);

// Sound design locked to picture.
[1.2, 1.9, 2.3].forEach((t) => click(t, .55, 2200));
for (let t = 1.0; t < 8.4; t += BEAT / 2) click(t, .12, 4200);          // timecode ticking under the cold open
beep(8.57, [880, 1320], .07, .2);                                          // record
[1.2, 3.0, 16.0].forEach((tc) => click(tcT(tc), .6, 2400));               // the expert's clicks
click(tcT(5.6), .25, 1800);
beep(20.0, [1320, 880], .07, .16);                                         // stop
[23.4, 23.7, 24.0, 24.3].forEach((t, i) => { click(t, .3, 3000 + i * 300); bell(t + .02, [74, 77, 81, 86][i], .5, .06, .3); });
[26.4, 27.6, 28.8].forEach((t, i) => { whoosh(t - .35, .75, .22, 1); bell(t + .25, [81, 84, 86][i], 1.2, .11, (i - 1) * .4); });
bell(31.6, 81, .5, .12, .2); bell(31.9, 77, .9, .12, -.2);                 // amber question
for (let i = 0; i < 44; i += 1) key(36.8 + i / 17 + (rnd() - .5) * .012, .3 + rnd() * .2);
click(40.2, .6, 2600);                                                     // save answer
bell(40.6, 86, .8, .09, 0);                                                // rule accepted
click(43.2, .7, 2400);                                                     // approve workflow
whoosh(43.4, 1.2, .3, -1);                                                 // the fold
for (let i = 0; i < 30; i += 1) click(44.6 + i / 26, .18, 3600 + (i % 3) * 400);
thump(45.71, .9); bell(45.74, 77, 1.6, .12, -.2); bell(45.74, 81, 1.6, .12, .2); bell(45.78, 84, 2, .1, 0);  // stamp
[48.8, 50.2, 51.6].forEach((t) => whoosh(t, .5, .12, 1));
[49.2, 50.6, 52.0].forEach((t, i) => bell(t + .1, [74, 77, 81][i], 1.1, .1, (i - 1) * .5));
beep(57.8, [880, 1320], .07, .16);                                         // run
[2.0, 8.0].forEach((r) => click(rtcT(r), .55, 2400));
bell(rtcT(4.2), 81, .45, .1, .2); bell(rtcT(4.5), 77, .8, .1, -.2);        // fresh evidence, NO branch
[2.5, 5.4, 8.6, 10.2].forEach((r, i) => { click(rtcT(r), .35, 3200); bell(rtcT(r) + .03, [79, 77, 79, 86][i], .6, .08, .3); });
[0, .11, .22].forEach((dt, i) => bell(65.8 + dt, [74, 81, 86][i], 1.6, .12, (i - 1) * .3));  // verified
whoosh(68.6, 2.2, .18, -1);                                                // pull back
thump(77.0, .8);                                                           // lockup

/* ---------- side-chain the pad/arp bus to the kick ---------- */
kickTimes.sort((a, b) => a - b);
{
  let k = 0;
  for (let i = 0; i < N; i += 1) {
    const t = i / SR;
    while (k + 1 < kickTimes.length && kickTimes[k + 1] <= t) k += 1;
    const since = kickTimes.length && kickTimes[k] <= t ? t - kickTimes[k] : 9;
    const duck = 1 - .5 * Math.pow(Math.max(0, 1 - since / .3), 1.6);
    L[i] += PL[i] * duck; R[i] += PR[i] * duck;
  }
}

/* ---------- ping-pong delay (dotted eighth) ---------- */
{
  const dl = Math.round(BEAT * .75 * SR);
  const bufL = new Float32Array(dl), bufR = new Float32Array(dl);
  let idx = 0, dampL = 0, dampR = 0;
  for (let i = 0; i < N; i += 1) {
    const outL = bufL[idx], outR = bufR[idx];
    dampL += .35 * (outL - dampL); dampR += .35 * (outR - dampR);
    bufL[idx] = DR[i] + dampR * .42;
    bufR[idx] = DL[i] + dampL * .42;
    idx = (idx + 1) % dl;
    L[i] += outL * .55; R[i] += outR * .55;
    VL[i] += outL * .2; VR[i] += outR * .2;
  }
}

/* ---------- Schroeder reverb on the send bus ---------- */
{
  const combs = [1687, 1601, 2053, 2251], allpasses = [347, 113];
  const make = (offset) => ({
    combBuf: combs.map((n) => new Float32Array(n + offset)), combIdx: combs.map(() => 0), combDamp: combs.map(() => 0),
    apBuf: allpasses.map((n) => new Float32Array(n)), apIdx: allpasses.map(() => 0),
  });
  const chans = [[VL, L, make(0)], [VR, R, make(37)]];
  for (let i = 0; i < N; i += 1) {
    for (const [IN, OUT, st] of chans) {
      const x = IN[i];
      let acc = 0;
      for (let c = 0; c < 4; c += 1) {
        const buf = st.combBuf[c]; const y = buf[st.combIdx[c]];
        st.combDamp[c] += .28 * (y - st.combDamp[c]);
        buf[st.combIdx[c]] = x + st.combDamp[c] * .84;
        st.combIdx[c] = (st.combIdx[c] + 1) % buf.length;
        acc += y;
      }
      let y = acc * .25;
      for (let a = 0; a < 2; a += 1) {
        const buf = st.apBuf[a]; const d = buf[st.apIdx[a]];
        const v = y + d * .5;
        buf[st.apIdx[a]] = v;
        y = d - v * .5;
        st.apIdx[a] = (st.apIdx[a] + 1) % buf.length;
      }
      OUT[i] += y * .55;
    }
  }
}

/* ---------- master ---------- */
let peak = 0;
for (let i = 0; i < N; i += 1) {
  const t = i / SR;
  const fadeOut = Math.min(1, (DUR - t) / 1.6);
  L[i] *= fadeOut; R[i] *= fadeOut;
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
}
const gain = .92 / Math.max(.001, peak);
for (let i = 0; i < N; i += 1) {
  L[i] = Math.tanh(L[i] * gain * 1.15) * .93;
  R[i] = Math.tanh(R[i] * gain * 1.15) * .93;
}

const channels = 2, bytesPerSample = 2;
const dataBytes = N * channels * bytesPerSample;
const buffer = Buffer.alloc(44 + dataBytes);
buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + dataBytes, 4); buffer.write("WAVE", 8);
buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
buffer.writeUInt32LE(SR, 24); buffer.writeUInt32LE(SR * channels * bytesPerSample, 28); buffer.writeUInt16LE(channels * bytesPerSample, 32); buffer.writeUInt16LE(16, 34);
buffer.write("data", 36); buffer.writeUInt32LE(dataBytes, 40);
for (let i = 0; i < N; i += 1) {
  buffer.writeInt16LE(Math.round(clamp(L[i], -1, 1) * 32767), 44 + i * 4);
  buffer.writeInt16LE(Math.round(clamp(R[i], -1, 1) * 32767), 46 + i * 4);
}
await writeFile(outputPath, buffer, { mode: 0o644 });
console.log(`Wrote original ${DUR}s score (${BPM} BPM, D minor → D major, peak ${peak.toFixed(3)} pre-normalise) to ${outputPath}`);
