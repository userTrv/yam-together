// Вагон: склейка интерфейса, сети и плеера.

import { Clock } from './clock.js';
import { SyncPlayer } from './player.js';
import { DEMO, coverFor } from './catalog.js';
import { loadTrack, yandexToken, parseToken, ymFetch } from './sources.js';
import { qrSvg } from './qr.js';
import { resolve } from '/shared/timeline.js';
import { Trip } from './trip.js';

const REACTIONS = ['🔥', '❤️', '😂', '🕺', '😮', '👏'];
const YM_OAUTH = 'https://oauth.yandex.ru/authorize?response_type=token&client_id=23cabbbdc6cd418abb4b39c32c41195d';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d = null) { try { const v = localStorage.getItem('vagon:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { v === null ? localStorage.removeItem('vagon:' + k) : localStorage.setItem('vagon:' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
};

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, few, many) => {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Ошибка ${res.status}`); e.status = res.status; throw e; }
  return data;
}

// ——— состояние ———
const clock = new Clock();
const state = {
  code: null,
  me: null, // { id, key, name, color }
  room: null, // последний снимок
  es: null,
  online: navigator.onLine,
  lastEventAt: 0,
};

const player = new SyncPlayer({
  clock,
  load: loadTrack,
  onStatus: () => { renderSync(); sendStatusSoon(); },
});
player.setLatency(store.get('latency', 0));

// ——— маршрутизация ———
function route() {
  const m = /^\/r\/([A-Za-z0-9]{4,8})\/?$/.exec(location.pathname);
  if (m) {
    const code = m[1].toUpperCase();
    const saved = store.get('member:' + code);
    if (saved) return enterRoom(code, saved);
    return showJoin({ code });
  }
  if (location.pathname === '/join') return showJoin({ askCode: true, code: new URLSearchParams(location.search).get('code') });
  return showJoin({});
}

// ——— вход ———
let joinMode = { code: null, askCode: false };

async function showJoin({ code = null, askCode = false }) {
  joinMode = { code, askCode };
  $('view-room').hidden = true;
  $('view-join').hidden = false;
  $('join-name').value = store.get('name', '');
  $('join-error').hidden = true;
  $('join-code-row').hidden = !askCode;
  $('join-switch').hidden = Boolean(code);
  $('join-switch').textContent = askCode ? 'Создать свой вагон' : 'У меня есть код';
  if (code || askCode) {
    $('join-heading').textContent = code ? `Вагон ${code}` : 'Войти по коду';
    $('join-sub').textContent = 'Назовитесь, и музыка подхватится с той же секунды, что у всех';
    $('join-submit').textContent = 'Войти в вагон';
    if (askCode && code) $('join-code').value = code;
  } else {
    $('join-heading').textContent = 'Новый вагон';
    $('join-sub').textContent = 'Придумайте имя, его увидят остальные пассажиры';
    $('join-submit').textContent = 'Создать вагон';
  }
  $('join-preview').hidden = true;
  if (code) {
    try {
      const snap = await api('/api/rooms/' + code);
      const r = resolve(snap.queue, snap.playback, snap.serverNow);
      const online = snap.members.filter((m) => m.online).length;
      $('join-preview-label').textContent = `${online} ${plural(online, 'пассажир', 'пассажира', 'пассажиров')} в вагоне`;
      const item = snap.queue[r.index];
      if (item && (r.status === 'playing' || r.status === 'paused')) {
        $('join-cover').src = coverFor(item);
        $('join-title').textContent = item.title;
        $('join-meta').textContent = item.artist;
        $('join-preview').hidden = false;
      } else if (online) {
        $('join-cover').src = '/icon.svg';
        $('join-title').textContent = 'Пока тихо';
        $('join-meta').textContent = 'Можно добавить первый трек';
        $('join-preview').hidden = false;
      }
    } catch (err) {
      showJoinError(err.status === 404 ? 'Такого вагона нет. Возможно, он уже уехал в депо' : err.message);
    }
  }
  setTimeout(() => $(askCode && !code ? 'join-code' : 'join-name').focus(), 50);
}

function showJoinError(text) { $('join-error').textContent = text; $('join-error').hidden = false; }

$('join-switch').addEventListener('click', () => {
  history.pushState(null, '', joinMode.askCode ? '/new' : '/join');
  route();
});

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('join-name').value.trim();
  if (!name) { showJoinError('Нужно имя, хотя бы одна буква'); $('join-name').focus(); return; }
  let code = joinMode.code;
  if (joinMode.askCode) {
    code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { showJoinError('Код — это пять букв и цифр, например K7QMP'); $('join-code').focus(); return; }
  }
  store.set('name', name);
  player.unlock(); // жест пользователя: разрешаем звук прямо сейчас
  $('join-submit').disabled = true;
  try {
    const res = code
      ? await api(`/api/rooms/${code}/join`, { name })
      : await api('/api/rooms', { name });
    store.set('member:' + res.code, res.member);
    history.pushState(null, '', '/r/' + res.code);
    enterRoom(res.code, res.member);
  } catch (err) {
    showJoinError(err.status === 404 ? 'Такого вагона нет. Проверьте код' : err.message);
  } finally {
    $('join-submit').disabled = false;
  }
});

// ——— вагон ———
async function enterRoom(code, member) {
  state.code = code;
  state.me = member;
  $('view-join').hidden = true;
  $('view-room').hidden = false;
  $('code-chip').textContent = code;
  document.title = `Вагон ${code}`;
  renderReactBar();
  renderDemoList();
  state.trip = new Trip(code);
  await clock.sync(5);
  connect();
  setInterval(() => clock.sync(3), 30000);
  if (!player.unlocked) $('tap-to-listen').hidden = false;
}

function connect() {
  if (state.es) state.es.close();
  const { id, key } = state.me;
  const es = new EventSource(`/api/rooms/${state.code}/events?id=${encodeURIComponent(id)}&key=${encodeURIComponent(key)}`);
  state.es = es;
  let opened = false;
  es.addEventListener('open', () => { opened = true; state.lastEventAt = Date.now(); setOnline(navigator.onLine); });
  es.addEventListener('state', (e) => { state.lastEventAt = Date.now(); applySnapshot(JSON.parse(e.data)); });
  es.addEventListener('event', (e) => { state.lastEventAt = Date.now(); onRoomEvent(JSON.parse(e.data)); });
  es.addEventListener('ping', () => { state.lastEventAt = Date.now(); setOnline(navigator.onLine); });
  es.addEventListener('error', async () => {
    setOnline(false);
    if (!opened) {
      // Возможно, нас забыли (сервер перезапускался): проверим и войдём заново.
      try {
        await api(`/api/rooms/${state.code}/act`, { id, key, action: { type: 'status', state: 'idle' } });
      } catch (err) {
        if (err.status === 401 || err.status === 404) {
          es.close();
          store.set('member:' + state.code, null);
          toast(err.status === 404 ? 'Вагон уехал в депо. Создайте новый' : 'Нужно войти заново', true);
          showJoin(err.status === 404 ? {} : { code: state.code });
        }
      }
    }
  });
}

function setOnline(on) {
  if (state.online === on) return;
  state.online = on;
  $('net').hidden = on;
  if (on) clock.sync(3);
}

window.addEventListener('online', () => { if (state.code) connect(); });
window.addEventListener('offline', () => setOnline(false));
// Сервер шлёт ping раз в 10 секунд. Нет вестей 25 секунд — мы в тоннеле, переподключаемся.
setInterval(() => {
  if (!state.code || !state.lastEventAt) return;
  if (Date.now() - state.lastEventAt > 25000) { setOnline(false); connect(); state.lastEventAt = Date.now() - 15000; }
}, 5000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.code) {
    clock.sync(3);
    if (!state.es || state.es.readyState === 2) connect();
  }
});

function applySnapshot(snap) {
  // Сервер прислал своё время: если наши часы ещё не сверены, грубо подстроимся.
  if (!clock.synced) clock.offset = snap.serverNow - Date.now();
  state.room = snap;
  player.setRoom(snap.queue, snap.playback);
  const me = snap.members.find((m) => m.id === state.me.id);
  if (me) { state.me.name = me.name; state.me.color = me.color; }
  render();
}

async function act(action) {
  try {
    await api(`/api/rooms/${state.code}/act`, { id: state.me.id, key: state.me.key, action });
  } catch (err) {
    if (action.type !== 'status') toast(err.status ? err.message : 'Нет связи, команда не ушла. Попробуйте на станции', true);
    throw err;
  }
}

let statusTimer = null;
function sendStatusSoon() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    if (!state.code || !state.online) return;
    act({ type: 'status', state: player.muted ? 'muted' : player.status.state, driftMs: player.status.driftMs, yandex: Boolean(yandexToken.get()) }).catch(() => {});
  }, 600);
}
setInterval(() => { if (state.code) sendStatusSoon(); }, 5000);

function onRoomEvent(ev) {
  if (ev.kind === 'react') spawnReaction(ev.emoji, ev.color);
  if (ev.kind === 'toast' && ev.by !== state.me?.id) toast(ev.text, false, colorOf(ev.by));
  if (ev.kind === 'toast' && !ev.by) toast(ev.text);
}

const colorOf = (id) => state.room?.members.find((m) => m.id === id)?.color;
const nameOf = (id) => state.room?.members.find((m) => m.id === id)?.name ?? 'Пассажир';
const isHost = () => state.room?.hostId === state.me?.id;
const canControl = () => state.room?.settings.everyoneControls || isHost();

// ——— отрисовка ———
let lastRenderedQid = null;

function render() {
  const snap = state.room;
  if (!snap) return;
  const r = resolve(snap.queue, snap.playback, clock.now());
  const item = (r.status === 'playing' || r.status === 'paused') ? snap.queue[r.index] : null;

  // Сейчас играет
  if (item) {
    if (lastRenderedQid !== item.qid) {
      lastRenderedQid = item.qid;
      const img = $('now-cover');
      img.classList.remove('is-loaded');
      img.onload = () => img.classList.add('is-loaded');
      img.src = coverFor(item);
      $('now-empty').hidden = true;
      updateMediaSession(item);
    }
    $('now-title').textContent = item.title;
    $('now-artist').textContent = item.artist || ' ';
    const by = snap.members.find((m) => m.id === item.addedBy);
    $('now-label').innerHTML = `<span class="station" style="--line:${esc(by?.color ?? '#7a8296')}"></span>${r.status === 'paused' ? 'На паузе' : 'Сейчас'} · ставит ${esc(by?.name ?? 'пассажир')}`;
  } else {
    lastRenderedQid = null;
    $('now-cover').classList.remove('is-loaded');
    $('now-cover').removeAttribute('src');
    $('now-empty').hidden = false;
    $('now-label').textContent = r.status === 'ended' ? 'Линия закончилась' : 'Пока тихо';
    $('now-title').textContent = r.status === 'ended' ? 'Добавьте ещё трек' : 'Добавьте первый трек';
    $('now-artist').textContent = 'Он заиграет у всех сразу';
  }

  // Кнопки
  const control = canControl();
  const playBtn = $('btn-play');
  playBtn.classList.toggle('is-playing', r.status === 'playing');
  playBtn.setAttribute('aria-label', r.status === 'playing' ? 'Пауза для всех' : 'Играть для всех');
  playBtn.disabled = !control || snap.queue.length === 0;
  const skip = $('btn-skip');
  skip.disabled = !item;
  if (control) {
    $('skip-label').textContent = 'Дальше';
    skip.classList.remove('is-voted');
  } else {
    const online = snap.members.filter((m) => m.online).length;
    const need = Math.max(1, Math.ceil(online / 2));
    const votes = snap.skipQid === item?.qid ? snap.skipVotes.length : 0;
    $('skip-label').textContent = `Пропустить ${votes}/${need}`;
    skip.classList.toggle('is-voted', snap.skipVotes.includes(state.me.id));
  }
  $('progress').classList.toggle('can-seek', control && Boolean(item));

  renderPassengers();
  renderLine(r);
  renderSync();
  renderSettings();
}

function renderProgress() {
  const snap = state.room;
  if (!snap) return;
  const r = resolve(snap.queue, snap.playback, clock.now());
  const item = (r.status === 'playing' || r.status === 'paused') ? snap.queue[r.index] : null;
  if (item && item.qid !== lastRenderedQid) render();
  const dur = item?.durationMs ?? 0;
  const pos = item ? Math.min(r.positionMs, dur) : 0;
  $('bar-fill').style.transform = `scaleX(${dur ? pos / dur : 0})`;
  $('t-pos').textContent = fmt(pos);
  $('t-dur').textContent = fmt(dur);
  if ('mediaSession' in navigator && item && navigator.mediaSession.setPositionState && r.status === 'playing') {
    try { navigator.mediaSession.setPositionState({ duration: dur / 1000, position: pos / 1000, playbackRate: 1 }); } catch { /* */ }
  }
}
setInterval(renderProgress, 250);

// Считаем время, когда звук реально шёл вместе с вагоном.
setInterval(() => {
  const snap = state.room;
  if (!snap || !state.trip || player.audio.paused || player.muted) return;
  if (player.status.state !== 'synced' && player.status.state !== 'catching') return;
  const r = resolve(snap.queue, snap.playback, clock.now());
  state.trip.tick(snap.queue[r.index], colorOf, snap.members, state.me.id);
}, 1000);
addEventListener('pagehide', () => state.trip?.save());

const STATE_TEXT = {
  synced: 'в синхроне', catching: 'догоняет', loading: 'грузит трек', blocked: 'без звука',
  muted: 'без звука', unavailable: 'не слышит трек', idle: 'ждёт', paused: 'пауза', offline: 'в тоннеле', joining: 'заходит',
};

function renderPassengers() {
  const snap = state.room;
  const list = [...snap.members].sort((a, b) => (b.online - a.online) || (a.lastSeen - b.lastSeen));
  const online = list.filter((m) => m.online).length;
  $('passenger-count').textContent = `${online} ${plural(online, 'в вагоне', 'в вагоне', 'в вагоне')}`;
  $('passengers').innerHTML = list.map((m) => {
    const st = m.online ? (m.sync?.state ?? 'idle') : 'offline';
    const host = m.id === snap.hostId ? ' · пульт' : '';
    return `<li class="passenger${m.online ? '' : ' is-offline'}${m.id === state.me.id ? ' is-me' : ''}">
      <span class="station" style="--line:${esc(m.color)}"></span>
      <span>${esc(m.name)}${m.id === state.me.id ? ' (вы)' : ''}</span>
      <span class="passenger-state">${STATE_TEXT[st] ?? st}${host}</span>
    </li>`;
  }).join('');
}

function renderLine(r) {
  const snap = state.room;
  const q = snap.queue;
  $('line-empty').hidden = q.length > 0;
  const upcoming = r.status === 'idle' ? q.length : Math.max(0, q.length - r.index - 1);
  const leftMs = q.slice(r.index + 1).reduce((s, t) => s + t.durationMs, 0)
    + (r.status === 'playing' || r.status === 'paused' ? q[r.index].durationMs - r.positionMs : 0);
  $('line-meta').textContent = q.length ? `${upcoming} ${plural(upcoming, 'станция', 'станции', 'станций')} впереди · ${fmt(leftMs)}` : '';
  // Показываем две прошедшие станции и всё, что впереди.
  const from = Math.max(0, r.index - 2);
  const control = canControl();
  $('line').innerHTML = q.slice(from).map((t, k) => {
    const i = from + k;
    const past = r.status !== 'idle' && (i < r.index || (r.status === 'ended' && i <= r.index));
    const current = (r.status === 'playing' || r.status === 'paused') && i === r.index;
    const next = (r.status === 'playing' || r.status === 'paused') && i === r.index + 1;
    const color = colorOf(t.addedBy) ?? '#7a8296';
    const mine = t.addedBy === state.me.id;
    const tag = current ? '<span class="stop-tag">сейчас</span> · ' : next ? '<span class="stop-tag">следующая</span> · ' : '';
    const actions = !past && !current ? `
      ${control && !next ? `<button class="btn btn-ghost btn-icon" data-act="playNext" data-qid="${t.qid}" type="button" aria-label="Поставить следующим"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/></svg></button>` : ''}
      ${control || mine ? `<button class="btn btn-ghost btn-icon" data-act="remove" data-qid="${t.qid}" type="button" aria-label="Убрать из очереди"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>` : ''}` : '';
    return `<li class="stop${past ? ' is-past' : ''}${current ? ' is-current' : ''}" style="--line:${esc(color)}">
      <span class="stop-dot"></span>
      <div class="stop-body${control && !current ? ' is-jump' : ''}" ${control && !current ? `data-act="jump" data-qid="${t.qid}" role="button" tabindex="0" aria-label="Перейти к треку ${esc(t.title)}"` : ''}>
        <p class="stop-title">${esc(t.title)}</p>
        <p class="stop-meta">${tag}${esc(t.artist)} · ${esc(nameOf(t.addedBy))} <span class="mono">${fmt(t.durationMs)}</span></p>
      </div>
      <div class="stop-actions">${actions}</div>
    </li>`;
  }).join('');
}

function renderSync() {
  const el = $('sync');
  const snap = state.room;
  const s = player.status;
  let text = 'Подключаемся';
  let st = s.state;
  if (!state.online) { st = 'catching'; text = 'В тоннеле. Играем по своим часам, догоним на станции'; }
  else if (s.state === 'blocked') text = 'Браузер ждёт нажатия, чтобы включить звук';
  else if (s.state === 'unavailable') text = s.error || 'Этот трек у вас не загрузился';
  else if (s.state === 'loading') text = 'Загружаем трек';
  else if (s.state === 'paused') text = 'На паузе у всех';
  else if (s.state === 'idle') text = snap?.queue.length ? 'Линия закончилась' : 'Ждём первый трек';
  else if (snap) {
    const others = snap.members.filter((m) => m.online && m.id !== state.me.id && m.sync?.driftMs != null && m.sync.state === 'synced');
    const drifts = [s.driftMs ?? 0, ...others.map((m) => m.sync.driftMs)];
    const spread = Math.max(...drifts) - Math.min(...drifts);
    if (s.state === 'synced') {
      text = others.length
        ? `В синхроне с ${others.length} ${plural(others.length, 'пассажиром', 'пассажирами', 'пассажирами')} · разброс ${spread} мс`
        : `В синхроне · ${Math.abs(s.driftMs ?? 0)} мс`;
    } else {
      text = `Догоняем остальных · ${Math.abs(s.driftMs ?? 0)} мс`;
    }
  }
  if (player.muted && s.state !== 'blocked') text = 'Звук выключен у вас, вагон играет дальше';
  el.dataset.state = st;
  $('sync-text').textContent = text;
  $('tap-to-listen').hidden = s.state !== 'blocked';
}

function renderSettings() {
  const snap = state.room;
  $('host-setting').hidden = !isHost();
  $('everyone-controls').checked = snap.settings.everyoneControls;
  $('me-name').textContent = state.me.name;
}

function renderReactBar() {
  $('react-bar').innerHTML = REACTIONS.map((e) => `<button class="react-btn" type="button" data-emoji="${e}" aria-label="Реакция ${e}">${e}</button>`).join('');
}

function spawnReaction(emoji, color) {
  const layer = $('reactions-layer');
  if (layer.childElementCount > 12) return;
  const el = document.createElement('span');
  el.className = 'reaction';
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 70}%`;
  const dot = document.createElement('span');
  dot.className = 'reaction-by';
  dot.style.background = color || '#7a8296';
  el.append(dot);
  layer.append(el);
  setTimeout(() => el.remove(), 1900);
  if (navigator.vibrate && document.visibilityState === 'visible') navigator.vibrate(12);
}

function toast(text, isError = false, color = null) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' is-error' : '');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'station';
    dot.style.setProperty('--line', color);
    el.append(dot);
  }
  el.append(document.createTextNode(text));
  $('toasts').append(el);
  setTimeout(() => el.remove(), 3200);
  while ($('toasts').childElementCount > 3) $('toasts').firstChild.remove();
}

