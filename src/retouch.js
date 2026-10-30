// Spot removal (Lightroom's Remove panel, Heal and Clone): spots and brushed areas that copy pixels
// from another part of the photo. Operations are stored in p.retouch and applied to the source
// (after lens corrections, before every other edit), so they follow all later edits and export at
// full quality.
//
// Heal copies the source, then adds a smooth correction so the copy meets the destination at its
// border: the difference between destination and source on a ring outside the shape is extended
// inward as a membrane (Laplace's equation, solved with multigrid V-cycles). Clone blends the source
// in as it is. A new spot's source is found automatically: the nearby area whose border matches and
// whose texture is similar, avoiding other spots and clipped highlights.
//
// Ported from RAWmakase (src/develop/retouch/{mod,heal,search}.rs), MIT licence,
// © RAWmakase contributors; see NOTICE.md.
//
// Generative fills (mode 'fill', inpaint.js) are spots too: they carry `fill: { key, rect, scale }`, the
// stored patch, where it goes (UV [u0, v0, u1, v1]) and the scale it was encoded at.
//
// An operation: { mode: 'heal' | 'clone' | 'fill', shape: 'spot' | 'brush', points: [[u, v], …] (one for a spot),
//   radius (fraction of the photo's long edge), feather 0–1, opacity 0–1, offset: [du, dv] }.
// Positions are UV of the (lens-corrected) photo: u to the right, v down, 0–1.

import { inpaint, patches, patchReady, savePatch } from './inpaint.js';

export const MAX_OPS = 1000;
export const MAX_POINTS = 4096;

// ---------------------------------------------------------------- geometry

// A long-edge fraction as UV radii, for a photo `aspect` (width / height).
export function radii(r, aspect) { return aspect >= 1 ? [r, r * aspect] : [r / aspect, r]; }
export const pin = (op) => op.points[op.points.length - 1];

export function valid(op) {
  const unit = (v) => Number.isFinite(v) && v >= 0 && v <= 1;
  const pos = (p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v) && Math.abs(v) <= 2);
  const fill = op?.mode !== 'fill' || (typeof op.fill?.key === 'string' && Array.isArray(op.fill.rect) && op.fill.rect.length === 4 && op.fill.rect.every((v) => Number.isFinite(v)) && op.fill.scale > 0);
  return op && (op.mode === 'heal' || op.mode === 'clone' || op.mode === 'fill') && fill && unit(op.feather) && unit(op.opacity) && pos(op.offset)
    && Number.isFinite(op.radius) && op.radius >= 1e-4 && op.radius <= 0.5
    && Array.isArray(op.points) && op.points.length >= 1 && op.points.length <= MAX_POINTS && op.points.every(pos);
}

// An operation placed on a W × H pixel grid (pixel centres at integers).
function place(op, W, H) {
  const long = Math.max(W, H);
  const px = ([u, v]) => [u * W - 0.5, v * H - 0.5];
  return {
    mode: op.mode, opacity: op.opacity, feather: op.feather,
    points: op.points.map(px),
    radius: Math.max(0.5, op.radius * long),
    offset: [op.offset[0] * W, op.offset[1] * H],
  };
}
function destRect(pl) {
  const r = pl.radius + 1;
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pl.points) b = [Math.min(b[0], Math.floor(x - r)), Math.min(b[1], Math.floor(y - r)), Math.max(b[2], Math.ceil(x + r) + 1), Math.max(b[3], Math.ceil(y + r) + 1)];
  return b;
}
const clip = (r, W, H) => [Math.max(0, Math.min(W, r[0])), Math.max(0, Math.min(H, r[1])), Math.max(0, Math.min(W, r[2])), Math.max(0, Math.min(H, r[3]))];

// ---------------------------------------------------------------- coverage

// 1 up to `inner`, smoothstep down to 0 at `outer`.
export function profile(d, inner, outer) {
  if (d <= inner) return 1;
  if (d >= outer) return 0;
  const t = (outer - d) / (outer - inner);
  return t * t * (3 - 2 * t);
}

