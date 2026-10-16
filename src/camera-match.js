// Match my camera: RAW colour that looks like the camera's own JPEGs. Every RAW file carries the
// JPEG the camera made from it, so Rembrandt compares its own default rendering of each RAW with that
// JPEG and learns, per camera model, how the camera renders: a brightness curve, and saturation and
// hue per colour (8 hue bands, only where the photos have enough of that colour). Applied in the
// display stage (the FINAL shader's camera look); turned on per photo in Color › Camera colour.
// A plain 3×3 matrix was tried first and didn't help on held-out pixels; the camera's differences
// are mostly in its tone curve and per-hue saturation. Nothing leaves the device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { oklab, SRGB_TO_REC2020 as S2R } from '../engine/src/color.js';

export const cameraKey = (meta) => (meta?.make || meta?.model ? `${meta.make || ''} ${meta.model || ''}`.trim() : null);
export const BANDS = 8, KNOTS = 17;
const TAU = Math.PI * 2;
export const bandCentre = (k) => -Math.PI + (k + 0.5) * (TAU / BANDS);

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const labOf = (d, i) => {
  const r = lin(d[i] / 255), g = lin(d[i + 1] / 255), b = lin(d[i + 2] / 255);
  return oklab([S2R[0][0] * r + S2R[0][1] * g + S2R[0][2] * b, S2R[1][0] * r + S2R[1][1] * g + S2R[1][2] * b, S2R[2][0] * r + S2R[2][1] * g + S2R[2][2] * b]);
};

// Pixel pairs (Oklab of the display image) from Rembrandt's render and the camera's JPEG of the same
// photo, both RGBA `w × h`, columns [x0, x1). Skips clipped and near-black pixels and the border.
export function pixelPairs(ours, cam, w, h, out = [], x0 = 0, x1 = w) {
  for (let y = 1; y < h - 1; y++) for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) {
    const i = (y * w + x) * 4;
    if (Math.max(ours[i], ours[i + 1], ours[i + 2], cam[i], cam[i + 1], cam[i + 2]) > 246) continue;
    if (ours[i] + ours[i + 1] + ours[i + 2] < 24 || cam[i] + cam[i + 1] + cam[i + 2] < 24) continue;
    const a = labOf(ours, i), b = labOf(cam, i);
    if (Math.abs(a[0] - b[0]) > 0.25) continue;   // misregistered (an edge that moved)
    out.push(a, b);
  }
  return out;
}

const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

// { L: KNOTS lightness values for L = 0, 1/16 … 1, gain / shift: per hue band, n } from pixel pairs.
export function fitLook(pairs) {
  const n = pairs.length / 2;
  const binL = Array.from({ length: KNOTS }, () => []), bandC = Array.from({ length: BANDS }, () => []), bandH = Array.from({ length: BANDS }, () => []);
  for (let k = 0; k < pairs.length; k += 2) {
    const a = pairs[k], b = pairs[k + 1];
    binL[Math.min(KNOTS - 1, Math.round(a[0] * (KNOTS - 1)))].push(b[0] - a[0]);
    const C = Math.hypot(a[1], a[2]);
    if (C > 0.02) {
      const h = Math.atan2(a[2], a[1]), band = Math.min(BANDS - 1, Math.floor((h + Math.PI) / (TAU / BANDS)));
      bandC[band].push(Math.hypot(b[1], b[2]) / C);
      let d = Math.atan2(b[2], b[1]) - h; d -= TAU * Math.round(d / TAU);
      bandH[band].push(d);
    }
  }
  // Lightness: the median shift per bin where there is data (eased toward none when there is little),
  // filled in between, and kept monotone.
  const L = [];
  for (let j = 0; j < KNOTS; j++) {
    const m = binL[j].length >= 25 ? median(binL[j]) * (binL[j].length / (binL[j].length + 60)) : NaN;
    L.push(j / (KNOTS - 1) + (Number.isNaN(m) ? NaN : m));
  }
  L[0] = Number.isNaN(L[0]) ? 0 : Math.max(0, L[0]); L[KNOTS - 1] = Number.isNaN(L[KNOTS - 1]) ? 1 : Math.min(1, L[KNOTS - 1]);
  for (let j = 1; j < KNOTS - 1; j++) if (Number.isNaN(L[j])) {
    let k = j + 1; while (Number.isNaN(L[k])) k++;
    L[j] = L[j - 1] + (L[k] - L[j - 1]) / (k - j + 1);
  }
  for (let j = 1; j < KNOTS; j++) L[j] = Math.max(L[j], L[j - 1]);
  const gain = [], shift = [], used = [];
  for (let k = 0; k < BANDS; k++) {
    const m = bandC[k].length, w = m >= 60 ? m / (m + 200) : 0;
    gain.push(1 + (Math.min(1.6, Math.max(0.6, median(bandC[k]) || 1)) - 1) * w);
    shift.push(Math.min(0.3, Math.max(-0.3, median(bandH[k]) || 0)) * w);
    used.push(m);
  }
  return { L, gain, shift, n, used };
}

