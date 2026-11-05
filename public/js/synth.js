// Демо-треки, которые синтезируются прямо в браузере. Нужны, чтобы «Вагон» работал
// без аккаунта Яндекса: в метро, на демо для партнёров, в тестах синхронизации.
// Один и тот же seed даёт одну и ту же музыку на всех телефонах.

const RATE = 24000;
const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
};
const PROGRESSIONS = [[0, 5, 2, 6], [0, 3, 4, 0], [0, 6, 5, 6], [5, 3, 0, 4], [0, 4, 5, 3]];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

/** Длительность демо-трека в мс, известная заранее, без рендера. */
export function demoDuration(t) {
  return Math.round((t.bars * 4 * 60000) / t.bpm + 2000);
}

function plan(t) {
  const rnd = mulberry32(t.seed);
  const scale = SCALES[t.scale] ?? SCALES.minor;
  const root = t.root;
  const prog = PROGRESSIONS[Math.floor(rnd() * PROGRESSIONS.length)];
  const note = (deg, oct = 0) => {
    const n = scale.length;
    const d = ((deg % n) + n) % n;
    return root + scale[d] + 12 * (oct + Math.floor(deg / n));
  };
  const kick = rnd() < 0.6
    ? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
    : [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0];
  const hat = Array.from({ length: 16 }, (_, i) => (i % 4 === 2 ? 1 : rnd() < 0.35 ? 0.45 : 0));
  const bassRhythm = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? 1 : i % 2 === 0 && rnd() < 0.5 ? 1 : 0));
  const arpShape = [0, 2, 4, 2, 0, 4, 2, 4].map((x) => (rnd() < 0.2 ? x + 7 : x));
  return { rnd, prog, note, kick, hat, bassRhythm, arpShape };
}

/** Какая фраза (4 такта) звучит в группе g из groups. */
export function phraseKind(g, groups) {
  if (g === 0) return 'intro';
  if (g === groups - 1) return 'outro';
  if (g < 4) return 'groove';
  const br = Math.round(groups * 0.62);
  if (g === br || g === br + 1) return 'break';
  return 'full';
}

/**
 * Рендерит одну фразу из четырёх тактов плюс такт на хвосты эха.
 * Трек собирается из таких фраз: узлов в каждом рендере мало, поэтому быстро
 * даже на слабом телефоне.
 */
