// Tethered shooting (desktop app): the camera on a USB cable, the shutter fired from here (F12) or on the
// camera, each photo saved into a folder and opened in the editor as it lands. The Tether bar sits over
// the bottom of the photo: the camera and its state, the shutter, what each new photo gets (nothing,
// the previous photo's edit, or a preset), the number of shots, and where they're saved.
// The native side (src-tauri/src/tether) talks to the camera: ImageCaptureCore on macOS, libgphoto2 on
// Linux; it reports through "tether" events.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { el } from './util.js';
import { icon } from './icons.js';
import { popMenu } from './ui.js';
import { prefs, savePrefs } from './account.js';

const T = () => globalThis.__TAURI_INTERNALS__;
export const tetherSupported = () => !!T() && !/Android|iPhone|iPad/.test(navigator.userAgent);

// api: { app, importShot(entry) → photo entry, applyEdit(photo, mode, previous), presets() → [{ name }],
//        addToAlbum(photo, name), pickFolder() → path | null }
let api = null, bar = null, unlisten = null;
const state = {
  phase: 'looking',     // looking | choose | connecting | ready | busy | unavailable
  cameras: [], camera: null, canCapture: false,
  folder: '', note: '', shots: 0, pending: 0, previous: null,
};
const settings = () => ({ apply: 'previous', album: true, ...(prefs.tether || {}) });
const setSetting = (k, v) => { prefs.tether = { ...settings(), [k]: v }; savePrefs(); };
const short = (path) => (path || '').split(/[\\/]/).filter(Boolean).pop() || path;
const today = () => new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

async function listen(handler) {
  const t = T();
  const id = t.transformCallback((e) => handler(e.payload));
  const eventId = await t.invoke('plugin:event|listen', { event: 'tether', target: { kind: 'Any' }, handler: id });
  return () => t.invoke('plugin:event|unlisten', { event: 'tether', eventId }).catch(() => {});
}

export async function openTether(a) {
  api = a;
  if (!tetherSupported()) { api.app.toast('Tethered shooting needs the desktop app'); return; }
  if (!bar) build();
  bar.hidden = false;
  document.body.classList.add('tethering');
  if (unlisten) { paint(); return; }
  unlisten = await listen(onEvent);
  try {
    const info = await T().invoke('tether_start');
    state.folder = info.folder;
    if (!info.supported) { state.phase = 'unavailable'; state.note = info.missing; }
  } catch (err) { state.phase = 'unavailable'; state.note = String(err?.message || err); }
  paint();
}

export async function closeTether() {
  if (!bar) return;
  bar.hidden = true;
  document.body.classList.remove('tethering');
  if (state.camera) await T().invoke('tether_disconnect').catch(() => {});
}

export const tethering = () => !!bar && !bar.hidden;

export function capture() {
  if (!tethering() || state.phase !== 'ready' || !state.canCapture) return false;
  state.previous = api.app.images[api.app.cur] || null;
  state.phase = 'busy'; state.pending++;
  state.note = 'Taking a photo…';
  paint();
  T().invoke('tether_capture').catch((err) => onEvent({ kind: 'error', message: String(err?.message || err) }));
  // A camera that can't focus takes nothing: don't wait forever.
  clearTimeout(state.busyTimer);
  state.busyTimer = setTimeout(() => { if (state.phase === 'busy') { state.phase = 'ready'; state.pending = 0; state.note = 'No photo came back: check focus, or press the camera’s shutter'; paint(); } }, 15000);
  return true;
}

function connect(c) {
  state.camera = c; state.phase = 'connecting'; state.note = '';
  paint();
  T().invoke('tether_connect', { id: c.id }).catch((err) => onEvent({ kind: 'error', message: String(err?.message || err) }));
}

