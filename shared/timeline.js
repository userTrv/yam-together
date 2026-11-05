// Общая логика таймлайна комнаты. Один и тот же файл работает на сервере (Node)
// и в браузере, поэтому любой участник, даже без связи в тоннеле, сам знает,
// какой трек и с какой секунды сейчас играет у всех.
//
// Модель: очередь треков и «якорь» — индекс трека и серверное время, когда
// у этого трека была нулевая секунда. Дальше всё считается арифметикой:
// трек N+1 начинается через GAP_MS после конца трека N.

export const GAP_MS = 1200; // пауза между треками: время сменить источник звука
export const LEAD_MS = 1500; // запас на старт после команды: все успевают загрузиться

/**
 * @typedef {{ qid: string, durationMs: number }} QueueItem
 * @typedef {{ status: 'idle' } |
 *   { status: 'playing', index: number, startAt: number } |
 *   { status: 'paused', index: number, positionMs: number }} Playback
 */

/**
 * Где сейчас воспроизведение.
 * @param {QueueItem[]} queue
 * @param {Playback} playback
 * @param {number} now серверное время, мс
 * @returns {{ status: 'idle' | 'playing' | 'paused' | 'ended', index: number, startAt: number, positionMs: number }}
 */
export function resolve(queue, playback, now) {
  if (!playback || playback.status === 'idle' || queue.length === 0) {
    return { status: 'idle', index: -1, startAt: 0, positionMs: 0 };
  }
  if (playback.status === 'paused') {
    const index = Math.min(playback.index, queue.length - 1);
    return { status: 'paused', index, startAt: 0, positionMs: playback.positionMs };
  }
  let index = playback.index;
  let startAt = playback.startAt;
  if (index >= queue.length) {
    return { status: 'ended', index: queue.length - 1, startAt, positionMs: 0 };
  }
  // Идём по очереди вперёд, пока текущий трек уже закончился.
  while (now >= startAt + queue[index].durationMs + GAP_MS) {
    if (index + 1 >= queue.length) {
      return { status: 'ended', index, startAt, positionMs: queue[index].durationMs };
    }
    startAt += queue[index].durationMs + GAP_MS;
    index += 1;
  }
  const positionMs = Math.max(0, Math.min(now - startAt, queue[index].durationMs));
  return { status: 'playing', index, startAt, positionMs };
}

/**
 * Свести воспроизведение к каноничному виду: якорь на текущем треке.
 * Сервер вызывает это перед каждым изменением, чтобы якорь не уезжал в прошлое.
 * @param {QueueItem[]} queue
 * @param {Playback} playback
 * @param {number} now
 * @returns {Playback}
 */
export function normalize(queue, playback, now) {
  const r = resolve(queue, playback, now);
  if (r.status === 'idle') return { status: 'idle' };
  if (r.status === 'paused') return { status: 'paused', index: r.index, positionMs: r.positionMs };
  if (r.status === 'ended') return { status: 'playing', index: queue.length, startAt: r.startAt };
  return { status: 'playing', index: r.index, startAt: r.startAt };
}

/** Через сколько мс случится следующее событие таймлайна (смена трека или конец). */
export function nextBoundary(queue, playback, now) {
  const r = resolve(queue, playback, now);
  if (r.status !== 'playing') return Infinity;
  return r.startAt + queue[r.index].durationMs + GAP_MS - now;
}
