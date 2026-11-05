// Каталог демо-треков и обложки к ним. Обложки рисуются в SVG из того же seed:
// пара линий метро и станции, у каждого трека своя схема.

import { demoDuration, mulberry32 } from './synth.js';

const RAW = [
  { id: 'demo-koltsevaya', title: 'Кольцевая', seed: 1101, bpm: 112, bars: 56, root: 45, scale: 'minor' },
  { id: 'demo-posledniy', title: 'Последний поезд', seed: 2207, bpm: 96, bars: 44, root: 50, scale: 'dorian' },
  { id: 'demo-tonnel', title: 'Тоннельный свет', seed: 3313, bpm: 120, bars: 60, root: 43, scale: 'minor' },
  { id: 'demo-dveri', title: 'Осторожно, двери', seed: 4421, bpm: 124, bars: 56, root: 48, scale: 'major' },
  { id: 'demo-peresadka', title: 'Пересадка', seed: 5527, bpm: 104, bars: 48, root: 46, scale: 'dorian' },
  { id: 'demo-chas-pik', title: 'Час пик', seed: 6637, bpm: 118, bars: 52, root: 41, scale: 'minor' },
  { id: 'demo-depo', title: 'Депо', seed: 7741, bpm: 100, bars: 44, root: 47, scale: 'minor' },
  { id: 'demo-eskalator', title: 'Эскалатор', seed: 8849, bpm: 108, bars: 48, root: 52, scale: 'major' },
];

export const DEMO = RAW.map((t) => ({
  ...t,
  source: 'demo',
  artist: 'Демо Вагона',
  durationMs: demoDuration(t),
}));

export const demoById = (id) => DEMO.find((t) => t.id === id);

const LINE_HUES = ['#e4473d', '#3daa5c', '#3f7fe0', '#2fb3c4', '#f08a24', '#9a6bd8', '#a0703f', '#9cc63b'];

/** SVG-обложка для демо-трека: строка разметки. */
export function demoCoverSvg(t) {
  const r = mulberry32(t.seed * 31 + 7);
  const lines = 2 + Math.floor(r() * 2);
  const hues = [...LINE_HUES].sort(() => r() - 0.5).slice(0, lines);
  let paths = '';
  let stations = '';
  hues.forEach((hue, i) => {
    const y0 = 40 + r() * 160;
    const y1 = 40 + r() * 160;
    const bend = 60 + r() * 120;
    const d = `M -10 ${y0.toFixed(1)} H ${bend.toFixed(1)} L ${(bend + Math.abs(y1 - y0)).toFixed(1)} ${y1.toFixed(1)} H 250`;
    paths += `<path d="${d}" stroke="${hue}" stroke-width="10" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`;
    const sx = [30 + r() * 30, 200 + r() * 20];
    stations += `<circle cx="${sx[0].toFixed(1)}" cy="${y0.toFixed(1)}" r="7" fill="#0b0d14" stroke="${hue}" stroke-width="4"/>`;
    stations += `<circle cx="${sx[1].toFixed(1)}" cy="${y1.toFixed(1)}" r="7" fill="#0b0d14" stroke="${hue}" stroke-width="4"/>`;
    if (i === 0) stations += `<circle cx="${(bend).toFixed(1)}" cy="${y0.toFixed(1)}" r="11" fill="#0b0d14" stroke="#eef0f5" stroke-width="4"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="#11141c"/>${paths}${stations}</svg>`;
}

export function demoCoverUrl(t) {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(demoCoverSvg(t));
}

/** Обложка любого трека для <img>. */
export function coverFor(track) {
  if (track.source === 'demo') {
    const t = demoById(track.id);
    return t ? demoCoverUrl(t) : '';
  }
  return track.cover || '';
}
