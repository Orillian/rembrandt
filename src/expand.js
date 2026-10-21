// Generative Expand: a wider (or taller) photo, the new edges filled with what plausibly continues
// the scene, by the inpainting network Generative Remove uses (inpaint.js, MI-GAN, on the CPU).
//
// The network sees the whole new canvas at about 1024 px, the photo placed in it and the border to
// fill; the original pixels are kept exactly and only the border comes from the network, scaled up.
// The result is a new linear DNG beside the original (like AI Denoise), so every edit still works.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { inpaint } from './inpaint.js';

const CONTEXT = 1024;
const OVERLAP = 6;   // cells of the photo the network redraws along each expanded edge

// The ways to expand: fractions of the width (left, right) and of the height (top, bottom).
export const EXPANDS = {
  wider: { label: 'Wider', sides: [0.15, 0.15, 0, 0] },
  taller: { label: 'Taller', sides: [0, 0, 0.15, 0.15] },
  all: { label: 'All sides', sides: [0.12, 0.12, 0.12, 0.12] },
  square: { label: 'Square', sides: null },
};

const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const DEC = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const half = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
    t[h] = s * (e === 0 ? m * 2 ** -24 : e === 31 ? (m ? NaN : Infinity) : (1 + m / 1024) * 2 ** (e - 15));
  }
  return t;
})();

// The border sizes, in pixels, for a frame of w × h.
function borders(kind, w, h) {
  const k = EXPANDS[kind];
  if (!k) throw new Error('Unknown expand');
  if (!k.sides) { const s = Math.max(w, h); return [Math.floor((s - w) / 2), Math.ceil((s - w) / 2), Math.floor((s - h) / 2), Math.ceil((s - h) / 2)]; }
  const [l, r, t, b] = k.sides;
  return [Math.round(w * l), Math.round(w * r), Math.round(h * t), Math.round(h * b)];
}

// frame: { w, h, data: Uint16Array RGBA half floats, linear }; gain: the RAW's display gain (1 for
// other photos). Resolves { w, h, data: Uint16Array RGB, scale } (display brightness = data / 65535 ·
// scale), for writeDNG.
export async function expandFrame(frame, gain, kind, { onProgress = () => {}, breathe = async () => {} } = {}) {
  const { w, h, data } = frame;
  const [bl, br, bt, bb] = borders(kind, w, h);
  if (!(bl + br + bt + bb)) throw new Error('This photo is already that shape');
  const W = w + bl + br, H = h + bt + bb;
  // Scale: nearly every pixel in range (as Generative Remove does), from a sample.
  const peaks = [];
  for (let i = 0; i < w * h; i += 97) peaks.push(Math.max(half[data[i * 4]], half[data[i * 4 + 1]], half[data[i * 4 + 2]]) * gain);
  peaks.sort((a, b) => a - b);
  const scale = Math.max(1e-4, peaks[Math.floor(peaks.length * 0.995)] || 1);

  // The canvas the network sees: the photo box-averaged into place, the border to fill, and a thin
  // strip just inside each expanded edge (OVERLAP cells), which the network redraws so the result can
  // fade from the photo into the fill instead of meeting it at a seam.
  const k = Math.min(1, CONTEXT / Math.max(W, H)), sw = Math.max(1, Math.round(W * k)), sh = Math.max(1, Math.round(H * k));
  const ov = OVERLAP / k;   // the strip, in full-size pixels
  // Distance (full-size pixels) from a photo pixel to the nearest expanded edge.
  const edge = (x, y) => Math.min(bl ? x : Infinity, br ? w - 1 - x : Infinity, bt ? y : Infinity, bb ? h - 1 - y : Infinity);
  const rgb = new Uint8Array(sw * sh * 3), hole = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const X0 = x / k - bl, X1 = (x + 1) / k - bl, Y0 = y / k - bt, Y1 = (y + 1) / k - bt;
      const o = y * sw + x;
      if (X0 < 0 || Y0 < 0 || X1 > w || Y1 > h) { hole[o] = 1; continue; }
      if (edge((X0 + X1) / 2, (Y0 + Y1) / 2) < ov) hole[o] = 1;
      let r = 0, g = 0, b = 0, n = 0;
      const step = Math.max(1, Math.floor((X1 - X0) / 3));
      for (let yy = Math.floor(Y0); yy < Math.min(h, Math.ceil(Y1)); yy += step) for (let xx = Math.floor(X0); xx < Math.min(w, Math.ceil(X1)); xx += step) {
        const i = (yy * w + xx) * 4; r += half[data[i]]; g += half[data[i + 1]]; b += half[data[i + 2]]; n++;
      }
      const f = gain / Math.max(1, n) / scale;
      rgb[o * 3] = Math.round(255 * enc(Math.min(1, Math.max(0, r * f))));
      rgb[o * 3 + 1] = Math.round(255 * enc(Math.min(1, Math.max(0, g * f))));
      rgb[o * 3 + 2] = Math.round(255 * enc(Math.min(1, Math.max(0, b * f))));
    }
  }
  onProgress(0.1);
  await breathe();
  const fill = await inpaint(rgb, hole, sw, sh);
  // Where the photo was shown, the photo (the network's output there isn't meant to be used): so the
  // fill, scaled up, never pulls stray colours into the edge.
  for (let o = 0; o < sw * sh; o++) if (!hole[o]) { fill[o * 3] = rgb[o * 3]; fill[o * 3 + 1] = rgb[o * 3 + 1]; fill[o * 3 + 2] = rgb[o * 3 + 2]; }
  onProgress(0.7);
  await breathe();

  // The full-size result: the original pixels as they are, the border from the fill (bilinear).
  const out = new Uint16Array(W * H * 3), toU = 65535 / scale;
  const at = (fx, fy, c) => {
    const x0 = Math.min(sw - 1, Math.max(0, Math.floor(fx))), y0 = Math.min(sh - 1, Math.max(0, Math.floor(fy)));
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), tx = Math.min(1, Math.max(0, fx - x0)), ty = Math.min(1, Math.max(0, fy - y0));
    const v = (xx, yy) => DEC[fill[(yy * sw + xx) * 3 + c]];
    return (v(x0, y0) * (1 - tx) + v(x1, y0) * tx) * (1 - ty) + (v(x0, y1) * (1 - tx) + v(x1, y1) * tx) * ty;
  };
  for (let Y = 0; Y < H; Y++) {
    const y = Y - bt;
    for (let X = 0; X < W; X++) {
      const x = X - bl, o = (Y * W + X) * 3;
      if (x >= 0 && y >= 0 && x < w && y < h) {
        const i = (y * w + x) * 4, d = edge(x, y);
        // The photo, fading into the fill over the last strip before an expanded edge.
        const t = d >= ov ? 1 : Math.max(0, d / ov), wPhoto = t * t * (3 - 2 * t);
        for (let c = 0; c < 3; c++) {
          let v = half[data[i + c]] * gain * toU;
          if (wPhoto < 1) v = v * wPhoto + at(X * k - 0.5, Y * k - 0.5, c) * 65535 * (1 - wPhoto);
          out[o + c] = Math.min(65535, Math.max(0, Math.round(v)));
        }
      } else {
        const fx = X * k - 0.5, fy = Y * k - 0.5;
        for (let c = 0; c < 3; c++) out[o + c] = Math.min(65535, Math.round(at(fx, fy, c) * 65535));
      }
    }
    if ((Y & 255) === 0) { onProgress(0.7 + 0.28 * (Y / H)); await breathe(); }
  }
  return { w: W, h: H, data: out, scale };
}