async function onEvent(ev) {
  switch (ev.kind) {
    case 'cameras':
      state.cameras = ev.cameras;
      if (state.camera && !ev.cameras.some((c) => c.id === state.camera.id) && state.phase !== 'connecting') state.camera = null;
      if (!state.camera || state.phase === 'looking' || state.phase === 'choose') {
        if (ev.cameras.length === 1) return connect(ev.cameras[0]);
        state.phase = ev.cameras.length ? 'choose' : 'looking';
      }
      break;
    case 'connected':
      state.camera = { id: ev.id, name: ev.name };
      state.canCapture = ev.canCapture;
      state.phase = 'ready';
      state.note = ev.canCapture ? '' : 'Take photos with the camera’s shutter button';
      break;
    case 'disconnected':
      if (state.camera?.id === ev.id || !state.camera) {
        state.camera = null; state.canCapture = false;
        state.phase = state.cameras.length > 1 ? 'choose' : 'looking';
        if (ev.reason) state.note = ev.reason;
      }
      break;
    case 'shot':
      if (state.phase !== 'busy') { state.previous ||= api.app.images[api.app.cur] || null; state.phase = 'busy'; }
      state.pending = Math.max(state.pending, 1);
      state.note = `Saving ${ev.name}…`;
      break;
    case 'photo': {
      clearTimeout(state.busyTimer);
      state.shots++;
      state.pending = Math.max(0, state.pending - 1);
      state.note = `${ev.name} · opened`;
      if (state.camera) state.phase = state.pending ? 'busy' : 'ready';
      paint();
      flash();
      const previous = state.previous;
      state.previous = null;
      try {
        const photo = await api.importShot(ev);
        if (photo) {
          const s = settings();
          if (s.apply && s.apply !== 'none') await api.applyEdit(photo, s.apply, previous);
          if (s.album) await api.addToAlbum(photo, `Tethered · ${today()}`);
        }
      } catch (err) { api.app.toast(`${ev.name} couldn’t be opened: ${err.message}`); }
      return;
    }
    case 'error':
      clearTimeout(state.busyTimer);
      if (state.phase === 'busy') state.phase = 'ready';
      if (state.phase === 'connecting') state.phase = state.cameras.length > 1 ? 'choose' : 'looking';
      state.pending = 0;
      state.note = '';
      api.app.toast(ev.message, { ms: 9000 });
      break;
  }
  paint();
}

// ------------------------------------------------------------------ the bar

const parts = {};
const isMac = /Mac/.test(navigator.platform || navigator.userAgent);
// libgphoto2's names read "Nikon DSC D5200": the camera's own name is "Nikon D5200".
const cameraName = (n) => (n || 'Camera').replace(/\bDSC\s+/i, '').trim();

function build() {
  parts.dot = el('span', { class: 'tether-glyph', 'aria-hidden': 'true' }, icon('camera'), el('span', { class: 'tether-dot' }));
  parts.name = el('button', { class: 'tether-name', type: 'button' });
  parts.sub = el('div', { class: 'tether-sub', 'aria-live': 'polite' });
  parts.shutter = el('button', { class: 'tether-shutter', type: 'button', title: 'Take a photo (F12)', 'aria-label': 'Take a photo (F12)' }, el('span', { class: 'tether-shutter-disc' }));
  parts.apply = el('button', { class: 'tether-chip', type: 'button', title: 'What each new photo gets' });
  parts.count = el('span', { class: 'tether-count', title: 'Photos this session' });
  parts.folder = el('button', { class: 'icon-btn sm', type: 'button', title: 'Choose where photos are saved', 'aria-label': 'Choose where photos are saved' }, icon('folder'));
  parts.close = el('button', { class: 'icon-btn sm', type: 'button', title: 'Stop tethering', 'aria-label': 'Stop tethering' }, icon('x'));

  parts.shutter.addEventListener('click', capture);
  parts.name.addEventListener('click', () => {
    if (state.cameras.length < 2 && state.camera) return;
    if (!state.cameras.length) return;
    popMenu(parts.name, state.cameras.map((c) => ({ label: cameraName(c.name), checked: state.camera?.id === c.id, onClick: () => connect(c) })));
  });
  parts.apply.addEventListener('click', () => {
    const s = settings();
    const presets = api.presets();
    popMenu(parts.apply, [
      { label: 'Nothing', checked: s.apply === 'none', onClick: () => { setSetting('apply', 'none'); paint(); } },
      { label: 'Same as the previous photo', checked: s.apply === 'previous', onClick: () => { setSetting('apply', 'previous'); paint(); } },
      ...(presets.length ? [{ sep: true }, ...presets.map((p) => ({ label: p.name, checked: s.apply === `preset:${p.name}`, onClick: () => { setSetting('apply', `preset:${p.name}`); paint(); } }))] : []),
      { sep: true },
      { label: `Add to the album “Tethered · ${today()}”`, checked: !!s.album, onClick: () => { setSetting('album', !s.album); paint(); } },
    ]);
  });
  parts.folder.addEventListener('click', async () => {
    const path = await api.pickFolder();
    if (!path) return;
    try { state.folder = await T().invoke('tether_folder', { path }); paint(); } catch (err) { api.app.toast(String(err?.message || err)); }
  });
  parts.close.addEventListener('click', closeTether);

  bar = el('div', { class: 'tether', role: 'toolbar', 'aria-label': 'Tethered shooting', hidden: true },
    el('div', { class: 'tether-cam' }, parts.dot, el('div', { class: 'tether-id' }, parts.name, parts.sub)),
    parts.shutter,
    el('div', { class: 'tether-side' },
      el('div', { class: 'tether-field' }, el('span', { class: 'tether-label' }, 'New photos'), parts.apply),
      el('div', { class: 'tether-field' }, el('span', { class: 'tether-label' }, 'Shots'), parts.count)),
    el('div', { class: 'tether-tools' }, parts.folder, parts.close));
  // The bar is over the photo: its clicks and scrolls are its own, not the viewer's (pan, zoom, pick).
  for (const t of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'dblclick']) bar.addEventListener(t, (e) => e.stopPropagation());
  // Before the first photo: what to do now, in the empty viewer's big type (over the photo it would hide).
  parts.hero = el('div', { class: 'empty tether-hero', 'aria-live': 'polite' });
  document.getElementById('viewer').append(parts.hero, bar);
}

