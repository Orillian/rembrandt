// RAW development in native code: LibRaw (compiled by build.rs) on its own thread, then the
// conversion to the GPU's half floats and the small display preview on every core. The same result
// as src/raw-worker.js (the WebAssembly path, kept for browsers): see `decode` for the layout.

use std::ffi::{c_char, c_int, c_uchar, CStr};
use std::sync::OnceLock;

#[repr(C)]
struct LrnImage {
    _p: [u8; 0],
}

extern "C" {
    fn lrn_decode(buf: *const c_uchar, size: usize, quality: c_int, half: c_int, threads: c_int, flip: c_int, out: *mut *mut LrnImage) -> c_int;
    fn lrn_free(h: *mut LrnImage);
    fn lrn_width(h: *const LrnImage) -> c_int;
    fn lrn_height(h: *const LrnImage) -> c_int;
    fn lrn_data(h: *const LrnImage) -> *const u16;
    fn lrn_meta(h: *const LrnImage) -> *const c_char;
    fn lrn_error(code: c_int) -> *const c_char;
    fn lrn_thumb(buf: *const c_uchar, size: usize, out: *mut *mut c_uchar, len: *mut usize, flip: *mut c_int) -> c_int;
    fn lrn_free_bytes(p: *mut c_uchar);
}

/// A developed RAW, freed when dropped.
struct Image(*mut LrnImage);
impl Drop for Image {
    fn drop(&mut self) {
        unsafe { lrn_free(self.0) }
    }
}

fn develop(bytes: &[u8], quality: i32, half: bool) -> Result<Image, String> {
    let mut h: *mut LrnImage = std::ptr::null_mut();
    // A full-size develop runs in bands on up to six threads (each holds the whole RAW in memory).
    let threads = threads().min(6) as c_int;
    let r = unsafe { lrn_decode(bytes.as_ptr(), bytes.len(), quality, half as c_int, threads, -1, &mut h) };
    if r != 0 || h.is_null() {
        return Err(unsafe { CStr::from_ptr(lrn_error(r)) }.to_string_lossy().into_owned());
    }
    Ok(Image(h))
}

// ------------------------------------------------------------------ colour (engine/src/color.js)

