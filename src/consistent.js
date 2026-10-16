// Make these consistent: photos from one shoot brought to the same brightness and white balance as a
// hero photo. Each photo keeps its own edits; only Exposure, Temperature and Tint change, solved by
// rendering the photo and measuring it (mid-tone brightness, and the colour cast of its mid-tones)
// until it matches the hero's render. Works the same for RAWs and JPEGs because it measures results.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { oklab, SRGB_TO_REC2020 as S2R } from '../engine/src/color.js';

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const WB_RANGE = 40;

// { ev: median log2 luminance, a, b: mean Oklab cast of the mid-tones } of display RGBA pixels.
export function measure(data, w, h) {
  const evs = [];
  let sa = 0, sb = 0, n = 0;
  const step = Math.max(1, Math.floor((w * h) / 40000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    const r = lin(data[i] / 255), g = lin(data[i + 1] / 255), b = lin(data[i + 2] / 255);
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    evs.push(Math.log2(Math.max(Y, 1e-5)));
    if (Math.max(data[i], data[i + 1], data[i + 2]) > 250) continue;
    const lab = oklab([S2R[0][0] * r + S2R[0][1] * g + S2R[0][2] * b, S2R[1][0] * r + S2R[1][1] * g + S2R[1][2] * b, S2R[2][0] * r + S2R[2][1] * g + S2R[2][2] * b]);
    // Mid-tones with little colour: what reads as the light's colour, not the subject's.
    const C = Math.hypot(lab[1], lab[2]);
    if (lab[0] < 0.3 || lab[0] > 0.9 || C > 0.08) continue;
    const wgt = 1 - C / 0.08;
    sa += lab[1] * wgt; sb += lab[2] * wgt; n += wgt;
  }
  evs.sort((x, y) => x - y);
  return { ev: evs[evs.length >> 1] ?? 0, a: n ? sa / n : 0, b: n ? sb / n : 0 };
}

// How far apart two measurements look: EV for brightness, Oklab ×100 (≈ ΔE) for the cast.
export const gap = (m, t) => ({ ev: Math.abs(m.ev - t.ev), cast: Math.hypot(m.a - t.a, m.b - t.b) * 100 });

// `render(params)` resolves { data, w, h } of the photo with those settings. Returns the photo's
// params with exposure, temp and tint changed to match `target` (a measurement of the hero), and how
// close it got: { params, before, after }.
export async function matchTo(params, target, render) {
  const at = async (p) => { const r = await render(p); return measure(r.data, r.w, r.h); };
  let p = { ...params };
  let m = await at(p);
  const before = gap(m, target);
  // Brightness: exposure is in stops, but tone mapping bends it; a few steps settle it.
  for (let k = 0; k < 6 && Math.abs(target.ev - m.ev) > 0.02; k++) {
    p.exposure = clamp(Math.round((p.exposure + (target.ev - m.ev)) * 100) / 100, -5, 5);
    m = await at(p);
  }
  // White balance: Newton steps on (temp, tint) → (a, b), the slope measured once on this photo.
  const D = 12;
  const mt = await at({ ...p, temp: clamp(p.temp + D, -100, 100) }), mn = await at({ ...p, tint: clamp(p.tint + D, -100, 100) });
  const J = [[(mt.a - m.a) / D, (mn.a - m.a) / D], [(mt.b - m.b) / D, (mn.b - m.b) / D]];
  const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
  if (Math.abs(det) > 1e-9) {
    for (let k = 0; k < 3 && Math.hypot(target.a - m.a, target.b - m.b) > 0.002; k++) {
      const da = target.a - m.a, db = target.b - m.b;
      const dt = (J[1][1] * da - J[0][1] * db) / det, dn = (-J[1][0] * da + J[0][0] * db) / det;
      // Within ±WB_RANGE of where the photo was: a shoot's frames differ by a little, and a big jump
      // means different light (or a different scene), better left to you.
      const next = { ...p, temp: clamp(Math.round(p.temp + dt), Math.max(-100, params.temp - WB_RANGE), Math.min(100, params.temp + WB_RANGE)), tint: clamp(Math.round(p.tint + dn), Math.max(-100, params.tint - WB_RANGE), Math.min(100, params.tint + WB_RANGE)) };
      if (next.temp === p.temp && next.tint === p.tint) break;
      const mm = await at(next);
      if (Math.hypot(target.a - mm.a, target.b - mm.b) >= Math.hypot(da, db)) break;   // no better: stop
      p = next; m = mm;
    }
  }
  return { params: p, before, after: gap(m, target) };
}

// Self-check: node src/consistent.js — a dark, warm frame brought to a neutral hero.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('consistent.js')) {
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const W = 64, H = 48, scene = Array.from({ length: W * H }, () => { const v = 0.05 + rnd() * 0.5, c = rnd() * 0.3; return [v * (1 + c), v, v * (1 - c * 0.5)]; });
  const enc = (c) => Math.round(255 * clamp(c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055, 0, 1));
  // A toy renderer: exposure in stops, temp/tint as channel gains, a soft shoulder; `light` is the shot's own cast and level.
  const shot = (light) => async (p) => {
    const k = 2 ** (p.exposure + light.ev), wr = 1 + p.temp / 250 + light.r, wb = 1 - p.temp / 250 + light.b, wg = 1 - p.tint / 300;
    const data = new Uint8ClampedArray(W * H * 4);
    scene.forEach(([r, g, b], i) => { const f = (x) => x / (1 + x * 0.35); data.set([enc(f(r * k * wr)), enc(f(g * k * wg)), enc(f(b * k * wb)), 255], i * 4); });
    return { data, w: W, h: H };
  };
  const base = { exposure: 0, temp: 0, tint: 0, contrast: 12 };
  const hero = await shot({ ev: 0, r: 0, b: 0 })(base), target = measure(hero.data, hero.w, hero.h);
  const r = await matchTo(base, target, shot({ ev: -1.3, r: 0.18, b: -0.12 }));
  if (!(r.after.ev < 0.05 && r.after.cast < 0.25 && r.before.ev > 1 && r.before.cast > 0.8)) throw new Error('not matched: ' + JSON.stringify(r));
  if (r.params.contrast !== 12) throw new Error('other edits must be kept');
  console.log(`consistent.js ok: ${r.before.ev.toFixed(2)} EV / ΔE ${r.before.cast.toFixed(1)} → ${r.after.ev.toFixed(3)} EV / ΔE ${r.after.cast.toFixed(2)} (exposure ${r.params.exposure}, temp ${r.params.temp}, tint ${r.params.tint})`);
}