function updateMediaSession(item) {
  if (!('mediaSession' in navigator)) return;
  const art = item.source === 'yandex' && item.cover ? [{ src: item.cover, sizes: '400x400', type: 'image/jpeg' }] : [{ src: '/icon-512.png', sizes: '512x512', type: 'image/png' }];
  navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.artist, album: `Вагон ${state.code}`, artwork: art });
}
if ('mediaSession' in navigator) {
  const toggle = () => canControl() && act({ type: 'toggle' }).catch(() => {});
  navigator.mediaSession.setActionHandler('play', toggle);
  navigator.mediaSession.setActionHandler('pause', toggle);
  navigator.mediaSession.setActionHandler('nexttrack', () => act({ type: canControl() ? 'skip' : 'voteSkip' }).catch(() => {}));
}

// ——— действия интерфейса ———
$('btn-play').addEventListener('click', () => { player.unlock(); act({ type: 'toggle' }).catch(() => {}); });
$('btn-skip').addEventListener('click', () => act({ type: canControl() ? 'skip' : 'voteSkip' }).catch(() => {}));
$('btn-listen').addEventListener('click', () => { player.unlock(); renderSync(); });
$('btn-mute').addEventListener('click', () => {
  player.setMuted(!player.muted);
  $('btn-mute').classList.toggle('is-muted', player.muted);
  $('btn-mute').setAttribute('aria-label', player.muted ? 'Включить звук у себя' : 'Выключить звук у себя');
  renderSync(); sendStatusSoon();
});
$('react-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-emoji]');
  if (!b) return;
  act({ type: 'react', emoji: b.dataset.emoji }).catch(() => {});
});
$('line').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  act({ type: b.dataset.act, qid: b.dataset.qid }).catch(() => {});
});
$('line').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-act="jump"]')) { e.preventDefault(); e.target.click(); }
});
$('progress').addEventListener('click', (e) => {
  if (!canControl()) return;
  const snap = state.room;
  const r = resolve(snap.queue, snap.playback, clock.now());
  const item = snap.queue[r.index];
  if (!item || (r.status !== 'playing' && r.status !== 'paused')) return;
  const rect = $('progress').querySelector('.bar').getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  act({ type: 'seek', positionMs: Math.round(frac * item.durationMs) }).catch(() => {});
});

