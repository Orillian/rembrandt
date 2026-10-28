// Export dialog and full-resolution rendering to JPEG / PNG / WebP.
import { isMobileApp } from './platform.js';
import { canSave, countSave, askToUnlock, isUnlocked, freeSavesLeft } from './unlock.js';
import { el, clamp } from './util.js';
import { segmented, slider, popMenu } from './ui.js';
import { withRecipe, recipeOf } from './recipe.js';
import { withMetadata, srgbProfile } from './exif.js';
import { HEADROOM, gainMap, ultraHdr } from './hdr.js';
import { prefs, savePrefs } from './account.js';
import { beforeAfterPage } from './beforeafter.js';
import { recordReplay, replaySupported } from './replay.js';
import { icon } from './icons.js';
import { DESTINATIONS, destination, deliver } from './export-dest.js';
import { track } from './feedback.js';
import { credentialsSupported, manifestFor, withCredentials } from './credentials.js';

const FORMATS = { jpeg: ['image/jpeg', '.jpg'], png: ['image/png', '.png'], webp: ['image/webp', '.webp'], tiff: ['image/tiff', '.tif'] };
const SIZES = [
  { value: 0, label: 'Full' }, { value: 3840, label: '3840' }, { value: 2048, label: '2048' }, { value: 1080, label: '1080' },
];
const OPTS_KEY = 'lumen:export';
const opts = (() => {
  const d = { format: 'jpeg', quality: 92, long: 0, suffix: '-edit', dest: 'device', recipe: false };
  try { return { ...d, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return d; }
})();
export const exportDefaults = opts;
export function saveExportDefaults() {
  try { localStorage.setItem(OPTS_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
}
export const FORMAT_EXT = { jpeg: '.jpg', png: '.png', webp: '.webp', tiff: '.tif' };

// Export presets: named export settings, the built-in ones and yours (prefs.exportPresets).
const PRESET_KEYS = ['format', 'quality', 'long', 'suffix', 'dest', 'recipe', 'tiffBits', 'hdr', 'watermark', 'credentials'];
export const BUILTIN_EXPORT_PRESETS = [
  { name: 'Full size JPEG', builtin: true, opts: { format: 'jpeg', quality: 92, long: 0, suffix: '-edit', recipe: false, watermark: false } },
  { name: 'Instagram (1080 px)', builtin: true, opts: { format: 'jpeg', quality: 90, long: 1080, suffix: '-ig', recipe: false } },
  { name: 'Web (2048 px)', builtin: true, opts: { format: 'jpeg', quality: 85, long: 2048, suffix: '-web' } },
  { name: 'Print (16-bit TIFF)', builtin: true, opts: { format: 'tiff', tiffBits: 16, long: 0, suffix: '-print', recipe: false, watermark: false } },
];
export const exportPresets = () => [...BUILTIN_EXPORT_PRESETS, ...(prefs.exportPresets || [])];
const presetOf = (o) => Object.fromEntries(PRESET_KEYS.map((k) => [k, k === 'watermark' ? !!prefs.watermark?.on : o[k]]).filter(([, v]) => v !== undefined));

const doneMessage = (d, n) => {
  const what = `${n} photo${n === 1 ? '' : 's'}`;
  if (d.id === 'device') return isMobileApp ? `Saved ${what} to Photos` : `Exported ${what}`;
  if (d.id === 'folder') return `Saved ${what} to the folder`;
  if (d.id === 'photos') return isMobileApp ? `Shared ${what}` : window.__TAURI_INTERNALS__ ? `Added ${what} to Photos` : `Shared ${what}`;
  return `Uploaded ${what} to ${d.name}`;
};

function resizeCanvas(src, w, h) {
  let cur = src;
  while (cur.width / 2 >= w * 1.2) {
    const t = el('canvas', { width: Math.round(cur.width / 2), height: Math.round(cur.height / 2) });
    const c = t.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(cur, 0, 0, t.width, t.height);
    cur = t;
  }
  const out = el('canvas', { width: w, height: h });
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

// Your name or copyright in a corner (Settings › Export › Watermark).
export const WATERMARK = { on: false, text: '', pos: 'br', size: 3, opacity: 70 };
export const watermarkText = () => (prefs.watermark?.text || prefs.copyright || prefs.artist || '').trim();
export function drawWatermark(canvas, wm = { ...WATERMARK, ...prefs.watermark }) {
  const text = watermarkText();
  if (!wm.on || !text) return;
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const px = Math.max(10, Math.round(Math.min(W, H) * wm.size / 100)), pad = Math.round(px * 1.1);
  ctx.save();
  ctx.font = `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.globalAlpha = wm.opacity / 100;
  ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = px * 0.25;
  ctx.textBaseline = wm.pos[0] === 't' ? 'top' : wm.pos === 'c' ? 'middle' : 'bottom';
  ctx.textAlign = wm.pos === 'c' ? 'center' : wm.pos[1] === 'l' ? 'left' : 'right';
  const x = wm.pos === 'c' ? W / 2 : wm.pos[1] === 'l' ? pad : W - pad;
  const y = wm.pos === 'c' ? H / 2 : wm.pos[0] === 't' ? pad : H - pad;
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Baseline RGB TIFF, Deflate-compressed, with the sRGB profile, for handing a photo to Photoshop or
// a print lab. `rgb`: interleaved samples, Uint8Array (8-bit) or Uint16Array (16-bit).
export async function encodeTiff(rgb, W, H) {
  const bits = rgb.BYTES_PER_ELEMENT * 8;
  const bytes = new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);   // little-endian, as the header says
  const data = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const icc = srgbProfile();
  // Header, then the IFD (11 entries), then BitsPerSample, the profile and the pixels.
  const n = 11, ifd = 8, bps = ifd + 2 + n * 12 + 4, iccAt = bps + 6, dataAt = iccAt + icc.length + (icc.length & 1);
  const out = new Uint8Array(dataAt + data.length), dv = new DataView(out.buffer);
  out.set([0x49, 0x49, 42, 0]); dv.setUint32(4, ifd, true);
  dv.setUint16(ifd, n, true);
  const tags = [
    [256, 4, 1, W], [257, 4, 1, H], [258, 3, 3, bps], [259, 3, 1, 8], [262, 3, 1, 2], [273, 4, 1, dataAt],
    [277, 3, 1, 3], [278, 4, 1, H], [279, 4, 1, data.length], [284, 3, 1, 1], [34675, 7, icc.length, iccAt],
  ];
  tags.forEach(([tag, type, count, v], k) => {
    const o = ifd + 2 + k * 12;
    dv.setUint16(o, tag, true); dv.setUint16(o + 2, type, true); dv.setUint32(o + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(o + 8, v, true); else dv.setUint32(o + 8, v, true);
  });
  for (let c = 0; c < 3; c++) dv.setUint16(bps + c * 2, bits, true);
  out.set(icc, iccAt);
  out.set(data, dataAt);
  return new Blob([out], { type: 'image/tiff' });
}
const canvasRGB = (canvas) => {
  const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data, rgb = new Uint8Array(canvas.width * canvas.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2]; }
  return rgb;
};

// Area-average downscale of float RGBA (each output pixel averages the source pixels it covers).
function shrinkFloat(src, w, h, W, H) {
  const out = new Float32Array(W * H * 4), sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const i = (yy * w + xx) * 4; r += src[i]; g += src[i + 1]; b += src[i + 2]; }
      const k = 1 / ((y1 - y0) * (x1 - x0)), o = (y * W + x) * 4;
      out[o] = r * k; out[o + 1] = g * k; out[o + 2] = b * k; out[o + 3] = 1;
    }
  }
  return out;
}

// 16-bit TIFF: the final pass read back as floats, so nothing is rounded to 8 bits on the way.
async function renderTiff16(app, long, p, mats) {
  const { crop } = p.geometry, E = app.engine;
  const nativeW = Math.round(crop.w * E.fullH), nativeH = Math.round(crop.h * E.fullH);
  const k = long ? Math.min(1, long / Math.max(nativeW, nativeH)) : 1;
  const outW = Math.max(1, Math.round(nativeW * k)), outH = Math.max(1, Math.round(nativeH * k));
  const res = await E.exportPixels(p, crop.w, crop.h, outH, (w, h) => mats(p, w, h), { float: true });
  let px = res.pixels, w = res.w, h = res.h;
  if (w !== outW || h !== outH) { px = shrinkFloat(px, w, h, outW, outH); w = outW; h = outH; }
  // The watermark is drawn on a transparent layer and blended in.
  const wm = el('canvas', { width: w, height: h });
  drawWatermark(wm);
  const a8 = prefs.watermark?.on && watermarkText() ? wm.getContext('2d').getImageData(0, 0, w, h).data : null;
  const rgb = new Uint16Array(w * h * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    for (let c = 0; c < 3; c++) {
      let v = px[i + c];
      if (a8 && a8[i + 3]) { const a = a8[i + 3] / 255; v = v * (1 - a) + (a8[i + c] / 255) * a; }
      rgb[j + c] = Math.round(Math.min(1, Math.max(0, v)) * 65535);
    }
  }
  return { blob: await encodeTiff(rgb, w, h), w, h };
}

// The edited photo at full resolution (`long`: at most this many pixels on its long edge), as ImageData.
export async function renderPixels(app, { long = 0 } = {}, p = app.params, mats = (pp, w, h) => app.outputMats(pp, w, h)) {
  const { crop } = p.geometry;
  const E = app.engine;
  const nativeW = Math.round(crop.w * E.fullH), nativeH = Math.round(crop.h * E.fullH);
  const k = long ? Math.min(1, long / Math.max(nativeW, nativeH)) : 1;
  const outW = Math.max(1, Math.round(nativeW * k)), outH = Math.max(1, Math.round(nativeH * k));
  const res = await E.exportPixels(p, crop.w, crop.h, outH, (w, h) => mats(p, w, h));
  return { image: new ImageData(new Uint8ClampedArray(res.pixels.buffer), res.w, res.h), outW, outH };
}

// Renders `p` (default: the photo being edited) with the engine's current image.
export async function renderExport(app, opts, p = app.params, mats = (pp, w, h) => app.outputMats(pp, w, h)) {
  const r = await renderEncoded(app, opts, p, mats);
  // Content Credentials last: the signature covers the finished file.
  if (opts.credentials && credentialsSupported() && opts.format !== 'tiff') {
    const mime = FORMATS[opts.format][0];
    const original = opts.original || app.images?.[app.cur]?.name || 'photo';
    r.blob = await withCredentials(r.blob, mime, manifestFor(p, { title: original.replace(/\.[^.]+$/, '') + FORMATS[opts.format][1], original, version: window.LUMEN_BUILD?.version || 'dev' }));
  }
  return r;
}
async function renderEncoded(app, { format, quality, long, recipe, meta, tiffBits, hdr }, p, mats) {
  track('export', hdr ? `${format}-hdr` : format);
  if (format === 'tiff' && tiffBits !== 8) return renderTiff16(app, long, p, mats);
  const { image, outW, outH } = await renderPixels(app, { long }, p, mats);
  let canvas = el('canvas', { width: image.width, height: image.height });
  canvas.getContext('2d').putImageData(image, 0, 0);
  if (image.width !== outW || image.height !== outH) canvas = resizeCanvas(canvas, outW, outH);
  drawWatermark(canvas);
  const [mime] = FORMATS[format];
  if (format === 'tiff') return { blob: await encodeTiff(canvasRGB(canvas), canvas.width, canvas.height), w: canvas.width, h: canvas.height };
  let blob = await new Promise((r) => canvas.toBlob(r, mime, clamp(quality, 1, 100) / 100));
  if (!blob) throw new Error('The browser could not encode this format.');
  // Camera details, your name and copyright, and the sRGB profile (Settings › Export), then the recipe.
  const by = { artist: (prefs.artist || '').trim(), copyright: (prefs.copyright || '').trim() };
  blob = await withMetadata(blob, { meta: meta === undefined ? app.images?.[app.cur]?.meta : meta, ...by, exif: prefs.exportExif !== false, w: canvas.width, h: canvas.height });
  if (recipe) blob = await withRecipe(blob, recipeOf(p), canvas.width, canvas.height);
  // HDR (JPEG): the same edit HEADROOM stops darker gives the highlights' detail for the gain map.
  if (hdr && format === 'jpeg') {
    const dark = (await renderPixels(app, { long }, { ...p, exposure: (p.exposure || 0) - HEADROOM }, mats)).image;
    const g = gainMap(image.data, dark.data, image.width, image.height);
    const gc = el('canvas', { width: g.w, height: g.h }), id = new ImageData(g.w, g.h);
    for (let i = 0; i < g.data.length; i++) { const v = g.data[i]; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
    gc.getContext('2d').putImageData(id, 0, 0);
    const gj = await new Promise((r) => gc.toBlob(r, 'image/jpeg', 0.9));
    blob = new Blob([ultraHdr(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(await gj.arrayBuffer()))], { type: 'image/jpeg' });
  }
  return { blob, w: canvas.width, h: canvas.height };
}

// Export dialog. With `ids` (library selection) it exports several photos; `renderPhoto(id, opts)`
// renders one of them and resolves {blob, name}. One file is saved directly, several go into a ZIP.
export function openExport(app, ids = null, renderPhoto = null) {
  const batch = ids && ids.length > 0 && renderPhoto;
  if (!batch && !app.img) return;
  const dlg = document.getElementById('exportDialog');
  dlg.textContent = '';
  const n = batch ? ids.length : 1;
  const base = batch ? '' : app.img.name.replace(/\.[^.]+$/, '');
  const name = el('input', { class: 'text-input', value: batch ? opts.suffix : `${base}${opts.suffix}`, spellcheck: 'false' });
  const dims = el('div', { class: 'export-dims' });
  const E = app.engine;
  const custom = el('input', { class: 'text-input narrow', type: 'number', min: 64, max: 20000, placeholder: 'px' });

  function update() {
    if (batch) dims.textContent = opts.long ? `Long edge up to ${opts.long} px` : 'Full resolution';
    else {
      const { crop } = app.params.geometry;
      const nativeW = Math.round(crop.w * E.fullH), nativeH = Math.round(crop.h * E.fullH);
      const k = opts.long ? Math.min(1, opts.long / Math.max(nativeW, nativeH)) : 1;
      dims.textContent = `${Math.round(nativeW * k)} × ${Math.round(nativeH * k)} px`;
    }
    const special = opts.format === 'compare' || opts.format === 'replay';
    // A chip names a choice made in the ⋯ menu, so it's never hidden state.
    chip.textContent = [SPECIAL[opts.format], opts.recipe && opts.format !== 'replay' ? 'with recipe' : '', prefs.watermark?.on && watermarkText() && opts.format !== 'replay' ? 'watermark' : '', opts.format === 'tiff' ? `${opts.tiffBits === 8 ? 8 : 16}-bit` : '', opts.format === 'jpeg' && opts.hdr ? 'HDR' : '', opts.credentials && credentialsSupported() && FORMAT_EXT[opts.format] && opts.format !== 'tiff' ? 'Content Credentials' : ''].filter(Boolean).join(' · ');
    chip.hidden = !chip.textContent;
    q.el.style.display = opts.format === 'png' || opts.format === 'tiff' || special ? 'none' : '';
    size.el.closest('.field').style.display = opts.format === 'replay' ? 'none' : '';
    if (opts.format === 'compare') dims.textContent = 'A web page with the original and the edit, and a slider between them. Opens in any browser; nothing to upload.';
    if (opts.format === 'replay') dims.textContent = 'A short video of the photo developing, one step of the edit at a time, each named on screen. It plays as it records, so keep this window open.';
  }
  if ((batch || (opts.format === 'replay' && !replaySupported())) && !FORMAT_EXT[opts.format]) opts.format = 'jpeg';
  const fmt = segmented([{ value: 'jpeg', label: 'JPEG' }, { value: 'png', label: 'PNG' }, { value: 'webp', label: 'WebP' }, { value: 'tiff', label: 'TIFF' }], opts.format, (v) => { opts.format = v; update(); });
  // Less common outputs and the recipe option sit behind one ⋯ so the dialog stays short.
  const SPECIAL = { compare: 'Before/after page', replay: 'Replay video' };
  const extras = el('button', { class: 'icon-btn sm', type: 'button', title: 'More formats and options', 'aria-label': 'More formats and options' }, icon('more'));
  extras.addEventListener('click', () => popMenu(extras, [
    ...(batch ? [] : [
      { label: 'Before/after page (HTML)', checked: opts.format === 'compare', onClick: () => { opts.format = 'compare'; fmt.set(null); update(); } },
      replaySupported() ? { label: 'Replay video', checked: opts.format === 'replay', onClick: () => { opts.format = 'replay'; fmt.set(null); update(); } } : null,
      { sep: true },
    ]),
    opts.format === 'tiff' ? { label: '16 bits per channel', checked: opts.tiffBits !== 8, onClick: () => { opts.tiffBits = opts.tiffBits === 8 ? 16 : 8; update(); } } : null,
    opts.format === 'jpeg' ? { label: 'HDR (brighter highlights on HDR screens)', checked: !!opts.hdr, onClick: () => { opts.hdr = !opts.hdr; update(); } } : null,
    { label: 'Include how it was edited', checked: !!opts.recipe, onClick: () => { opts.recipe = !opts.recipe; update(); } },
    credentialsSupported() && opts.format !== 'tiff' ? { label: 'Content Credentials (a signed record of the edits)', checked: !!opts.credentials, onClick: () => { opts.credentials = !opts.credentials; update(); } } : null,
    { label: watermarkText() ? `Watermark “${watermarkText()}”` : 'Watermark (set it up in Settings)', checked: !!prefs.watermark?.on, onClick: () => {
      if (!watermarkText()) { status.textContent = 'Add your name, copyright or a watermark text in Settings › Preferences › Export first.'; return; }
      prefs.watermark = { ...WATERMARK, ...prefs.watermark, on: !prefs.watermark?.on }; savePrefs(); update();
    } },
  ]));
  const chip = el('span', { class: 'export-chip' });
  const size = segmented(SIZES, SIZES.some((s) => s.value === opts.long) ? opts.long : -1, (v) => { opts.long = v; custom.value = ''; update(); });
  if (!SIZES.some((s) => s.value === opts.long)) custom.value = opts.long;
  custom.addEventListener('input', () => { const v = parseInt(custom.value, 10); if (v >= 64) { opts.long = v; size.set(-1); update(); } });
  custom.addEventListener('keydown', (e) => e.stopPropagation());
  name.addEventListener('keydown', (e) => e.stopPropagation());
  const q = slider({ label: 'Quality', min: 40, max: 100, def: 92, get: () => opts.quality, set: (v) => { opts.quality = v; } });

  // Presets: picking one sets everything below; Save keeps the current settings under a name.
  const presetSel = el('select', { class: 'text-input', 'aria-label': 'Export preset' });
  const presetName = el('input', { class: 'text-input', type: 'text', placeholder: 'Preset name', hidden: true, 'aria-label': 'Preset name' });
  const presetSave = el('button', { class: 'btn sm', type: 'button', hidden: true }, 'Save');
  const presetDel = el('button', { class: 'icon-btn sm', type: 'button', title: 'Delete this preset', 'aria-label': 'Delete this preset', hidden: true }, icon('trash'));
  const paintPresets = (sel = '') => {
    presetSel.replaceChildren(el('option', { value: '' }, 'Choose a preset…'),
      ...exportPresets().map((p) => el('option', { value: p.name, selected: p.name === sel }, p.name)),
      el('option', { value: '+' }, 'Save current settings as a preset…'));
    presetDel.hidden = !sel || !!exportPresets().find((p) => p.name === sel)?.builtin;
  };
  const applyPreset = (p) => {
    const o = p.opts;
    for (const k of PRESET_KEYS) if (k !== 'watermark' && o[k] !== undefined) opts[k] = o[k];
    if (o.watermark !== undefined && (!o.watermark || watermarkText())) prefs.watermark = { ...WATERMARK, ...prefs.watermark, on: !!o.watermark };
    if (!destination(opts.dest).ready()) opts.dest = 'device';
    fmt.set(FORMAT_EXT[opts.format] ? opts.format : null);
    size.set(SIZES.some((s) => s.value === opts.long) ? opts.long : -1);
    custom.value = SIZES.some((s) => s.value === opts.long) ? '' : opts.long;
    q.refresh();
    if (o.suffix !== undefined) name.value = batch ? opts.suffix : `${base}${opts.suffix}`;
    update(); paintDest();
  };
  presetSel.addEventListener('change', () => {
    const v = presetSel.value;
    if (v === '+') { presetSel.hidden = true; presetName.hidden = presetSave.hidden = false; presetName.focus(); return; }
    const p = exportPresets().find((x) => x.name === v);
    if (p) applyPreset(p);
    presetDel.hidden = !p || !!p.builtin;
  });
  const endSave = (keep) => {
    const nm = presetName.value.trim();
    if (keep && nm) {
      if (!batch) { const n0 = name.value.trim(); if (n0.startsWith(base)) opts.suffix = n0.slice(base.length); } else opts.suffix = name.value;
      prefs.exportPresets = [...(prefs.exportPresets || []).filter((p) => p.name !== nm), { name: nm, opts: presetOf(opts) }];
      savePrefs();
      status.textContent = `Saved the preset “${nm}”`; status.className = 'export-status';
    }
    presetName.value = ''; presetName.hidden = presetSave.hidden = true; presetSel.hidden = false;
    paintPresets(keep && nm ? nm : '');
  };
  presetSave.addEventListener('click', () => endSave(true));
  presetName.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') endSave(true); else if (e.key === 'Escape') { e.preventDefault(); endSave(false); } });
  presetDel.addEventListener('click', () => {
    prefs.exportPresets = (prefs.exportPresets || []).filter((p) => p.name !== presetSel.value);
    savePrefs(); paintPresets('');
  });
  paintPresets();

  // Where the photos go.
  if (!destination(opts.dest).ready()) opts.dest = 'device';
  const destBtn = el('button', { class: 'btn dest-btn', type: 'button' });
  const destHint = el('div', { class: 'hint' });
  const paintDest = () => {
    const d = destination(opts.dest);
    destBtn.replaceChildren(icon(d.icon), el('span', {}, d.name), icon('chevron', 'i chev'));
    destHint.textContent = d.hint || (d.id === 'device' ? (batch && n > 1 ? 'Photos are rendered at full quality one by one and saved together as a ZIP file.' : (prefs.exportExif !== false ? 'Full resolution, with the camera details, your name and copyright (Settings › Export) and an sRGB colour profile. Location is never included.' : 'Full resolution, with an sRGB colour profile. Camera details are off (Settings › Export).')) : `Each photo is uploaded to ${d.name}${['dropbox', 'onedrive', 'gdrive'].includes(d.id) ? ' in a “Rembrandt” folder' : ''}.`);
    go.textContent = d.id === 'device' ? (batch ? `Export ${n}` : 'Export') : d.id === 'folder' ? 'Choose folder & save' : `Send to ${d.name.replace(/ \(.*\)$/, '')}`;
  };
  destBtn.addEventListener('click', () => popMenu(destBtn, DESTINATIONS.map((d) => ({
    label: d.ready() ? d.name : `${d.name} · available at launch`,
    icon: d.icon,
    checked: undefined,
    onClick: () => {
      if (!d.ready()) { status.textContent = `${d.name} isn’t set up yet${window.__TAURI_INTERNALS__ && ['gphotos', 'gdrive', 'dropbox', 'onedrive'].includes(d.id) ? '. In the desktop app, save into its folder on this computer instead.' : '.'}`; status.className = 'export-status'; return; }
      opts.dest = d.id; saveExportDefaults(); paintDest();
    },
  }))));

  const status = el('div', { class: 'export-status' });
  const bar = el('div', { class: 'progress', hidden: true }, el('span'));
  const go = el('button', { class: 'btn primary', type: 'button' }, batch ? `Export ${n}` : 'Export');
  let cancelled = false;
  const cancel = el('button', { class: 'btn ghost', type: 'button', onclick: () => { cancelled = true; dlg.close(); } }, 'Cancel');
  go.addEventListener('click', async () => {
    // Phone app: saving needs the one-time unlock after the free saves are used.
    if (!canSave(n) && !(await askToUnlock(app))) return;
    go.disabled = true;
    cancelled = false;
    status.className = 'export-status busy';
    saveExportDefaults();
    try {
      await new Promise((r) => setTimeout(r, 30));
      const ext = FORMAT_EXT[opts.format];
      const progress = (t) => { status.textContent = t; };
      if (!batch && opts.format === 'replay') {
        const { blob, ext: vext } = await recordReplay(app, { onProgress: (t) => { status.textContent = t; } });
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + '-replay' + vext, blob }], progress);
        app.toast(d.id === 'device' && !isMobileApp ? `Saved the replay · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else if (!batch && opts.format === 'compare') {
        status.textContent = 'Rendering before and after…';
        const blob = await beforeAfterPage(app, { title: name.value.trim() || base, recipe: opts.recipe, long: Math.min(opts.long || 2560, 2560) });
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + '-before-after.html', blob }], progress);
        app.toast(d.id === 'device' && !isMobileApp ? `Saved a before/after page · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else if (!batch) {
        status.textContent = 'Rendering at full resolution…';
        const { blob, w, h } = await renderExport(app, opts);
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, [{ name: (name.value.trim() || base) + ext, blob }], progress);
        countSave();
        app.toast(d.id === 'device' && !isMobileApp ? `Exported ${w} × ${h} · ${(blob.size / 1048576).toFixed(1)} MB` : doneMessage(d, 1));
      } else {
        opts.suffix = name.value;
        saveExportDefaults();
        bar.hidden = false;
        const files = [];
        for (let i = 0; i < ids.length; i++) {
          if (cancelled) return;
          status.textContent = `Rendering ${i + 1} of ${ids.length}…`;
          bar.firstChild.style.width = `${(i / ids.length) * 100}%`;
          const r = await renderPhoto(ids[i], opts);
          if (r) files.push({ name: r.base + opts.suffix + ext, blob: r.blob });
        }
        bar.firstChild.style.width = '100%';
        if (!files.length) throw new Error('Nothing could be exported (originals missing?)');
        status.textContent = 'Saving…';
        const d = await deliver(opts.dest, files, progress);
        app.toast(doneMessage(d, files.length));
      }
      dlg.close();
    } catch (err) {
      if (err?.code === 'declined') {
        status.textContent = 'Save cancelled.';
        status.className = 'export-status';
        return;
      }
      console.error(err);
      status.textContent = `Export failed: ${err.message}`;
      status.className = 'export-status error';
    } finally {
      go.disabled = false;
      app.requestRender();
    }
  });

  dlg.append(
    el('div', { class: 'dlg-head' }, el('h2', {}, batch ? `Export ${n} photo${n > 1 ? 's' : ''}` : 'Export photo')),
    el('div', { class: 'dlg-body' },
      el('div', { class: 'field' }, el('span', {}, 'Preset'), el('div', { class: 'row export-presets' }, presetSel, presetName, presetSave, presetDel)),
      el('label', { class: 'field' }, el('span', {}, batch ? 'Add to file names' : 'File name'), name),
      el('div', { class: 'field' }, el('span', {}, 'Format'), el('div', { class: 'row' }, fmt.el, chip, extras)),
      q.el,
      el('div', { class: 'field' }, el('span', {}, 'Long edge'), el('div', { class: 'row' }, size.el, custom)),
      dims,
      el('div', { class: 'field' }, el('span', {}, 'Save to'), destBtn),
      destHint,
      bar,
      status,
    ),
    el('div', { class: 'dlg-foot' }, cancel, go),
  );
  update();
  paintDest();
  if (isMobileApp && !isUnlocked()) {
    const left = freeSavesLeft();
    status.textContent = left ? `${left} free save${left === 1 ? '' : 's'} left. Unlock Rembrandt once for unlimited saving.` : 'Saving and sharing need the one-time unlock.';
  }
  dlg.showModal();
}
