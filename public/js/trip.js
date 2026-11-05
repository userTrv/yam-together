// Итоги поездки: сколько слушали вместе и какие станции проехали.
// Картинка 1080×1920 для сторис — главный способ, которым вагон зовёт новых людей.

const key = (code) => 'vagon:trip:' + code;

export class Trip {
  constructor(code) {
    this.code = code;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key(code)) || 'null'); } catch { /* */ }
    this.ms = saved?.ms ?? 0;
    this.tracks = saved?.tracks ?? []; // [{ qid, title, artist, color }]
    this.people = saved?.people ?? {}; // id -> { name, color }
    this.startedAt = saved?.startedAt ?? Date.now();
  }

  /** Вызывать раз в секунду, когда звук реально идёт вместе с вагоном. */
  tick(item, colorOf, members, meId) {
    this.ms += 1000;
    if (item && !this.tracks.some((t) => t.qid === item.qid)) {
      this.tracks.push({ qid: item.qid, title: item.title, artist: item.artist, color: colorOf(item.addedBy) ?? '#8b93a7' });
      if (this.tracks.length > 60) this.tracks.shift();
    }
    for (const m of members) if (m.online && m.id !== meId) this.people[m.id] = { name: m.name, color: m.color };
    if (this.ms % 10000 === 0) this.save();
  }

  save() {
    try { localStorage.setItem(key(this.code), JSON.stringify({ ms: this.ms, tracks: this.tracks, people: this.people, startedAt: this.startedAt })); } catch { /* */ }
  }

  minutes() { return Math.floor(this.ms / 60000); }

  /** Рисует карточку итогов и возвращает canvas. */
  async render() {
    await document.fonts?.ready;
    const W = 1080; const H = 1920;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#0b0d14'; g.fillRect(0, 0, W, H);

    const font = (w, s, fam = 'Manrope') => `${w} ${s}px ${fam}, system-ui, sans-serif`;
    // Шапка
    g.fillStyle = '#7a8296'; g.font = font(500, 36, 'JetBrains Mono');
    g.fillText(`Вагон ${this.code}`, 96, 168);
    const mins = this.minutes();
    const headline = mins < 1 ? 'Меньше минуты' : `${mins} ${plural(mins, 'минута', 'минуты', 'минут')}`;
    let size = 132;
    g.font = font(500, size);
    while (g.measureText(headline).width > W - 192 && size > 72) { size -= 4; g.font = font(500, size); }
    g.fillStyle = '#eef0f5';
    g.fillText(headline, 96, 340);
    g.fillStyle = '#a3a9b8'; g.font = font(400, 52);
    const people = Object.values(this.people);
    const withWhom = people.length
      ? `Ехали вместе: ${people.slice(0, 3).map((p) => p.name).join(', ')}${people.length > 3 ? ` и ещё ${people.length - 3}` : ''}`
      : 'Музыка в одном вагоне';
    wrap(g, withWhom, 96, 424, W - 192, 64);
    g.fillStyle = '#7a8296'; g.font = font(400, 34, 'JetBrains Mono');
    const n = this.tracks.length;
    g.fillText(`${n} ${plural(n, 'станция', 'станции', 'станций')} · ${people.length + 1} ${plural(people.length + 1, 'пассажир', 'пассажира', 'пассажиров')}`, 96, 520);

    // Линия станций
    const shown = this.tracks.slice(-8);
    const top = 680; const step = Math.min(150, (H - top - 360) / Math.max(1, shown.length));
    shown.forEach((t, i) => {
      const y = top + i * step;
      if (i < shown.length - 1) {
        g.strokeStyle = t.color; g.lineWidth = 18; g.lineCap = 'round';
        g.beginPath(); g.moveTo(150, y); g.lineTo(150, y + step); g.stroke();
      }
    });
    shown.forEach((t, i) => {
      const y = top + i * step;
      const last = i === shown.length - 1;
      g.fillStyle = '#0b0d14'; g.strokeStyle = last ? '#ffb547' : t.color; g.lineWidth = last ? 16 : 12;
      g.beginPath(); g.arc(150, y, last ? 34 : 26, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#eef0f5'; g.font = font(500, 46);
      g.fillText(clip(g, t.title, W - 330), 240, y + 4);
      g.fillStyle = '#7a8296'; g.font = font(400, 34);
      g.fillText(clip(g, t.artist || '', W - 330), 240, y + 52);
    });
    if (!shown.length) {
      g.fillStyle = '#7a8296'; g.font = font(400, 44);
      g.fillText('Станции появятся, когда заиграет музыка', 96, top);
    }

    // Подвал
    g.fillStyle = '#ffb547'; g.font = font(600, 52);
    g.fillText('Один трек на весь вагон', 96, H - 200);
    g.fillStyle = '#7a8296'; g.font = font(400, 38, 'JetBrains Mono');
    g.fillText(location.host, 96, H - 128);
    return c;
  }
}

function plural(n, one, few, many) {
  const a = n % 10; const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

function clip(g, text, max) {
  if (g.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function wrap(g, text, x, y, max, lh) {
  const words = text.split(' ');
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (g.measureText(test).width > max && line) { g.fillText(line, x, y); line = w; y += lh; }
    else line = test;
  }
  if (line) g.fillText(line, x, y);
}
