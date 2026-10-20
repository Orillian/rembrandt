// Reshape: Liquify strokes and face sculpting, as one warp of the photo.
//
// Everything becomes a displacement field on a small grid (256 cells along the long edge), worked out
// on the CPU from the strokes and sliders whenever they change, then one GPU pass samples the photo
// through it (output at uv shows the photo at uv + field(uv)). The pass runs after lens corrections
// and before Retouch, so spots are placed on the reshaped photo. Cheap at any size: the field is
// small and the pass is a single texture lookup per pixel.
//
//   p.warp = { strokes: [{ mode: 'push' | 'bloat' | 'pucker' | 'restore', points: [[u, v]…],
//              radius (fraction of the long edge), strength 0–1 }],
//              eyes, face, nose, smile (−100…100), faces: [compact landmarks, see faceShape] }
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const GRID = 256;

export const warpActive = (w) => !!w && (w.strokes?.length > 0 || (w.faces?.length && (w.eyes || w.face || w.nose || w.smile)));

// The landmarks face sculpting needs, from a 478-point face mesh (x, y 0–1 of the photo).
const EYE_A = [33, 133, 159, 145], EYE_B = [263, 362, 386, 374];
const JAW = [234, 93, 132, 58, 172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454];
const mean = (pts, ids) => { let x = 0, y = 0; for (const i of ids) { x += pts[i][0]; y += pts[i][1]; } return [x / ids.length, y / ids.length]; };
export function faceShape(pts) {
  const eye = (ids) => { const [x, y] = mean(pts, ids); return [x, y, Math.hypot(pts[ids[0]][0] - pts[ids[1]][0], pts[ids[0]][1] - pts[ids[1]][1])]; };
  const r = (v) => Math.round(v * 1e5) / 1e5;
  return {
    e1: eye(EYE_A).map(r), e2: eye(EYE_B).map(r),
    jaw: JAW.map((i) => pts[i].map(r)),
    c: mean(pts, [1, 152, 10]).map(r),
    nose: [pts[1][0], pts[1][1], Math.hypot(pts[129][0] - pts[358][0], pts[129][1] - pts[358][1])].map(r),
    m1: pts[61].map(r), m2: pts[291].map(r),
    w: r(Math.hypot(pts[234][0] - pts[454][0], pts[234][1] - pts[454][1])),
  };
}