// The camera look on one Oklab colour (mirrors the FINAL shader).
export function applyLook(look, [l, a, b]) {
  const x = Math.min(1, Math.max(0, l)) * (KNOTS - 1), j = Math.min(KNOTS - 2, Math.floor(x));
  const L2 = look.L[j] + (look.L[j + 1] - look.L[j]) * (x - j);
  const C = Math.hypot(a, b);
  if (C < 1e-6) return [L2, a, b];
  const h = Math.atan2(b, a);
  // Linear between band centres, around the circle.
  const t = (h + Math.PI) / (TAU / BANDS) - 0.5, k0 = Math.floor(t), f = t - k0, i0 = (k0 + BANDS) % BANDS, i1 = (i0 + 1) % BANDS;
  const g = look.gain[i0] * (1 - f) + look.gain[i1] * f, s = look.shift[i0] * (1 - f) + look.shift[i1] * f;
  return [L2, C * g * Math.cos(h + s), C * g * Math.sin(h + s)];
}

// Mean colour difference (Oklab ×100 ≈ ΔE) between the camera and Rembrandt, with or without the look.
export function lookError(pairs, look = null) {
  let s = 0;
  for (let k = 0; k < pairs.length; k += 2) {
    const a = look ? applyLook(look, pairs[k]) : pairs[k], b = pairs[k + 1];
    s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return pairs.length ? (s / (pairs.length / 2)) * 100 : 0;
}

export const lookUniforms = (look) => (look ? { uCamOn: 1, uCamL: look.L, uCamGain: look.gain, uCamShift: look.shift } : { uCamOn: 0 });

// Learns the look for one camera from its RAW files (browser). `render(file)` resolves Rembrandt's
// default rendering of a RAW as { data (RGBA), w, h } (null to skip it); `decodeFile(file)` gives the
// camera's embedded JPEG. Fits on the left half of every frame and tests on the right half for an
// honest error, then fits on everything. Resolves { look, photos, err: [before, after] } or null.
export const GRID = 160;
export async function learnCamera(files, { render, decodeFile }, onProgress = () => {}) {
  const sets = [];
  for (const [n, file] of files.entries()) {
    onProgress(n / files.length);
    let bm = null;
    try {
      const ours = await render(file);
      bm = ours && (await decodeFile(file))?.bitmap;
      if (!bm || bm.width < GRID) continue;
      // Our render cropped to the JPEG's aspect (sensor edges differ), and the JPEG, on one grid.
      const W = GRID, H = Math.round(GRID * bm.height / bm.width), ja = bm.width / bm.height;
      const cw = Math.min(ours.w, Math.round(ours.h * ja)), ch = Math.min(ours.h, Math.round(ours.w / ja));
      const src = new OffscreenCanvas(ours.w, ours.h);
      src.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(ours.data.buffer, ours.data.byteOffset, ours.data.length), ours.w, ours.h), 0, 0);
      const grid = (img, sx, sy, sw, sh) => { const c = new OffscreenCanvas(W, H), x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(img, sx, sy, sw, sh, 0, 0, W, H); return x.getImageData(0, 0, W, H).data; };
      sets.push({ W, H, ours: grid(src, (ours.w - cw) / 2, (ours.h - ch) / 2, cw, ch), cam: grid(bm, 0, 0, bm.width, bm.height) });
    } catch { /* not a RAW with an embedded JPEG: skipped */ } finally { bm?.close?.(); }
  }
  onProgress(1);
  if (!sets.length) return null;
  const train = [], test = [];
  for (const s of sets) {
    pixelPairs(s.ours, s.cam, s.W, s.H, train, 0, s.W >> 1);
    pixelPairs(s.ours, s.cam, s.W, s.H, test, s.W >> 1, s.W);
  }
  if (train.length + test.length < 4000) return null;
  const err = [lookError(test), lookError(test, fitLook(train))];
  const look = fitLook(train.concat(test));
  const r = (v) => Math.round(v * 1e4) / 1e4;
  return { look: { L: look.L.map(r), gain: look.gain.map(r), shift: look.shift.map(r) }, photos: sets.length, err: err.map((v) => Math.round(v * 100) / 100) };
}

// Self-check: node src/camera-match.js — learns a known look from synthetic pairs and generalises.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('camera-match.js')) {
  const truth = { L: Array.from({ length: KNOTS }, (_, j) => { const x = j / (KNOTS - 1); return x + 0.08 * Math.sin(Math.PI * x); }), gain: [1, 1.1, 1.2, 0.9, 1, 1, 0.85, 1.05], shift: [0, 0.05, -0.08, 0, 0, 0.02, 0, -0.04] };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const make = (count) => { const p = []; for (let n = 0; n < count; n++) { const a = [0.15 + rnd() * 0.75, (rnd() - 0.5) * 0.24, (rnd() - 0.5) * 0.24]; p.push(a, applyLook(truth, a).map((v) => v + (rnd() - 0.5) * 0.004)); } return p; };
  const look = fitLook(make(20000)), test = make(4000);
  const before = lookError(test), after = lookError(test, look);
  if (!(after < before * 0.25)) throw new Error(`look not learned: ${before.toFixed(2)} → ${after.toFixed(2)}`);
  for (let j = 1; j < KNOTS; j++) if (look.L[j] < look.L[j - 1]) throw new Error('curve not monotone');
  console.log(`camera-match.js ok: held-out ΔE ${before.toFixed(2)} → ${after.toFixed(2)}`);
}
