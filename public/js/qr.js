// Небольшой генератор QR-кода (байтовый режим, уровень коррекции M, версии 1–6).
// Хватает для ссылки на вагон. Свой, чтобы не тянуть зависимость ради одной картинки.

const EC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4];
const RAW = [0, 26, 44, 70, 100, 134, 172];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const d = new Array(degree).fill(0);
  d[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      d[j] = gfMul(d[j], root);
      if (j + 1 < degree) d[j] ^= d[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return d;
}

function rsRemainder(data, divisor) {
  const r = new Array(divisor.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    divisor.forEach((c, i) => { r[i] ^= gfMul(c, f); });
  }
  return r;
}

function encodeData(bytes, version) {
  const capacity = RAW[version] - EC_PER_BLOCK[version] * BLOCKS[version];
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < capacity; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

function withEcc(data, version) {
  const numBlocks = BLOCKS[version];
  const eccLen = EC_PER_BLOCK[version];
  const raw = RAW[version];
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const div = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((b, j) => {
      if (i !== shortLen - eccLen || j >= numShort) result.push(b[i]);
    });
  }
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function build(codewords, version, mask) {
  const size = 17 + version * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { m[y][x] = dark; fn[y][x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (version >= 2) {
    const pos = [6, version * 4 + 10];
    for (const ay of pos) for (const ax of pos) {
      if ((ax === 6 && ay === 6) || (ax === pos[1] && ay === 6) || (ax === 6 && ay === pos[1])) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  // Резерв под формат, заполним после маски.
  const formatBits = (() => {
    const data = (0b00 << 3) | mask; // уровень M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  })();
  const bit = (v, i) => ((v >>> i) & 1) === 1;
  const drawFormat = () => {
    for (let i = 0; i <= 5; i++) set(8, i, bit(formatBits, i));
    set(8, 7, bit(formatBits, 6));
    set(8, 8, bit(formatBits, 7));
    set(7, 8, bit(formatBits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(formatBits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(formatBits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(formatBits, i));
    set(8, size - 8, true);
  };
  drawFormat();

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && i < codewords.length * 8) {
          m[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
    }
  }
  const f = MASKS[mask];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (!fn[y][x] && f(x, y)) m[y][x] = !m[y][x];
  }
  return m;
}

function penalty(m) {
  const n = m.length;
  let p = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b];
        const prev = pass ? m[b - 1][a] : m[a][b - 1];
        if (cur === prev) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1;
      }
    }
  }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  p += Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n)) * 10;
  return p;
}

/** Матрица QR для строки. mask можно задать для тестов. */
export function qrMatrix(text, { mask } = {}) {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  while (version <= 6 && RAW[version] - EC_PER_BLOCK[version] * BLOCKS[version] < bytes.length + 2) version++;
  if (version > 6) throw new Error('Слишком длинная строка для QR');
  const cw = withEcc(encodeData(bytes, version), version);
  if (mask !== undefined) return build(cw, version, mask);
  let best = null; let bestP = Infinity;
  for (let k = 0; k < 8; k++) {
    const mm = build(cw, version, k);
    const p = penalty(mm);
    if (p < bestP) { bestP = p; best = mm; }
  }
  return best;
}

/** SVG-разметка QR, тёмные модули цветом fg на прозрачном фоне. */
export function qrSvg(text, fg = '#0b0d14', bg = '#eef0f5') {
  const m = qrMatrix(text);
  const n = m.length;
  const q = 3;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) d += `M${x + q} ${y + q}h1v1h-1z`;
  const s = n + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges" role="img" aria-label="QR-код ссылки на вагон"><rect width="${s}" height="${s}" rx="2" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`;
}