function hero() {
  const { phase, camera } = state;
  const h = parts.hero;
  h.textContent = '';
  const title = (a, b) => el('h1', {}, a, ' ', el('em', {}, b));
  const card = el('div', { class: 'empty-card' }, el('span', { class: 'tether-hero-mark' }, icon('camera')));
  if (phase === 'unavailable') card.append(title('Tethering', 'unavailable'), el('p', {}, state.note));
  else if (phase === 'looking') card.append(title('Connect your', 'camera'), el('ol', { class: 'tether-steps' },
    el('li', {}, 'Plug it into this computer with its USB cable.'),
    el('li', {}, 'Switch it on. Rembrandt finds it by itself.'),
    el('li', {}, isMac ? 'If Image Capture or Photos opens, quit it: it holds the camera.' : 'If your file manager opens the camera, unmount it there: it holds the camera.')));
  else if (phase === 'choose') card.append(title('Choose a', 'camera'), el('div', { class: 'row-btns center' },
    ...state.cameras.map((c) => el('button', { class: 'btn', type: 'button', onclick: () => connect(c) }, icon('camera'), el('span', {}, cameraName(c.name))))));
  else if (phase === 'connecting') card.append(title('Connecting', '…'), el('p', {}, cameraName(camera?.name)));
  else if (phase === 'busy') card.append(title('Taking a', 'photo'), el('p', {}, state.note || 'It opens here in a moment.'));
  else card.append(title('Ready to', 'shoot'), el('p', {}, cameraName(camera?.name), ' · ',
    state.canCapture ? el('span', {}, 'press the shutter on the camera, or ', el('kbd', {}, 'F12')) : 'press the shutter on the camera'));
  h.append(card);
}

function applyLabel() {
  const a = settings().apply;
  return a === 'none' ? 'As shot' : a === 'previous' ? 'Previous edit' : a.startsWith('preset:') ? a.slice(7) : 'As shot';
}

function paint() {
  if (!bar) return;
  const { phase, camera } = state;
  bar.dataset.phase = phase;
  const many = state.cameras.length > 1;
  parts.name.textContent = '';
  parts.name.append(el('span', {}, phase === 'unavailable' ? 'Tethered shooting' : camera ? cameraName(camera.name) : phase === 'choose' ? 'Choose a camera' : 'Looking for a camera…'));
  if (many || phase === 'choose') parts.name.append(icon('chevron', 'i chev'));
  parts.name.disabled = !(many || phase === 'choose');
  parts.sub.textContent = phase === 'unavailable' ? state.note
    : phase === 'looking' ? (state.note || 'Searching on USB…')
    : phase === 'choose' ? `${state.cameras.length} cameras connected`
    : phase === 'connecting' ? 'Connecting…'
    : state.note || `Saving to ${short(state.folder)}`;
  parts.sub.title = state.folder ? `Photos are saved in ${state.folder}` : '';
  parts.shutter.disabled = phase !== 'ready' || !state.canCapture;
  parts.shutter.classList.toggle('busy', phase === 'busy');
  parts.apply.textContent = '';
  parts.apply.append(el('span', {}, applyLabel()), icon('chevron', 'i chev'));
  parts.count.textContent = String(state.shots);
  parts.folder.hidden = phase === 'unavailable';
  hero();
}

// A photo landed: the shutter glows and the view blinks, like a flash going off.
function flash() {
  const v = document.getElementById('viewer');
  for (const n of [bar, v]) { n.classList.remove('tether-flash'); void n.offsetWidth; n.classList.add('tether-flash'); }
}
