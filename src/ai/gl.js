// A WebGL 2 context that can render to float textures, for the AI networks on the GPU (Denoise, Super
// Resolution). An OffscreenCanvas first; where the web view has no WebGL there (WebKitGTK on Linux, for
// one, though the GPU is fine: an Intel UHD 630 runs them), an ordinary canvas. Null when neither works.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
const OPTS = { antialias: false, depth: false, premultipliedAlpha: false };

export function floatGL() {
  const tries = [
    () => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : null),
    () => (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 1, height: 1 }) : null),
  ];
  for (const make of tries) {
    try {
      const gl = make()?.getContext('webgl2', OPTS);
      if (gl && gl.getExtension('EXT_color_buffer_float')) return gl;
    } catch { /* the next one */ }
  }
  return null;
}