type M3 = [[f64; 3]; 3];
fn mul3(m: &M3, v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}
fn matmul(a: &M3, b: &M3) -> M3 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}
fn inv3(m: &M3) -> M3 {
    let [[a, b, c], [d, e, f], [g, h, i]] = *m;
    let (aa, bb, cc) = (e * i - f * h, f * g - d * i, d * h - e * g);
    let det = a * aa + b * bb + c * cc;
    [
        [aa / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [bb / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [cc / det, (b * g - a * h) / det, (a * e - b * d) / det],
    ]
}
fn rgb_to_xyz(prim: [[f64; 2]; 3]) -> M3 {
    let col = |[x, y]: [f64; 2]| [x / y, 1.0, (1.0 - x - y) / y];
    let p = [col(prim[0]), col(prim[1]), col(prim[2])];
    let pm = [[p[0][0], p[1][0], p[2][0]], [p[0][1], p[1][1], p[2][1]], [p[0][2], p[1][2], p[2][2]]];
    let s = mul3(&inv3(&pm), col([0.3127, 0.329]));
    let mut o = pm;
    for r in o.iter_mut() {
        for j in 0..3 {
            r[j] *= s[j];
        }
    }
    o
}

const RAW_EV: f64 = 1.4;
const RAW_CHROMA: f64 = 0.82;
const TWIST_DEG: f64 = 12.0;
const TWIST_CENTRE: f64 = -70.0;
const TWIST_WIDTH: f64 = 40.0;
const MIDDLE_GREY: f64 = 0.1845;
const SCENE_CONTRAST: f64 = 1.56;
const TONE_MAX: f64 = 16.0;

struct Color {
    srgb_to_2020: M3,
    rec2020_to_srgb: M3,
    ok_m1: M3,
    ok_m1_inv: M3,
    ok_m2: M3,
    ok_m2_inv: M3,
    tone: Vec<f32>,
    half: Vec<u16>,
}

fn color() -> &'static Color {
    static C: OnceLock<Color> = OnceLock::new();
    C.get_or_init(|| {
        let srgb = rgb_to_xyz([[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]]);
        let rec = rgb_to_xyz([[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]);
        let srgb_to_2020 = matmul(&inv3(&rec), &srgb);
        let rec2020_to_srgb = matmul(&inv3(&srgb), &rec);
        let ok_m1_srgb: M3 = [
            [0.4122214708, 0.5363325363, 0.0514459929],
            [0.2119034982, 0.6806995451, 0.1073969566],
            [0.0883024619, 0.2817188376, 0.6299787005],
        ];
        let ok_m1 = matmul(&ok_m1_srgb, &rec2020_to_srgb);
        let ok_m2: M3 = [
            [0.2104542553, 0.793617785, -0.0040720468],
            [1.9779984951, -2.428592205, 0.4505937099],
            [0.0259040371, 0.7827717662, -0.808675766],
        ];
        let k = MIDDLE_GREY.powf(SCENE_CONTRAST) * (1.0 / MIDDLE_GREY - 1.0);
        let tone_fwd = |x: f64| {
            let p = x.max(0.0).powf(SCENE_CONTRAST);
            p / (p + k)
        };
        let wg = 1.0 / tone_fwd(MIDDLE_GREY * 2f64.powf(3.75));
        let tone = (0..8192).map(|i| (tone_fwd(i as f64 / 8191.0 * TONE_MAX) * wg).min(1.0) as f32).collect();
        let half = (0..65536u32).map(|i| float_to_half(i as f32 / 65535.0)).collect();
        Color { srgb_to_2020, rec2020_to_srgb, ok_m1, ok_m1_inv: inv3(&ok_m1), ok_m2, ok_m2_inv: inv3(&ok_m2), tone, half }
    })
}

// Same rounding as floatToHalf in src/raw-worker.js.
pub(crate) fn float_to_half(v: f32) -> u16 {
    let x = v.to_bits();
    let sign = (x >> 16) & 0x8000;
    let exp = ((x >> 23) & 0xff) as i32 - 127 + 15;
    let mut mant = x & 0x7fffff;
    if exp <= 0 {
        if exp < -10 {
            return sign as u16;
        }
        mant = (mant | 0x800000) >> (1 - exp);
        return (sign | ((mant + 0x1000) >> 13)) as u16;
    }
    if exp >= 31 {
        return (sign | 0x7c00) as u16;
    }
    (sign | ((exp as u32) << 10) | ((mant + 0x1000) >> 13)) as u16
}

impl Color {
    fn raw_look(&self, rgb: [f64; 3]) -> [f64; 3] {
        let lms = mul3(&self.ok_m1, [rgb[0].max(0.0), rgb[1].max(0.0), rgb[2].max(0.0)]).map(f64::cbrt);
        let [l, a, b] = mul3(&self.ok_m2, lms);
        let from = |lab: [f64; 3]| mul3(&self.ok_m1_inv, mul3(&self.ok_m2_inv, lab).map(|v| v * v * v)).map(|v| v.max(0.0));
        let c = a.hypot(b) * RAW_CHROMA;
        if c < 0.01 * RAW_CHROMA {
            return from([l, a * RAW_CHROMA, b * RAW_CHROMA]);
        }
        let h = b.atan2(a);
        let d = ((h * 180.0 / std::f64::consts::PI - TWIST_CENTRE) / TWIST_WIDTH).clamp(-1.0, 1.0);
        let mut wc = ((c / RAW_CHROMA - 0.01) / 0.05).min(1.0);
        wc = wc * wc * (3.0 - 2.0 * wc);
        let h2 = h - (TWIST_DEG * std::f64::consts::PI / 180.0) * (0.5 + 0.5 * (d * std::f64::consts::PI).cos()) * wc;
        from([l, c * h2.cos(), c * h2.sin()])
    }
    fn tone_at(&self, v: f64) -> f64 {
        let n = self.tone.len() - 1;
        self.tone[((v / TONE_MAX * n as f64).round().max(0.0) as usize).min(n)] as f64
    }
}

fn enc(c: f64) -> f64 {
    if c <= 0.0031308 {
        c * 12.92
    } else {
        1.055 * c.min(1.0).powf(1.0 / 2.4) - 0.055
    }
}

// ------------------------------------------------------------------ on every core

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(16)
}

/// Runs `f(first_row, rows)` over `out` split into bands of whole rows, one band per core.
fn rows<T: Send>(out: &mut [T], row_len: usize, f: impl Fn(usize, &mut [T]) + Sync) {
    let height = if row_len == 0 { 0 } else { out.len() / row_len };
    let per = height.div_ceil(threads()).max(1);
    std::thread::scope(|s| {
        for (i, band) in out.chunks_mut(per * row_len).enumerate() {
            let f = &f;
            s.spawn(move || f(i * per, band));
        }
    });
}

// Display preview with the same transform as the GPU pipeline at default settings (`preview` in
// src/raw-worker.js): sRGB-linear × gain → Rec.2020 → RAW base look → RGB tone → sRGB, 8-bit.
fn preview(src: &[u16], w: usize, h: usize, gain: f64, long: usize) -> (Vec<u8>, usize, usize) {
    let c = color();
    let s = (long as f64 / w.max(h) as f64).min(1.0);
    let pw = ((w as f64 * s).round() as usize).max(1);
    let ph = ((h as f64 * s).round() as usize).max(1);
    let step = 1.0 / s;
    let taps = (step.floor() as usize).clamp(1, 4);
    let mut out = vec![0u8; pw * ph * 4];
    rows(&mut out, pw * 4, |y0, band| {
        for (dy, row) in band.chunks_mut(pw * 4).enumerate() {
            let y = y0 + dy;
            for x in 0..pw {
                let (mut r, mut g, mut b) = (0.0, 0.0, 0.0);
                for ty in 0..taps {
                    let sy = (((y as f64 + (ty as f64 + 0.5) / taps as f64) * step).floor() as usize).min(h - 1);
                    for tx in 0..taps {
                        let sx = (((x as f64 + (tx as f64 + 0.5) / taps as f64) * step).floor() as usize).min(w - 1);
                        let i = (sy * w + sx) * 3;
                        r += src[i] as f64;
                        g += src[i + 1] as f64;
                        b += src[i + 2] as f64;
                    }
                }
                let k = gain / ((taps * taps) as f64 * 65535.0);
                let rec = mul3(&c.srgb_to_2020, [r * k, g * k, b * k]).map(|v| v.max(0.0));
                let sv = c.raw_look(rec);
                let hi = sv[0].max(sv[1]).max(sv[2]);
                let lo = sv[0].min(sv[1]).min(sv[2]);
                let (th, tl) = (c.tone_at(hi), c.tone_at(lo));
                let kt = if hi - lo > 1e-9 { (th - tl) / (hi - lo) } else { 0.0 };
                let q = [tl + (sv[0] - lo) * kt, tl + (sv[1] - lo) * kt, tl + (sv[2] - lo) * kt];
                let o = mul3(&c.rec2020_to_srgb, q);
                let p = &mut row[x * 4..x * 4 + 4];
                for ch in 0..3 {
                    // Uint8ClampedArray: round half to even, clamp to 0..255.
                    let v = (enc(o[ch].max(0.0)) * 255.0).clamp(0.0, 255.0);
                    p[ch] = v.round_ties_even() as u8;
                }
                p[3] = 255;
            }
        }
    });
    (out, pw, ph)
}

/// Decodes a RAW file. The reply, little-endian, every part starting on a 4-byte boundary:
/// "LRN1", output width, height, preview width, height (u32 each), meta JSON length (u32), the meta
/// JSON (padded), the preview (RGBA, 8-bit), then the image (RGBA half floats, linear, no gain).
/// `long` > 0 box-averages the image to about that long edge (analysis only).
pub fn decode(bytes: &[u8], quality: i32, half: bool, want_preview: bool, long: usize) -> Result<Vec<u8>, String> {
    let c = color();
    let t0 = std::time::Instant::now();
    let img = develop(bytes, quality, half)?;
    let t_libraw = t0.elapsed().as_millis();
    let (w, h) = unsafe { (lrn_width(img.0) as usize, lrn_height(img.0) as usize) };
    let src = unsafe { std::slice::from_raw_parts(lrn_data(img.0), w * h * 3) };
    let mut meta = unsafe { CStr::from_ptr(lrn_meta(img.0)) }.to_bytes().to_vec();
    let baseline = std::str::from_utf8(&meta)
        .ok()
        .and_then(|m| m.split("\"baselineExposure\":").nth(1))
        .and_then(|t| t.split([',', '}']).next())
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|v| *v > -20.0 && *v < 20.0)
        .unwrap_or(0.0);
    let gain = 2f64.powf(RAW_EV + baseline);

    let (pv, pw, ph) = if want_preview { preview(src, w, h, gain, 1024) } else { (Vec::new(), 0, 0) };
    let f = if long > 0 && w.max(h) > long { w.max(h).div_ceil(long) } else { 1 };
    let (ow, oh) = (w / f, h / f);

    // Native timings, for the performance report (`meta.timing`).
    let t_preview = t0.elapsed().as_millis() - t_libraw;
    let timing = format!(",\"timing\":{{\"libraw\":{t_libraw},\"preview\":{t_preview},\"convert\":CONVERT}}}}");
    meta.pop();   // the closing brace
    meta.extend_from_slice(timing.as_bytes());
    let pad = |n: usize| (4 - n % 4) % 4;
    let head = 24 + meta.len() + pad(meta.len());
    let mut out = vec![0u8; head + pv.len() + ow * oh * 8];
    out[0..4].copy_from_slice(b"LRN1");
    for (i, v) in [ow, oh, pw, ph, meta.len()].iter().enumerate() {
        out[4 + i * 4..8 + i * 4].copy_from_slice(&(*v as u32).to_le_bytes());
    }
    out[24..24 + meta.len()].copy_from_slice(&meta);
    out[head..head + pv.len()].copy_from_slice(&pv);
    let data = &mut out[head + pv.len()..];
    let one = float_to_half(1.0).to_le_bytes();
    rows(data, ow * 8, |y0, band| {
        for (dy, row) in band.chunks_mut(ow * 8).enumerate() {
            let y = y0 + dy;
            for x in 0..ow {
                let rgb = if f == 1 {
                    let i = (y * w + x) * 3;
                    [src[i], src[i + 1], src[i + 2]]
                } else {
                    let (mut r, mut g, mut b) = (0u64, 0u64, 0u64);
                    for yy in 0..f {
                        let mut i = ((y * f + yy) * w + x * f) * 3;
                        for _ in 0..f {
                            r += src[i] as u64;
                            g += src[i + 1] as u64;
                            b += src[i + 2] as u64;
                            i += 3;
                        }
                    }
                    let n = (f * f) as f64;
                    [(r as f64 / n).round() as u16, (g as f64 / n).round() as u16, (b as f64 / n).round() as u16]
                };
                let p = &mut row[x * 8..x * 8 + 8];
                p[0..2].copy_from_slice(&c.half[rgb[0] as usize].to_le_bytes());
                p[2..4].copy_from_slice(&c.half[rgb[1] as usize].to_le_bytes());
                p[4..6].copy_from_slice(&c.half[rgb[2] as usize].to_le_bytes());
                p[6..8].copy_from_slice(&one);
            }
        }
    });
    // The conversion time, written into the space reserved for it (same width, padded with spaces).
    let t_convert = format!("{:<7}", (t0.elapsed().as_millis() - t_libraw - t_preview).min(9_999_999));
    if let Some(at) = out[24..head].windows(7).position(|w| w == b"CONVERT") {
        out[24 + at..24 + at + 7].copy_from_slice(t_convert.as_bytes());
    }
    Ok(out)
}

