// HDR from one photo: the photo as several exposures of itself (darker ones that keep the
// highlights, brighter ones that open the shadows), blended where each looks best, as a merge of
// real brackets would be. The blend is exposure fusion (Mertens, Kautz and Van Reeth, 2007): each
// exposure is weighted by how well exposed and how detailed it is, and the weighted exposures are
// combined band by band in a Laplacian pyramid, so the seams fall where nobody sees them.
//
// Only brightness is fused, on a smaller copy of the photo (cheap even on old computers). The result
// is a gain per pixel, carried up to full size by a guided filter (He, Sun and Tang, 2010) on the
// photo's own luminance so it follows edges without halos, then applied to the linear colour. Hue and
// saturation stay as they were. A RAW becomes a new linear DNG beside the original, edited like a RAW;
// a JPEG (or any display-referred photo) a PNG, read through the same curve the editor reads it with,
// so it looks and edits as the original did.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { toneFwd, toneInv, toneK, SCENE_CONTRAST, REF_CONTRAST, sceneWhiteGain, mul3, SRGB_TO_REC2020, REC2020_TO_SRGB, REC2020_LUMA } from '../engine/src/color.js';
import { H2F } from './merge.js';

// The exposures each strength makes (EV relative to the photo), and how much of the fused result
// is used. Natural stays close to the photo; Strong is the classic HDR look.
export const HDR_ONE = {
  natural: { label: 'Natural', evs: [-2, 0, 2], amount: 0.75 },
  strong: { label: 'Strong', evs: [-3, -1.5, 0, 1.5, 3], amount: 1 },
};
const WORK = 1600;      // long side the fusion works at
const SIGMA = 0.2;      // well-exposedness: Gaussian around mid grey on the displayed scale

const WG = sceneWhiteGain(SCENE_CONTRAST);
// Displayed lightness (0–1, gamma 2.2) of a scene luminance, as the RAW display curve shows it.
const shown = (Y) => Math.pow(Math.min(1, toneFwd(Math.max(Y, 0), SCENE_CONTRAST) * WG), 1 / 2.2);
const unshown = (v) => toneInv(Math.min(0.9999, Math.pow(Math.min(Math.max(v, 0), 1), 2.2) / WG), SCENE_CONTRAST);

// ------------------------------------------------------------------ small image helpers (one channel)

// 5-tap binomial blur, then every other pixel.
function down(a, w, h) {
  const W = Math.max(1, (w + 1) >> 1), H = Math.max(1, (h + 1) >> 1);
  const t = new Float32Array(W * h), o = new Float32Array(W * H);
  const k = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++) for (let X = 0; X < W; X++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * a[y * w + Math.min(w - 1, Math.max(0, 2 * X + i))];
    t[y * W + X] = s / 16;
  }
  for (let Y = 0; Y < H; Y++) for (let X = 0; X < W; X++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * t[Math.min(h - 1, Math.max(0, 2 * Y + i)) * W + X];
    o[Y * W + X] = s / 16;
  }
  return o;
}
// Bilinear, from (sw × sh) to (w × h), pixel centres aligned.
function up(a, sw, sh, w, h) {
  const o = new Float32Array(w * h), fx = sw / w, fy = sh / h;
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      o[y * w + x] = (a[y0 * sw + x0] * (1 - tx) + a[y0 * sw + x1] * tx) * (1 - ty) + (a[y1 * sw + x0] * (1 - tx) + a[y1 * sw + x1] * tx) * ty;
    }
  }
  return o;
}
function boxMean(a, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0, n = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) { s += a[y * w + x]; n++; }
    for (let x = 0; x < w; x++) {
      t[y * w + x] = s / n;
      if (x + r + 1 < w) { s += a[y * w + x + r + 1]; n++; }
      if (x - r >= 0) { s -= a[y * w + x - r]; n--; }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) { s += t[y * w + x]; n++; }
    for (let y = 0; y < h; y++) {
      o[y * w + x] = s / n;
      if (y + r + 1 < h) { s += t[(y + r + 1) * w + x]; n++; }
      if (y - r >= 0) { s -= t[(y - r) * w + x]; n--; }
    }
  }
  return o;
}
// Gaussian and Laplacian pyramids: [{ a, w, h }] from full to coarsest.
function gaussian(a, w, h, levels) {
  const out = [{ a, w, h }];
  for (let l = 1; l < levels; l++) { const p = out[l - 1]; out.push({ a: down(p.a, p.w, p.h), w: (p.w + 1) >> 1, h: (p.h + 1) >> 1 }); }
  return out;
}
function laplacian(a, w, h, levels) {
  const g = gaussian(a, w, h, levels);
  return g.map((p, l) => {
    if (l === levels - 1) return p;
    const n = g[l + 1], u = up(n.a, n.w, n.h, p.w, p.h), d = new Float32Array(p.a.length);
    for (let i = 0; i < d.length; i++) d[i] = p.a[i] - u[i];
    return { a: d, w: p.w, h: p.h };
  });
}

