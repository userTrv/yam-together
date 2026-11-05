// Сервис-воркер: держит оболочку приложения в кэше, чтобы «Вагон» открывался
// и без связи. API и звук не кэшируются здесь: треки плеер держит в памяти сам.
const CACHE = 'vagon-v1';
const SHELL = [
  '/', '/app.html', '/css/base.css', '/css/app.css', '/css/landing.css',
  '/js/app.js', '/js/clock.js', '/js/player.js', '/js/sources.js', '/js/synth.js',
  '/js/catalog.js', '/js/qr.js', '/js/landing.js', '/shared/timeline.js',
  '/icon.svg', '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return;

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      const net = fetch(e.request).then((r) => { if (r.ok || r.type === 'opaque') c.put(e.request, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  // Сначала сеть (чтобы обновления доходили), без связи — кэш.
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok) (await caches.open(CACHE)).put(e.request, r.clone());
      return r;
    } catch {
      const c = await caches.open(CACHE);
      const hit = await c.match(e.request);
      if (hit) return hit;
      if (e.request.mode === 'navigate') return (await c.match(url.pathname.startsWith('/r/') || url.pathname === '/new' || url.pathname === '/join' ? '/app.html' : '/')) || Response.error();
      return Response.error();
    }
  })());
});