// Feathered coverage of dabs of `radius` along `points` over rect [x0, y0, x1, y1).
export function coverage(points, radius, feather, rect) {
  const w = rect[2] - rect[0], h = rect[3] - rect[1];
  const dist = new Float32Array(w * h).fill(Infinity);
  const reach = radius + 1;
  const segs = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
  for (const [a, b] of segs) {
    const x0 = Math.max(rect[0], Math.floor(Math.min(a[0], b[0]) - reach)), x1 = Math.min(rect[2], Math.ceil(Math.max(a[0], b[0]) + reach) + 1);
    const y0 = Math.max(rect[1], Math.floor(Math.min(a[1], b[1]) - reach)), y1 = Math.min(rect[3], Math.ceil(Math.max(a[1], b[1]) + reach) + 1);
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const px = x - a[0], py = y - a[1];
        const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const ex = px - t * dx, ey = py - t * dy;
        const i = (y - rect[1]) * w + (x - rect[0]);
        const d2 = ex * ex + ey * ey;
        if (d2 < dist[i]) dist[i] = d2;
      }
    }
  }
  const inner = radius * (1 - feather);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = profile(Math.sqrt(dist[i]), inner, radius);
  return out;
}

// ---------------------------------------------------------------- heal membrane

// Heal works in log values: ln(x + 0.001).
const toLog = (v) => Math.log(Math.max(0, v) + 1e-3);
const fromLog = (v) => Math.max(0, Math.exp(v) - 1e-3);

function neighbours(v, w, h, x, y) {
  const l = x > 0 ? x - 1 : Math.min(x + 1, w - 1), r = x + 1 < w ? x + 1 : Math.max(x - 1, 0);
  const u = y > 0 ? y - 1 : Math.min(y + 1, h - 1), d = y + 1 < h ? y + 1 : Math.max(y - 1, 0);
  return v[y * w + l] + v[y * w + r] + v[u * w + x] + v[d * w + x];
}
// Red-black Gauss–Seidel with over-relaxation.
function sweeps(v, rhs, inside, w, h, count) {
  const OMEGA = 1.15;
  for (let n = 0; n < count; n++) {
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < h; y++) {
        for (let x = (y + parity) % 2; x < w; x += 2) {
          const i = y * w + x;
          if (inside[i]) v[i] += OMEGA * ((neighbours(v, w, h, x, y) + rhs[i]) * 0.25 - v[i]);
        }
      }
    }
  }
}
// Relax, solve for the error on a grid half the size, correct, relax.
function vCycle(v, rhs, inside, w, h) {
  if (w <= 12 && h <= 12) { sweeps(v, rhs, inside, w, h, 60); return; }
  sweeps(v, rhs, inside, w, h, 3);
  const cw = Math.ceil(w / 2), ch = Math.ceil(h / 2);
  const crhs = new Float32Array(cw * ch), cinside = new Uint8Array(cw * ch).fill(1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c = (y >> 1) * cw + (x >> 1);
      if (inside[i]) crhs[c] += rhs[i] - (4 * v[i] - neighbours(v, w, h, x, y));
      cinside[c] &= inside[i];
    }
  }
  const err = new Float32Array(cw * ch);
  vCycle(err, crhs, cinside, cw, ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!inside[i]) continue;
      const fx = Math.max(0, Math.min(cw - 1, (x - 0.5) / 2)), fy = Math.max(0, Math.min(ch - 1, (y - 0.5) / 2));
      const ix = fx | 0, iy = fy | 0, jx = Math.min(ix + 1, cw - 1), jy = Math.min(iy + 1, ch - 1), tx = fx - ix, ty = fy - iy;
      v[i] += (err[iy * cw + ix] * (1 - tx) + err[iy * cw + jx] * tx) * (1 - ty) + (err[jy * cw + ix] * (1 - tx) + err[jy * cw + jx] * tx) * ty;
    }
  }
  sweeps(v, rhs, inside, w, h, 3);
}
// Laplace's equation over `inside`, with the values outside as the boundary.
export function membrane(values, inside, w, h) {
  const v = Float32Array.from(values);
  let sum = 0, n = 0;
  for (let i = 0; i < v.length; i++) if (!inside[i]) { sum += values[i]; n++; }
  const start = n ? sum / n : 0;
  for (let i = 0; i < v.length; i++) if (inside[i]) v[i] = start;
  const rhs = new Float32Array(w * h);
  for (let k = 0; k < 8; k++) vCycle(v, rhs, inside, w, h);
  return v;
}
// Source plus the membrane of (dest − source), per channel, in log values. RGBA arrays.
export function heal(dest, source, alpha, w, h) {
  const inside = new Uint8Array(w * h);
  for (let i = 0; i < inside.length; i++) inside[i] = alpha[i] > 0 ? 1 : 0;
  const out = new Float32Array(w * h * 4);
  for (let c = 0; c < 3; c++) {
    const diff = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) diff[i] = toLog(dest[i * 4 + c]) - toLog(source[i * 4 + c]);
    const m = membrane(diff, inside, w, h);
    for (let i = 0; i < w * h; i++) out[i * 4 + c] = fromLog(toLog(source[i * 4 + c]) + m[i]);
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 1;
  return out;
}

