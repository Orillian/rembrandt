// Words to edits with Needle 3, Cactus Compute's on-device tool-calling model (Apache-2.0, see
// src/vendor/needle/README.md). It reads a request the way a person says it ("the sky is too white",
// "it looks too yellow", "start over") and picks actions from the list below; Rembrandt decides how
// far each slider moves. Exact requests ("shadows +25") never reach it: command.js handles those.
//
// The model (36 MB) loads in a worker the first time the words box is used, only while AI is on
// (Settings → Workspace). Until it is ready, and whenever it finds nothing, the rule-based reading
// in command.js answers instead. Nothing leaves the device.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { clamp } from '../util.js';
import { aiOn, onWorkspaceChange } from '../workspace.js';
import { defaultParams } from '../params.js';

const AMOUNT = { type: 'string', enum: ['a little', 'some', 'a lot'], description: 'how much' };
const K = { 'a little': 0.5, some: 1, 'a lot': 2 };
const c100 = (v) => clamp(Math.round(v), -100, 100);

// One action per tool, named the way people ask (Needle's tool-design guidance): each has the
// description and trigger words the model reads, a label for the reply, and the change it makes.
const ACTIONS = [
  ['brighten', 'Make the photo brighter: raise exposure.', ['brighter', 'lighten', 'too dark', 'underexposed'],
    'Brighter', (p, k) => ({ exposure: clamp(+(p.exposure + 0.3 * k).toFixed(2), -5, 5) })],
  ['darken', 'Make the photo darker: lower exposure.', ['darker', 'too bright', 'overexposed'],
    'Darker', (p, k) => ({ exposure: clamp(+(p.exposure - 0.3 * k).toFixed(2), -5, 5) })],
  ['add_contrast', 'More contrast, punchier.', ['contrast', 'punch', 'pop'],
    'More contrast', (p, k) => ({ contrast: c100(p.contrast + 15 * k), clarity: c100(p.clarity + 6 * k) })],
  ['reduce_contrast', 'Less contrast, flatter and softer.', ['flat', 'flatter', 'softer', 'less contrast', 'lower contrast'],
    'Less contrast', (p, k) => ({ contrast: c100(p.contrast - 15 * k), clarity: c100(p.clarity - 8 * k) })],
  ['recover_highlights', 'Bring back detail in bright areas and blown or burnt-out skies.', ['blown', 'burnt out', 'sky', 'highlights', 'white sky'],
    'Highlights recovered', (p, k) => ({ highlights: c100(p.highlights - 30 * k) })],
  ['open_shadows', 'Lift and open up the dark areas to show detail.', ['shadows', 'dark areas', 'lift', 'detail in the dark'],
    'Shadows opened', (p, k) => ({ shadows: c100(p.shadows + 30 * k) })],
  ['warm_up', 'Make the colour warmer, more orange and golden; fixes a cold or blue look.', ['warmer', 'warm', 'golden', 'too blue', 'too cold'],
    'Warmer', (p, k) => ({ temp: c100(p.temp + 12 * k) })],
  ['cool_down', 'Make the colour cooler, more blue, less yellow or orange.', ['cooler', 'too warm', 'too orange', 'too yellow'],
    'Cooler', (p, k) => ({ temp: c100(p.temp - 12 * k) })],
  ['more_color', 'More saturation and vibrance, vivid colour.', ['saturated', 'colourful', 'vivid', 'dull', 'boost colour'],
    'More colour', (p, k) => ({ vibrance: c100(p.vibrance + 20 * k) })],
  ['less_color', 'Less saturation, muted colour.', ['desaturate', 'muted', 'too saturated', 'mute', 'less colour', 'washed out'],
    'Less colour', (p, k) => ({ saturation: c100(p.saturation - 20 * k) })],
  ['dehaze', 'Cut haze and fog.', ['haze', 'hazy', 'fog', 'mist', 'clear'],
    'Dehaze', (p, k) => ({ dehaze: c100(p.dehaze + 15 * k) })],
  ['add_grain', 'Add film grain.', ['grain', 'film'],
    'Grain', (p, k) => ({ grain: { amount: clamp(Math.round(p.grain.amount + 20 * k), 0, 100) } })],
  ['sharpen', 'Sharpen the photo, crisper detail.', ['sharp', 'crisp'],
    'Sharpen', (p, k) => ({ sharpen: { amount: clamp(Math.round(p.sharpen.amount + 30 * k), 0, 150) } })],
  ['vignette', 'Darken the corners and edges.', ['vignette', 'corners', 'edges'],
    'Vignette', (p, k) => ({ vignette: { amount: c100(p.vignette.amount - 20 * k) } })],
  ['blur_background', 'Blur the background behind the subject (portrait mode, bokeh).', ['blur background', 'bokeh', 'portrait mode', 'background blur', 'blurry background'],
    'Lens blur', (p, k) => ({ ai: { blur: { amount: clamp(Math.round((p.ai.blur.amount || 0) + 55 * k), 0, 100) } } })],
  ['black_and_white', 'Make the photo black and white (monochrome, greyscale).', ['black and white', 'b&w', 'monochrome', 'greyscale', 'grayscale'],
    'Black & white', () => ({ bw: true }), false],
  ['reset', 'Undo all edits, back to the original photo.', ['start over', 'reset', 'undo everything', 'undo all', 'remove all edits', 'original'],
    'Back to the original', null, false],
];
export const TOOLS = ACTIONS.map(([name, description, triggers, , , amount = true]) => ({
  name, description, triggers, parameters: { type: 'object', properties: amount ? { amount: AMOUNT } : {} },
}));
const BY_NAME = new Map(ACTIONS.map((a) => [a[0], a]));

