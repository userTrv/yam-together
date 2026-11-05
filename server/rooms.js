// Комнаты («вагоны»): участники, очередь, воспроизведение.
// Чистая логика без сети, чтобы её можно было гонять в тестах.

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { resolve, normalize, LEAD_MS } from '../shared/timeline.js';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LINE_COLORS = [
  '#e4473d', '#3daa5c', '#3f7fe0', '#2fb3c4', '#f08a24',
  '#9a6bd8', '#a0703f', '#9cc63b', '#e25c9c', '#8b93a7',
];
export const REACTIONS = ['🔥', '❤️', '😂', '🕺', '😮', '👏'];

const MAX_MEMBERS = 40;
const MAX_QUEUE = 300;
const MEMBER_FORGET_MS = 30 * 60 * 1000;

export class RoomError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

function sameSecret(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Room {
  constructor(code, now) {
    this.code = code;
    this.createdAt = now;
    this.touchedAt = now;
    this.hostId = null;
    /** @type {Map<string, any>} */
    this.members = new Map();
    this.queue = [];
    this.playback = { status: 'idle' };
    this.settings = { everyoneControls: true };
    this.skipVotes = new Set();
    this.version = 0;
    this.seq = 0;
    this.colorCursor = randomInt(LINE_COLORS.length);
  }

  // ——— участники ———

  join(name, now) {
    if (this.members.size >= MAX_MEMBERS) this.forgetStale(now, 0);
    if (this.members.size >= MAX_MEMBERS) throw new RoomError(409, 'В вагоне нет мест');
    const id = randomBytes(6).toString('hex');
    const key = randomBytes(18).toString('base64url');
    const used = new Set([...this.members.values()].map((m) => m.color));
    let color = LINE_COLORS[this.colorCursor % LINE_COLORS.length];
    for (let i = 0; i < LINE_COLORS.length && used.has(color); i++) {
      this.colorCursor += 1;
      color = LINE_COLORS[this.colorCursor % LINE_COLORS.length];
    }
    this.colorCursor += 1;
    const member = {
      id, key, color,
      name: clean(name, 24) || 'Пассажир',
      joinedAt: now, lastSeen: now, online: 0,
      sync: { state: 'joining', driftMs: null, source: null, at: now },
    };
    this.members.set(id, member);
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = id;
    this.bump(now);
    return member;
  }

  auth(id, key) {
    const m = this.members.get(String(id ?? ''));
    if (!m || !sameSecret(m.key, key ?? '')) throw new RoomError(401, 'Нужно заново войти в вагон');
    return m;
  }

  connect(member, now) { member.online += 1; member.lastSeen = now; this.bump(now); }
  disconnect(member, now) {
    member.online = Math.max(0, member.online - 1);
    member.lastSeen = now;
    if (member.online === 0) member.sync = { ...member.sync, state: 'offline', at: now };
    this.bump(now);
  }

  forgetStale(now, ttl = MEMBER_FORGET_MS) {
    let changed = false;
    for (const [id, m] of this.members) {
      if (m.online === 0 && now - m.lastSeen > ttl) {
        this.members.delete(id); this.skipVotes.delete(id); changed = true;
      }
    }
    if (changed && !this.members.has(this.hostId)) {
      const next = [...this.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostId = next ? next.id : null;
    }
    if (changed) this.bump(now);
    return changed;
  }

  // ——— права ———

  canControl(member) { return this.settings.everyoneControls || member.id === this.hostId; }
  requireControl(member) {
    if (!this.canControl(member)) throw new RoomError(403, 'Пульт сейчас только у хозяина вагона');
  }
  onlineCount() { return [...this.members.values()].filter((m) => m.online > 0).length; }

  // ——— действия ———

  /** Применить действие участника. Возвращает событие для рассылки или null. */
  act(member, action, now) {
    member.lastSeen = now;
    this.touchedAt = now;
    this.playback = normalize(this.queue, this.playback, now);
    const type = action?.type;
    switch (type) {
      case 'add': return this.add(member, action.track, now, Boolean(action.next));
      case 'remove': return this.remove(member, String(action.qid ?? ''), now);
      case 'playNext': return this.playNext(member, String(action.qid ?? ''), now);
      case 'toggle': return this.toggle(member, now);
      case 'skip': return this.skip(member, now);
      case 'voteSkip': return this.voteSkip(member, now);
      case 'jump': return this.jump(member, String(action.qid ?? ''), now);
      case 'seek': return this.seek(member, Number(action.positionMs), now);
      case 'react': return this.react(member, action.emoji, now);
      case 'status': return this.status(member, action, now);
      case 'settings': return this.updateSettings(member, action, now);
      case 'rename': return this.rename(member, action.name, now);
      default: throw new RoomError(400, 'Неизвестное действие');
    }
  }

  add(member, track, now, next) {
    if (this.queue.length >= MAX_QUEUE) throw new RoomError(409, 'Очередь заполнена');
    const t = sanitizeTrack(track);
    const item = { qid: randomBytes(5).toString('hex'), ...t, addedBy: member.id, addedAt: now };
    const r = resolve(this.queue, this.playback, now);
    if (next && (r.status === 'playing' || r.status === 'paused')) {
      this.queue.splice(r.index + 1, 0, item);
    } else {
      this.queue.push(item);
    }
    if (r.status === 'idle' || r.status === 'ended') {
      const index = this.queue.indexOf(item);
      this.playback = { status: 'playing', index, startAt: now + LEAD_MS };
      this.skipVotes.clear();
    }
    this.bump(now);
    return { kind: 'toast', text: `${member.name} добавляет «${item.title}»`, by: member.id };
  }

  remove(member, qid, now) {
    const i = this.queue.findIndex((q) => q.qid === qid);
    if (i < 0) throw new RoomError(404, 'Трека уже нет в очереди');
    const r = resolve(this.queue, this.playback, now);
    if (i <= r.index && r.status !== 'idle') throw new RoomError(409, 'Этот трек уже звучал или звучит сейчас');
    if (this.queue[i].addedBy !== member.id) this.requireControl(member);
    this.queue.splice(i, 1);
    if (this.playback.status === 'playing' && this.playback.index > this.queue.length) {
      this.playback.index = this.queue.length;
    }
    this.bump(now);
    return null;
  }

  playNext(member, qid, now) {
    this.requireControl(member);
    const r = resolve(this.queue, this.playback, now);
    const i = this.queue.findIndex((q) => q.qid === qid);
    if (i < 0) throw new RoomError(404, 'Трека уже нет в очереди');
    if (i <= r.index + 1) return null;
    const [item] = this.queue.splice(i, 1);
    this.queue.splice(r.index + 1, 0, item);
    this.bump(now);
    return null;
  }

  toggle(member, now) {
    this.requireControl(member);
    const r = resolve(this.queue, this.playback, now);
    if (r.status === 'playing') {
      this.playback = { status: 'paused', index: r.index, positionMs: r.positionMs };
    } else if (r.status === 'paused') {
      this.playback = { status: 'playing', index: r.index, startAt: now + LEAD_MS - r.positionMs };
    } else if (this.queue.length > 0) {
      // Конец очереди: начинаем с последнего трека заново.
      this.playback = { status: 'playing', index: Math.max(0, r.index), startAt: now + LEAD_MS };
    }
    this.bump(now);
    return null;
  }

  skip(member, now) {
    this.requireControl(member);
    return this.doSkip(now, null);
  }

  doSkip(now, reason) {
    const r = resolve(this.queue, this.playback, now);
    if (r.status === 'idle' || r.status === 'ended') return null;
    const index = r.index + 1;
    this.playback = index < this.queue.length
      ? { status: 'playing', index, startAt: now + LEAD_MS }
      : { status: 'playing', index: this.queue.length, startAt: now };
    this.skipVotes.clear();
    this.bump(now);
    return reason ? { kind: 'toast', text: reason } : null;
  }

  voteSkip(member, now) {
    const r = resolve(this.queue, this.playback, now);
    if (r.status !== 'playing' && r.status !== 'paused') return null;
    const current = this.queue[r.index].qid;
    if (this.skipVotes.qid !== current) { this.skipVotes = new Set(); this.skipVotes.qid = current; }
    if (this.skipVotes.has(member.id)) this.skipVotes.delete(member.id);
    else this.skipVotes.add(member.id);
    const need = Math.max(1, Math.ceil(this.onlineCount() / 2));
    if (this.skipVotes.size >= need) return this.doSkip(now, 'Вагон проголосовал: пропускаем');
    this.bump(now);
    return null;
  }

  jump(member, qid, now) {
    this.requireControl(member);
    const i = this.queue.findIndex((q) => q.qid === qid);
    if (i < 0) throw new RoomError(404, 'Трека уже нет в очереди');
    this.playback = { status: 'playing', index: i, startAt: now + LEAD_MS };
    this.skipVotes.clear();
    this.bump(now);
    return null;
  }

  seek(member, positionMs, now) {
    this.requireControl(member);
    const r = resolve(this.queue, this.playback, now);
    if (r.status !== 'playing' && r.status !== 'paused') return null;
    const dur = this.queue[r.index].durationMs;
    const pos = Math.max(0, Math.min(Number.isFinite(positionMs) ? positionMs : 0, dur - 1000));
    this.playback = r.status === 'paused'
      ? { status: 'paused', index: r.index, positionMs: pos }
      : { status: 'playing', index: r.index, startAt: now + LEAD_MS - pos };
    this.bump(now);
    return null;
  }

  react(member, emoji, now) {
    if (!REACTIONS.includes(emoji)) throw new RoomError(400, 'Такой реакции нет');
    if (member.lastReactAt && now - member.lastReactAt < 400) return null;
    member.lastReactAt = now;
    return { kind: 'react', emoji, by: member.id, color: member.color };
  }

  status(member, s, now) {
    const states = ['synced', 'catching', 'loading', 'blocked', 'muted', 'unavailable', 'idle'];
    const state = states.includes(s.state) ? s.state : 'idle';
    const drift = Number(s.driftMs);
    member.sync = {
      state,
      driftMs: Number.isFinite(drift) ? Math.round(Math.max(-60000, Math.min(60000, drift))) : null,
      source: s.yandex ? 'yandex' : 'demo',
      at: now,
    };
    member.hasYandex = Boolean(s.yandex);
    // Статусы приходят часто, рассылаем их пачкой (см. server/index.js).
    this.statusDirty = true;
    return null;
  }

  updateSettings(member, s, now) {
    if (member.id !== this.hostId) throw new RoomError(403, 'Настройки меняет хозяин вагона');
    if (typeof s.everyoneControls === 'boolean') this.settings.everyoneControls = s.everyoneControls;
    this.bump(now);
    return null;
  }

  rename(member, name, now) {
    member.name = clean(name, 24) || member.name;
    this.bump(now);
    return null;
  }

  bump(now) { this.version += 1; this.touchedAt = now; }

  /** Снимок для клиентов. Ключи участников сюда не попадают. */
  snapshot(now) {
    this.playback = normalize(this.queue, this.playback, now);
    return {
      code: this.code,
      version: this.version,
      serverNow: now,
      hostId: this.hostId,
      settings: this.settings,
      queue: this.queue,
      playback: this.playback,
      skipVotes: this.skipVotes.qid ? [...this.skipVotes] : [],
      skipQid: this.skipVotes.qid ?? null,
      members: [...this.members.values()].map((m) => ({
        id: m.id, name: m.name, color: m.color, online: m.online > 0,
        lastSeen: m.lastSeen, sync: m.sync, hasYandex: Boolean(m.hasYandex),
      })),
    };
  }
}

export function sanitizeTrack(t) {
  if (!t || typeof t !== 'object') throw new RoomError(400, 'Нет трека');
  const source = t.source === 'yandex' ? 'yandex' : t.source === 'demo' ? 'demo' : null;
  if (!source) throw new RoomError(400, 'Неизвестный источник трека');
  const id = clean(t.id, 64);
  if (!/^[A-Za-z0-9:_-]{1,64}$/.test(id)) throw new RoomError(400, 'Странный id трека');
  const durationMs = Math.round(Number(t.durationMs));
  if (!Number.isFinite(durationMs) || durationMs < 5000 || durationMs > 60 * 60 * 1000) {
    throw new RoomError(400, 'Странная длительность трека');
  }
  let cover = clean(t.cover, 300);
  if (cover && !/^https:\/\/avatars\.yandex\.net\//.test(cover)) cover = '';
  return {
    source, id, durationMs, cover,
    title: clean(t.title, 120) || 'Без названия',
    artist: clean(t.artist, 120),
  };
}

export class Rooms {
  constructor({ maxRooms = 2000, idleMs = 6 * 60 * 60 * 1000 } = {}) {
    this.map = new Map();
    this.maxRooms = maxRooms;
    this.idleMs = idleMs;
  }

  create(now) {
    this.sweep(now);
    if (this.map.size >= this.maxRooms) throw new RoomError(503, 'Слишком много вагонов, попробуйте позже');
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.map.has(code));
    const room = new Room(code, now);
    this.map.set(code, room);
    return room;
  }

  get(code) {
    const room = this.map.get(String(code ?? '').toUpperCase());
    if (!room) throw new RoomError(404, 'Такого вагона нет. Проверьте код');
    return room;
  }

  sweep(now) {
    for (const [code, room] of this.map) {
      const anyoneOnline = [...room.members.values()].some((m) => m.online > 0);
      if (!anyoneOnline && now - room.touchedAt > this.idleMs) this.map.delete(code);
      else room.forgetStale(now);
    }
  }
}