// ---------------------------------------------------------------- applying to an image

// `img`: { read(x, y, w, h) -> Float32Array RGBA, write(x, y, w, h, data), W, H }.
// Renders one operation; the photo is only read and written where the operation reaches.
export function applyOp(img, op) {
  if (op.mode === 'fill') return applyFill(img, op);
  const W = img.W, H = img.H, pl = place(op, W, H);
  const rect = clip(destRect(pl), W, H);
  if (rect[2] <= rect[0] || rect[3] <= rect[1]) return;
  const grid = clip([rect[0] - 1, rect[1] - 1, rect[2] + 1, rect[3] + 1], W, H);
  const w = grid[2] - grid[0], h = grid[3] - grid[1];
  const [ox, oy] = pl.offset;
  // One read covering the destination and its source.
  const R = clip([Math.min(grid[0], Math.floor(grid[0] + ox) - 1), Math.min(grid[1], Math.floor(grid[1] + oy) - 1),
    Math.max(grid[2], Math.ceil(grid[2] + ox) + 1), Math.max(grid[3], Math.ceil(grid[3] + oy) + 1)], W, H);
  const rw = R[2] - R[0], rh = R[3] - R[1];
  const buf = img.read(R[0], R[1], rw, rh);
  const at = (x, y) => ((Math.max(R[1], Math.min(R[3] - 1, y)) - R[1]) * rw + (Math.max(R[0], Math.min(R[2] - 1, x)) - R[0])) * 4;
  const alpha = coverage(pl.points, pl.radius, pl.feather, grid);
  const dest = new Float32Array(w * h * 4), source = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, gx = grid[0] + x, gy = grid[1] + y;
      const d = at(gx, gy);
      dest[i] = buf[d]; dest[i + 1] = buf[d + 1]; dest[i + 2] = buf[d + 2]; dest[i + 3] = 1;
      // Bilinear source sample, clamped to the photo.
      const sx = Math.max(0, Math.min(W - 1, gx + ox)), sy = Math.max(0, Math.min(H - 1, gy + oy));
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), e = at(ix + 1, iy + 1);
      for (let k = 0; k < 3; k++) source[i + k] = (buf[a + k] * (1 - fx) + buf[b + k] * fx) * (1 - fy) + (buf[c + k] * (1 - fx) + buf[e + k] * fx) * fy;
      source[i + 3] = 1;
    }
  }
  const patch = pl.mode === 'clone' ? source : heal(dest, source, alpha, w, h);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i] * pl.opacity;
    if (a > 0) for (let k = 0; k < 3; k++) dest[i * 4 + k] += (patch[i * 4 + k] - dest[i * 4 + k]) * a;
  }
  img.write(grid[0], grid[1], w, h, dest);
}

// ---------------------------------------------------------------- generative fill

const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const DEC = Float32Array.from({ length: 256 }, (_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });

