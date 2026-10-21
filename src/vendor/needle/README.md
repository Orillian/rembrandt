# Needle (WebAssembly engine)

`needle.js` and `needle.wasm` are the browser engine of Needle 3, Cactus Compute's on-device
tool-calling model, from `huggingface.co/Cactus-Compute/needle3` (folder `wasm/`, engine 3.1.0).
The weights are `models/needle3.cact` from the same repository. Apache-2.0 (`LICENSE`).

Rembrandt runs it in `src/ai/needle-worker.js` to turn what you type in the words box into edits;
see `src/ai/needle.js`. Single-threaded, no network access, nothing leaves the device.
