// Прокси Яндекс Музыки на мок-сервере: настоящий API из тестов недоступен.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

let mock; let app; let base; let seenAuth = [];
const TOKEN = 'y0_TESTTOKENabcdefghijklmnopqrstuvwxyz0123';

before(async () => {
  mock = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    const u = new URL(req.url, 'http://x');
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/search') {
      return json({ result: { tracks: { results: [
        { id: 4242, title: 'Хочешь', version: null, artists: [{ name: 'Земфира' }], durationMs: 211000, coverUri: 'avatars.yandex.net/get-music-content/x/%%', available: true },
      ] } } });
    }
    if (u.pathname === '/account/status') {
      if (req.headers.authorization !== `OAuth ${TOKEN}`) return json({ error: 'unauthorized' }, 401);
      return json({ result: { account: { login: 'lena', firstName: 'Лена' }, plus: { hasPlus: true } } });
    }
    if (u.pathname === '/tracks/4242/download-info') {
      return json({ result: [
        { codec: 'mp3', bitrateInKbps: 192, preview: false, downloadInfoUrl: `http://127.0.0.1:${mock.address().port}/dl/192` },
        { codec: 'mp3', bitrateInKbps: 320, preview: false, downloadInfoUrl: `http://127.0.0.1:${mock.address().port}/dl/320` },
        { codec: 'aac', bitrateInKbps: 256, preview: false, downloadInfoUrl: 'http://bad' },
      ] });
    }
    if (u.pathname === '/dl/320') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end('<?xml version="1.0"?><download-info><host>s123.storage.yandex.net</host><path>/rmusic/U2FsdGVk/abc</path><ts>0005f1</ts><region>-1</region><s>deadbeef</s></download-info>');
    }
    json({ error: 'nope' }, 404);
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.YM_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  const { createApp } = await import('../server/index.js');
  app = createApp();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.address().port}`;
});

after(() => { mock.close(); app.close(); });

test('поиск упрощает треки и собирает обложку', async () => {
  const r = await fetch(base + '/api/ym/search?q=' + encodeURIComponent('земфира'));
  const { tracks } = await r.json();
  assert.equal(tracks[0].id, '4242');
  assert.equal(tracks[0].artist, 'Земфира');
  assert.equal(tracks[0].cover, 'https://avatars.yandex.net/get-music-content/x/400x400');
});

test('аккаунт: токен уходит заголовком OAuth', async () => {
  seenAuth = [];
  const r = await fetch(base + '/api/ym/me', { headers: { 'X-YM-Token': TOKEN } });
  assert.deepEqual(await r.json(), { login: 'lena', name: 'Лена', plus: true });
  assert.ok(seenAuth.includes(`OAuth ${TOKEN}`));
});

test('без токена ссылка на трек не выдаётся', async () => {
  const r = await fetch(base + '/api/ym/url?id=4242');
  assert.equal(r.status, 401);
});

test('ссылка на mp3 подписывается как в клиенте Яндекса', async () => {
  const r = await fetch(base + '/api/ym/url?id=4242', { headers: { 'X-YM-Token': TOKEN } });
  const body = await r.json();
  const sign = createHash('md5').update('XGRlBW9FXlekgbPrRHuSiA' + 'rmusic/U2FsdGVk/abc' + 'deadbeef').digest('hex');
  assert.equal(body.url, `https://s123.storage.yandex.net/get-mp3/${sign}/0005f1/rmusic/U2FsdGVk/abc`);
  assert.equal(body.bitrate, 320);
});

test('аудиопрокси не открывает чужие хосты', async () => {
  for (const src of ['https://evil.example/a.mp3', 'http://s1.storage.yandex.net/a', 'https://user:pw@s1.storage.yandex.net/a', 'file:///etc/passwd', 'https://yandex.net.evil.com/a']) {
    const r = await fetch(base + '/api/ym/audio?src=' + encodeURIComponent(src));
    assert.equal(r.status, 400, src);
  }
});

test('странный токен отклоняется до запроса к Яндексу', async () => {
  const r = await fetch(base + '/api/ym/me', { headers: { 'X-YM-Token': 'bad token with spaces' } });
  assert.equal(r.status, 400);
});