// Blends a fill's stored patch into the photo (at any size: the patch is resampled).
function applyFill(img, op) {
  const P = patches.get(op.fill.key);
  if (!P) return;
  const W = img.W, H = img.H, [u0, v0, u1, v1] = op.fill.rect, sc = op.fill.scale;
  const grid = clip([Math.floor(u0 * W), Math.floor(v0 * H), Math.ceil(u1 * W), Math.ceil(v1 * H)], W, H);
  const w = grid[2] - grid[0], h = grid[3] - grid[1];
  if (w <= 0 || h <= 0) return;
  const pl = place(op, W, H), alpha = coverage(pl.points, pl.radius, pl.feather, grid);
  const dest = img.read(grid[0], grid[1], w, h), d = P.data;
  for (let y = 0; y < h; y++) {
    const pv = Math.min(P.h - 1, Math.max(0, ((grid[1] + y + 0.5) / H - v0) / (v1 - v0) * P.h - 0.5));
    const iy = Math.floor(pv), fy = pv - iy, iy1 = Math.min(P.h - 1, iy + 1);
    for (let x = 0; x < w; x++) {
      const a = alpha[y * w + x] * op.opacity;
      if (a <= 0) continue;
      const pu = Math.min(P.w - 1, Math.max(0, ((grid[0] + x + 0.5) / W - u0) / (u1 - u0) * P.w - 0.5));
      const ix = Math.floor(pu), fx = pu - ix, ix1 = Math.min(P.w - 1, ix + 1);
      const i = (y * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const t = (DEC[d[(iy * P.w + ix) * 4 + k]] * (1 - fx) + DEC[d[(iy * P.w + ix1) * 4 + k]] * fx) * (1 - fy)
          + (DEC[d[(iy1 * P.w + ix) * 4 + k]] * (1 - fx) + DEC[d[(iy1 * P.w + ix1) * 4 + k]] * fx) * fy;
        dest[i + k] += (t * sc - dest[i + k]) * a;
      }
    }
  }
  img.write(grid[0], grid[1], w, h, dest);
}

// Works out a new fill for `op` (a 'fill' brush or spot) on `img`, the photo as it is now: the painted
// area and the context around it go through the inpainting network, and the result is stored.
// Sets op.fill. The context is resampled to at most CONTEXT_PX on its long edge.
const CONTEXT_PX = 1024;
export async function makeFill(img, op) {
  const W = img.W, H = img.H, pl = place(op, W, H);
  const rect = clip(destRect(pl), W, H);
  const rw = rect[2] - rect[0], rh = rect[3] - rect[1];
  if (rw <= 0 || rh <= 0) throw new Error('Nothing to remove there');
  const m = Math.max(48, Math.round(Math.max(rw, rh) * 0.75));
  const C = clip([rect[0] - m, rect[1] - m, rect[2] + m, rect[3] + m], W, H);
  const cw = C[2] - C[0], ch = C[3] - C[1];
  const src = img.read(C[0], C[1], cw, ch);
  const hole = coverage(pl.points, pl.radius + 2, Math.min(pl.feather, 0.5), C);
  // Display-encode at a scale that keeps nearly every pixel in range (the network wants 8-bit sRGB):
  // the 99.5th percentile of each pixel's brightest channel, from a histogram (sorting millions of
  // values for a large removal took about a second).
  let top = 0;
  for (let i = 0; i < cw * ch; i++) top = Math.max(top, src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
  const BINS = 4096, hist = new Uint32Array(BINS), per = (BINS - 1) / Math.max(top, 1e-9);
  for (let i = 0; i < cw * ch; i++) hist[Math.floor(Math.max(src[i * 4], src[i * 4 + 1], src[i * 4 + 2], 0) * per)]++;
  let bin = 0;
  for (let n = 0, want = Math.floor(cw * ch * 0.995); bin < BINS - 1 && (n += hist[bin]) <= want; bin++);
  const scale = Math.max(1e-4, (bin + 1) / per);
  const ENC = Uint8Array.from({ length: 4097 }, (_, j) => Math.round(255 * enc(j / 4096)));
  // Resampled to the working size (nearest is fine: the network works at 512 inside).
  const k = Math.min(1, CONTEXT_PX / Math.max(cw, ch)), sw = Math.max(1, Math.round(cw * k)), sh = Math.max(1, Math.round(ch * k));
  const rgb = new Uint8Array(sw * sh * 3), holes = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const sx = Math.min(cw - 1, Math.floor((x + 0.5) / k)), sy = Math.min(ch - 1, Math.floor((y + 0.5) / k)), i = (sy * cw + sx);
    for (let c = 0; c < 3; c++) rgb[(y * sw + x) * 3 + c] = ENC[Math.round(4096 * Math.min(1, Math.max(0, src[i * 4 + c] / scale)))];
    holes[y * sw + x] = hole[i] > 0.02 ? 1 : 0;
  }
  const out = await inpaint(rgb, holes, sw, sh);
  // Keep the part over the painted area.
  const x0 = Math.floor((rect[0] - C[0]) * k), y0 = Math.floor((rect[1] - C[1]) * k);
  const pw = Math.max(1, Math.min(sw - x0, Math.ceil(rw * k))), ph = Math.max(1, Math.min(sh - y0, Math.ceil(rh * k)));
  const rgba = new Uint8Array(pw * ph * 4);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const s3 = ((y0 + y) * sw + x0 + x) * 3, d4 = (y * pw + x) * 4;
    rgba[d4] = out[s3]; rgba[d4 + 1] = out[s3 + 1]; rgba[d4 + 2] = out[s3 + 2]; rgba[d4 + 3] = 255;
  }
  const key = 'fill:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  await savePatch(key, rgba, pw, ph);
  // The patch covers exactly the pixels it was cut from.
  const kx = pw / k, ky = ph / k;
  op.fill = { key, rect: [rect[0] / W, rect[1] / H, (rect[0] + kx) / W, (rect[1] + ky) / H], scale };
  return op;
}

