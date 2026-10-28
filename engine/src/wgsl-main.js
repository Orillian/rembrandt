// The main colour stage (MAIN in shaders.js) in WGSL, for the GPU benchmark: the same maths on the
// native GPU API (src-tauri/src/gpubench.rs), so its time compares with the WebGL version's. Settings
// travel in a storage buffer (mainParams) instead of uniforms; the input texture is read texel by texel.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
import { OK_M1, OK_M1_INV, OK_M2, OK_M2_INV, REC2020_LUMA, MIDDLE_GREY, SCENE_CONTRAST, toneK, sceneWhiteGain } from './color.js';

const f = (x) => x.toFixed(9);
const mat = (m) => `mat3x3<f32>(${[0, 1, 2].map((c) => [0, 1, 2].map((r) => f(m[r][c])).join(', ')).join(', ')})`;

export const MAIN_WGSL = `
@group(0) @binding(0) var<storage, read> P: array<vec4<f32>>;
@group(0) @binding(1) var uPre: texture_2d<f32>;
@group(0) @binding(2) var uGuide: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4<f32> };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return VOut(vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0));
}

const GREY: f32 = ${f(MIDDLE_GREY)};
const PI: f32 = 3.14159265358979;
const OKM1 = ${mat(OK_M1)};
const OKM1I = ${mat(OK_M1_INV)};
const OKM2 = ${mat(OK_M2)};
const OKM2I = ${mat(OK_M2_INV)};
const LUM = vec3<f32>(${REC2020_LUMA.map(f).join(', ')});
const HC = array<f32, 8>(25.0, 58.0, 100.0, 140.0, 195.0, 258.0, 298.0, 338.0);

fn fmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }
fn lum(c: vec3<f32>) -> f32 { return dot(c, LUM); }
fn cbrt3(v: vec3<f32>) -> vec3<f32> { return sign(v) * pow(abs(v), vec3<f32>(1.0 / 3.0)); }
fn oklab(rgb: vec3<f32>) -> vec3<f32> { return OKM2 * cbrt3(OKM1 * rgb); }
fn unOklab(lab: vec3<f32>) -> vec3<f32> { let l = OKM2I * lab; return OKM1I * (l * l * l); }
fn hill(x: f32, c: f32, k: f32) -> f32 { let p = pow(max(x, 0.0), c); return p / (p + k); }
fn bump(x: f32, c: f32, w: f32) -> f32 { let d = clamp((x - c) / w, -1.0, 1.0); return 0.5 + 0.5 * cos(d * PI); }
fn zoneWindow(x: f32, z: vec4<f32>) -> f32 {
  let w = select(z.z, z.y, x < z.x);
  if (w < 0.0) { return 1.0; }
  return bump(x, z.x, w);
}
fn zoneGain(x: f32, t: vec4<f32>) -> f32 {
  var g = 0.0;
  for (var i = 0; i < 4; i++) {
    let v = t[i];
    let a = P[15 + i];
    if (v > 0.0) { g += v * a.x * zoneWindow(x, P[7 + i]); } else { g += v * a.y * zoneWindow(x, P[11 + i]); }
  }
  return g;
}
fn shownLightness(Y: f32) -> f32 {
  let p = pow(max(Y, 0.0), ${f(SCENE_CONTRAST)});
  return pow(clamp(p / (p + ${f(toneK(SCENE_CONTRAST))}) * ${f(sceneWhiteGain(SCENE_CONTRAST))}, 0.0, 1.0), 1.0 / 2.2);
}
fn mixWeight(hDeg: f32, i: i32) -> f32 {
  let c = HC[i];
  let prev = HC[(i + 7) % 8];
  let next = HC[(i + 1) % 8];
  let dl = fmod(c - prev + 360.0, 360.0);
  let dr = fmod(next - c + 360.0, 360.0);
  let d = fmod(hDeg - c + 540.0, 360.0) - 180.0;
  let w = select(dr, dl, d < 0.0);
  if (abs(d) >= w) { return 0.0; }
  return 0.5 + 0.5 * cos(d / w * PI);
}
fn mixAt(base: i32, i: i32) -> f32 { return P[base + i / 4][i % 4]; }

@fragment fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let px = vec2<i32>(pos.xy);
  var rgb = textureLoad(uPre, px, 0).rgb;
  let Y = max(lum(rgb), 1.0 / 65536.0);
  let tone = P[0];
  let m1 = P[1];
  let m2 = P[2];
  let m3 = P[3];

  if (m2.y > 0.5) {
    let g = log2(Y);
    let ab = textureLoad(uGuide, px, 0).xy;
    let base = ab.x * g + ab.y;
    let ev = base - log2(GREY);
    var gain = zoneGain(shownLightness(exp2(base)), tone);
    let detail = clamp(g - base, -3.0, 3.0);
    gain += m1.x * 0.65 * detail * exp(-ev * ev / 24.0);
    rgb *= exp2(gain);
  }
  if (m2.z > 0.5) {
    rgb = max(mat3x3<f32>(P[4].xyz, P[5].xyz, P[6].xyz) * rgb, vec3<f32>(0.0));
  }
  var lab = oklab(max(rgb, vec3<f32>(0.0)));
  var C = length(lab.yz);
  var h = atan2(lab.z, lab.y);
  let chromaW = smoothstep(0.005, 0.05, C);
  if (m2.w > 0.5) {
    let hd = degrees(h);
    var dh = 0.0; var ds = 0.0; var dl = 0.0; var wsum = 0.0;
    for (var i = 0; i < 8; i++) {
      let w = mixWeight(hd, i);
      dh += w * mixAt(19, i); ds += w * mixAt(21, i); dl += w * mixAt(23, i); wsum += w;
    }
    if (wsum > 0.0) { dh /= wsum; ds /= wsum; dl /= wsum; }
    h += radians(dh * 35.0) * chromaW;
    C *= max(1.0 + ds * chromaW, 0.0);
    lab.x *= exp2(dl * 0.55 * chromaW * smoothstep(0.02, 0.12, C));
  }
  if (m1.y != 0.0) {
    let muted = 1.0 - smoothstep(0.02, 0.25, C);
    let skin = exp(-pow((degrees(h) - 55.0) / 22.0, 2.0));
    C *= max(1.0 + m1.y * muted * (1.0 - 0.45 * skin * step(0.0, m1.y)), 0.0);
  }
  C *= max(1.0 + m1.z, 0.0);
  lab = vec3<f32>(lab.x, C * cos(h), C * sin(h));
  if (m3.x > 0.5) {
    let x = clamp(pow(hill(Y, 1.5, 0.0792), 1.0 / 2.2), 0.0, 1.0);
    let p = clamp(0.5 - m1.w * 0.3, 0.15, 0.85);
    let xm = select(0.5 + 0.5 * (x - p) / (1.0 - p), 0.5 * x / p, x < p);
    let sharp = mix(2.2, 0.9, m2.x);
    let wS = pow(1.0 - smoothstep(0.0, 0.62, xm), sharp);
    let wH = pow(smoothstep(0.38, 1.0, xm), sharp);
    let wM = max(1.0 - wS - wH, 0.0);
    let g = wS * P[25].xyz + wM * P[26].xyz + wH * P[27].xyz + P[28].xyz;
    let ab = lab.yz + g.xy * smoothstep(0.0, 0.1, lab.x) * max(lab.x, 0.25);
    lab = vec3<f32>(lab.x * exp2(g.z * 0.3), ab);
  }
  if (m3.y > 0.5) { lab = vec3<f32>(lab.x, 0.0, 0.0); }
  return vec4<f32>(max(unOklab(lab), vec3<f32>(0.0)), 0.0);
}
`;

