// Performance report: what opening photos and moving sliders cost on this computer, to copy into a
// bug report. Nothing is sent anywhere. Ctrl/⌘ + Alt/⌥ + Shift + P copies it to the clipboard.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

const events = [];
const frames = [];   // [ms between frames, ms of CPU in the frame] while a slider moves
let lastFrame = 0;

/// Notes a step (photo opened, shown, developed) with how long it took.
export function mark(what, data = {}) {
  events.push({ t: Math.round(performance.now()), what, ...data });
  if (events.length > 80) events.shift();
}

/// Called for each rendered frame; `sliding` frames are the ones that matter for editing feel.
export function frame(cpuMs, sliding) {
  const now = performance.now();
  if (sliding && lastFrame && now - lastFrame < 500) {
    frames.push([now - lastFrame, cpuMs]);
    if (frames.length > 600) frames.shift();
  }
  lastFrame = sliding ? now : 0;
}

// What paces a drag: how often the web view offers a frame (requestAnimationFrame) and how often the
// slider reports a move, measured during drags. Frames every 33 ms with both at 16 ms would be the
// app's doing; frames offered only every 33 ms, the system's (Low Power Mode, for one).
const rafGaps = [], inputGaps = [];
let probing = false, lastInput = 0;

// Freezes during drags: a frame offered over 50 ms after the last one (the frame timer runs on while
// the slider is held still, so a pause of the hand isn't one), with the app's work that was running
// then (`begin` / its end marks the spans of likely culprits). Nothing running: the GPU or the system.
const spans = [], stalls = [];
export function begin(name) {
  const s = { name, t0: performance.now(), t1: 0 };
  spans.push(s);
  if (spans.length > 200) spans.shift();
  return () => { s.t1 = performance.now(); };
}
function stall(t, gap) {
  const during = spans.filter((s) => s.t0 <= t && (!s.t1 || s.t1 >= t - gap) && (!s.t1 || s.t1 - s.t0 >= 2))
    .map((s) => `${s.name} ${Math.round((s.t1 || t) - s.t0)}ms`);
  stalls.push({ t: Math.round(t), gap: Math.round(gap), during: [...new Set(during)] });
  if (stalls.length > 30) stalls.shift();
}
export function dragStart() {
  if (probing) return;
  probing = true;
  let last = 0;
  const tick = (t) => {
    if (!probing) return;
    if (last && t - last < 2000) {
      rafGaps.push(t - last); if (rafGaps.length > 600) rafGaps.shift();
      if (t - last > 50) stall(t, t - last);
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
export function dragEnd() { probing = false; lastInput = 0; }
export function dragInput() {
  const now = performance.now();
  if (probing && lastInput && now - lastInput < 500) { inputGaps.push(now - lastInput); if (inputGaps.length > 600) inputGaps.shift(); }
  lastInput = now;
}

const pct = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};

// GPU time of each stage of a slider frame on this computer: a few frames rendered as during a drag,
// each draw timed with a round trip to the GPU (so slower than real frames, but the split is right).
function gpuStages(app) {
  const E = app.engine, gl = E?.gl;
  if (!gl || !app.img) return null;
  const px = new Uint8Array(4);
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const names = new Map(Object.entries(E.P).map(([k, v]) => [v, k]));
  const cost = {};
  let mips = 0;
  const draw = E.draw, gen = gl.generateMipmap;
  E.draw = function (prog, u, tgt, ...rest) {
    sync();
    const t0 = performance.now();
    const r = draw.call(this, prog, u, tgt, ...rest);
    sync();
    const k = `${names.get(prog) || 'other'} ${tgt ? `${tgt.w}x${tgt.h}` : 'screen'}`;
    cost[k] = (cost[k] || 0) + performance.now() - t0;
    return r;
  };
  gl.generateMipmap = function (x) { sync(); const t0 = performance.now(); gen.call(gl, x); sync(); mips += performance.now() - t0; };
  const was = app.state.sliding, exp = app.params.exposure, n = 6;
  let total = 0;
  try {
    app.state.sliding = true;
    for (let i = 0; i < n; i++) {
      app.params.exposure = exp + (i % 2 ? 0.01 : -0.01);
      sync();
      const t0 = performance.now();
      app.renderNow();
      sync();
      total += performance.now() - t0;
    }
  } finally {
    E.draw = draw;
    gl.generateMipmap = gen;
    app.params.exposure = exp;
    app.state.sliding = was;
    app.requestRender();
  }
  const round = (v) => Math.round((v / n) * 10) / 10;
  return {
    frameMs: round(total),
    canvas: [gl.canvas.width, gl.canvas.height],
    level: [E.L?.kind, E.L?.w, E.L?.h],
    stages: { ...Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, round(v)])), mipmaps: round(mips) },
  };
}