// ---------------------------------------------------------------- automatic source

const SEARCH_RADIUS = 10;
const DISTANCES = [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
const ANGLES = 32;

// The offset (UV) for a new operation, or null. `others`: the photo's other operations (poor sources);
// `avoid`: offsets already offered, so asking again gives the next best source.
export function findSource(img, op, others = [], avoid = []) {
  const W = img.W, H = img.H, pl = place(op, W, H);
  const dest = destRect(pl);
  const extent = Math.max((Math.max(dest[2] - dest[0], dest[3] - dest[1])) * 0.5, pl.radius);
  const reach = extent * DISTANCES[DISTANCES.length - 1] + extent + 2;
  const rect = clip([dest[0] - reach, dest[1] - reach, dest[2] + reach, dest[3] + reach].map(Math.round), W, H);
  const scale = Math.max(1, pl.radius / SEARCH_RADIUS, Math.max(rect[2] - rect[0], rect[3] - rect[1]) / 600);
  // A reduced neighbourhood in log values (box-averaged), and where it's clipped.
  const pw = Math.max(1, Math.floor((rect[2] - rect[0]) / scale)), ph = Math.max(1, Math.floor((rect[3] - rect[1]) / scale));
  const full = img.read(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]), fw = rect[2] - rect[0];
  const logs = new Float32Array(pw * ph * 3), clipped = new Uint8Array(pw * ph);
  const taps = Math.min(4, Math.ceil(scale));
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const s = [0, 0, 0];
      let clip2 = 0;
      for (let j = 0; j < taps; j++) {
        for (let i = 0; i < taps; i++) {
          const sx = Math.min(fw - 1, Math.floor(x * scale + (i + 0.5) * scale / taps)), sy = Math.min(rect[3] - rect[1] - 1, Math.floor(y * scale + (j + 0.5) * scale / taps));
          const k = (sy * fw + sx) * 4;
          for (let c = 0; c < 3; c++) { s[c] += full[k + c]; if (full[k + c] >= 0.97) clip2 = 1; }
        }
      }
      for (let c = 0; c < 3; c++) logs[(y * pw + x) * 3 + c] = Math.log(Math.max(0, s[c] / (taps * taps)) + 1e-3);
      clipped[y * pw + x] = clip2;
    }
  }
  const toPatch = ([x, y]) => [(x - rect[0]) / scale, (y - rect[1]) / scale];
  const idx = (x, y) => (x >= 0 && y >= 0 && x < pw && y < ph ? y * pw + x : -1);
  const grad = (i) => {
    const x = i % pw, y = (i / pw) | 0;
    const g = (xx, yy) => { const j = idx(xx, yy); return j < 0 ? i : j; };
    const l = g(x - 1, y), r = g(x + 1, y), u = g(x, y - 1), d = g(x, y + 1);
    let s = 0;
    for (let c = 0; c < 3; c++) s += (logs[r * 3 + c] - logs[l * 3 + c]) ** 2 + (logs[d * 3 + c] - logs[u * 3 + c]) ** 2;
    return s * 0.25;
  };
  const pts = pl.points.map(toPatch), radius = pl.radius / scale;
  const all = [0, 0, pw, ph];
  const core = coverage(pts, radius, 0, all), outer = coverage(pts, radius * 1.4 + 1, 0, all);
  const inside = [], ring = [];
  for (let i = 0; i < core.length; i++) { const p = [i % pw, (i / pw) | 0]; if (core[i] > 0) inside.push(p); else if (outer[i] > 0) ring.push(p); }
  if (!inside.length || !ring.length) return null;
  const occupied = new Uint8Array(pw * ph);
  for (const o of others) {
    if (o === op) continue;
    const q = place(o, W, H);
    const c = coverage(q.points.map(toPatch), q.radius / scale, 0, all);
    for (let i = 0; i < c.length; i++) if (c[i] > 0) occupied[i] = 1;
  }
  const own = new Set(inside.map(([x, y]) => y * pw + x));
  let ringTex = 0;
  for (const [x, y] of ring) ringTex += grad(idx(x, y));
  ringTex /= ring.length;
  const score = (ox, oy) => {
    let ssd = 0;
    for (const [x, y] of ring) {
      const a = idx(x, y), b = idx(x + ox, y + oy);
      if (a < 0 || b < 0) return null;
      for (let c = 0; c < 3; c++) ssd += (logs[a * 3 + c] - logs[b * 3 + c]) ** 2;
    }
    ssd /= ring.length;
    let tex = 0, pen = 0;
    for (const [x, y] of inside) {
      const b = idx(x + ox, y + oy);
      if (b < 0) return null;
      tex += grad(b);
      if (clipped[b]) pen += 1;
      if (occupied[b]) pen += 0.5;
      if (own.has(b)) pen += 1;
    }
    const n = inside.length;
    return ssd + 2 * (Math.sqrt(tex / n) - Math.sqrt(ringTex)) ** 2 + 0.05 * pen / n;
  };
  const p0 = place({ ...op, points: [pin(op)] }, W, H).points[0];
  const avoided = (ox, oy) => avoid.some(([du, dv]) => Math.hypot(du * W / scale - ox, dv * H / scale - oy) < Math.max(radius, 2));
  const rr = extent / scale;
  let best = null;
  for (const dist of DISTANCES) {
    for (let k = 0; k < ANGLES; k++) {
      const ang = (k / ANGLES) * Math.PI * 2;
      const fx = Math.cos(ang) * dist * rr, fy = Math.sin(ang) * dist * rr;
      if (avoided(fx, fy)) continue;
      const ox = Math.round(fx), oy = Math.round(fy);
      const s = score(ox, oy);
      if (s != null && (!best || s < best[0])) best = [s, ox, oy];
    }
  }
  if (!best) return null;
  let [s, ox, oy] = best;
  for (let n = 0; n < 4; n++) {
    let moved = false;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (avoided(ox + dx, oy + dy)) continue;
      const t = score(ox + dx, oy + dy);
      if (t != null && t < s) { s = t; ox += dx; oy += dy; moved = true; }
    }
    if (!moved) break;
  }
  void p0;
  return [(ox * scale) / W, (oy * scale) / H];
}

// ---------------------------------------------------------------- engine hook

// engine.sourcePasses for spot removal: applies p.retouch in order on the float source copy.
export const retouchPasses = {
  // A fill whose patch is still loading is left out until it arrives (inpaint.js hooks.onReady).
  key(p) { return p.retouch?.length ? JSON.stringify(p.retouch) + p.retouch.map((o) => (o.mode === 'fill' && o.fill ? (patchReady(o.fill.key) ? 1 : 0) : '')).join('') : ''; },
  run(engine, p, target) {
    const img = imageOf(engine, target);
    for (const op of p.retouch) if (valid(op)) applyOp(img, op);
    return target;
  },
};

// Read/write access to an engine float target, for applyOp and findSource.
export function imageOf(engine, target) {
  return {
    W: target.w, H: target.h,
    read: (x, y, w, h) => engine.readRect(target, x, y, w, h),
    write: (x, y, w, h, data) => engine.writeRect(target, x, y, w, h, data),
  };
}