async function renderPhrase(t, p, kind) {
  const secPerBeat = 60 / t.bpm;
  const step = secPerBeat / 4;
  const bar = secPerBeat * 4;
  const ctx = new OfflineAudioContext(1, Math.ceil(bar * 5 * RATE), RATE);

  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);

  const noise = ctx.createBuffer(1, RATE, RATE);
  const nd = noise.getChannelData(0);
  const nr = mulberry32(t.seed ^ 0x9e3779b9);
  for (let i = 0; i < nd.length; i++) nd[i] = nr() * 2 - 1;

  // Общие шины с фильтрами, чтобы не создавать фильтр на каждую ноту.
  const hatBus = ctx.createBiquadFilter(); hatBus.type = 'highpass'; hatBus.frequency.value = 7000; hatBus.connect(master);
  const snareBus = ctx.createBiquadFilter(); snareBus.type = 'bandpass'; snareBus.frequency.value = 1800; snareBus.Q.value = 0.7; snareBus.connect(master);
  const bassBus = ctx.createBiquadFilter(); bassBus.type = 'lowpass'; bassBus.frequency.value = 520; bassBus.Q.value = 5; bassBus.connect(master);
  const padBus = ctx.createBiquadFilter(); padBus.type = 'lowpass'; padBus.frequency.value = 1100; padBus.connect(master);
  const leadBus = ctx.createBiquadFilter(); leadBus.type = 'lowpass'; leadBus.frequency.value = 2400; leadBus.connect(master);
  const delay = ctx.createDelay(2);
  delay.delayTime.value = step * 3;
  const fb = ctx.createGain(); fb.gain.value = 0.32;
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  leadBus.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(master);

  const env = (g, at, peak, a, d) => {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + a);
    g.gain.exponentialRampToValueAtTime(0.0001, at + a + d);
  };
  const kick = (at) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.setValueAtTime(140, at);
    o.frequency.exponentialRampToValueAtTime(42, at + 0.14);
    env(g, at, 0.9, 0.004, 0.36);
    o.connect(g).connect(master); o.start(at); o.stop(at + 0.42);
  };
  const hat = (at, v) => {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const g = ctx.createGain(); env(g, at, 0.16 * v, 0.002, 0.045);
    s.connect(g).connect(hatBus); s.start(at, (at * 7.3) % 0.9); s.stop(at + 0.06);
  };
  const snare = (at) => {
    const s = ctx.createBufferSource(); s.buffer = noise;
    const g = ctx.createGain(); env(g, at, 0.42, 0.002, 0.17);
    s.connect(g).connect(snareBus); s.start(at, (at * 3.1) % 0.8); s.stop(at + 0.2);
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 190;
    const og = ctx.createGain(); env(og, at, 0.25, 0.002, 0.08);
    o.connect(og).connect(master); o.start(at); o.stop(at + 0.1);
  };
  const bass = (at, midi, len) => {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(midi);
    const g = ctx.createGain(); env(g, at, 0.4, 0.006, len);
    o.connect(g).connect(bassBus); o.start(at); o.stop(at + len + 0.02);
  };
  const pad = (at, midis, len) => {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(0.06, at + len * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, at + len);
    g.connect(padBus);
    for (const m of midis) for (const det of [-7, 7]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = mtof(m); o.detune.value = det;
      o.connect(g); o.start(at); o.stop(at + len + 0.02);
    }
  };
  const lead = (at, midi) => {
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = mtof(midi);
    const g = ctx.createGain(); env(g, at, 0.07, 0.004, step * 1.6);
    o.connect(g).connect(leadBus);
    o.start(at); o.stop(at + step * 2);
  };

  for (let b = 0; b < 4; b++) {
    const t0 = b * bar;
    const deg = p.prog[b];
    const chord = [p.note(deg, 0), p.note(deg + 2, 0), p.note(deg + 4, 0)];
    const lastBars = kind === 'outro' && b >= 2;
    pad(t0, chord.map((m) => m + 12), bar * (lastBars && b === 3 ? 1.6 : 0.98));
    for (let s = 0; s < 16; s++) {
      const at = t0 + s * step + (s % 2 ? step * 0.06 : 0); // лёгкий свинг
      const drums = kind === 'groove' || kind === 'full';
      if (drums && p.kick[s]) kick(at);
      if ((kind !== 'intro' || b >= 2) && !lastBars && p.hat[s]) hat(at, p.hat[s]);
      if (kind === 'full' && (s === 4 || s === 12)) snare(at);
      if ((drums || (kind === 'break' && s === 0) || (kind === 'outro' && b < 2 && s === 0)) && p.bassRhythm[s]) {
        bass(at, chord[0] - 24 + (s === 14 ? 7 : 0), step * 1.7);
      }
      if ((kind === 'full' || kind === 'break') && s % 2 === 0) {
        const k = p.arpShape[(s / 2 + b) % p.arpShape.length];
        lead(at, p.note(deg + k, 1));
      }
    }
  }
  return (await ctx.startRendering()).getChannelData(0);
}

/** Рендерит трек в WAV. Возвращает Blob. */
export async function renderDemo(t) {
  const bar = (60 / t.bpm) * 4;
  const total = demoDuration(t) / 1000;
  const out = new Float32Array(Math.ceil(total * RATE));
  const p = plan(t);
  const groups = Math.floor(t.bars / 4);
  const cache = new Map();
  const lead = Math.round(0.4 * RATE);
  for (let g = 0; g < groups; g++) {
    const kind = phraseKind(g, groups);
    if (!cache.has(kind)) cache.set(kind, await renderPhrase(t, p, kind));
    const data = cache.get(kind);
    const at = lead + Math.round(g * 4 * bar * RATE);
    const n = Math.min(data.length, out.length - at);
    for (let i = 0; i < n; i++) out[at + i] += data[i];
  }
  // Плавный вход и выход, мягкое ограничение вместо компрессора.
  const fadeIn = 1.5 * RATE; const fadeOutStart = out.length - 4 * RATE;
  for (let i = 0; i < out.length; i++) {
    let v = out[i];
    if (i < fadeIn) v *= i / fadeIn;
    if (i > fadeOutStart) v *= Math.max(0, (out.length - i - 0.2 * RATE) / (4 * RATE));
    out[i] = Math.tanh(v * 1.1);
  }
  return encodeWav(out, RATE);
}

function encodeWav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Blob([out.buffer], { type: 'audio/wav' });
}