// ——— шторки ———
let openSheet = null;
function showSheet(id) {
  closeSheet(true);
  const sheet = $(id);
  openSheet = sheet;
  $('scrim').hidden = false; sheet.hidden = false;
  requestAnimationFrame(() => { $('scrim').classList.add('is-open'); sheet.classList.add('is-open'); });
  const focusable = sheet.querySelector('input:not([type=range]), button:not([data-close])');
  setTimeout(() => focusable?.focus({ preventScroll: true }), 60);
}
function closeSheet(instant = false) {
  if (!openSheet) return;
  const sheet = openSheet; openSheet = null;
  sheet.classList.remove('is-open'); $('scrim').classList.remove('is-open');
  const done = () => { sheet.hidden = true; if (!openSheet) $('scrim').hidden = true; };
  instant ? done() : setTimeout(done, 240);
}
$('scrim').addEventListener('click', () => closeSheet());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet()));

$('open-add').addEventListener('click', () => { refreshYmHint(); showSheet('sheet-add'); });
$('open-invite').addEventListener('click', openInvite);
$('code-chip').addEventListener('click', openInvite);
$('open-settings').addEventListener('click', () => { refreshYmStatus(); showSheet('sheet-settings'); });

// Вкладки
function selectTab(which) {
  const ym = which === 'ym';
  $('tab-ym').setAttribute('aria-selected', String(ym));
  $('tab-demo').setAttribute('aria-selected', String(!ym));
  $('pane-ym').hidden = !ym; $('pane-demo').hidden = ym;
  store.set('tab', which);
}
$('tab-ym').addEventListener('click', () => selectTab('ym'));
$('tab-demo').addEventListener('click', () => selectTab('demo'));
selectTab(store.get('tab', yandexToken.get() ? 'ym' : 'demo'));

