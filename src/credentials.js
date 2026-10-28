// Content Credentials (C2PA) in exports, desktop app: a signed record inside the file of what was done
// to the photo, which anyone can check (contentcredentials.org/verify). This builds the record from the
// edit; the desktop app signs it into the file (src-tauri/src/credentials.rs).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { isMobileApp } from './platform.js';
import { describe, recipeOf } from './recipe.js';
import { nativeSign } from './loader.js';

export const credentialsSupported = () => !!globalThis.__TAURI_INTERNALS__ && !isMobileApp;

const IPTC = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const RAW_MIME = { cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef', arw: 'image/x-sony-arw', dng: 'image/x-adobe-dng', raf: 'image/x-fuji-raf', orf: 'image/x-olympus-orf', rw2: 'image/x-panasonic-rw2' };
const mimeOf = (name) => {
  const x = (name || '').split('.').pop().toLowerCase();
  return RAW_MIME[x] || (x === 'jpg' || x === 'jpeg' ? 'image/jpeg' : x === 'png' ? 'image/png' : x === 'heic' ? 'image/heic' : x === 'tif' || x === 'tiff' ? 'image/tiff' : x === 'webp' ? 'image/webp' : 'application/octet-stream');
};

// The manifest definition (c2pa Builder JSON) for an export of a photo edited with `p`.
export function manifestFor(p, { title, original, version }) {
  const actions = [{ action: 'c2pa.opened', parameters: { ingredientIds: ['original'] } }];
  const changes = describe(recipeOf(p));
  if (changes.length) actions.push({ action: 'c2pa.color_adjustments', parameters: { description: changes.join('; ') } });
  const g = p.geometry;
  if (g && (g.angle || g.crop && (g.crop.h < 0.999 || Math.abs(g.crop.cx) > 1e-3 || Math.abs(g.crop.cy) > 1e-3))) actions.push({ action: 'c2pa.cropped' });
  if (g && (g.rot90 || g.flipH || g.flipV)) actions.push({ action: 'c2pa.orientation' });
  const retouch = p.retouch || [];
  if (retouch.some((o) => o.mode === 'heal' || o.mode === 'clone')) actions.push({ action: 'c2pa.edited', parameters: { description: 'Spot removal (heal and clone)' } });
  // Generative AI: parts of the photo drawn by a model are recorded as such.
  const generated = [];
  if (retouch.some((o) => o.mode === 'fill')) generated.push('Generative Remove');
  if (p.ai?.sky?.replace && p.ai.sky.replace !== 'none') generated.push('Sky replacement');
  if (generated.length) actions.push({ action: 'c2pa.edited', digitalSourceType: IPTC + 'compositeWithTrainedAlgorithmicMedia', parameters: { description: generated.join(', ') } });
  if ((p.masks || []).length) actions.push({ action: 'c2pa.edited', parameters: { description: `${p.masks.length} local adjustment${p.masks.length === 1 ? '' : 's'}` } });
  return {
    claim_generator_info: [{ name: 'Rembrandt', version }],
    title,
    ingredients: [{ title: original, format: mimeOf(original), relationship: 'parentOf', label: 'original' }],
    assertions: [{ label: 'c2pa.actions', data: { actions } }],
  };
}

// The exported file with Content Credentials, signed by the desktop app.
export async function withCredentials(blob, mime, manifest) {
  const signed = await nativeSign(new Uint8Array(await blob.arrayBuffer()), mime, JSON.stringify(manifest));
  if (!signed) throw new Error('Content Credentials need the desktop app');
  return new Blob([signed], { type: mime });
}
