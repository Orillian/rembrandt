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

const pct = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 10) / 10;
};

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
    } : null,
    events,
  };
}

export async function copyReport(app) {
  const text = JSON.stringify(report(app), null, 1);
  try { await navigator.clipboard.writeText(text); app.toast('Performance report copied. Paste it into an issue or a message.'); }
  catch { console.info(text); app.toast('Couldn’t copy the report; it is in the developer console'); }
}
