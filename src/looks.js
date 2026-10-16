// Looks: film-style colour (built in) and your own .cube LUTs, applied at the end of the pipeline on
// the display-encoded colour (where LUTs made for photo and video editors expect it), with Amount.
// Built-in looks are written as functions and turned into 33 × 33 × 33 tables when first used, so
// nothing has to ship. Imported .cube files are kept beside your photos and listed for every photo.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mix = (a, b, t) => a + (b - a) * t;
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// A film-like tone curve: blacks lifted to `lift`, whites rolled to `top`, contrast `k` (S around mid).
const tone = (x, k, lift, top) => {
  const s = 1 / (1 + Math.exp(-k * (x - 0.5)));
  const s0 = 1 / (1 + Math.exp(k * 0.5)), s1 = 1 / (1 + Math.exp(-k * 0.5));
  return lift + (top - lift) * ((s - s0) / (s1 - s0));
};
const sat = ([r, g, b], f) => { const y = luma(r, g, b); return [y + (r - y) * f, y + (g - y) * f, y + (b - y) * f]; };
// Tints shadows and highlights (split toning), each [r, g, b] offsets.
const split = ([r, g, b], sh, hi) => {
  const y = luma(r, g, b), ws = (1 - y) ** 2, wh = y ** 2;
  return [r + sh[0] * ws + hi[0] * wh, g + sh[1] * ws + hi[1] * wh, b + sh[2] * ws + hi[2] * wh];
};

// name, group, function on display-encoded RGB (0–1).
export const LOOKS = {
  'film:portrait': ['Portrait 400', (c) => {
    // Soft contrast, warm highlights, gentle pastel colour, lifted blacks: kind to skin.
    let [r, g, b] = c.map((x) => tone(x, 4.2, 0.035, 0.97));
    [r, g, b] = sat([r, g, b], 0.88);
    return split([r, g, b], [-0.01, 0.0, 0.02], [0.035, 0.015, -0.025]);
  }],
  'film:vivid': ['Vivid 50', (c) => {
    // Punchy slide film: deep contrast, rich blues and greens.
    let [r, g, b] = c.map((x) => tone(x, 6.5, 0.0, 1.0));
    [r, g, b] = sat([r, g, b], 1.32);
    return [r, g * 1.02, b * 1.04];
  }],
  'film:chrome': ['Chrome', (c) => {
    // Muted colour with firm shadows: documentary, a little cool in the shadows.
    let [r, g, b] = c.map((x) => tone(x, 5.4, 0.015, 0.98));
    [r, g, b] = sat([r, g, b], 0.72);
    return split([r * 0.98, g, b], [-0.015, 0.0, 0.02], [0.01, 0.005, -0.01]);
  }],
  'film:tungsten': ['Tungsten 800', (c) => {
    // Night film balanced for lamps: cool mids, warm glowing highlights.
    let [r, g, b] = c.map((x) => tone(x, 4.8, 0.03, 0.98));
    [r, g, b] = sat([r, g, b], 1.1);
    return split([r, g, b], [-0.03, 0.005, 0.05], [0.06, 0.01, -0.03]);
  }],
  'film:matte': ['Matte', (c) => {
    // Faded print: grey blacks, soft whites, quiet colour.
    let [r, g, b] = c.map((x) => tone(x, 3.6, 0.09, 0.93));
    return sat([r, g, b], 0.8);
  }],
  'film:pan400': ['Pan 400 B&W', (c) => {
    // Panchromatic black and white with a slight red-filter response and a film curve.
    const y = 0.38 * c[0] + 0.48 * c[1] + 0.14 * c[2];
    const v = tone(y, 5.2, 0.02, 0.99);
    return [v, v, v];
  }],
};

const N = 33;
// The table for a built-in look: N³ RGB, red fastest.
export function lookTable(key) {
  const f = LOOKS[key]?.[1];
  if (!f) return null;
  const data = new Float32Array(N * N * N * 3);
  let o = 0;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) {
    const out = f([r / (N - 1), g / (N - 1), b / (N - 1)]);
    data[o++] = clamp01(out[0]); data[o++] = clamp01(out[1]); data[o++] = clamp01(out[2]);
  }
  return { size: N, data };
}

// A .cube file (Adobe / Resolve 3D LUT): { title, size, data (size³ RGB, red fastest) }.
export function parseCube(text) {
  let size = 0, title = '', min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [k, ...rest] = line.split(/\s+/);
    if (k === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (k === 'LUT_3D_SIZE') size = +rest[0];
    else if (k === 'LUT_1D_SIZE') throw new Error('1D LUTs aren’t supported; use a 3D .cube file');
    else if (k === 'DOMAIN_MIN') min = rest.map(Number);
    else if (k === 'DOMAIN_MAX') max = rest.map(Number);
    else if (/^[-+.\d]/.test(k)) { const v = [k, ...rest].slice(0, 3).map(Number); if (v.some((x) => !Number.isFinite(x))) throw new Error('This .cube file has a damaged line'); vals.push(...v); }
  }
  if (!(size >= 2 && size <= 129)) throw new Error('Not a 3D .cube file (no LUT_3D_SIZE)');
  if (vals.length !== size ** 3 * 3) throw new Error(`This .cube file should have ${size ** 3} entries but has ${vals.length / 3}`);
  if (max.some((v, i) => v <= min[i])) throw new Error('This .cube file has an invalid domain');
  return { title, size, data: Float32Array.from(vals) };
}

// Self-check: node src/looks.js
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('looks.js')) {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  // An identity cube round-trips.
  const n = 3, lines = ['TITLE "id"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${r / 2} ${g / 2} ${b / 2}`);
  const c = parseCube(lines.join('\n'));
  assert(c.size === 3 && c.title === 'id' && c.data[3] === 0.5 && c.data[c.data.length - 1] === 1, 'cube parse');
  let threw = false; try { parseCube('LUT_3D_SIZE 2\n0 0 0'); } catch { threw = true; }
  assert(threw, 'short cube rejected');
  // Every built-in look stays in range, is monotone in grey, and B&W is grey.
  for (const key of Object.keys(LOOKS)) {
    const t = lookTable(key);
    let prev = -1;
    for (let i = 0; i < N; i++) { const o = ((i * N + i) * N + i) * 3, y = luma(t.data[o], t.data[o + 1], t.data[o + 2]); assert(y >= prev - 1e-6, `${key} grey not monotone`); prev = y; }
  }
  const bw = lookTable('film:pan400').data, o = ((5 * N + 20) * N + 30) * 3;
  assert(bw[o] === bw[o + 1] && bw[o + 1] === bw[o + 2], 'B&W is grey');
  console.log(`looks.js ok: ${Object.keys(LOOKS).length} looks`);
}