// ------------------------------------------------------------------ fusion

// Display-referred photos enter the editor through the RGB tone curve's inverse (see sceneIn in
// shaders.js); these are that curve and its inverse, so a PNG written with toDisplay reads back as the
// scene colour it was made from.
const IN_K = toneK(REF_CONTRAST);
const hill = (x) => { const p = Math.pow(Math.max(x, 0), REF_CONTRAST); return p / (p + IN_K); };
const hillInv = (y) => { const t = Math.min(Math.max(y, 0), 0.9985); return Math.pow((IN_K * t) / (1 - t), 1 / REF_CONTRAST); };
const rgbMap = (c, f) => {
  const hi = Math.max(c[0], c[1], c[2]), lo = Math.min(c[0], c[1], c[2]), H = f(hi), L = f(lo);
  return hi - lo < 1e-9 ? [H, H, H] : c.map((v) => L + (v - lo) * ((H - L) / (hi - lo)));
};
const toScene = (srgbLin) => rgbMap(mul3(SRGB_TO_REC2020, srgbLin).map((v) => Math.min(1, Math.max(0, v))), hillInv);
const toDisplay = (scene2020) => mul3(REC2020_TO_SRGB, rgbMap(scene2020.map((v) => Math.max(0, v)), (x) => Math.min(1, hill(x))));
const enc = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; };

