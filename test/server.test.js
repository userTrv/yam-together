import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let app; let base;
before(async () => {
  const { createApp } = await import('../server/index.js');
  app = createApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(() => app.close());

const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

test('статика и защита от выхода за пределы папки', async () => {
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/r/ABCDE')).status, 200);
  assert.equal((await fetch(base + '/shared/timeline.js')).status, 200);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  assert.equal((await fetch(base + '/shared/%2e%2e/server/rooms.js')).status, 404);
  const r = await fetch(base + '/nope');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
});

test('создание, вход, действие и события', async () => {
  const c = await (await post('/api/rooms', { name: 'Лена' })).json();
  assert.match(c.code, /^[A-Z0-9]{5}$/);
  const j = await (await post(`/api/rooms/${c.code}/join`, { name: 'Кирилл' })).json();
  const ctrl = new AbortController();
  const es = await fetch(`${base}/api/rooms/${c.code}/events?id=${j.member.id}&key=${j.member.key}`, { signal: ctrl.signal });
  assert.equal(es.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = es.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /retry: 2000/);
  const a = await post(`/api/rooms/${c.code}/act`, { id: j.member.id, key: j.member.key, action: { type: 'add', track: { source: 'demo', id: 'demo-depo', title: 'Депо', artist: 'Демо', durationMs: 60000 } } });
  assert.equal(a.status, 200);
  let text = '';
  while (!text.includes('Депо')) text += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!text.includes(j.member.key), 'ключ не должен утекать в события');
  ctrl.abort();
  const bad = await post(`/api/rooms/${c.code}/act`, { id: j.member.id, key: 'wrong', action: { type: 'toggle' } });
  assert.equal(bad.status, 401);
});

test('кривой JSON и неизвестный вагон', async () => {
  const r = await fetch(base + '/api/rooms', { method: 'POST', body: '{nope' });
  assert.equal(r.status, 400);
  assert.equal((await fetch(base + '/api/rooms/QQQQQ')).status, 404);
});
