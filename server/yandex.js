// Прокси к API Яндекс Музыки.
//
// Официального публичного API у Яндекс Музыки нет. Здесь используются те же
// эндпоинты, что у мобильного клиента, в том виде, как их описывает
// open-source библиотека MarshalX/yandex-music-api. Это прототипный путь:
// для продакшена нужен договор с Яндексом (см. docs/pitch-yandex.md).
//
// Правила обращения с токеном:
// - токен живёт только в браузере участника и приходит заголовком X-YM-Token;
// - сервер не пишет его в логи, не хранит и не пересылает никуда, кроме API Яндекса;
// - каждый участник слушает через свой аккаунт и свою подписку.

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

const API = process.env.YM_API_BASE || 'https://api.music.yandex.net';
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';
const CLIENT_HEADERS = {
  'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
  'User-Agent': 'Yandex-Music-API',
  'Accept-Language': 'ru',
};
// Звук отдают только хосты хранилища Яндекса. Всё остальное прокси не тронет.
const AUDIO_HOST = process.env.YM_AUDIO_HOST_RE
  ? new RegExp(process.env.YM_AUDIO_HOST_RE)
  : /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(yandex\.net|yandex\.ru|music\.yandex\.ru)$/;

export class YandexError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function tokenFrom(req) {
  const t = String(req.headers['x-ym-token'] ?? '').trim();
  if (!t) return null;
  if (!/^[A-Za-z0-9_.-]{20,400}$/.test(t)) throw new YandexError(400, 'Токен выглядит неправильно');
  return t;
}

async function api(path, token, { params } = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const headers = { ...CLIENT_HEADERS };
  if (token) headers.Authorization = `OAuth ${token}`;
  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new YandexError(502, 'Яндекс Музыка не отвечает');
  }
  if (res.status === 401 || res.status === 403) throw new YandexError(401, 'Яндекс не принял токен. Подключите аккаунт заново');
  if (res.status === 451) throw new YandexError(451, 'Яндекс Музыка недоступна из страны, где стоит сервер');
  if (!res.ok) throw new YandexError(502, `Яндекс Музыка ответила ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!body || body.error) throw new YandexError(502, 'Яндекс Музыка ответила странно');
  return body.result;
}

export function coverUrl(uri, size = '400x400') {
  if (!uri || typeof uri !== 'string') return '';
  return 'https://' + uri.replace('%%', size);
}

export function simplifyTrack(t) {
  return {
    source: 'yandex',
    id: String(t.id),
    title: t.title + (t.version ? ` (${t.version})` : ''),
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    durationMs: t.durationMs ?? 0,
    cover: coverUrl(t.coverUri || t.albums?.[0]?.coverUri),
    available: t.available !== false,
  };
}

export async function search(req, q) {
  const text = String(q ?? '').trim().slice(0, 100);
  if (!text) return [];
  const token = tokenFrom(req);
  const result = await api('/search', token, { params: { text, type: 'track', page: 0, nocorrect: 'false' } });
  const items = result?.tracks?.results ?? [];
  return items.map(simplifyTrack).filter((t) => t.durationMs > 0).slice(0, 20);
}

export async function me(req) {
  const token = tokenFrom(req);
  if (!token) throw new YandexError(401, 'Нет токена');
  const r = await api('/account/status', token);
  return {
    login: r?.account?.login ?? null,
    name: r?.account?.firstName || r?.account?.displayName || r?.account?.login || null,
    plus: Boolean(r?.plus?.hasPlus),
  };
}

function xmlText(xml, tag) {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m ? m[1] : null;
}

export function directLink(xml) {
  const host = xmlText(xml, 'host');
  const path = xmlText(xml, 'path');
  const ts = xmlText(xml, 'ts');
  const s = xmlText(xml, 's');
  if (!host || !path || !ts || !s) throw new YandexError(502, 'Не удалось собрать ссылку на трек');
  const sign = createHash('md5').update(SIGN_SALT + path.slice(1) + s).digest('hex');
  return `https://${host}/get-mp3/${sign}/${ts}${path}`;
}

/** Прямая ссылка на mp3 для владельца токена. Без Плюса Яндекс отдаёт 30-секундное превью. */
export async function trackUrl(req, id) {
  if (!/^[0-9]{1,20}(:[0-9]{1,20})?$/.test(String(id))) throw new YandexError(400, 'Странный id трека');
  const token = tokenFrom(req);
  if (!token) throw new YandexError(401, 'Подключите Яндекс Музыку, чтобы слышать этот трек');
  const infos = await api(`/tracks/${id}/download-info`, token);
  const mp3 = (infos ?? []).filter((i) => i.codec === 'mp3').sort((a, b) => b.bitrateInKbps - a.bitrateInKbps);
  const full = mp3.find((i) => !i.preview);
  const pick = full ?? mp3[0];
  if (!pick) throw new YandexError(404, 'Яндекс не отдал этот трек');
  let res;
  try {
    res = await fetch(pick.downloadInfoUrl, { headers: { ...CLIENT_HEADERS, Authorization: `OAuth ${token}` }, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new YandexError(502, 'Яндекс Музыка не отвечает');
  }
  if (!res.ok) throw new YandexError(502, `Хранилище ответило ${res.status}`);
  const url = directLink(await res.text());
  return { url, bitrate: pick.bitrateInKbps, preview: !full };
}

export function isAllowedAudioUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && !(process.env.YM_AUDIO_ALLOW_HTTP && u.protocol === 'http:')) return false;
  if (u.username || u.password) return false;
  return AUDIO_HOST.test(u.hostname);
}

/**
 * Проксирует mp3 из хранилища Яндекса, если браузер не может скачать его сам
 * (нет CORS). Токен сюда не нужен: подпись уже в ссылке.
 */
export async function proxyAudio(req, res, raw) {
  if (!isAllowedAudioUrl(raw)) throw new YandexError(400, 'Эту ссылку прокси не открывает');
  const headers = { 'User-Agent': CLIENT_HEADERS['User-Agent'] };
  if (req.headers.range) headers.Range = String(req.headers.range).slice(0, 64);
  let upstream;
  try {
    upstream = await fetch(raw, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  } catch {
    throw new YandexError(502, 'Хранилище не отвечает');
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = upstream.headers.get('location');
    const next = loc ? new URL(loc, raw).toString() : '';
    if (!isAllowedAudioUrl(next)) throw new YandexError(502, 'Хранилище увело на чужой адрес');
    upstream = await fetch(next, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  }
  if (!upstream.ok && upstream.status !== 206) throw new YandexError(502, `Хранилище ответило ${upstream.status}`);
  const type = upstream.headers.get('content-type') || 'audio/mpeg';
  if (!/^audio\/|^application\/octet-stream/.test(type)) throw new YandexError(502, 'Хранилище отдало не звук');
  const out = { 'Content-Type': type, 'Cache-Control': 'private, max-age=3600' };
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  Readable.fromWeb(upstream.body).pipe(res);
}
