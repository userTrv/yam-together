// Сверка часов с сервером, как в NTP: несколько пингов, берём самые быстрые.
// Смещение нужно, чтобы «трек начался в 12:03:07.250» значило одно и то же на всех телефонах.

export class Clock {
  constructor() {
    this.offset = 0;
    this.rtt = null;
    this.synced = false;
    this.samples = [];
  }

  now() { return Date.now() + this.offset; }

  async ping() {
    const t0 = Date.now();
    const res = await fetch('/api/time', { cache: 'no-store' });
    const t1 = Date.now();
    const { now } = await res.json();
    return { rtt: t1 - t0, offset: now - (t0 + t1) / 2 };
  }

  async sync(count = 6) {
    const fresh = [];
    for (let i = 0; i < count; i++) {
      try { fresh.push(await this.ping()); } catch { /* нет связи — попробуем позже */ }
    }
    if (!fresh.length) return false;
    // Держим окно последних замеров, чтобы один плохой пинг не дёргал часы.
    this.samples = [...this.samples, ...fresh].slice(-24);
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, 5);
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    this.offset = offsets[Math.floor(offsets.length / 2)];
    this.rtt = best[0].rtt;
    this.synced = true;
    return true;
  }
}