/// The camera's embedded JPEG preview, decoded straight to a reduced size: the JPEG decoder's DCT
/// scaling (1/2, 1/4, 1/8) picks the smallest size whose long edge is still at least `long`, so a
/// 36 MP preview shown on screen decodes a quarter of the pixels or fewer. The reply: "LRP1", width,
/// height, EXIF orientation (1, 3, 6 or 8), the full-size preview's width and height (u32 little-endian
/// each), then RGBA, 8-bit.
pub fn embedded_preview(bytes: &[u8], long: usize) -> Result<Vec<u8>, String> {
    let (mut p, mut len, mut flip): (*mut c_uchar, usize, c_int) = (std::ptr::null_mut(), 0, 0);
    let r = unsafe { lrn_thumb(bytes.as_ptr(), bytes.len(), &mut p, &mut len, &mut flip) };
    if r != 0 || p.is_null() {
        return Err(if r == -3 { "no JPEG preview".into() } else { unsafe { CStr::from_ptr(lrn_error(r)) }.to_string_lossy().into_owned() });
    }
    let jpeg = unsafe { std::slice::from_raw_parts(p, len) }.to_vec();
    unsafe { lrn_free_bytes(p) };
    let mut dec = jpeg_decoder::Decoder::new(std::io::Cursor::new(&jpeg));
    dec.read_info().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("unreadable preview")?;
    let (w0, h0) = (info.width as usize, info.height as usize);
    // Scale so the long edge stays at least `long` (the decoder rounds up to its next DCT size).
    let k = if long > 0 && w0.max(h0) > long { long as f64 / w0.max(h0) as f64 } else { 1.0 };
    let (w, h) = dec.scale(((w0 as f64 * k).ceil() as u16).max(1), ((h0 as f64 * k).ceil() as u16).max(1)).map_err(|e| e.to_string())?;
    let px = dec.decode().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("unreadable preview")?;
    let (w, h) = (w as usize, h as usize);
    let orientation: u32 = match flip { 3 => 3, 5 => 8, 6 => 6, _ => 1 };
    let mut out = vec![0u8; 24 + w * h * 4];
    out[0..4].copy_from_slice(b"LRP1");
    for (i, v) in [w as u32, h as u32, orientation, w0 as u32, h0 as u32].iter().enumerate() {
        out[4 + i * 4..8 + i * 4].copy_from_slice(&v.to_le_bytes());
    }
    let rgba = &mut out[24..];
    use jpeg_decoder::PixelFormat as F;
    match info.pixel_format {
        F::RGB24 => for (d, s) in rgba.chunks_exact_mut(4).zip(px.chunks_exact(3)) { d[..3].copy_from_slice(s); d[3] = 255; },
        F::L8 => for (d, &v) in rgba.chunks_exact_mut(4).zip(px.iter()) { d.copy_from_slice(&[v, v, v, 255]); },
        F::L16 => for (d, s) in rgba.chunks_exact_mut(4).zip(px.chunks_exact(2)) { let v = s[0]; d.copy_from_slice(&[v, v, v, 255]); },
        F::CMYK32 => for (d, s) in rgba.chunks_exact_mut(4).zip(px.chunks_exact(4)) {
            let k = 255 - s[3] as u32;
            for c in 0..3 { d[c] = ((255 - s[c] as u32) * k / 255) as u8; }
            d[3] = 255;
        },
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    // RAW files to try, from REMBRANDT_TEST_RAWS (paths separated by ':').
    #[test]
    fn embedded_preview_decodes_reduced() {
        let Ok(list) = std::env::var("REMBRANDT_TEST_RAWS") else { return };
        for path in list.split(':') {
            let bytes = std::fs::read(path).unwrap();
            let t = std::time::Instant::now();
            let r = super::embedded_preview(&bytes, 2560);
            match r {
                Ok(out) => {
                    let w = u32::from_le_bytes(out[4..8].try_into().unwrap());
                    let h = u32::from_le_bytes(out[8..12].try_into().unwrap());
                    println!("{path}: {w}x{h} in {} ms", t.elapsed().as_millis());
                    assert!(w.max(h) >= 2560);
                }
                Err(e) => panic!("{path}: {e}"),
            }
        }
    }
}
