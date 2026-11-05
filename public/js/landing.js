// Лендинг: обложка в превью, проявление секций и слов слогана, вход по коду.

import { DEMO, demoCoverSvg } from './catalog.js';

const cover = document.getElementById('p-cover');
if (cover) cover.innerHTML = demoCoverSvg(DEMO.find((t) => t.id === 'demo-tonnel'));

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Секции проявляются один раз.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
}, { rootMargin: '0px 0px -10% 0px' });
document.querySelectorAll('.reveal').forEach((el) => (reduced ? el.classList.add('is-in') : io.observe(el)));

// Слоган: каждое слово загорается, когда проходит линию на 70% высоты экрана.
const tagline = document.getElementById('tagline');
if (tagline && !reduced) {
  const words = tagline.textContent.trim().split(/\s+/);
  tagline.innerHTML = words.map((w) => `<span class="w">${w}</span>`).join(' ');
  const spans = [...tagline.querySelectorAll('.w')];
  let queued = false;
  const update = () => {
    queued = false;
    const line = innerHeight * 0.7;
    for (const s of spans) s.classList.toggle('on', s.getBoundingClientRect().top < line);
  };
  addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(update); } }, { passive: true });
  update();
}

// Вход по коду.
const form = document.getElementById('code-form');
form?.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = form.code.value.trim().toUpperCase();
  if (/^[A-Z0-9]{5}$/.test(code)) location.href = '/r/' + code;
  else {
    form.code.focus();
    form.code.setCustomValidity('Код — пять букв и цифр');
    form.code.reportValidity();
  }
});
form?.code.addEventListener('input', () => form.code.setCustomValidity(''));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