// The displacement field (Float32Array RGBA, gw × gh, in uv units) for p.warp on a photo `aspect`.
export function warpField(w, aspect) {
  const gw = aspect >= 1 ? GRID : Math.max(8, Math.round(GRID * aspect));
  const gh = aspect >= 1 ? Math.max(8, Math.round(GRID / aspect)) : GRID;
  const field = new Float32Array(gw * gh * 4);
  // Distances in a square space: x scaled by the aspect so a brush is round on the photo.
  const ax = aspect >= 1 ? aspect : 1, ay = aspect >= 1 ? 1 : 1 / aspect;
  const long = Math.max(ax, ay);
  // One dab: f(t) = (1 − t²)², t = distance / radius. `fn(dx, dy, f, i)` changes the field at cell i.
  const dab = (u, v, radius, fn) => {
    const R = radius * long;
    const x0 = Math.max(0, Math.floor((u - R / ax) * gw)), x1 = Math.min(gw - 1, Math.ceil((u + R / ax) * gw));
    const y0 = Math.max(0, Math.floor((v - R / ay) * gh)), y1 = Math.min(gh - 1, Math.ceil((v + R / ay) * gh));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = ((x + 0.5) / gw - u) * ax, dy = ((y + 0.5) / gh - v) * ay, t2 = (dx * dx + dy * dy) / (R * R);
      if (t2 >= 1) continue;
      fn(dx, dy, (1 - t2) * (1 - t2), (y * gw + x) * 4);
    }
  };
  // Moves what is under (u, v) by (du, dv) (uv units): sample from behind.
  const push = (u, v, radius, du, dv) => dab(u, v, radius, (dx, dy, f, i) => { field[i] -= du * f; field[i + 1] -= dv * f; });
  // Grows (k > 0) or shrinks what is under (u, v): sample nearer to or farther from the centre.
  const scale = (u, v, radius, kx, ky) => dab(u, v, radius, (dx, dy, f, i) => { field[i] -= (dx / ax) * kx * f; field[i + 1] -= (dy / ay) * ky * f; });

  for (const s of w.strokes || []) {
    const pts = s.points || [], st = Math.min(1, Math.max(0, s.strength ?? 0.5)), r = s.radius || 0.05;
    for (let k = 0; k < pts.length; k++) {
      const [u, v] = pts[k];
      if (s.mode === 'push') {
        if (k === 0) continue;
        push(u, v, r, (u - pts[k - 1][0]) * st, (v - pts[k - 1][1]) * st);
      } else if (s.mode === 'bloat' || s.mode === 'pucker') {
        const k1 = (s.mode === 'bloat' ? 1 : -1) * 0.12 * st;
        scale(u, v, r, k1, k1);
      } else if (s.mode === 'restore') {
        dab(u, v, r, (dx, dy, f, i) => { const m = 1 - st * f; field[i] *= m; field[i + 1] *= m; });
      }
    }
  }

  for (const fc of w.faces || []) {
    const fw = fc.w || 0.1;
    // Eyes: grow or shrink each eye.
    if (w.eyes) for (const [u, v, ew] of [fc.e1, fc.e2]) scale(u, v, Math.max(ew * 1.4, 0.004), 0.28 * w.eyes / 100, 0.28 * w.eyes / 100);
    // Face width: the cheeks and jaw in towards the middle of the face (out for negative).
    if (w.face) {
      const [cu] = fc.c;
      for (const [u, v] of fc.jaw) push(u, v, fw * 0.32, (cu - u) * 0.09 * w.face / 100, 0);
    }
    // Nose: narrower (positive) or wider, across only.
    if (w.nose) { const [u, v, nw] = fc.nose; scale(u, v, Math.max(nw * 1.1, 0.004), -0.3 * w.nose / 100, 0); }
    // Smile: the corners of the mouth up (and a little out).
    if (w.smile) {
      const mid = (fc.m1[0] + fc.m2[0]) / 2;
      for (const [u, v] of [fc.m1, fc.m2]) push(u, v, fw * 0.13, Math.sign(u - mid) * fw * 0.012 * w.smile / 100, -fw * 0.035 * w.smile / 100);
    }
  }
  return { data: field, w: gw, h: gh };
}

const WARP = `#version 300 es
precision highp float;
uniform sampler2D uIn, uField;
uniform vec2 uSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  o = textureLod(uIn, uv + textureLod(uField, uv, 0.0).xy, 0.0);
}`;

// The engine source pass (see Engine.baseStage): the photo through the field, into its own target.
export const warpPass = {
  key(p) { return warpActive(p.warp) ? JSON.stringify(p.warp) : ''; },
  run(engine, p, target) {
    const gl = engine.gl;
    engine._warp ||= { prog: engine.program(WARP), tex: null, key: '' };
    const W = engine._warp, aspect = target.w / target.h, key = JSON.stringify(p.warp) + aspect.toFixed(4);
    if (W.key !== key) {
      const f = warpField(p.warp, aspect);
      if (!W.tex) {
        W.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, W.tex);
        for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      }
      gl.bindTexture(gl.TEXTURE_2D, W.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, f.w, f.h, 0, gl.RGBA, gl.FLOAT, f.data);
      W.key = key;
    }
    const out = engine.tgt('warp', gl.RGBA16F, true);
    engine.draw(W.prog, { uIn: target.tex, uField: W.tex, uSize: [target.w, target.h] }, out);
    return out;
  },
};

// Several source passes in order (Reshape, then Retouch): one key, each pass on the last's result.
export const chainPasses = (...passes) => ({
  key: (p) => passes.map((s) => s.key(p)).join('\u0001').replace(/^\u0001+$/, ''),
  run(engine, p, target) {
    let cur = target;
    for (const s of passes) if (s.key(p)) cur = s.run(engine, p, cur) || cur;
    return cur;
  },
});
