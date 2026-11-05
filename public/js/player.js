// Синхронный плеер. Каждые 250 мс сверяет, где должен быть трек по общим часам,
// и подтягивает свой <audio>: мелкое расхождение лечит скоростью (незаметно на слух),
// крупное — перемоткой. Следующий трек скачивается заранее, поэтому тоннель
// без связи музыку не останавливает.

import { resolve } from '/shared/timeline.js';

const HARD_SEEK_S = 0.4;
const SOFT_S = 0.025;
const SYNCED_S = 0.06;

export class SyncPlayer {
  /**
   * @param {{ clock: import('./clock.js').Clock, load: (track: any) => Promise<string>, onStatus: (s: any) => void }} opts
   */
  constructor({ clock, load, onStatus }) {
    this.clock = clock;
    this.load = load;
    this.onStatus = onStatus;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.queue = [];
    this.playback = { status: 'idle' };
    this.latencyMs = 0;
    this.muted = false;
    this.unlocked = false;
    this.current = null; // { qid, url }
    this.loading = new Map(); // qid -> Promise<string>
    this.ready = new Map(); // qid -> url
    this.errors = new Map(); // qid -> message
    this.correcting = false;
    this.seekLag = 0.08; // сколько секунд уходит на перемотку, подстраивается само
    this.lastSeekAt = 0;
    this.status = { state: 'idle', driftMs: null };
    this.timer = setInterval(() => this.tick(), 250);
    document.addEventListener('visibilitychange', () => this.tick());
    this.audio.addEventListener('playing', () => this.tick());
    this.audio.addEventListener('waiting', () => this.report('loading', null));
  }

  setRoom(queue, playback) {
    this.queue = queue;
    this.playback = playback;
    const alive = new Set(queue.map((q) => q.qid));
    for (const qid of this.ready.keys()) if (!alive.has(qid)) this.ready.delete(qid);
    this.tick();
  }

  /** Вызвать из обработчика нажатия: мобильные браузеры разрешают звук только после жеста. */
  async unlock() {
    this.unlocked = true;
    try {
      if (!this.audio.src) {
        // Короткая тишина, чтобы браузер запомнил, что звук разрешён.
        this.audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
      }
      await this.audio.play();
    } catch { /* разберёмся на следующем тике */ }
    this.tick();
  }

  /** Забыть ошибки загрузки, например после подключения Яндекс Музыки. */
  retry() { this.errors.clear(); this.tick(); }

  setMuted(m) { this.muted = m; this.audio.muted = m; this.tick(); }
  setLatency(ms) { this.latencyMs = ms; this.tick(); }

  report(state, driftMs) {
    const changed = state !== this.status.state || Math.abs((driftMs ?? 0) - (this.status.driftMs ?? 0)) > 15;
    const item = this.queue[resolve(this.queue, this.playback, this.clock.now()).index];
    this.status = { state, driftMs, error: (item && this.errors.get(item.qid)?.message) ?? null };
    if (changed) this.onStatus?.(this.status);
  }

  prepare(item) {
    if (!item) return null;
    const err = this.errors.get(item.qid);
    if (err && performance.now() - err.at < 8000) return null;
    if (this.ready.has(item.qid)) return Promise.resolve(this.ready.get(item.qid));
    if (this.loading.has(item.qid)) return this.loading.get(item.qid);
    const p = this.load(item)
      .then((url) => { this.ready.set(item.qid, url); this.errors.delete(item.qid); return url; })
      .catch((err) => { this.errors.set(item.qid, { message: err?.message || 'Не удалось загрузить трек', at: performance.now() }); throw err; })
      .finally(() => { this.loading.delete(item.qid); this.tick(); });
    this.loading.set(item.qid, p);
    p.catch(() => {});
    return p;
  }

  tick() {
    const now = this.clock.now() + this.latencyMs;
    const r = resolve(this.queue, this.playback, now);
    const a = this.audio;

    if (r.status !== 'playing') {
      if (!a.paused) a.pause();
      if (r.status === 'paused') {
        const item = this.queue[r.index];
        if (item) { this.prepare(item); this.prepare(this.queue[r.index + 1]); }
      }
      this.report(r.status === 'paused' ? 'paused' : 'idle', null);
      return;
    }

    const item = this.queue[r.index];
    this.prepare(this.queue[r.index + 1]);

    const err = this.errors.get(item.qid);
    if (err && !this.ready.has(item.qid) && performance.now() - err.at < 8000) {
      if (!a.paused) a.pause();
      this.report('unavailable', null);
      return;
    }
    const url = this.ready.get(item.qid);
    if (!url) {
      this.prepare(item);
      if (!a.paused) a.pause();
      this.report('loading', null);
      return;
    }

    if (this.current?.qid !== item.qid || this.current?.url !== url) {
      this.current = { qid: item.qid, url };
      a.src = url;
      a.playbackRate = 1;
      this.correcting = false;
    }

    const target = (now - r.startAt) / 1000;
    if (target < 0) {
      // Старт в будущем: встаём на ноль и ждём общего момента.
      if (!a.paused) a.pause();
      if (a.readyState >= 1 && a.currentTime !== 0) a.currentTime = 0;
      clearTimeout(this.startTimer);
      if (-target < 0.3) {
        this.startTimer = setTimeout(() => this.startNow(), Math.max(0, -target * 1000 - 5));
      }
      this.report('loading', null);
      return;
    }

    if (item.durationMs && target * 1000 >= item.durationMs - 50) {
      if (!a.paused) a.pause();
      this.report('synced', 0);
      return;
    }

    if (!this.unlocked) { this.report('blocked', null); return; }
    if (a.readyState < 2) { this.report('loading', null); return; }

    if (a.paused) {
      this.seek(target + this.seekLag);
      a.play().catch(() => this.report('blocked', null));
      return;
    }

    const drift = a.currentTime - target;
    if (Math.abs(drift) > HARD_SEEK_S) {
      const sinceSeek = performance.now() - this.lastSeekAt;
      // Если после прошлой перемотки опять отстаём, перемотка медленнее, чем думали.
      if (sinceSeek < 1500 && drift < 0) this.seekLag = Math.min(0.6, this.seekLag - drift);
      this.seek(target + this.seekLag);
      a.playbackRate = 1;
      this.correcting = false;
      this.report('catching', Math.round(drift * 1000));
      return;
    }
    if (Math.abs(drift) > SOFT_S || (this.correcting && Math.abs(drift) > 0.008)) {
      this.correcting = true;
      // Убираем расхождение примерно за две секунды, не больше ±6% скорости.
      a.playbackRate = Math.max(0.94, Math.min(1.06, 1 - drift / 2));
    } else {
      this.correcting = false;
      a.playbackRate = 1;
    }
    this.report(Math.abs(drift) <= SYNCED_S ? 'synced' : 'catching', Math.round(drift * 1000));
  }

  startNow() {
    const a = this.audio;
    const now = this.clock.now() + this.latencyMs;
    const r = resolve(this.queue, this.playback, now);
    if (r.status !== 'playing' || !this.unlocked) return;
    const target = Math.max(0, (now - r.startAt) / 1000);
    if (a.readyState >= 1) a.currentTime = target;
    a.play().catch(() => this.report('blocked', null));
  }

  seek(t) {
    this.lastSeekAt = performance.now();
    try { this.audio.currentTime = Math.max(0, t); } catch { /* ещё нет метаданных */ }
  }

  /** Позиция для интерфейса: по общим часам, а не по своему плееру. */
  position() {
    return resolve(this.queue, this.playback, this.clock.now());
  }
}