// The settings for MAIN_WGSL from mainUniforms() (pipeline.js), as vec4s.
export function mainParams(u) {
  const out = new Float32Array(29 * 4);
  const put = (i, v) => out.set(Array.from(v).slice(0, 4), i * 4);
  put(0, u.uTone);
  put(1, [u.uClarity, u.uVib, u.uSat, u.uGBalance]);
  put(2, [u.uGBlend, u.uGuideOn ? 1 : 0, u.uWBOn ? 1 : 0, u.uMixOn ? 1 : 0]);
  put(3, [u.uGradeOn ? 1 : 0, u.uBW ? 1 : 0, 0, 0]);
  for (let c = 0; c < 3; c++) put(4 + c, u.uWB.slice(c * 3, c * 3 + 3));
  for (let i = 0; i < 4; i++) {
    put(7 + i, u.uZoneW.slice(i * 4, i * 4 + 4));
    put(11 + i, u.uZoneWn.slice(i * 4, i * 4 + 4));
    put(15 + i, u.uZoneA.slice(i * 2, i * 2 + 2));
  }
  for (let i = 0; i < 2; i++) {
    put(19 + i, u.uMixHue.slice(i * 4, i * 4 + 4));
    put(21 + i, u.uMixSat.slice(i * 4, i * 4 + 4));
    put(23 + i, u.uMixLum.slice(i * 4, i * 4 + 4));
  }
  [u.uGS, u.uGM, u.uGH, u.uGG].forEach((g, i) => put(25 + i, g));
  return out;
}
