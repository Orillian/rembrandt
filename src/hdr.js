// HDR export: an Ultra HDR JPEG. The file is an ordinary JPEG (the photo as you edited it) with a
// "gain map" inside: a small greyscale image saying how much brighter each part may be shown on an
// HDR screen. HDR-aware viewers (Chrome, Android, Apple Photos, Instagram and others) brighten the
// highlights by up to 2^HEADROOM; everything else shows the normal photo. Metadata follows Adobe's
// gain map spec (hdrgm XMP, ISO 21496-1's predecessor) with Google's container and the MPF index.
//
// The HDR rendition is the same edit rendered HEADROOM stops darker, so highlights that the normal
// tone curve rolls off still have their detail, then brightened back; only the highlights take the
// gain (mid-tones and shadows stay exactly as edited).
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

export const HEADROOM = 2;   // stops above SDR white the highlights may reach
const SCALE = 4;             // gain map at 1/4 of the photo's size

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const LIN = Float32Array.from({ length: 256 }, (_, i) => lin(i / 255));
const lum = (d, i) => 0.2126 * LIN[d[i]] + 0.7152 * LIN[d[i + 1]] + 0.0722 * LIN[d[i + 2]];

// Gain map (w/4 × h/4 grey bytes, log2 gain / HEADROOM) from the normal render `sdr` and the render
// HEADROOM stops darker `dark`, both RGBA of the same w × h.
export function gainMap(sdr, dark, w, h) {
  const gw = Math.max(1, Math.round(w / SCALE)), gh = Math.max(1, Math.round(h / SCALE));
  const out = new Uint8Array(gw * gh), k = 2 ** HEADROOM;
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const x0 = Math.floor(gx * w / gw), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * w / gw));
    const y0 = Math.floor(gy * h / gh), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * h / gh));
    let s = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4, ls = lum(sdr, i), lh = lum(dark, i) * k;
      // Only the highlights: no gain below mid-grey, the full ratio from near white.
      const t = Math.min(1, Math.max(0, (ls - 0.18) / (0.7 - 0.18)));
      const g = 1 + (Math.max(1, lh / Math.max(ls, 1e-4)) - 1) * t * t * (3 - 2 * t);
      s += Math.log2(Math.min(k, g)); n++;
    }
    out[gy * gw + gx] = Math.round(255 * Math.min(1, Math.max(0, s / n / HEADROOM)));
  }
  return { data: out, w: gw, h: gh };
}

// ---------------------------------------------------------------- container

const te = new TextEncoder();
const u16 = (v) => [(v >> 8) & 255, v & 255];
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function segment(marker, payload) {
  const len = payload.length + 2;
  if (len > 65535) throw new Error('metadata too large');
  return Uint8Array.from([0xff, marker, ...u16(len), ...payload]);
}
const XMP_NS = te.encode('http://ns.adobe.com/xap/1.0/\0');
const xmpSeg = (xml) => segment(0xe1, Uint8Array.from([...XMP_NS, ...te.encode(xml)]));
const RDF = (inner) => `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${inner}</rdf:RDF></x:xmpmeta>`;

// Where the APPn segments at the start of a JPEG end (new segments go there).
function afterApp(b) {
  let o = 2;
  while (o + 4 <= b.length && b[o] === 0xff && b[o + 1] >= 0xe0 && b[o + 1] <= 0xef) o += 2 + ((b[o + 2] << 8) | b[o + 3]);
  return o;
}
const splice = (b, at, ins) => { const out = new Uint8Array(b.length + ins.length); out.set(b.subarray(0, at)); out.set(ins, at); out.set(b.subarray(at), at + ins.length); return out; };

// MPF index (CIPA DC-007): two images, the primary and the gain map.
function mpf(primaryLen, gainLen, gainOffset) {
  const entries = [...u32(0x030000), ...u32(primaryLen), ...u32(0), ...u16(0), ...u16(0), ...u32(0), ...u32(gainLen), ...u32(gainOffset), ...u16(0), ...u16(0)];
  const ifd = [...u16(3),
    ...u16(0xb000), ...u16(7), ...u32(4), ...te.encode('0100'),
    ...u16(0xb001), ...u16(4), ...u32(1), ...u32(2),
    ...u16(0xb002), ...u16(7), ...u32(32), ...u32(8 + 2 + 3 * 12 + 4),
    ...u32(0)];
  return segment(0xe2, Uint8Array.from([...te.encode('MPF\0'), 0x4d, 0x4d, 0x00, 0x2a, ...u32(8), ...ifd, ...entries]));
}

// The Ultra HDR file from the finished SDR JPEG (with its EXIF and profile) and the gain map JPEG.
export function ultraHdr(primary, gain) {
  const gm = `<rdf:Description xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0" hdrgm:GainMapMin="0" hdrgm:GainMapMax="${HEADROOM}" hdrgm:Gamma="1" hdrgm:OffsetSDR="0.015625" hdrgm:OffsetHDR="0.015625" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="${HEADROOM}" hdrgm:BaseRenditionIsHDR="False"/>`;
  const gainFile = splice(gain, 2, xmpSeg(RDF(gm)));
  const dir = `<rdf:Description xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0"><Container:Directory><rdf:Seq><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li><rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="${gainFile.length}"/></rdf:li></rdf:Seq></Container:Directory></rdf:Description>`;
  const at = afterApp(primary);
  const xmp = xmpSeg(RDF(dir));
  // The MPF segment has a fixed size, so the lengths can be worked out before it's written.
  const mpfLen = mpf(0, 0, 0).length;
  const total = primary.length + xmp.length + mpfLen;
  const tiffAt = at + xmp.length + 4 + 4;   // the MPF's TIFF header: after FF E2, length and "MPF\0"
  const head = Uint8Array.from([...xmp, ...mpf(total, gainFile.length, total - tiffAt)]);
  const first = splice(primary, at, head);
  const out = new Uint8Array(first.length + gainFile.length);
  out.set(first); out.set(gainFile, first.length);
  return out;
}
