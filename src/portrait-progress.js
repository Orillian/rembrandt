// Progress card for imports and uploads: Rembrandt's 1659 self-portrait drawn in dots, in black and
// white, that comes into colour as the work completes (colour rises from the bottom, dot by dot, with
// the dots swelling as they turn). One card serves every long job; `begin` returns a handle.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';

const COLS = 46, ROWS = 57;
const arts = new Map();
// The portrait as a grid of cells (luminance, colour, and when each cell takes colour). Also used,
// smaller, by the studio in the left panel (command.js).
// `zoom` > 1 crops in on the face.
export function loadArt(COLS = 46, ROWS = 57, zoom = 1) {
  const key = `${COLS}x${ROWS}x${zoom}`;
  if (!arts.has(key)) arts.set(key, new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = COLS; c.height = ROWS;
      const x = c.getContext('2d', { willReadFrequently: true });
      // Cover-fit, keeping the face (upper middle) in frame.
      const s = Math.max(COLS / img.width, ROWS / img.height) * zoom;
      const w = img.width * s, h = img.height * s;
      x.drawImage(img, (COLS - w) * (zoom > 1 ? 0.56 : 0.5), (ROWS - h) * (zoom > 1 ? 0.2 : 0.3), w, h);
      const d = x.getImageData(0, 0, COLS, ROWS).data;
      const cells = [];
      let lo = 1, hi = 0;
      for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
        const k = (j * COLS + i) * 4;
        const L = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255;
        lo = Math.min(lo, L); hi = Math.max(hi, L);
        // Colour arrives bottom first, with some grain so it reads as paint, not a wipe.
        const seed = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
        cells.push({ i, j, L, r: d[k], g: d[k + 1], b: d[k + 2], at: 0.72 * (1 - j / (ROWS - 1)) + 0.28 * (seed - Math.floor(seed)) });
      }
      for (const c of cells) c.L = Math.pow((c.L - lo) / Math.max(0.05, hi - lo), 0.55);
      resolve(cells);
    };
    img.onerror = () => resolve(null);
    img.src = new URL('./art/selfportrait-1659.jpg', import.meta.url).href;
  }));
  return arts.get(key);
}

let card = null;
function ensureCard() {
  if (card) return card;
  const cv = el('canvas', { class: 'pp-art', 'aria-hidden': 'true' });
  const label = el('div', { class: 'pp-label' });
  const count = el('div', { class: 'pp-count' });
  const pct = el('div', { class: 'pp-pct' });
  const root = el('div', { class: 'pp-card', role: 'status', 'aria-live': 'polite' }, cv, el('div', { class: 'pp-text' }, label, el('div', { class: 'pp-row' }, count, pct)));
  document.body.append(root);
  card = { root, cv, label, count, pct, shown: 0, target: 0, raf: 0, jobs: new Set(), hideTimer: 0 };
  return card;
}

// Drawn at 30 fps from per-dot values computed once: the import it decorates shares the main thread.
function frame(now) {
  const c = card;
  c.raf = 0;
  if (now - (c.last || 0) < 32) { c.raf = requestAnimationFrame(frame); return; }
  c.last = now;
  const d = Math.min(2, window.devicePixelRatio || 1);
  const W = c.cv.clientWidth, H = c.cv.clientHeight;
  if (c.cv.width !== Math.round(W * d)) { c.cv.width = Math.round(W * d); c.cv.height = Math.round(H * d); c.dots = null; }
  const x = c.cv.getContext('2d');
  x.setTransform(d, 0, 0, d, 0, 0);
  x.clearRect(0, 0, W, H);
  c.shown += (c.target - c.shown) * 0.12;
  if (Math.abs(c.target - c.shown) < 0.002) c.shown = c.target;
  const p = c.shown;
  const cw = W / COLS, ch = H / ROWS, t = now / 1000, unit = Math.min(cw, ch) * 0.5;
  // Per dot, once: centre, size, and the grey and full-colour fills (the in-between ones are mixed live).
  c.dots ||= (c.cells || []).map((s) => {
    const g = Math.round(60 + s.L * 190), col = [s.r, s.g, s.b].map((v) => Math.min(255, v * 1.25));
    return { s, cx: (s.i + 0.5 + (s.j & 1 ? 0.25 : -0.25)) * cw, cy: (s.j + 0.5) * ch, base: 0.16 + s.L * 0.9, g, col, grey: `rgb(${g},${g},${g})`, full: `rgb(${col.map(Math.round).join(',')})` };
  });
  for (const o of c.dots) {
    const s = o.s;
    // 0 = grey, 1 = full colour; the dot swells while it turns.
    const k = Math.min(1, Math.max(0, (p * 1.18 - s.at) / 0.18));
    const swell = k > 0 && k < 1 ? Math.sin(k * Math.PI) * 0.35 : 0;
    const breathe = p < 1 ? 0.04 * Math.sin(t * 2 - s.j * 0.3 + s.i * 0.1) : 0;
    const r = unit * Math.min(1.1, o.base + swell + breathe);
    if (r < 0.3) continue;
    x.fillStyle = k === 0 ? o.grey : k === 1 ? o.full : `rgb(${Math.round(o.g + (o.col[0] - o.g) * k)},${Math.round(o.g + (o.col[1] - o.g) * k)},${Math.round(o.g + (o.col[2] - o.g) * k)})`;
    x.beginPath();
    x.arc(o.cx, o.cy, r, 0, Math.PI * 2);
    x.fill();
  }
  c.pct.textContent = `${Math.round(c.target * 100)}%`;
  if (c.root.classList.contains('on')) c.raf = requestAnimationFrame(frame);
}

// Starts a job: `begin('Importing')` → { update(done, total, text?), finish(text?) }.
export function begin(title) {
  const c = ensureCard();
  clearTimeout(c.hideTimer);
  const job = { done: 0, total: 1 };
  c.jobs.add(job);
  const sum = () => {
    let d = 0, t = 0;
    for (const j of c.jobs) { d += j.done; t += j.total; }
    c.target = t ? Math.min(1, d / t) : 0;
  };
  c.label.textContent = title;
  c.count.textContent = '';
  if (!c.root.classList.contains('on')) { c.shown = 0; c.target = 0; }
  loadArt().then((cells) => {
    if (!cells) return;
    if (c.cells !== cells) { c.cells = cells; c.dots = null; }
    c.root.classList.add('on');
    if (!c.raf) c.raf = requestAnimationFrame(frame);
  });
  return {
    update(done, total, text) {
      job.done = done; job.total = Math.max(1, total);
      if (text) c.label.textContent = text;
      c.count.textContent = `${done} of ${total}`;
      sum();
    },
    finish(text) {
      job.done = job.total;
      sum();
      if (text) c.label.textContent = text;
      c.count.textContent = '';
      c.jobs.delete(job);
      if (c.jobs.size) return;
      c.target = 1;
      c.root.classList.add('done');
      c.hideTimer = setTimeout(() => { c.root.classList.remove('on', 'done'); }, 2200);
    },
  };
}
