import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, normalize, GAP_MS } from '../shared/timeline.js';

const q = [{ qid: 'a', durationMs: 10000 }, { qid: 'b', durationMs: 5000 }, { qid: 'c', durationMs: 8000 }];

test('пустая очередь и idle', () => {
  assert.equal(resolve([], { status: 'playing', index: 0, startAt: 0 }, 5).status, 'idle');
  assert.equal(resolve(q, { status: 'idle' }, 5).status, 'idle');
});

test('позиция внутри первого трека', () => {
  const r = resolve(q, { status: 'playing', index: 0, startAt: 1000 }, 4000);
  assert.deepEqual([r.status, r.index, r.positionMs], ['playing', 0, 3000]);
});

test('старт в будущем даёт позицию 0', () => {
  const r = resolve(q, { status: 'playing', index: 0, startAt: 5000 }, 4000);
  assert.deepEqual([r.index, r.positionMs], [0, 0]);
});

test('переход на следующий трек после паузы между треками', () => {
  const t = 10000 + GAP_MS + 2000;
  const r = resolve(q, { status: 'playing', index: 0, startAt: 0 }, t);
  assert.deepEqual([r.index, r.startAt, r.positionMs], [1, 10000 + GAP_MS, 2000]);
});

test('во время паузы между треками ещё старый трек на последней секунде', () => {
  const r = resolve(q, { status: 'playing', index: 0, startAt: 0 }, 10000 + GAP_MS / 2);
  assert.deepEqual([r.index, r.positionMs], [0, 10000]);
});

test('конец очереди', () => {
  const total = 10000 + 5000 + 8000 + GAP_MS * 3;
  assert.equal(resolve(q, { status: 'playing', index: 0, startAt: 0 }, total + 10).status, 'ended');
});

test('пауза хранит позицию', () => {
  const r = resolve(q, { status: 'paused', index: 2, positionMs: 1234 }, 99999);
  assert.deepEqual([r.status, r.index, r.positionMs], ['paused', 2, 1234]);
});

test('normalize переносит якорь на текущий трек и сохраняет время', () => {
  const p = { status: 'playing', index: 0, startAt: 0 };
  const now = 10000 + GAP_MS + 3000;
  const n = normalize(q, p, now);
  assert.deepEqual(n, { status: 'playing', index: 1, startAt: 10000 + GAP_MS });
  assert.deepEqual(resolve(q, n, now + 777), resolve(q, p, now + 777));
});