// Демо-каталог
function renderDemoList() {
  $('demo-results').innerHTML = DEMO.map((t) => resultRow(t)).join('');
}
function resultRow(t) {
  const cover = coverFor(t);
  return `<li class="result" data-track='${esc(JSON.stringify({ source: t.source, id: t.id, title: t.title, artist: t.artist, durationMs: t.durationMs, cover: t.source === 'yandex' ? t.cover : '' }))}'>
    ${cover ? `<img src="${esc(cover)}" alt="" width="48" height="48" loading="lazy">` : '<span class="ph"></span>'}
    <div class="result-body">
      <p class="result-title">${esc(t.title)}</p>
      <p class="result-meta">${esc(t.artist)} · <span class="mono">${fmt(t.durationMs)}</span></p>
    </div>
    <div class="result-actions">
      <button class="btn btn-ghost btn-icon" type="button" data-add="next" aria-label="Следующим"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/></svg></button>
      <button class="btn btn-icon" type="button" data-add="end" aria-label="В конец очереди"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg></button>
    </div>
  </li>`;
}
function onResultClick(e) {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  const row = b.closest('.result');
  const track = JSON.parse(row.dataset.track);
  player.unlock();
  act({ type: 'add', track, next: b.dataset.add === 'next' })
    .then(() => {
      row.classList.add('is-added');
      toast(b.dataset.add === 'next' ? `«${track.title}» следующим` : `«${track.title}» в очереди`);
    })
    .catch(() => {});
}
$('demo-results').addEventListener('click', onResultClick);
$('ym-results').addEventListener('click', onResultClick);

