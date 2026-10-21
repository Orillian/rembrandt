// Needle 3 (Cactus Compute, Apache-2.0) in a worker: loads the model once, takes the tool list,
// then answers one request at a time with the tool calls it picks. See src/ai/needle.js.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).
importScripts('../vendor/needle/needle.js');

const HERE = self.location.href;
let M = null;
const cstr = (s) => { const b = new TextEncoder().encode(s + '\0'), p = M._malloc(b.length); M.HEAPU8.set(b, p); return p; };
const lastError = () => M.UTF8ToString(M._needle_last_error());

async function init(tools) {
  // The engine looks for needle.wasm beside this worker; hand it the bytes instead.
  const wasm = await fetch(new URL('../vendor/needle/needle.wasm', HERE).href);
  if (!wasm.ok) throw new Error(`The language engine is missing (${wasm.status})`);
  M = await createNeedle({ wasmBinary: new Uint8Array(await wasm.arrayBuffer()) });
  const res = await fetch(new URL('../../models/needle3.cact', HERE).href);
  if (!res.ok) throw new Error(`The language model is missing (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const p = M._malloc(bytes.length);
  M.HEAPU8.set(bytes, p);
  if (M._needle_load(p, BigInt(bytes.length)) < 0) throw new Error(lastError());
  const sys = cstr(''), tj = cstr(JSON.stringify(tools));
  const r = M._needle_init(sys, tj, 0);
  M._free(sys); M._free(tj);
  if (r < 0) throw new Error(lastError());
}

const CAP = 1 << 16;
function complete(text) {
  M._needle_reset();
  const q = cstr(text), out = M._malloc(CAP);
  try {
    if (M._needle_complete(q, 0, 0, 256, out, CAP) < 0) throw new Error(lastError());
    return JSON.parse(M.UTF8ToString(out));
  } finally { M._free(q); M._free(out); }
}

onmessage = async ({ data }) => {
  try {
    if (data.tools) { await init(data.tools); postMessage({ id: data.id, ok: true }); return; }
    postMessage({ id: data.id, result: complete(data.text) });
  } catch (e) { postMessage({ id: data.id, error: e?.message || String(e) }); }
};
