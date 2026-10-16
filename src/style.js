// Edit like me: Rembrandt learns how you edit from the photos you have edited, and edits a new photo
// the way you would. Each edited photo remembers what it looked like before you touched it (a few
// numbers: how bright, how contrasty, how colourful, what colour cast; and Auto's tone settings for
// it). For a new photo, the edited photos that started out most like it are found, and their
// settings blended: the tone sliders as your usual change from Auto (so a dark photo still gets
// lifted the way you like), the colour and effects sliders as you set them. On this device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { oklab, SRGB_TO_REC2020 as S2R } from '../engine/src/color.js';

export const TONE = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'];
export const LOOK = ['temp', 'tint', 'vibrance', 'saturation', 'texture', 'clarity', 'dehaze', 'vignette.amount', 'grain.amount', 'sharpen.amount'];
const RANGE = { exposure: [-5, 5], 'sharpen.amount': [0, 150], 'grain.amount': [0, 100] };
export const MIN_EXAMPLES = 3;
const K = 6;

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const get = (o, path) => path.split('.').reduce((x, k) => x?.[k], o);

// What a photo looks like unedited, from its small preview `sample` ({ data RGBA, w, h }):
// [shadows, mid-tones, highlights (EV), colourfulness, cast a, cast b].
export function features(sample) {
  const d = sample.data, evs = [];
  let C = 0, A = 0, B = 0, n = 0;
  const step = Math.max(1, Math.floor((sample.w * sample.h) / 20000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    const r = lin(d[i] / 255), g = lin(d[i + 1] / 255), b = lin(d[i + 2] / 255);
    evs.push(Math.log2(Math.max(0.2126 * r + 0.7152 * g + 0.0722 * b, 1e-4)));
    const lab = oklab([S2R[0][0] * r + S2R[0][1] * g + S2R[0][2] * b, S2R[1][0] * r + S2R[1][1] * g + S2R[1][2] * b, S2R[2][0] * r + S2R[2][1] * g + S2R[2][2] * b]);
    C += Math.hypot(lab[1], lab[2]); A += lab[1]; B += lab[2]; n++;
  }
  evs.sort((x, y) => x - y);
  const q = (t) => evs[Math.min(evs.length - 1, Math.floor(t * evs.length))] ?? 0;
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return [q(0.05), q(0.5), q(0.95), (C / n) * 10, (A / n) * 10, (B / n) * 10].map(r3);
}

// The settings you would give a photo that starts at `start` ({ f: features, base: Auto's tone
// settings }), from `examples` [{ start, params }]. Null with fewer than MIN_EXAMPLES.
export function predict(examples, start) {
  if (examples.length < MIN_EXAMPLES) return null;
  // Each feature in units of how much it varies across your photos.
  const dims = start.f.length, sd = [];
  for (let j = 0; j < dims; j++) {
    const v = examples.map((e) => e.start.f[j]), m = v.reduce((a, b) => a + b, 0) / v.length;
    sd.push(Math.max(Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length), j < 3 ? 0.5 : 0.1));
  }
  const near = examples.map((e) => ({ e, d: Math.hypot(...start.f.map((x, j) => (x - e.start.f[j]) / sd[j])) }))
    .sort((a, b) => a.d - b.d).slice(0, K);
  const ws = near.map(({ d }) => 1 / (d * d + 0.5)), W = ws.reduce((a, b) => a + b, 0);
  const blend = (fn) => near.reduce((s, { e }, i) => s + fn(e) * ws[i], 0) / W;
  const out = {};
  for (const k of TONE) out[k] = (start.base?.[k] || 0) + blend((e) => (get(e.params, k) || 0) - (e.start.base?.[k] || 0));
  for (const k of LOOK) out[k] = blend((e) => get(e.params, k) || 0);
  for (const k of [...TONE, ...LOOK]) {
    const [lo, hi] = RANGE[k] || [-100, 100];
    out[k] = Math.min(hi, Math.max(lo, k === 'exposure' ? Math.round(out[k] * 100) / 100 : Math.round(out[k])));
  }
  return { settings: out, from: near.length, nearest: near[0].d };
}

// Settings as a nested object (vignette.amount → { vignette: { amount } }) for withSettings.
export function nested(flat) {
  const o = {};
  for (const [k, v] of Object.entries(flat)) {
    const [a, b] = k.split('.');
    if (b) (o[a] ||= {})[b] = v; else o[a] = v;
  }
  return o;
}

// Self-check: node src/style.js — a photographer with habits; held-out photos predicted from the rest.
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('style.js')) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Synthetic photos: a brightness level and a cast; Auto lifts dark ones. This photographer goes
  // half a stop over Auto, opens shadows, warms cool photos, and adds clarity to dark ones.
  const photo = () => {
    const mid = -6 + rnd() * 5, cast = (rnd() - 0.5) * 0.4;
    const f = [mid - 3, mid, mid + 2.5, 0.5 + rnd(), cast * 0.3, cast];
    const base = { exposure: Math.round((-2.5 - mid) * 0.75 * 100) / 100, contrast: 10, highlights: 0, shadows: 10, whites: 0, blacks: 0 };
    const noise = () => (rnd() - 0.5) * 6;
    const params = { exposure: base.exposure + 0.5, contrast: 10 + 15 + noise(), highlights: -30 + noise(), shadows: 10 + 25 + noise(), whites: 0, blacks: -10, temp: Math.round(-cast * 60 + noise()), tint: 0, vibrance: 20 + noise(), saturation: 0, texture: 0, clarity: mid < -4 ? 25 : 5, dehaze: 0, vignette: { amount: -15 }, grain: { amount: 0 }, sharpen: { amount: 40 } };
    return { start: { f, base }, params };
  };
  const all = Array.from({ length: 40 }, photo), train = all.slice(0, 30), test = all.slice(30);
  const err = (pred) => { let s = 0, n = 0; for (const t of test) { const p = pred(t); for (const k of [...TONE, ...LOOK]) { const scale = k === 'exposure' ? 50 : 1; s += Math.abs((p[k] - (get(t.params, k) || 0)) * scale); n++; } } return s / n; };
  const mine = err((t) => predict(train, t.start).settings);
  const autoOnly = err((t) => ({ ...Object.fromEntries(LOOK.map((k) => [k, 0])), ...t.start.base }));
  if (!(mine < autoOnly * 0.35)) throw new Error(`style not learned: ${mine.toFixed(1)} vs Auto ${autoOnly.toFixed(1)}`);
  if (predict(train.slice(0, 2), test[0].start) !== null) throw new Error('needs a few examples');
  // A dark photo gets the clarity this photographer gives dark photos.
  const dark = test.find((t) => t.start.f[1] < -4.6), p = predict(train, dark.start).settings;
  if (!(p.clarity > 15)) throw new Error('local habit not learned: clarity ' + p.clarity);
  console.log(`style.js ok: mean slider error ${mine.toFixed(1)} (Auto alone ${autoOnly.toFixed(1)})`);
}