// ------------------------------------------------------------------ the worker

let worker = null, ready = null, seq = 0, state = 'off';
const waiting = new Map();
const call = (msg) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });

// AI turned off: the model leaves memory, and loads again the next time it is needed.
onWorkspaceChange(() => {
  if (aiOn() || !worker) return;
  worker.terminate();
  for (const w of waiting.values()) w.reject(new Error('AI is off'));
  waiting.clear();
  worker = null; ready = null; state = 'off';
});

// 'off' (not loaded) | 'loading' | 'ready' | 'failed'.
export const needleState = () => state;

// Starts loading the model in the background (the words box calls this when it is first used).
export function warmNeedle() {
  if (!aiOn() || ready || typeof Worker === 'undefined') return ready;
  state = 'loading';
  worker = new Worker(new URL('./needle-worker.js', import.meta.url));
  worker.onmessage = ({ data }) => { const w = waiting.get(data.id); waiting.delete(data.id); if (data.error) w?.reject(new Error(data.error)); else w?.resolve(data.result ?? data.ok); };
  worker.onerror = (e) => { state = 'failed'; for (const w of waiting.values()) w.reject(new Error(e.message || 'The language model stopped')); waiting.clear(); };
  ready = call({ tools: TOOLS }).then(() => { state = 'ready'; return true; }, (e) => { state = 'failed'; console.warn('Needle', e); return false; });
  return ready;
}

// The actions Needle picks for one clause: [{ name, arguments }], [] when nothing fits, or null when
// it isn't available (AI off, not loaded yet, failed) so the rules should answer.
export async function needleCalls(clause, { wait = false } = {}) {
  if (!aiOn()) return null;
  warmNeedle();
  if (state !== 'ready' && !(wait && state === 'loading')) return null;
  if (!(await ready)) return null;
  try {
    const r = await call({ text: clause });
    return (r.function_calls || []).filter((c) => BY_NAME.has(c.name));
  } catch (e) { console.warn('Needle', e); return null; }
}

// Applies Needle's calls to `p`: → { next, labels }. `aspect` is for "start over". `k`: how far
// to go (0.5, 1, 2), read from the user's own words ("a bit", "a lot"); the model's guess at the
// amount is used only when it isn't given, since it often says "a little" when nobody did.
export function applyCalls(calls, p, aspect = 1.5, k0 = null) {
  let next = p;
  const labels = [];
  for (const c of calls) {
    const [, , , label, change] = BY_NAME.get(c.name);
    if (!change) {   // reset: everything back to the original, crop included
      next = defaultParams(aspect);
      labels.push(label);
      continue;
    }
    const k = k0 ?? K[c.arguments?.amount] ?? 1;
    next = merge(next, change(next, k));
    labels.push(k === 0.5 ? `${label} (a little)` : k === 2 ? `${label} ++` : label);
  }
  return { next, labels };
}
const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  return out;
};