// Поиск по Яндекс Музыке
let searchSeq = 0;
let searchTimer = null;
async function runSearch() {
  const q = $('search-input').value.trim();
  const seq = ++searchSeq;
  if (!q) { $('ym-results').innerHTML = ''; return; }
  $('ym-results').innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  try {
    const { tracks } = await ymFetch('/api/ym/search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    $('ym-results').innerHTML = tracks.length
      ? tracks.map(resultRow).join('')
      : '<li class="results-empty">Ничего не нашлось. Попробуйте по-другому написать название или исполнителя</li>';
  } catch (err) {
    if (seq !== searchSeq) return;
    $('ym-results').innerHTML = `<li class="results-empty">${esc(err.message)}</li>`;
  }
}
$('search-form').addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(searchTimer); runSearch(); $('search-input').blur(); });
$('search-input').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 350); });

function refreshYmHint() { $('ym-connect-hint').hidden = Boolean(yandexToken.get()); }
$('ym-connect-open').addEventListener('click', () => {
  refreshYmStatus(); showSheet('sheet-settings'); $('ym-flow').hidden = false;
});

// Приглашение
function openInvite() {
  const url = `${location.origin}/r/${state.code}`;
  $('invite-code').textContent = state.code;
  $('invite-qr').innerHTML = qrSvg(url);
  $('invite-share').hidden = !navigator.share;
  showSheet('sheet-invite');
}
$('invite-share').addEventListener('click', () => {
  navigator.share?.({ title: 'Вагон', text: 'Залетай в вагон, слушаем вместе', url: `${location.origin}/r/${state.code}` }).catch(() => {});
});
$('invite-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/r/${state.code}`);
    $('invite-copy').querySelector('span').textContent = 'Скопировано';
    setTimeout(() => { $('invite-copy').querySelector('span').textContent = 'Скопировать'; }, 1600);
  } catch { toast('Не получилось скопировать. Код вагона: ' + state.code); }
});

