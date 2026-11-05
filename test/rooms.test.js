import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, RoomError, sanitizeTrack } from '../server/rooms.js';
import { resolve, LEAD_MS } from '../shared/timeline.js';

const track = (id, durationMs = 60000) => ({ source: 'demo', id, title: 'T ' + id, artist: 'A', durationMs });

function setup() {
  const rooms = new Rooms();
  const room = rooms.create(0);
  const host = room.join('Лена', 0);
  const guest = room.join('Кирилл', 0);
  room.connect(host, 0); room.connect(guest, 0);
  return { rooms, room, host, guest };
}

test('код вагона из пяти знаков и поиск без учёта регистра', () => {
  const { rooms, room } = setup();
  assert.match(room.code, /^[A-Z0-9]{5}$/);
  assert.equal(rooms.get(room.code.toLowerCase()), room);
  assert.throws(() => rooms.get('ZZZZZ'), RoomError);
});

test('первый трек стартует через LEAD_MS у всех', () => {
  const { room, host } = setup();
  room.act(host, { type: 'add', track: track('demo-a') }, 1000);
  assert.deepEqual(room.playback, { status: 'playing', index: 0, startAt: 1000 + LEAD_MS });
});

test('пауза и продолжение сохраняют позицию', () => {
  const { room, host, guest } = setup();
  room.act(host, { type: 'add', track: track('demo-a') }, 0);
  room.act(guest, { type: 'toggle' }, LEAD_MS + 5000);
  assert.deepEqual(room.playback, { status: 'paused', index: 0, positionMs: 5000 });
  room.act(guest, { type: 'toggle' }, 100000);
  const r = resolve(room.queue, room.playback, 100000 + LEAD_MS);
  assert.equal(r.positionMs, 5000);
});

test('skip, playNext и remove', () => {
  const { room, host, guest } = setup();
  for (const id of ['demo-a', 'demo-b', 'demo-c', 'demo-d']) room.act(host, { type: 'add', track: track(id) }, 0);
  const d = room.queue[3].qid;
  room.act(guest, { type: 'playNext', qid: d }, 10);
  assert.deepEqual(room.queue.map((x) => x.id), ['demo-a', 'demo-d', 'demo-b', 'demo-c']);
  room.act(host, { type: 'skip' }, 20000);
  assert.equal(resolve(room.queue, room.playback, 20000 + LEAD_MS).index, 1);
  assert.throws(() => room.act(guest, { type: 'remove', qid: room.queue[0].qid }, 20001), /звучал/);
  room.act(guest, { type: 'remove', qid: room.queue[3].qid }, 20002);
  assert.equal(room.queue.length, 3);
});

test('без общего пульта гость голосует, большинство пропускает', () => {
  const { room, host, guest } = setup();
  const third = room.join('Аня', 0); room.connect(third, 0);
  room.act(host, { type: 'add', track: track('demo-a') }, 0);
  room.act(host, { type: 'add', track: track('demo-b') }, 0);
  room.act(host, { type: 'settings', everyoneControls: false }, 0);
  assert.throws(() => room.act(guest, { type: 'skip' }, 5000), (e) => e.status === 403);
  room.act(guest, { type: 'voteSkip' }, 5000);
  assert.equal(resolve(room.queue, room.playback, 5000).index, 0);
  const ev = room.act(third, { type: 'voteSkip' }, 6000);
  assert.equal(ev?.kind, 'toast');
  assert.equal(resolve(room.queue, room.playback, 6000 + LEAD_MS).index, 1);
});

test('гость не может менять настройки, чужой ключ не проходит', () => {
  const { room, host, guest } = setup();
  assert.throws(() => room.act(guest, { type: 'settings', everyoneControls: false }, 0), (e) => e.status === 403);
  assert.throws(() => room.auth(host.id, guest.key), (e) => e.status === 401);
  assert.equal(room.auth(host.id, host.key), host);
});

test('снимок не раскрывает ключи участников', () => {
  const { room, host } = setup();
  const s = JSON.stringify(room.snapshot(0));
  assert.ok(!s.includes(host.key));
});

test('добавление в конец очереди после её окончания снова запускает воспроизведение', () => {
  const { room, host } = setup();
  room.act(host, { type: 'add', track: track('demo-a', 10000) }, 0);
  const later = 100000;
  room.act(host, { type: 'add', track: track('demo-b', 10000) }, later);
  const r = resolve(room.queue, room.playback, later + LEAD_MS + 1000);
  assert.deepEqual([r.status, r.index, r.positionMs], ['playing', 1, 1000]);
});

test('sanitizeTrack отбрасывает мусор', () => {
  assert.throws(() => sanitizeTrack({ source: 'spotify', id: '1', durationMs: 60000 }));
  assert.throws(() => sanitizeTrack({ source: 'demo', id: '../x', durationMs: 60000 }));
  assert.throws(() => sanitizeTrack({ source: 'demo', id: 'a', durationMs: 10 }));
  const t = sanitizeTrack({ source: 'yandex', id: '123', durationMs: 60000, cover: 'https://evil.example/x.png', title: 'x'.repeat(500) });
  assert.equal(t.cover, '');
  assert.equal(t.title.length, 120);
});

test('уход хозяина передаёт пульт следующему', () => {
  const { room, host, guest } = setup();
  room.disconnect(host, 0);
  room.forgetStale(10 * 60 * 60 * 1000);
  assert.equal(room.hostId, guest.id);
});