// frame: { w, h, data: Uint16Array RGBA half floats, linear }; gain: the RAW's display gain.
// RAW (display false): resolves { w, h, data: Uint16Array RGB, scale } like expandFrame, for writeDNG.
// Display-referred (display true; frame is the decoded sRGB, linearised): resolves { w, h, rgba }.
export async function hdrFromOne(frame, gain, strength = 'natural', { display = false, onProgress = () => {}, breathe = async () => {} } = {}) {
  const S = HDR_ONE[strength] || HDR_ONE.natural;
  const { w, h, data } = frame;
  const px = (i) => [H2F[data[i * 4]], H2F[data[i * 4 + 1]], H2F[data[i * 4 + 2]]];
  const lum = display
    ? (i) => { const c = toScene(px(i)); return Math.max(1e-6, REC2020_LUMA[0] * c[0] + REC2020_LUMA[1] * c[1] + REC2020_LUMA[2] * c[2]); }
    : (i) => Math.max(1e-6, (0.2126 * H2F[data[i * 4]] + 0.7152 * H2F[data[i * 4 + 1]] + 0.0722 * H2F[data[i * 4 + 2]]) * gain);

  // The working copy: luminance box-averaged to WORK on the long side.
  const k = Math.min(1, WORK / Math.max(w, h)), sw = Math.max(8, Math.round(w * k)), sh = Math.max(8, Math.round(h * k));
  const Y = new Float32Array(sw * sh), cnt = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) {
    const row = Math.min(sh - 1, Math.floor((y * sh) / h)) * sw;
    for (let x = 0; x < w; x++) { const o = row + Math.min(sw - 1, Math.floor((x * sw) / w)); Y[o] += lum(y * w + x); cnt[o]++; }
    if ((y & 511) === 0) { onProgress(0.25 * (y / h)); await breathe(); }
  }
  for (let i = 0; i < Y.length; i++) Y[i] /= cnt[i] || 1;

  // Each exposure as shown, with its weight: well exposed (near mid grey) times local detail.
  const levels = Math.max(1, Math.floor(Math.log2(Math.min(sw, sh))) - 2);
  const layers = S.evs.map((ev) => { const m = 2 ** ev, I = new Float32Array(Y.length); for (let i = 0; i < I.length; i++) I[i] = shown(Y[i] * m); return I; });
  const weights = layers.map((I) => {
    const W = new Float32Array(I.length);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x, c = I[i];
      const lap = Math.abs(4 * c - I[y * sw + Math.max(0, x - 1)] - I[y * sw + Math.min(sw - 1, x + 1)] - I[Math.max(0, y - 1) * sw + x] - I[Math.min(sh - 1, y + 1) * sw + x]);
      W[i] = Math.exp(-((c - 0.5) ** 2) / (2 * SIGMA * SIGMA)) * (lap + 0.02) + 1e-6;
    }
    return W;
  });
  for (let i = 0; i < Y.length; i++) { let s = 0; for (const W of weights) s += W[i]; for (const W of weights) W[i] /= s; }
  onProgress(0.35); await breathe();

  // Blend band by band, then collapse the pyramid.
  let acc = null;
  for (let j = 0; j < layers.length; j++) {
    const L = laplacian(layers[j], sw, sh, levels), G = gaussian(weights[j], sw, sh, levels);
    if (!acc) acc = L.map((p) => ({ a: new Float32Array(p.a.length), w: p.w, h: p.h }));
    for (let l = 0; l < levels; l++) { const A = acc[l].a, la = L[l].a, ga = G[l].a; for (let i = 0; i < A.length; i++) A[i] += la[i] * ga[i]; }
    onProgress(0.35 + 0.25 * ((j + 1) / layers.length)); await breathe();
  }
  let F = acc[levels - 1].a;
  for (let l = levels - 2; l >= 0; l--) {
    const n = acc[l + 1], p = acc[l], u = up(F, n.w, n.h, p.w, p.h);
    for (let i = 0; i < u.length; i++) u[i] += p.a[i];
    F = u;
  }

  // The gain (log2) the fusion asks for, then a guided filter on log luminance, so the full-size
  // gain is a local linear function of the photo's own luminance: it follows every edge.
  const gY = new Float32Array(Y.length), lg = new Float32Array(Y.length);
  for (let i = 0; i < Y.length; i++) {
    gY[i] = Math.log2(Y[i]);
    let g = S.amount * (Math.log2(Math.max(1e-6, unshown(F[i]))) - gY[i]);
    // Highlights only ever come down: what is already bright is never lifted.
    if (g > 0) { const t = Math.min(1, Math.max(0, (shown(Y[i]) - 0.55) / 0.3)); g *= 1 - t * t * (3 - 2 * t); }
    lg[i] = g;
  }
  const r = Math.max(2, Math.round(Math.max(sw, sh) / 200)), eps = 0.04;
  const mI = boxMean(gY, sw, sh, r), mP = boxMean(lg, sw, sh, r);
  const II = new Float32Array(Y.length), IP = new Float32Array(Y.length);
  for (let i = 0; i < Y.length; i++) { II[i] = gY[i] * gY[i]; IP[i] = gY[i] * lg[i]; }
  const mII = boxMean(II, sw, sh, r), mIP = boxMean(IP, sw, sh, r);
  const A = new Float32Array(Y.length), B = new Float32Array(Y.length);
  for (let i = 0; i < Y.length; i++) { const v = mII[i] - mI[i] * mI[i], c = mIP[i] - mI[i] * mP[i]; A[i] = c / (v + eps); B[i] = mP[i] - A[i] * mI[i]; }
  const mA = boxMean(A, sw, sh, r), mB = boxMean(B, sw, sh, r);
  onProgress(0.65); await breathe();

  // Full size: linear colour times the gain, into 16 bits with a scale that keeps nearly every
  // pixel in range (as Expand does).
  const peaks = [];
  const at = (arr, fx, fy) => {
    const x0 = Math.min(sw - 1, Math.max(0, Math.floor(fx))), y0 = Math.min(sh - 1, Math.max(0, Math.floor(fy)));
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    return (arr[y0 * sw + x0] * (1 - tx) + arr[y0 * sw + x1] * tx) * (1 - ty) + (arr[y1 * sw + x0] * (1 - tx) + arr[y1 * sw + x1] * tx) * ty;
  };
  const gainAt = (x, y, i, Yi = lum(i)) => { const fx = ((x + 0.5) * sw) / w - 0.5, fy = ((y + 0.5) * sh) / h - 0.5; return 2 ** (at(mA, fx, fy) * Math.log2(Yi) + at(mB, fx, fy)); };
  if (display) {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = toScene(px(i)), Yi = Math.max(1e-6, REC2020_LUMA[0] * c[0] + REC2020_LUMA[1] * c[1] + REC2020_LUMA[2] * c[2]);
        const g = gainAt(x, y, i, Yi), d = toDisplay([c[0] * g, c[1] * g, c[2] * g]);
        rgba[i * 4] = Math.round(enc(d[0]) * 255); rgba[i * 4 + 1] = Math.round(enc(d[1]) * 255); rgba[i * 4 + 2] = Math.round(enc(d[2]) * 255); rgba[i * 4 + 3] = 255;
      }
      if ((y & 255) === 0) { onProgress(0.65 + 0.33 * (y / h)); await breathe(); }
    }
    return { w, h, rgba };
  }
  for (let i = 0; i < w * h; i += 97) { const x = i % w, y = (i - x) / w; peaks.push(Math.max(H2F[data[i * 4]], H2F[data[i * 4 + 1]], H2F[data[i * 4 + 2]]) * gain * gainAt(x, y, i)); }
  peaks.sort((a, b) => a - b);
  const scale = Math.max(1e-4, peaks[Math.floor(peaks.length * 0.995)] || 1), toU = 65535 / scale;
  const out = new Uint16Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, g = gainAt(x, y, i) * gain * toU;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.min(65535, Math.max(0, Math.round(H2F[data[i * 4 + c]] * g)));
    }
    if ((y & 255) === 0) { onProgress(0.65 + 0.33 * (y / h)); await breathe(); }
  }
  return { w, h, data: out, scale };
}
