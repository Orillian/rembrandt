// Auto distortion: for lenses without a profile (old manual lenses, adapters, cheap zooms), finds the
// Optics › Distortion amount that makes the photo's straight lines straight.
//
// Strong edges (Sobel, thinned to their ridge) are found once on a small copy of the photo. For each
// candidate amount the edge points are moved to where the correction would put them (the inverse of
// opticsLut's radial model, 1 + d·0.15·r² of the half-diagonal) and vote in a Hough transform, each
// point only near its own direction, so it costs a few milliseconds. The amount whose votes pile up
// most sharply (lines, not curves) wins. Photos without long lines get no suggestion, not a guess.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const K = 0.15;          // opticsLut: g(r) = 1 + d · K · r² for Distortion d in −1…1
const TH_BINS = 360;     // 0.5° per bin over 180°
const SPREAD = 4;        // bins either side of a point's own direction

// `img`: ImageData of the photo before lens corrections (any size; ~800 px across is plenty).
// Returns { amount (−100…100, Optics › Distortion), confidence 0–1 } or null.
export function detectDistortion(img) {
  const { width: w, height: h, data } = img;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2];
  const gx = new Float32Array(w * h), gy = new Float32Array(w * h), mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const a = g[i - w - 1], b = g[i - w], c = g[i - w + 1], d = g[i - 1], f = g[i + 1], p = g[i + w - 1], q = g[i + w], r = g[i + w + 1];
    gx[i] = c + 2 * f + r - a - 2 * d - p; gy[i] = p + 2 * q + r - a - 2 * b - c; mag[i] = Math.hypot(gx[i], gy[i]);
  }
  const thr = Math.max(40, Float32Array.from(mag).sort()[Math.floor(mag.length * 0.9)]);
  // Edge points away from the centre (distortion barely moves the middle), at most 6000 of them.
  const cx = w / 2, cy = h / 2, hd = 0.5 * Math.hypot(w, h);
  let pts = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, m = mag[i];
    if (m < thr) continue;
    const nx = gx[i] / m, ny = gy[i] / m, dx = Math.round(nx), dy = Math.round(ny);
    if (mag[i + dy * w + dx] > m || mag[i - dy * w - dx] > m) continue;
    if (Math.hypot(x - cx, y - cy) < 0.25 * hd) continue;
    pts.push([x - cx, y - cy, Math.atan2(ny, nx)]);
  }
  if (pts.length < 400) return null;
  if (pts.length > 6000) { const step = pts.length / 6000; pts = Array.from({ length: 6000 }, (_, k) => pts[Math.floor(k * step)]); }

  const nRho = Math.ceil(2 * hd) + 1;
  const acc = new Float32Array(TH_BINS * nRho);
  const cs = Float32Array.from({ length: TH_BINS }, (_, k) => Math.cos((k * Math.PI) / TH_BINS));
  const sn = Float32Array.from({ length: TH_BINS }, (_, k) => Math.sin((k * Math.PI) / TH_BINS));
  // Sharpness of the vote: sum of squared bins, so a line's votes in one bin outweigh a curve's spread.
  const score = (d) => {
    acc.fill(0);
    for (const [x, y, th] of pts) {
      // Where the correction moves this point: out · g(|out| / hd) = src (Newton, a few steps).
      const rs = Math.hypot(x, y) / hd;
      let r = rs;
      for (let n = 0; n < 4; n++) r -= (r * (1 + d * K * r * r) - rs) / (1 + 3 * d * K * r * r);
      const s = rs > 0 ? r / rs : 1, X = x * s, Y = y * s;
      const k0 = Math.round((((th % Math.PI) + Math.PI) % Math.PI) / Math.PI * TH_BINS);
      for (let k = k0 - SPREAD; k <= k0 + SPREAD; k++) {
        const kk = (k + TH_BINS) % TH_BINS, flip = k < 0 || k >= TH_BINS ? -1 : 1;
        const rho = Math.round(flip * (X * cs[kk] + Y * sn[kk]) + hd);
        if (rho >= 0 && rho < nRho) acc[kk * nRho + rho]++;
      }
    }
    let s2 = 0;
    for (let i = 0; i < acc.length; i++) s2 += acc[i] * acc[i];
    return s2;
  };
  let best = 0, bestScore = score(0);
  const base = bestScore;
  for (let d = -1; d <= 1.0001; d += 0.05) {
    const v = score(d);
    if (v > bestScore) { bestScore = v; best = d; }
  }
  // Refine around the best amount.
  for (let d = best - 0.04; d <= best + 0.04 + 1e-6; d += 0.01) {
    const v = score(d);
    if (v > bestScore) { bestScore = v; best = d; }
  }
  const gain = bestScore / base - 1;
  // Too little difference between straight and curved, or the search's edge: no clear lines to go by.
  if (Math.abs(best) < 0.03 || Math.abs(best) > 0.95 || gain < 0.04) return null;
  // And real lines once corrected: at least three as long as an eighth of the photo's height.
  score(best);
  const long = 0.125 * Math.min(w, h);
  let lines = 0;
  for (let i = 0; i < acc.length; i++) if (acc[i] >= long) lines++;
  if (lines < 3) return null;
  return { amount: Math.round(best * 100), confidence: Math.min(1, gain / 0.3) };
}
