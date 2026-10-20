// Reshape tool (L): face sculpting sliders and Liquify brushes. The warp itself is in warp.js.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, svgEl } from './util.js';
import { slider, segmented, button, section } from './ui.js';
import { A } from './geometry.js';
import { detectFaces } from './ai/ai.js';
import { faceShape } from './warp.js';

export const warpState = { mode: 'push', size: 0.06, strength: 0.6 };
const MAX_STROKES = 400;

const aspect = (app) => app.img?.aspect || 1.5;
export const warpOf = (p) => (p.warp ||= { strokes: [], eyes: 0, face: 0, nose: 0, smile: 0, faces: null });

export class WarpOverlay {
  constructor(app) { this.app = app; this.drag = null; this.hover = null; }
  uv(x, y) { return this.app.cssToUV(x, y); }
  css(u, v) { return A.apply(A.inv(this.app.m.cssToUV), u, v); }
  cssRadius(r) {
    const a = aspect(this.app), ru = a >= 1 ? r : r / a;
    const [x0, y0] = this.css(0.5, 0.5), [x1, y1] = this.css(0.5 + ru, 0.5);
    return Math.hypot(x1 - x0, y1 - y0);
  }
  down(e, x, y) {
    if (e.button !== 0) return false;
    const w = warpOf(this.app.params);
    if (w.strokes.length >= MAX_STROKES) { this.app.toast('That’s the most Liquify strokes one photo can have'); return true; }
    const S = warpState;
    this.drag = { mode: S.mode, points: [this.uv(x, y)], radius: S.size, strength: S.strength };
    w.strokes.push(this.drag);
    this.app.requestRender();
    // Bloat and pucker grow while the button is held, like a brush that keeps working.
    if (S.mode === 'bloat' || S.mode === 'pucker' || S.mode === 'restore') {
      const d = this.drag;
      this.hold = setInterval(() => { if (this.drag === d && d.points.length < 2000) { d.points.push(d.points[d.points.length - 1]); this.app.requestRender(); } }, 60);
    }
    return true;
  }
  move(e, x, y) {
    this.hover = [x, y];
    const d = this.drag;
    if (d) {
      const [u, v] = this.uv(x, y), last = d.points[d.points.length - 1];
      if (Math.hypot(u - last[0], v - last[1]) > d.radius * 0.08 && d.points.length < 2000) { d.points.push([u, v]); this.app.requestRender(); }
    }
    this.app.drawOverlay();
  }
  up() {
    clearInterval(this.hold);
    if (!this.drag) return;
    this.drag = null;
    this.app.commit();
    this.app.refreshPanel();
  }
  leave() { this.hover = null; this.app.drawOverlay(); }
  cursor() { return 'none'; }
  draw(svg) {
    if (!this.hover) return;
    const r = this.cssRadius(warpState.size);
    svg.append(svgEl('circle', { cx: this.hover[0], cy: this.hover[1], r, class: 'rt-cursor' }));
    svg.append(svgEl('circle', { cx: this.hover[0], cy: this.hover[1], r: r * 0.5, class: 'rt-cursor inner' }));
  }
}

// The faces sculpting works on, found once per photo and kept with the edit (so exports and other
// computers reshape the same way without running the face model again).
// True when face sliders are set but this photo's faces haven't been found yet (pasted edits, presets).
export const needsFaces = (p) => { const w = p?.warp; return !!w && !w.faces && !!(w.eyes || w.face || w.nose || w.smile); };
export async function ensureFaces(app) {
  const w = warpOf(app.params);
  if (w.faces) return w.faces.length;
  const e = app.images[app.cur];
  const faces = e ? await detectFaces(e) : [];
  w.faces = faces.map(faceShape);
  return w.faces.length;
}

export function buildWarpPanel(app) {
  const reg = [];
  const W = () => warpOf(app.params);
  const face = section('Face', { id: 'warp-face', badge: { icon: 'person', color: 'linear-gradient(135deg,#fbbf24,#d97706)' }, onReset: () => { Object.assign(W(), { eyes: 0, face: 0, nose: 0, smile: 0 }); app.requestRender(); app.commit(); refresh(); } });
  const note = el('div', { class: 'hint' }, 'Finds the faces in the photo the first time you move a slider.');
  const sl = (key, label) => {
    const s = slider({
      label, min: -100, max: 100, def: 0, get: () => W()[key] || 0,
      set: async (v) => {
        W()[key] = v;
        if (!W().faces) {
          note.textContent = 'Finding faces…';
          const n = await ensureFaces(app).catch(() => 0);
          note.textContent = n ? `${n} face${n === 1 ? '' : 's'} found.` : 'No faces found in this photo.';
        }
        app.requestRender();
      },
      commit: () => app.commit(),
    });
    reg.push(s);
    return s.el;
  };
  face.body.append(note, sl('eyes', 'Eyes'), sl('face', 'Face width'), sl('nose', 'Nose'), sl('smile', 'Smile'));

  const liq = section('Liquify', { id: 'warp-liquify', badge: { icon: 'brush', color: 'linear-gradient(135deg,#60a5fa,#2563eb)' } });
  const mode = segmented([{ value: 'push', label: 'Push' }, { value: 'bloat', label: 'Bloat' }, { value: 'pucker', label: 'Pucker' }, { value: 'restore', label: 'Restore' }], warpState.mode, (v) => { warpState.mode = v; }, 'seg-sm');
  const size = slider({ label: 'Size', min: 1, max: 30, step: 0.5, def: 6, get: () => warpState.size * 100, set: (v) => { warpState.size = v / 100; app.drawOverlay(); } });
  const strength = slider({ label: 'Strength', min: 5, max: 100, def: 60, get: () => warpState.strength * 100, set: (v) => { warpState.strength = v / 100; } });
  const count = el('div', { class: 'hint' });
  const undoLast = button('Undo stroke', () => { W().strokes.pop(); app.requestRender(); app.commit(); refresh(); }, 'sm ghost', 'undo');
  const clear = button('Clear all', () => { W().strokes = []; app.requestRender(); app.commit(); refresh(); }, 'sm ghost');
  liq.body.append(el('div', { class: 'hint' }, 'Paint on the photo. Push moves what’s under the brush; Bloat and Pucker grow and shrink while you hold; Restore undoes Liquify where you paint.'),
    el('div', { class: 'field' }, el('span', {}, 'Brush'), mode.el), size.el, strength.el, count, el('div', { class: 'row' }, undoLast, clear));
  reg.push(size, strength);

  function refresh() {
    reg.forEach((r) => r.refresh());
    const n = W().strokes.length;
    count.textContent = n ? `${n} stroke${n === 1 ? '' : 's'} on this photo` : 'No Liquify strokes yet.';
    undoLast.disabled = clear.disabled = !n;
    if (W().faces) note.textContent = W().faces.length ? `${W().faces.length} face${W().faces.length === 1 ? '' : 's'} found.` : 'No faces found in this photo.';
  }
  refresh();
  return { el: el('div', { class: 'panel-view retouch' }, face.el, liq.el), refresh };
}
