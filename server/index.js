// HTTP-сервер «Вагона»: статика, API комнат, события через SSE, прокси Яндекс Музыки.
// Без зависимостей: только встроенные модули Node.js 22+.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize as normPath, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rooms, RoomError } from './rooms.js';
import * as ym from './yandex.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const SHARED = join(ROOT, 'shared');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const rooms = new Rooms();
/** @type {Map<string, Set<{res: import('node:http').ServerResponse, member: any}>>} */
const streams = new Map();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://avatars.yandex.net",
  "media-src 'self' blob: data: https:",
  "connect-src 'self' https:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

function baseHeaders(extra = {}) {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extra,
  };
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, baseHeaders({
    'Content-Type': typeof body === 'object' && !Buffer.isBuffer(body) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  }));
  res.end(data);
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new RoomError(413, 'Слишком большой запрос');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RoomError(400, 'Запрос не похож на JSON'); }
}

// ——— простой лимит запросов по IP ———
const buckets = new Map();
function limit(req, name, perMinute) {
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const key = name + '|' + ip;
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  if (b.tokens < 1) { buckets.set(key, b); throw new RoomError(429, 'Слишком часто. Подождите немного'); }
  b.tokens -= 1;
  buckets.set(key, b);
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.at > 5 * 60000) buckets.delete(k);
}, 60000).unref();

// ——— рассылка событий ———
function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room, event = null) {
  const set = streams.get(room.code);
  if (!set) return;
  const snap = room.snapshot(Date.now());
  for (const s of set) {
    sse(s.res, 'state', snap);
    if (event) sse(s.res, 'event', event);
  }
  room.statusDirty = false;
}

setInterval(() => {
  for (const room of rooms.map.values()) if (room.statusDirty) broadcast(room);
}, 1000).unref();

setInterval(() => {
  for (const set of streams.values()) for (const s of set) s.res.write(`: keep-alive ${Date.now()}\n\n`);
}, 15000).unref();

setInterval(() => {
  const before = rooms.map.size;
  rooms.sweep(Date.now());
  if (rooms.map.size !== before) console.log(`вагонов: ${rooms.map.size}`);
}, 60000).unref();

// ——— маршруты API ———
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'time' && method === 'GET') {
    return send(res, 200, { now: Date.now() });
  }

  if (parts[1] === 'rooms') {
    if (parts.length === 2 && method === 'POST') {
      limit(req, 'create', 10);
      const body = await readJson(req);
      const now = Date.now();
      const room = rooms.create(now);
      const m = room.join(body.name, now);
      return send(res, 201, { code: room.code, member: { id: m.id, key: m.key, name: m.name, color: m.color } });
    }
    const room = rooms.get(parts[2]);
    if (parts.length === 3 && method === 'GET') {
      return send(res, 200, room.snapshot(Date.now()));
    }
    if (parts[3] === 'join' && method === 'POST') {
      limit(req, 'join', 30);
      const body = await readJson(req);
      const m = room.join(body.name, Date.now());
      broadcast(room);
      return send(res, 201, { code: room.code, member: { id: m.id, key: m.key, name: m.name, color: m.color } });
    }
    if (parts[3] === 'act' && method === 'POST') {
      limit(req, 'act', 240);
      const body = await readJson(req);
      const m = room.auth(body.id, body.key);
      const event = room.act(m, body.action, Date.now());
      if (body.action?.type !== 'status') broadcast(room, event);
      return send(res, 200, { ok: true, version: room.version, serverNow: Date.now() });
    }
    if (parts[3] === 'events' && method === 'GET') {
      const m = room.auth(url.searchParams.get('id'), url.searchParams.get('key'));
      res.writeHead(200, baseHeaders({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      }));
      res.write('retry: 2000\n\n');
      const entry = { res, member: m };
      if (!streams.has(room.code)) streams.set(room.code, new Set());
      streams.get(room.code).add(entry);
      room.connect(m, Date.now());
      broadcast(room);
      req.on('close', () => {
        streams.get(room.code)?.delete(entry);
        if (streams.get(room.code)?.size === 0) streams.delete(room.code);
        room.disconnect(m, Date.now());
        broadcast(room);
      });
      return;
    }
  }

  if (parts[1] === 'ym') {
    if (parts[2] === 'search' && method === 'GET') {
      limit(req, 'ym', 60);
      return send(res, 200, { tracks: await ym.search(req, url.searchParams.get('q')) });
    }
    if (parts[2] === 'me' && method === 'GET') {
      limit(req, 'ym', 60);
      return send(res, 200, await ym.me(req));
    }
    if (parts[2] === 'url' && method === 'GET') {
      limit(req, 'ym', 60);
      return send(res, 200, await ym.trackUrl(req, url.searchParams.get('id')));
    }
    if (parts[2] === 'audio' && method === 'GET') {
      limit(req, 'audio', 120);
      return ym.proxyAudio(req, res, url.searchParams.get('src') ?? '');
    }
  }

  throw new RoomError(404, 'Нет такого адреса');
}

// ——— статика ———
async function serveFile(res, file, { cache = 'no-cache', status = 200 } = {}) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const body = await readFile(file);
    res.writeHead(status, baseHeaders({
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': cache,
      'Content-Length': body.length,
    }));
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function safeJoin(base, p) {
  const full = normPath(join(base, decodeURIComponent(p)));
  return full.startsWith(base + '/') || full === base ? full : null;
}

async function handleStatic(req, res, url) {
  const p = url.pathname;
  if (p === '/' || p === '/index.html') return serveFile(res, join(PUBLIC, 'index.html'));
  if (/^\/r\/[A-Za-z0-9]{4,8}\/?$/.test(p) || p === '/new' || p === '/join') return serveFile(res, join(PUBLIC, 'app.html'));
  if (p.startsWith('/shared/')) {
    const f = safeJoin(SHARED, p.slice('/shared/'.length));
    return f ? serveFile(res, f) : false;
  }
  const f = safeJoin(PUBLIC, p.slice(1));
  if (!f) return false;
  if (await serveFile(res, f)) return true;
  if (!extname(p)) return serveFile(res, f + '.html');
  return false;
}

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new RoomError(405, 'Метод не поддерживается');
      if (!(await handleStatic(req, res, url))) {
        if (!(await serveFile(res, join(PUBLIC, '404.html'), { status: 404 }))) send(res, 404, 'Не найдено');
      }
    } catch (err) {
      const status = err instanceof RoomError || err instanceof ym.YandexError ? err.status : 500;
      if (status === 500) console.error('ошибка запроса', req.method, url.pathname, err?.message);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Что-то сломалось на сервере' : err.message });
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, HOST, () => console.log(`Вагон слушает http://${HOST}:${PORT}`));
}
