// Remove all dust: finds the spots sensor dust leaves (small, round, slightly darker blobs, seen in
// skies, walls and other smooth areas) so Retouch can heal them in one go.
//
// On the photo at its working size, in log luminance: the detail left after a wide blur, darker than
// the threshold, in connected blobs of dust's size and shape, where the surroundings are smooth
// (the same dip in foliage or fabric is texture, not dust). Visualize Spots shows what it looks at.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// Box mean of `src` (w × h) with radius r, separable, edges clamped.
function boxMean(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) { tmp[row + x] = s / n; s += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
  }
  return out;
}

// `rgba`: Float32Array (scene-linear RGBA) of the photo, w × h. `sensitivity` 0–1.
// Returns [{ u, v, radius (fraction of the long edge), strength }] strongest first.
export function findDust(rgba, w, h, { sensitivity = 0.5 } = {}) {
  const n = w * h, long = Math.max(w, h);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.log2(1e-4 + 0.2627 * rgba[i * 4] + 0.678 * rgba[i * 4 + 1] + 0.0593 * rgba[i * 4 + 2]);
  // Dust at this size is about 3–25 pixels across; the background blur is wider than that.
  const R = Math.max(16, Math.round(long / 80));
  const bg = boxMean(boxMean(L, w, h, R), w, h, R);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = L[i] - bg[i];
  const thr = 0.035 - 0.03 * sensitivity;   // 2.4 % darker at the least sensitive, 0.3 % at the most
  // Smoothness around each pixel: mean |detail| over a wide window, leaving out candidate pixels.
  const absd = new Float32Array(n), keep = new Float32Array(n);
  for (let i = 0; i < n; i++) { const c = d[i] < -thr; absd[i] = c ? 0 : Math.abs(d[i]); keep[i] = c ? 0 : 1; }
  const W2 = 2 * R, sa = boxMean(absd, w, h, W2), sk = boxMean(keep, w, h, W2);
  // Blobs of candidate pixels (4-connected flood fill).
  const label = new Int32Array(n).fill(-1), out = [];
  const stack = [];
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || d[start] >= -thr) continue;
    let area = 0, sx = 0, sy = 0, sum = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    stack.push(start); label[start] = start;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      area++; sx += x; sy += y; sum += -d[i];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (area > 2000) continue;   // far too big for dust; finish labelling without growing more
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && label[j] === -1 && d[j] < -thr) { label[j] = start; stack.push(j); }
      }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (area < 4 || bw > long * 0.035 || bh > long * 0.035) continue;        // noise, or too big
    if (Math.max(bw, bh) > 2 * Math.min(bw, bh) || area < 0.45 * bw * bh) continue;   // not round
    const cx = Math.round(sx / area), cy = Math.round(sy / area), c = cy * w + cx;
    const smooth = sk[c] > 0.2 ? sa[c] / sk[c] : 1;
    if (smooth > Math.max(0.012, thr * 0.6)) continue;                         // textured surroundings
    const strength = sum / area;
    if (strength < thr * 1.15) continue;
    out.push({ u: (cx + 0.5) / w, v: (cy + 0.5) / h, radius: (Math.sqrt(area / Math.PI) * 1.8 + 1.5) / long, strength });
  }
  return out.sort((a, b) => b.strength - a.strength);
}
