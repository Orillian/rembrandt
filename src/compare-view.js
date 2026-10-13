// Compare (like Lightroom's): two to four photos side by side for culling, with zoom and pan linked,
// so you can check focus and eyes at the same spot in every frame. Shows each photo's full-size
// preview (for RAWs, the camera's embedded JPEG). Keys: ← → choose, P / X / U flag, Z zoom, Esc close.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el, clamp } from './util.js';
import { icon } from './icons.js';

const MAX_PX = 3000;   // ponytail: previews capped at 3000 px on the long edge; full RAW decode if pixel-peeping needs more

// `entries`: library entries; `api`: { loadBitmap(entry) → ImageBitmap, setFlag(ids, flag) }.
export function openCompare(entries, api) {
  entries = entries.slice(0, 4);
  // Shared view: zoom 0 = fit, else display px per photo px; (cx, cy) the photo point at the cell centre, 0–1.
  const view = { zoom: 0, cx: 0.5, cy: 0.5 };
  let active = 0;
  const cells = entries.map((e) => {
    const cv = el('canvas', { class: 'cmpv-photo' });
    const flag = el('span', { class: 'cmpv-flag' });
    const cell = el('div', { class: 'cmpv-cell' }, el('div', { class: 'cmpv-frame' }, cv, el('div', { class: 'cmpv-loading' }, 'Loading…')),
      el('div', { class: 'cmpv-foot' }, el('span', { class: 'cmpv-name' }, e.name), flag,
        el('button', { class: 'icon-btn sm', title: 'Pick (P)', onclick: () => setFlag(entries.indexOf(e), 1) }, icon('check')),
        el('button', { class: 'icon-btn sm', title: 'Reject (X)', onclick: () => setFlag(entries.indexOf(e), -1) }, icon('x'))));
    cell.addEventListener('pointerdown', () => select(entries.indexOf(e)));
    return { e, cv, cell, flag, w: 0, h: 0 };
  });
  const root = el('div', { class: 'cmpv', role: 'dialog', 'aria-label': 'Compare photos', tabindex: -1 },
    el('div', { class: 'cmpv-bar' }, el('span', {}, `Compare · ${entries.length} photos`), el('span', { class: 'grow' }),
      el('span', { class: 'hint' }, 'Click to zoom to 100% · drag to pan · ← → choose · P / X flag · Esc close'),
      el('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: close }, icon('x'))),
    el('div', { class: 'cmpv-grid', style: { gridTemplateColumns: `repeat(${entries.length}, 1fr)` } }, cells.map((c) => c.cell)));
  document.body.append(root);
  root.focus();

  const paintFlags = () => cells.forEach((c, i) => {
    c.flag.textContent = c.e.flag === 1 ? 'Pick' : c.e.flag === -1 ? 'Rejected' : '';
    c.flag.className = 'cmpv-flag' + (c.e.flag === 1 ? ' pick' : c.e.flag === -1 ? ' reject' : '');
    c.cell.classList.toggle('on', i === active);
  });
  function select(i) { active = clamp(i, 0, cells.length - 1); paintFlags(); }
  function setFlag(i, f) { const e = cells[i].e; api.setFlag([e.id], e.flag === f ? 0 : f); paintFlags(); }

  // Each photo: the same photo point at the cell centre, at the same zoom (fit is per photo).
  function layout() {
    for (const c of cells) {
      if (!c.w) continue;
      const r = c.cv.parentElement.getBoundingClientRect();
      const fit = Math.min(r.width / c.w, r.height / c.h);
      const s = view.zoom || fit, cx = view.zoom ? view.cx : 0.5, cy = view.zoom ? view.cy : 0.5;
      c.cv.style.transform = `translate(${r.width / 2 - cx * c.w * s}px, ${r.height / 2 - cy * c.h * s}px) scale(${s})`;
    }
  }
  const ro = new ResizeObserver(layout);
  ro.observe(root);

  // Click: 100% at that point (or back to fit); drag: pan all; wheel: zoom all.
  let drag = null;
  root.addEventListener('pointerdown', (ev) => {
    const c = cells.find((x) => x.cv.parentElement.contains(ev.target));
    if (!c || !c.w) return;
    drag = { x: ev.clientX, y: ev.clientY, cx: view.cx, cy: view.cy, c, moved: false };
    root.setPointerCapture(ev.pointerId);
  });
  root.addEventListener('pointermove', (ev) => {
    if (!drag || !view.zoom) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (Math.hypot(dx, dy) > 3) drag.moved = true;
    view.cx = clamp(drag.cx - dx / (drag.c.w * view.zoom), 0, 1);
    view.cy = clamp(drag.cy - dy / (drag.c.h * view.zoom), 0, 1);
    layout();
  });
  root.addEventListener('pointerup', (ev) => {
    if (drag && !drag.moved) {
      if (view.zoom) view.zoom = 0;
      else {
        const r = drag.c.cv.getBoundingClientRect();   // the canvas box, transformed
        view.cx = clamp((ev.clientX - r.left) / r.width, 0, 1);
        view.cy = clamp((ev.clientY - r.top) / r.height, 0, 1);
        view.zoom = 1;
      }
      layout();
    }
    drag = null;
  });
  root.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const c = cells.find((x) => x.w);
    if (!c) return;
    const r = c.cv.parentElement.getBoundingClientRect(), fit = Math.min(r.width / c.w, r.height / c.h);
    const z = (view.zoom || fit) * Math.exp(-ev.deltaY * 0.0015);
    view.zoom = z <= fit * 1.02 ? 0 : Math.min(z, 4);
    layout();
  }, { passive: false });

  root.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const k = ev.key.toLowerCase();
    if (k === 'escape') close();
    else if (k === 'arrowright') select(active + 1);
    else if (k === 'arrowleft') select(active - 1);
    else if (k === 'p') setFlag(active, 1);
    else if (k === 'x') setFlag(active, -1);
    else if (k === 'u') { api.setFlag([cells[active].e.id], 0); paintFlags(); }
    else if (k === 'z') { view.zoom = view.zoom ? 0 : 1; layout(); }
    else return;
    ev.preventDefault();
  });

  function close() {
    ro.disconnect();
    root.remove();
  }

  paintFlags();
  // Load the previews one by one (each can be a large decode).
  (async () => {
    for (const c of cells) {
      try {
        const bm = await api.loadBitmap(c.e);
        if (!root.isConnected) { bm?.close?.(); return; }
        const k = Math.min(1, MAX_PX / Math.max(bm.width, bm.height));
        c.w = Math.round(bm.width * k); c.h = Math.round(bm.height * k);
        Object.assign(c.cv, { width: c.w, height: c.h });
        const ctx = c.cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bm, 0, 0, c.w, c.h);
        bm.close?.();
        c.cv.nextSibling.remove();
        layout();
      } catch (err) {
        c.cv.nextSibling.textContent = `Couldn’t open: ${err.message}`;
      }
    }
  })();
  return { close };
}