// Настройки
$('ym-oauth-link').href = YM_OAUTH;
async function refreshYmStatus() {
  const has = Boolean(yandexToken.get());
  $('ym-toggle').textContent = has ? 'Отключить' : 'Подключить';
  $('ym-flow').hidden = true;
  $('ym-error').hidden = true;
  if (!has) { $('ym-status').textContent = 'Не подключена. Доступны демо-треки'; return; }
  $('ym-status').textContent = 'Проверяем аккаунт';
  try {
    const me = await ymFetch('/api/ym/me');
    $('ym-status').textContent = `${me.name || me.login || 'Аккаунт'} · ${me.plus ? 'Плюс есть, треки целиком' : 'без Плюса Яндекс даёт только 30 секунд трека'}`;
  } catch (err) {
    $('ym-status').textContent = err.message;
  }
}
$('ym-toggle').addEventListener('click', () => {
  if (yandexToken.get()) {
    yandexToken.set('');
    refreshYmStatus(); sendStatusSoon();
    toast('Яндекс Музыка отключена на этом устройстве');
  } else {
    $('ym-flow').hidden = !$('ym-flow').hidden;
    if (!$('ym-flow').hidden) $('ym-token-input').focus();
  }
});
$('ym-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = parseToken($('ym-token-input').value);
  if (!token) { $('ym-error').textContent = 'Не нашли токен. Вставьте адрес страницы целиком, вместе с #access_token'; $('ym-error').hidden = false; return; }
  yandexToken.set(token);
  $('ym-token-input').value = '';
  try {
    await ymFetch('/api/ym/me');
    refreshYmStatus(); refreshYmHint();
    player.retry(); sendStatusSoon();
    selectTab('ym');
    toast('Яндекс Музыка подключена');
  } catch (err) {
    yandexToken.set('');
    $('ym-error').textContent = err.message; $('ym-error').hidden = false;
  }
});

