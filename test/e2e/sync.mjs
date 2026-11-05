// Сквозной тест: несколько браузеров в одном вагоне, меряем расхождение звука.
// Запуск: сервер на BASE (по умолчанию http://127.0.0.1:8787), затем node test/e2e/sync.mjs
import { createRequire } from 'node:module';

// Playwright ставится отдельно (в CI или глобально), в зависимости проекта не входит.
const { chromium } = createRequire(import.meta.url)('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const N = Number(process.env.N || 3);
const SECONDS = Number(process.env.SECONDS || 20);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const pages = [];
const errors = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`[${i}] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${i}] console: ${m.text()}`); });
  pages.push(page);
}

// Первый создаёт вагон.
const [host, ...guests] = pages;
await host.goto(BASE + '/new');
await host.fill('#join-name', 'Лена');
await host.click('#join-submit');
await host.waitForURL(/\/r\/[A-Z0-9]{5}$/);
const code = host.url().split('/').pop();
console.log('вагон', code);

// Добавляем два демо-трека.
await host.click('#open-add');
await host.click('#tab-demo');
await host.locator('#demo-results .result').nth(2).locator('[data-add="end"]').click();
await host.locator('#demo-results .result').nth(4).locator('[data-add="end"]').click();
await host.keyboard.press('Escape');

// Гости заходят по ссылке в разное время.
for (const [k, g] of guests.entries()) {
  await g.goto(`${BASE}/r/${code}`);
  await g.fill('#join-name', ['Кирилл', 'Аня', 'Вова', 'Лея'][k] ?? 'Гость');
  await g.click('#join-submit');
  await g.waitForSelector('#view-room:not([hidden])');
  await g.waitForTimeout(700);
}

const sample = async () => Promise.all(pages.map((p) => p.evaluate(() => {
  const { player, clock } = window.__vagon;
  const a = player.audio;
  // Позиция звука, приведённая к общему моменту времени.
  return { t: clock.now(), pos: a.currentTime, paused: a.paused, state: player.status.state, drift: player.status.driftMs, rate: a.playbackRate };
})));

const spreads = [];
const t0 = Date.now();
while (Date.now() - t0 < SECONDS * 1000) {
  await new Promise((r) => setTimeout(r, 1000));
  const s = await sample();
  if (s.some((x) => x.paused)) { console.log('ещё не все играют', s.map((x) => x.state).join(',')); continue; }
  // Приводим позицию каждой вкладки к одному моменту общего времени.
  const ref = s[0].t;
  const aligned = s.map((x) => x.pos - (x.t - ref) / 1000);
  const spread = (Math.max(...aligned) - Math.min(...aligned)) * 1000;
  spreads.push(spread);
  console.log(`разброс ${spread.toFixed(1)} мс`, s.map((x) => `${x.state}:${x.drift}`).join(' '));
}

// Пауза у всех и продолжение.
await guests[0].click('#btn-play');
await host.waitForTimeout(800);
const paused = await sample();
console.log('после паузы играют:', paused.filter((x) => !x.paused).length);
await host.click('#btn-play');
await host.waitForTimeout(3500);
const resumed = await sample();
console.log('после продолжения играют:', resumed.filter((x) => !x.paused).length);

// Тоннель: у одного гостя пропадает сеть на 12 секунд, пока остальные слушают.
const tunnel = guests[guests.length - 1];
await tunnel.context().setOffline(true);
await host.waitForTimeout(12000);
const inTunnel = await sample();
const refT = inTunnel[0].t;
const alignedT = inTunnel.map((x) => x.pos - (x.t - refT) / 1000);
const tunnelSpread = (Math.max(...alignedT) - Math.min(...alignedT)) * 1000;
const tunnelPlaying = !inTunnel[inTunnel.length - 1].paused;
const netShown = await tunnel.evaluate(() => !document.getElementById('net').hidden);
console.log(`в тоннеле: играет=${tunnelPlaying}, значок сети=${netShown}, разброс ${tunnelSpread.toFixed(1)} мс`);
await tunnel.context().setOffline(false);
await host.waitForTimeout(4000);
const back = await tunnel.evaluate(() => document.getElementById('net').hidden);
console.log('после станции значок сети скрыт:', back);

await host.screenshot({ path: process.env.SHOT || 'test-results/room.png', fullPage: false });

const settled = spreads.slice(3);
const max = Math.max(...settled);
const avg = settled.reduce((a, b) => a + b, 0) / settled.length;
const realErrors = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource|net::ERR/.test(e));
console.log(JSON.stringify({ samples: settled.length, maxSpreadMs: +max.toFixed(1), avgSpreadMs: +avg.toFixed(1), tunnelSpreadMs: +tunnelSpread.toFixed(1), errors: realErrors }));
await browser.close();
if (!settled.length || max > 80 || realErrors.length || paused.some((x) => !x.paused) || resumed.some((x) => x.paused)
  || !tunnelPlaying || tunnelSpread > 80 || !netShown || !back) process.exit(1);
