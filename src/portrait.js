// Portrait retouching: one slider per job (smooth skin, brighten eyes, define irises, whiten teeth,
// light the face), each driving a People mask (people.js) with the local adjustments a retoucher
// would use. The masks are ordinary masks named "Portrait · …", so they show in Masks and can be
// fine-tuned there; a slider at 0 removes its mask.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { newMask, newComponent, maskAdjDefaults } from './params.js';

// key: [label, People parts, adjustments at 100].
export const PORTRAIT = {
  skin: ['Smooth skin', ['faceSkin', 'bodySkin'], { clarity: -85, contrast: -8, highlights: -10 }],
  face: ['Light the face', ['faceSkin'], { exposure: 0.45, shadows: 30 }],
  eyes: ['Brighten eyes', ['eyes'], { exposure: 0.6, saturation: -35, whites: 15 }],
  iris: ['Define irises', ['iris'], { clarity: 60, saturation: 35, exposure: 0.25 }],
  teeth: ['Whiten teeth', ['teeth'], { saturation: -60, exposure: 0.4 }],
};

const find = (p, key) => p.masks.find((m) => m.portrait === key);
export const portraitAmount = (p, key) => find(p, key)?.portraitAmount ?? 0;

// Sets one slider (0–100). Returns true when a mask was added (the caller starts the AI analysis).
export function setPortrait(p, key, v, aspect) {
  const [label, parts, full] = PORTRAIT[key];
  let m = find(p, key);
  if (!v) { if (m) p.masks.splice(p.masks.indexOf(m), 1); return false; }
  const added = !m;
  if (!m) {
    m = newMask('person', aspect, p.masks.length + 1);
    m.comps = [{ ...newComponent('person', aspect), parts: [...parts] }];
    m.name = `Portrait · ${label}`;
    m.portrait = key;
    p.masks.push(m);
  }
  m.portraitAmount = v;
  const adj = maskAdjDefaults();
  for (const [k, x] of Object.entries(full)) adj[k] = Math.round(x * v / 100 * (k === 'exposure' ? 100 : 1)) / (k === 'exposure' ? 100 : 1);
  m.adj = adj;
  return added;
}