const latency = $('latency');
latency.value = String(store.get('latency', 0));
$('latency-value').textContent = `${latency.value} мс`;
latency.addEventListener('input', () => {
  const v = Number(latency.value);
  $('latency-value').textContent = `${v} мс`;
  store.set('latency', v);
  player.setLatency(v);
});

$('rename').addEventListener('click', () => {
  const name = prompt('Как вас называть в вагоне', state.me.name);
  if (name && name.trim()) {
    store.set('name', name.trim());
    act({ type: 'rename', name: name.trim() }).catch(() => {});
  }
});
$('everyone-controls').addEventListener('change', (e) => act({ type: 'settings', everyoneControls: e.target.checked }).catch(() => {}));
let tripBlob = null;
async function openTrip() {
  state.trip.save();
  const canvas = await state.trip.render();
  const url = canvas.toDataURL('image/png');
  $('trip-img').src = url;
  $('trip-save').href = url;
  $('trip-save').download = `vagon-${state.code}.png`;
  tripBlob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = tripBlob && new File([tripBlob], `vagon-${state.code}.png`, { type: 'image/png' });
  $('trip-share').hidden = !(file && navigator.canShare?.({ files: [file] }));
  showSheet('sheet-trip');
}
$('open-trip').addEventListener('click', openTrip);
$('trip-share').addEventListener('click', () => {
  const file = new File([tripBlob], `vagon-${state.code}.png`, { type: 'image/png' });
  navigator.share({ files: [file], text: `Слушали вместе в Вагоне ${location.origin}/r/${state.code}` }).catch(() => {});
});

$('leave').addEventListener('click', () => {
  store.set('member:' + state.code, null);
  state.es?.close();
  location.href = '/';
});

window.addEventListener('popstate', route);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// Для тестов синхронизации: состояние плеера и часы.
window.__vagon = { player, clock, state };

route();