// The main colour stage on this computer's native GPU API (desktop app) and in the web view's WebGL,
// same size and settings: does a native renderer pay here? Run when the report is made.
const BENCH = { exposure: 0.3, shadows: 30, highlights: -40, clarity: 20, temp: 10, vibrance: 20, saturation: 5,
  hsl: { hue: [10, 0, 0, -10, 0, 5, 0, 0], sat: [0, 10, 0, 0, -10, 0, 0, 0], lum: [0, 0, 5, 0, 0, -5, 0, 0] },
  grading: { shadows: { h: 220, s: 20, l: 0 }, midtones: { h: 30, s: 0, l: 0 }, highlights: { h: 45, s: 15, l: 0 }, global: { h: 30, s: 0, l: 0 }, blending: 50, balance: 0 } };
export async function nativeBenchmark(app) {
  const t = globalThis.__TAURI_INTERNALS__, E = app.engine;
  if (!t || !E?.gl) return null;
  const [{ MAIN_WGSL, mainParams }, { mainUniforms }, { defaultParams }, { deepMerge }] = await Promise.all([
    import('../engine/src/wgsl-main.js'), import('../engine/src/pipeline.js'), import('./params.js'), import('./util.js')]);
  const p = deepMerge(defaultParams(1.5), BENCH);
  const [w, h] = E.L ? [E.L.w, E.L.h] : [2560, 1707];
  const frames = 10;
  const webgl = Math.round(E.benchmarkMain(p, w, h, frames) * 100) / 100;
  try {
    const native = await t.invoke('gpu_benchmark', { w, h, frames, wgsl: MAIN_WGSL, params: Array.from(mainParams({ ...mainUniforms(p), uGuideOn: 1 })) });
    return { w, h, webglMs: webgl, nativeMs: native.ms, speedup: native.ms > 0 ? Math.round((webgl / native.ms) * 100) / 100 : null, adapter: native.adapter, backend: native.backend };
  } catch (err) { return { w, h, webglMs: webgl, nativeError: String(err?.message || err) }; }
}

export function report(app) {
  const gl = app.engine?.gl;
  let gpu = '';
  try { const d = gl?.getExtension('WEBGL_debug_renderer_info'); gpu = gl ? String(gl.getParameter(d ? d.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : ''; } catch { /* none */ }
  let gpuMsPerMP = null;
  try { gpuMsPerMP = Math.round(app.engine.benchmark() * 100) / 100; } catch { /* none */ }
  const E = app.engine;
  const level = (k) => { try { return E.levelSize(k); } catch { return null; } };
  return {
    version: window.LUMEN_BUILD?.version || 'dev',
    app: !!window.__TAURI_INTERNALS__,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency || 0,
    memoryGB: navigator.deviceMemory || null,
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`,
    gpu,
    gpuMsPerMP,
    levels: E?.fullW ? { full: [E.fullW, E.fullH], preview: level('preview'), drag: level('drag') } : null,
    sliderFrames: frames.length ? {
      count: frames.length,
      intervalMedian: pct(frames.map((f) => f[0]), 0.5),
      intervalP95: pct(frames.map((f) => f[0]), 0.95),
      cpuMedian: pct(frames.map((f) => f[1]), 0.5),
      cpuP95: pct(frames.map((f) => f[1]), 0.95),
      rafMedian: pct(rafGaps, 0.5),
      rafP95: pct(rafGaps, 0.95),
      inputMedian: pct(inputGaps, 0.5),
    } : null,
    stalls,
    gpuStages: (() => { try { return gpuStages(app); } catch (e) { return String(e); } })(),
    events,
  };
}

export async function copyReport(app) {
  const r = report(app);
  try { r.nativeGpu = await nativeBenchmark(app); } catch (err) { r.nativeGpu = String(err?.message || err); }
  const text = JSON.stringify(r, null, 1);
  try { await navigator.clipboard.writeText(text); app.toast('Performance report copied. Paste it into an issue or a message.'); }
  catch { console.info(text); app.toast('Couldn’t copy the report; it is in the developer console'); }
}
