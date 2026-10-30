// Decodes image files. Standard formats use the browser decoder; camera RAW files open through the
// full-size JPEG the camera embeds in every RAW (with the RAW's orientation applied).

import { RAW_EV } from '../engine/src/color.js';

export const RAW_EXT = new Set([
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl',
  'pef', 'srw', 'x3f', '3fr', 'iiq', 'erf', 'kdc', 'mos', 'mrw', 'dcr', 'mef', 'raw',
]);

export const ACCEPT = 'image/*,' + [...RAW_EXT].map((e) => '.' + e).join(',');

const ext = (name) => (name.split('.').pop() || '').toLowerCase();

// `screen`: the size the editor shows the photo at, for a faster first look at RAWs (desktop app).
export async function decodeFile(file, { screen = 0 } = {}) {
  if (RAW_EXT.has(ext(file.name))) return decodeRaw(file, { screen });
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none' });
    return { bitmap, kind: file.type.replace('image/', '').toUpperCase() || ext(file.name).toUpperCase() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { bitmap: await createImageBitmap(img), kind: ext(file.name).toUpperCase() };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

// ------------------------------------------------------------------ RAW

function tiffOrientation(u8) {
  if (u8.length < 16) return 0;
  const le = u8[0] === 0x49 && u8[1] === 0x49;
  const be = u8[0] === 0x4d && u8[1] === 0x4d;
  if (!le && !be) return 0;
  const r16 = (o) => (le ? u8[o] | (u8[o + 1] << 8) : (u8[o] << 8) | u8[o + 1]);
  const r32 = (o) => (le ? (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0 : ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0);
  const ifd = r32(4);
  if (ifd + 2 > u8.length) return 0;
  const n = r16(ifd);
  for (let i = 0; i < n && i < 500; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > u8.length) break;
    if (r16(e) === 0x0112) return r16(e + 8);
  }
  return 0;
}

// Walk JPEG markers from an SOI to find frame size and the end of the stream.
function probeJpeg(u8, off) {
  let pos = off + 2;
  let w = 0, h = 0, sof = 0;
  for (let guard = 0; guard < 400 && pos + 4 < u8.length; guard++) {
    if (u8[pos] !== 0xff) return null;
    const m = u8[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    const len = (u8[pos + 2] << 8) | u8[pos + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      sof = m;
      h = (u8[pos + 5] << 8) | u8[pos + 6];
      w = (u8[pos + 7] << 8) | u8[pos + 8];
    }
    if (m === 0xda) {
      if (!(sof === 0xc0 || sof === 0xc1 || sof === 0xc2) || !w || !h) return null;
      for (let i = pos + 2 + len; i < u8.length - 1; i++) {
        if (u8[i] === 0xff && u8[i + 1] === 0xd9) return { off, end: i + 2, w, h };
      }
      return { off, end: u8.length, w, h };
    }
    pos += 2 + len;
  }
  return null;
}

function findJpegs(u8) {
  const found = [];
  const n = u8.length - 3;
  // indexOf jumps between 0xFF bytes natively instead of stepping through the whole RAW in JS.
  for (let i = u8.indexOf(0xff); i >= 0 && i < n; i = u8.indexOf(0xff, i + 1)) {
    if (u8[i + 1] !== 0xd8 || u8[i + 2] !== 0xff) continue;
    const m = u8[i + 3];
    if (!((m >= 0xe0 && m <= 0xef) || m === 0xdb || m === 0xc4 || m === 0xc0 || m === 0xfe)) continue;
    const j = probeJpeg(u8, i);
    if (j) {
      found.push(j);
      i = Math.max(i, j.end - 1);
    }
    if (found.length > 40) break;
  }
  return found.sort((a, b) => b.w * b.h - a.w * a.h);
}

async function orient(bitmap, o) {
  if (o !== 3 && o !== 6 && o !== 8) return bitmap;
  const swap = o !== 3;
  const w = swap ? bitmap.height : bitmap.width, h = swap ? bitmap.width : bitmap.height;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.translate(w / 2, h / 2);
  ctx.rotate(o === 3 ? Math.PI : o === 6 ? Math.PI / 2 : -Math.PI / 2);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close?.();
  return createImageBitmap(c);
}

async function decodeRaw(file, { screen = 0 } = {}) {
  // For the editor's first look (`screen`: its working size): the camera preview decoded natively at
  // about that size, a fraction of the work of the full-size JPEG. The RAW develop replaces it soon.
  if (screen) {
    const r = await nativePreview(file, screen).catch(() => null);
    if (r) return { bitmap: r.bitmap, fullW: r.fullW, fullH: r.fullH, kind: ext(file.name).toUpperCase(), raw: true, rawPreview: true, reduced: true };
  }
  const embedded = await decodeEmbedded(file).catch(() => null);
  if (embedded) return embedded;
  // No usable embedded preview: decode the RAW data itself right away.
  const lin = await decodeRawLinear(file);
  const c = document.createElement('canvas');
  c.width = lin.preview.w;
  c.height = lin.preview.h;
  c.getContext('2d').putImageData(new ImageData(lin.preview.data, lin.preview.w, lin.preview.h), 0, 0);
  return { bitmap: await createImageBitmap(c), kind: ext(file.name).toUpperCase(), raw: true, linear: lin };
}

// The camera's own JPEG inside a RAW, decoded small (about `long` pixels wide), or null.
export async function decodeCameraJpeg(file, long) {
  return decodeEmbedded(file, long).catch(() => null);
}

// Bytes a caller already read into `file.bytes` (an ArrayBuffer). Not Blob.prototype.bytes(), the
// method every File has in Safari, the Mac and Linux apps (WebKit) and Firefox.
const readBytes = (file) => (file.bytes instanceof ArrayBuffer ? file.bytes : null);

async function decodeEmbedded(file, long = 0) {
  const have = readBytes(file);
  const u8 = new Uint8Array(have || await file.arrayBuffer());
  const o = tiffOrientation(u8);
  const list = findJpegs(u8);
  for (const j of list.slice(0, 4)) {
    try {
      // From the bytes already read when there are any (slicing the File reads storage again).
      const blob = have ? new Blob([u8.subarray(j.off, j.end)], { type: 'image/jpeg' }) : file.slice(j.off, j.end, 'image/jpeg');
      let bitmap = await createImageBitmap(blob, { imageOrientation: o ? 'none' : 'from-image', premultiplyAlpha: 'none', ...(long ? { resizeWidth: long, resizeQuality: 'medium' } : {}) });
      bitmap = await orient(bitmap, o);
      return { bitmap, kind: ext(file.name).toUpperCase(), raw: true, rawPreview: true };
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`Couldn't find a usable preview inside ${file.name}.`);
}

// ------------------------------------------------------------------ LibRaw (WebAssembly)

// Decoders in their own workers with their own queues ("lanes"): quick half-size develops of the photo
// being opened (about a second) never wait behind a full-size one (several seconds, for zooming in and
// exports) or behind background work (learning a camera, merges). Within a lane, decodes run one at a
// time so memory stays bounded, and a decoder idle for IDLE_MS is shut down: LibRaw's WebAssembly
// memory never shrinks, and a full-size decode grows it by hundreds of megabytes.
const IDLE_MS = 20000;
let seq = 0;
const lanes = {};
function lane(name) {
  if (lanes[name]) return lanes[name];
  const L = { worker: null, waiting: new Map(), queue: Promise.resolve(), idle: 0 };
  L.get = () => {
    clearTimeout(L.idle);
    if (L.worker) return L.worker;
    L.worker = new Worker(new URL('./raw-worker.js', import.meta.url), { type: 'module' });
    L.worker.onmessage = ({ data }) => {
      const p = L.waiting.get(data.id);
      if (!p) return;
      L.waiting.delete(data.id);
      data.ok ? p.resolve(data) : p.reject(new Error(data.error));
      if (!L.waiting.size) L.idle = setTimeout(() => { if (!L.waiting.size && L.worker) { L.worker.terminate(); L.worker = null; } }, IDLE_MS);
    };
    L.worker.onerror = (e) => {
      for (const p of L.waiting.values()) p.reject(new Error(e.message || 'RAW decoder failed to start'));
      L.waiting.clear();
      L.worker = null;
    };
    return L.worker;
  };
  return (lanes[name] = L);
}

// The desktop app develops RAWs in native code on every core (src-tauri/src/raw.rs): several times
// faster than WebAssembly, with the same result. Browsers use the WebAssembly worker below.
let nativeRaw = !!globalThis.__TAURI_INTERNALS__ && !/Android|iPhone|iPad/.test(globalThis.navigator?.userAgent || '');
// Big buffers travel over the app's private loopback channel (src-tauri/src/pixels.rs), many times
// faster than Tauri's IPC; IPC remains for when the channel isn't there.
let pixels;
const pixelServer = () => (pixels ||= globalThis.__TAURI_INTERNALS__.invoke('pixels_server').catch(() => null));
// A photo on disk the desktop app may read (in a synced folder, or opened with the app), over the
// loopback channel: much faster than the read_file command for big files. Null when unavailable.
export async function readNativeFile(path) {
  if (!globalThis.__TAURI_INTERNALS__) return null;
  const server = await pixelServer();
  if (!server) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${server.port}/file?key=${server.key}&${new URLSearchParams({ path })}`);
    return r.ok ? await r.arrayBuffer() : null;
  } catch { return null; }
}

// The native side keeps the last few files it was sent (by this id), so a photo's second develop
// doesn't send the file again.
const fileIds = new WeakMap(), sent = new Set();
const fileId = (file) => { if (!fileIds.has(file)) fileIds.set(file, crypto.randomUUID()); return fileIds.get(file); };
// POSTs a file to the loopback channel (`path`: /raw or /preview), sending its bytes only when the
// native side doesn't have them yet. The reply ({ buf, headers }), or null when the channel isn't
// reachable here (it is then not tried again).
async function nativePost(file, buffer, path, q) {
  const server = await pixelServer();
  if (!server) return null;
  const id = fileId(file);
  // text/plain keeps it a simple request (no CORS preflight); the body is the file's bytes.
  const post = (body) => fetch(`http://127.0.0.1:${server.port}${path}?key=${server.key}&file=${id}&${new URLSearchParams(q)}`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  let r;
  try {
    r = await post(sent.has(id) ? new ArrayBuffer(0) : await buffer());
    if (r.status === 409) r = await post(await buffer());
  } catch {
    pixels = Promise.resolve(null);
    return null;
  }
  if (!r.ok) throw new Error((await r.text()) || `native decoder answered ${r.status}`);
  sent.add(id);
  return { buf: await r.arrayBuffer(), headers: r.headers };
}

// The camera's JPEG inside a RAW, decoded natively at a reduced size (long edge at least `long`):
// { bitmap, fullW, fullH } (the full-size preview's oriented size), or null where there's no native
// side or no JPEG preview.
async function nativePreview(file, long) {
  if (!nativeRaw) return null;
  const buf = (await nativePost(file, async () => readBytes(file)?.slice(0) || file.arrayBuffer(), '/preview', { long }).catch(() => null))?.buf;
  if (!buf) return null;
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x3150524c) return null;   // "LRP1"
  const [w, h, o, fw, fh] = [4, 8, 12, 16, 20].map((at) => dv.getUint32(at, true));
  const bitmap = await orient(await createImageBitmap(new ImageData(new Uint8ClampedArray(buf, 24, w * h * 4), w, h)), o);
  const swap = o === 6 || o === 8;
  return { bitmap, fullW: swap ? fh : fw, fullH: swap ? fw : fh };
}

// Generative Remove in the desktop app's native ONNX Runtime (src-tauri/src/inpaint.rs): `planar` RGB
// bytes and `mask` (0 = fill), w × h → the filled image, planar; null where there's no native version
// (then not asked again).
let nativeFill = !!globalThis.__TAURI_INTERNALS__ && !/Android|iPhone|iPad/.test(globalThis.navigator?.userAgent || '');
export async function nativeInpaint(planar, mask, w, h) {
  if (!nativeFill) return null;
  const server = await pixelServer();
  if (!server) { nativeFill = false; return null; }
  const body = new Uint8Array(planar.length + mask.length);
  body.set(planar); body.set(mask, planar.length);
  const r = await fetch(`http://127.0.0.1:${server.port}/inpaint?key=${server.key}&w=${w}&h=${h}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body }).catch(() => null);
  if (!r || r.status === 404) { nativeFill = false; return null; }
  if (!r.ok) throw new Error(await r.text());
  return new Uint8Array(await r.arrayBuffer());
}
export async function nativeInpaintWarm() {
  if (!nativeFill) return false;
  const server = await pixelServer();
  if (!server) return false;
  const r = await fetch(`http://127.0.0.1:${server.port}/inpaint-warm?key=${server.key}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '' }).catch(() => null);
  if (!r || r.status === 404) { nativeFill = false; return false; }
  return true;
}

// Signs an exported file with Content Credentials (src/credentials.js): the signed bytes, or null
// where there's no desktop app.
export async function nativeSign(bytes, mime, manifest) {
  if (!globalThis.__TAURI_INTERNALS__) return null;
  const server = await pixelServer();
  if (!server) return null;
  const m = new TextEncoder().encode(manifest), body = new Uint8Array(4 + m.length + bytes.length);
  new DataView(body.buffer).setUint32(0, m.length, true);
  body.set(m, 4); body.set(bytes, 4 + m.length);
  const r = await fetch(`http://127.0.0.1:${server.port}/sign?key=${server.key}&${new URLSearchParams({ mime })}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
  if (!r.ok) throw new Error(`Content Credentials: ${await r.text()}`);
  return new Uint8Array(await r.arrayBuffer());
}

// Develops a RAW ahead, in the background, into the native side's disk cache (at half size: the
// cache holds a few hundred of those), so it opens without LibRaw. True when done, false when this
// photo couldn't be developed, null where there's no native side.
export async function developAhead(file, quality) {
  if (!nativeRaw) return null;
  try {
    const r = await nativePost(file, async () => readBytes(file)?.slice(0) || file.arrayBuffer(), '/raw', { quality, half: 1, preview: 1, long: 0, store: 1 });
    return r ? true : null;
  } catch { return false; }
}

// Photos developed before come from the native side's disk cache (src-tauri/src/devcache.rs), and
// a half-size request may get the stored full-size develop instead (`half` in the result says which).
async function decodeNative(file, buffer, { quality, half, preview, long }) {
  const t0 = performance.now();
  const q = { quality, half: half ? 1 : 0, preview: preview ? 1 : 0, long: long || 0, upgrade: half ? 1 : 0 };
  const reply = await nativePost(file, buffer, '/raw', q);
  let buf = reply?.buf, cached = false;
  if (reply) { half = reply.headers.get('x-half') !== '0' && !!half; cached = reply.headers.get('x-cached') === '1'; }
  else {
    const reply = await globalThis.__TAURI_INTERNALS__.invoke('raw_decode', new Uint8Array(await buffer()), {
      headers: { 'x-quality': String(quality), 'x-half': String(q.half), 'x-preview': String(q.preview), 'x-long': String(q.long) },
    });
    buf = reply instanceof ArrayBuffer ? reply : new Uint8Array(reply).buffer;
  }
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x314e524c) throw new Error('unexpected reply from the native decoder');   // "LRN1"
  const [w, h, pw, ph, ml] = [4, 8, 12, 16, 20].map((o) => dv.getUint32(o, true));
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 24, ml)));
  let at = 24 + ml + ((4 - (ml % 4)) % 4);
  // Its own copy: the preview outlives this develop (a full-size one reuses the half-size preview).
  const pv = pw ? { data: new Uint8ClampedArray(buf, at, pw * ph * 4).slice(), w: pw, h: ph } : null;
  at += pw * ph * 4;
  if (!(meta.baselineExposure > -20 && meta.baselineExposure < 20)) meta.baselineExposure = 0;
  meta.decodeMs = Math.round(performance.now() - t0);
  meta.native = true;
  if (cached) meta.timing = { cached: true };
  else if (meta.timing) meta.timing.transfer = meta.decodeMs - meta.timing.libraw - meta.timing.preview - meta.timing.convert;
  return { ok: true, half: !!half, w, h, meta, gain: 2 ** (RAW_EV + meta.baselineExposure), data: new Uint16Array(buf, at, w * h * 4), preview: pv };
}

// Demosaic of a camera RAW with LibRaw. Resolves {w, h, data (RGBA half floats), gain, meta, preview,
// half}. `half: 1` decodes at half size without demosaicing (each 2 × 2 sensor block is one pixel):
// about five times faster, and still larger than the editor's on-screen working size.
export function decodeRawLinear(file, { quality = 3, half = 0, background = false, preview = true, long = 0 } = {}) {
  const L = lane(background ? 'background' : half ? 'quick' : 'full');
  const run = async () => {
    const read = () => readBytes(file)?.slice(0) || file.arrayBuffer();
    if (nativeRaw) {
      try {
        return await decodeNative(file, read, { quality, half, preview, long });
      } catch (e) {
        // Fall back to WebAssembly (the same result, slower). A file LibRaw rejects only falls back on
        // its own; anything else means the native path is broken here, so it stays off.
        console.warn('native RAW decode', e);
        if (!/data|format|corrupt|unsupported|unknown/i.test(String(e))) nativeRaw = false;
      }
    }
    const buffer = await read();
    const w = L.get();
    const id = ++seq;
    const r = await new Promise((resolve, reject) => {
      L.waiting.set(id, { resolve, reject });
      w.postMessage({ id, buffer, quality, half, preview, long }, [buffer]);
    });
    r.half = !!half;
    return r;
  };
  const p = L.queue.then(run, run);
  L.queue = p.catch(() => {});
  return p;
}

export const isRaw = (name) => RAW_EXT.has(ext(name));

// Small CPU copy used for picking colors, auto tone and dehaze statistics.
export function sampleData(bitmap, long = 768) {
  const s = Math.min(1, long / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * s)), h = Math.max(1, Math.round(bitmap.height * s));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h };
}

export function thumbnail(bitmap, h = 112) {
  const s = h / bitmap.height;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bitmap.width * s));
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}
