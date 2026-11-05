// Откуда брать звук для трека из очереди.
// Демо — синтезируем у себя. Яндекс Музыка — каждый участник получает ссылку
// через свой токен и свою подписку, а файл целиком скачивает заранее.

import { demoById } from './catalog.js';
import { renderDemo } from './synth.js';

const TOKEN_KEY = 'vagon:ym-token';
const blobUrls = new Map(); // ключ -> objectURL
const order = [];

function remember(key, url) {
  blobUrls.set(key, url);
  order.push(key);
  // Держим в памяти не больше шести треков: текущий, следующий и немного истории.
  while (order.length > 6) {
    const old = order.shift();
    const u = blobUrls.get(old);
    if (u && !order.includes(old)) { URL.revokeObjectURL(u); blobUrls.delete(old); }
  }
  return url;
}

export const yandexToken = {
  get() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } },
  set(t) { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* приватный режим */ } },
};

/** Достаёт токен из вставленной строки: сам токен или адрес с #access_token=... */
export function parseToken(input) {
  const s = String(input ?? '').trim();
  const m = /access_token=([^&\s]+)/.exec(s);
  const t = m ? decodeURIComponent(m[1]) : s;
  return /^[A-Za-z0-9_.-]{20,400}$/.test(t) ? t : '';
}

export async function ymFetch(path) {
  const token = yandexToken.get();
  const res = await fetch(path, { headers: token ? { 'X-YM-Token': token } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Ошибка ${res.status}`);
  return body;
}

async function loadDemo(track) {
  const key = 'demo:' + track.id;
  if (blobUrls.has(key)) return blobUrls.get(key);
  const meta = demoById(track.id);
  if (!meta) throw new Error('Такого демо-трека нет в этой версии');
  const blob = await renderDemo(meta);
  return remember(key, URL.createObjectURL(blob));
}

async function loadYandex(track) {
  const key = 'ym:' + track.id;
  if (blobUrls.has(key)) return blobUrls.get(key);
  if (!yandexToken.get()) throw new Error('Подключите Яндекс Музыку, чтобы слышать этот трек');
  const { url } = await ymFetch('/api/ym/url?id=' + encodeURIComponent(track.id));
  // Сначала пробуем скачать напрямую, потом через свой сервер (если у хранилища нет CORS).
  for (const src of [url, '/api/ym/audio?src=' + encodeURIComponent(url)]) {
    try {
      const res = await fetch(src);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size < 10000) continue;
      return remember(key, URL.createObjectURL(blob));
    } catch { /* следующий способ */ }
  }
  // Последний вариант: потоковое воспроизведение через прокси, без запаса на тоннель.
  return '/api/ym/audio?src=' + encodeURIComponent(url);
}

export function loadTrack(track) {
  if (track.source === 'demo') return loadDemo(track);
  if (track.source === 'yandex') return loadYandex(track);
  return Promise.reject(new Error('Неизвестный источник'));
}
