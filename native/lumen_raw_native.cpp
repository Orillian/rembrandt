// Thin C API over LibRaw for the desktop app's native core (src-tauri/build.rs compiles it with LibRaw).
// Same development as lumen_raw.cpp (the WebAssembly build): linear (gamma 1.0) 16-bit RGB with
// sRGB primaries, the camera's white balance and colour matrix, no tone curve or auto-brightening.
// Unlike that build, each decode has its own LibRaw instance, so decodes can run on several threads.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

// LibRaw's headers include windows.h on Windows, whose min and max macros would break std::min/max.
#if defined(_WIN32) && !defined(NOMINMAX)
#define NOMINMAX
#endif
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <vector>
#include "libraw/libraw.h"

struct LrnImage {
  LibRaw *raw;
  libraw_processed_image_t *img;
  char meta[4096];
};

static void json_str(char *dst, size_t n, const char *s) {
  size_t j = 0;
  for (size_t i = 0; s && s[i] && j + 2 < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c == '"' || c == '\\') { dst[j++] = '\\'; dst[j++] = c; }
    else if (c >= 0x20 && c < 0x7f) dst[j++] = c;
  }
  dst[j] = 0;
}

static void set_params(LibRaw *raw, int quality, int half) {
  libraw_output_params_t &o = raw->imgdata.params;
  o.output_bps = 16;
  o.gamm[0] = 1.0;
  o.gamm[1] = 1.0;
  o.no_auto_bright = 1;
  o.use_camera_wb = 1;
  o.use_camera_matrix = 1;
  o.output_color = 1;  // sRGB primaries (linear, since gamma is 1)
  o.highlight = 0;     // clip; highlight reconstruction happens later in the pipeline
  o.user_qual = quality;
  o.half_size = half;
}

static void write_meta(LrnImage *h, int width, int height, int flip) {
  const libraw_iparams_t &ip = h->raw->imgdata.idata;
  const libraw_imgother_t &ot = h->raw->imgdata.other;
  const libraw_lensinfo_t &ln = h->raw->imgdata.lens;
  char make[128], model[128], lens[256];
  json_str(make, sizeof make, ip.make);
  json_str(model, sizeof model, ip.model);
  json_str(lens, sizeof lens, ln.Lens);
  float baseline = h->raw->imgdata.color.dng_levels.baseline_exposure;
  if (!std::isfinite(baseline)) baseline = 0.f;
  snprintf(h->meta, sizeof h->meta,
           "{\"make\":\"%s\",\"model\":\"%s\",\"lens\":\"%s\",\"iso\":%g,\"shutter\":%g,\"aperture\":%g,"
           "\"focal\":%g,\"timestamp\":%lld,\"flip\":%d,\"baselineExposure\":%g,\"width\":%d,\"height\":%d}",
           make, model, lens, ot.iso_speed, ot.shutter, ot.aperture, ot.focal_len, (long long)ot.timestamp, flip,
           baseline, width, height);
}

// A full-size develop split into horizontal bands developed on several threads, each by its own
// LibRaw (with a margin of rows the demosaic needs, then dropped), stitched and rotated as LibRaw
// would. LibRaw's demosaic is single-threaded, so this is what uses the other cores. The result is
// identical to one LibRaw developing the whole image: the one thing that depends on the whole image
// (the white level LibRaw lowers to the brightest pixel, adjust_maximum) is worked out across all
// bands first and given to each. Only for ordinary Bayer sensors; returns nullptr to fall back.
static LrnImage *decode_bands(const unsigned char *buf, size_t size, int quality, int threads, int flip_override) {
  LibRaw probe;
  if (probe.open_buffer(buf, size) != LIBRAW_SUCCESS) return nullptr;
  const libraw_iparams_t &ip = probe.imgdata.idata;
  const int W = probe.imgdata.sizes.width, H = probe.imgdata.sizes.height;
  const int flip = flip_override >= 0 ? flip_override : probe.imgdata.sizes.flip;
  if (ip.filters < 1000 || ip.colors != 3 || ip.is_foveon || probe.imgdata.idata.raw_count > 1) return nullptr;
  if (probe.imgdata.rawdata.ioparams.fuji_width || probe.imgdata.sizes.pixel_aspect != 1.0) return nullptr;
  const int M = 32;                                  // rows of margin each side; a multiple of 16
  int n = std::min(threads, H / 384);
  if (n < 2) return nullptr;
  const int band = ((H + n - 1) / n + 15) / 16 * 16;
  n = (H + band - 1) / band;

  struct Band { LibRaw *raw = nullptr; int y0 = 0, ys = 0, ye = 0, ok = 0; unsigned maximum = 0, data_max = 0; libraw_processed_image_t *img = nullptr; };
  std::vector<Band> b(n);
  for (int k = 0; k < n; k++) {
    b[k].ys = k * band;
    b[k].ye = std::min(H, (k + 1) * band);
    b[k].y0 = std::max(0, b[k].ys - M);
  }
  auto cleanup = [&]() { for (auto &x : b) { if (x.img) LibRaw::dcraw_clear_mem(x.img); delete x.raw; } };
  // 1. Each band reads the file and measures its brightest pixel.
  {
    std::vector<std::thread> th;
    for (int k = 0; k < n; k++)
      th.emplace_back([&, k] {
        Band &x = b[k];
        x.raw = new LibRaw();
        set_params(x.raw, quality, 0);
        libraw_output_params_t &o = x.raw->imgdata.params;
        o.user_flip = 0;
        o.cropbox[0] = 0;
        o.cropbox[1] = x.y0;
        o.cropbox[2] = W;
        o.cropbox[3] = std::min(H, x.ye + M) - x.y0;
        if (x.raw->open_buffer(buf, size) || x.raw->unpack() || x.raw->raw2image_ex(1)) return;
        x.maximum = x.raw->imgdata.color.maximum;
        x.data_max = x.raw->imgdata.color.data_maximum;
        x.ok = 1;
      });
    for (auto &t : th) t.join();
  }
  for (auto &x : b) if (!x.ok) { cleanup(); return nullptr; }
  // 2. The white level LibRaw would use for the whole image (adjust_maximum, default threshold).
  libraw_decoder_info_t di;
  b[0].raw->get_decoder_info(&di);
  unsigned m0 = b[0].maximum, dmax = 0;
  for (auto &x : b) dmax = std::max(dmax, x.data_max);
  unsigned sat = m0;
  if (!(di.decoder_flags & LIBRAW_DECODER_FIXEDMAXC) && dmax > 0 && dmax < m0 && dmax > m0 * LIBRAW_DEFAULT_ADJUST_MAXIMUM_THRESHOLD) sat = dmax;
  // 3. Develop every band with that white level, then stitch them, rotated, into one image.
  const int OW = (flip & 4) ? H : W, OH = (flip & 4) ? W : H;
  const size_t bytes = (size_t)OW * OH * 3 * 2;
  libraw_processed_image_t *out = (libraw_processed_image_t *)malloc(sizeof(libraw_processed_image_t) + bytes);
  if (!out) { cleanup(); return nullptr; }
  out->type = LIBRAW_IMAGE_BITMAP;
  out->width = OW;
  out->height = OH;
  out->colors = 3;
  out->bits = 16;
  out->data_size = (unsigned)bytes;
  unsigned short *dst = (unsigned short *)out->data;
  {
    std::vector<std::thread> th;
    for (int k = 0; k < n; k++)
      th.emplace_back([&, k] {
        Band &x = b[k];
        x.ok = 0;
        x.raw->imgdata.params.user_sat = (int)sat;
        int e = x.raw->dcraw_process();
        if (e == LIBRAW_SUCCESS) x.img = x.raw->dcraw_make_mem_image(&e);
        if (!x.img || x.img->bits != 16 || x.img->colors != 3 || x.img->width != W) return;
        const unsigned short *src = (const unsigned short *)x.img->data;
        // Source row y (whole image), column c → output pixel, as LibRaw's flip_index.
        for (int y = x.ys; y < x.ye; y++) {
          const unsigned short *s = src + (size_t)(y - x.y0) * W * 3;
          if (flip == 0) { memcpy(dst + (size_t)y * W * 3, s, (size_t)W * 3 * 2); continue; }
          for (int c = 0; c < W; c++) {
            int rr = y, cc = c;
            if (flip & 2) rr = H - 1 - rr;
            if (flip & 1) cc = W - 1 - cc;
            // flip_index maps output (row, col) to source (rr, cc); invert it for this source pixel.
            int orow = rr, ocol = cc;
            if (flip & 4) { orow = cc; ocol = rr; }
            unsigned short *d = dst + ((size_t)orow * OW + ocol) * 3;
            d[0] = s[c * 3];
            d[1] = s[c * 3 + 1];
            d[2] = s[c * 3 + 2];
          }
        }
        x.ok = 1;
      });
    for (auto &t : th) t.join();
  }
  for (auto &x : b) if (!x.ok) { free(out); cleanup(); return nullptr; }
  LrnImage *h = new LrnImage();
  h->raw = b[0].raw;
  b[0].raw = nullptr;
  h->img = out;
  write_meta(h, OW, OH, flip);
  h->raw->recycle();
  cleanup();
  return h;
}

extern "C" {

void lrn_free(LrnImage *h) {
  if (!h) return;
  if (h->img) LibRaw::dcraw_clear_mem(h->img);
  delete h->raw;
  delete h;
}

// quality: LibRaw user_qual (0 linear, 1 VNG, 2 PPG, 3 AHD, 4 DCB, 11 DHT, 12 AAHD). half: 1 = half size.
// threads > 1 lets a full-size develop use that many threads. flip >= 0 overrides the photo's
// orientation (tests). Returns 0 and sets *out on success (free it with lrn_free), otherwise a LibRaw
// error code (lrn_error).
int lrn_decode(const unsigned char *buf, size_t size, int quality, int half, int threads, int flip, LrnImage **out) {
  *out = nullptr;
  if (!half && threads > 1) {
    if (LrnImage *h = decode_bands(buf, size, quality, threads, flip)) { *out = h; return 0; }
  }
  LrnImage *h = new LrnImage();
  h->raw = new LibRaw();
  h->img = nullptr;
  set_params(h->raw, quality, half);
  if (flip >= 0) h->raw->imgdata.params.user_flip = flip;
  int r = h->raw->open_buffer(buf, size);
  if (r == LIBRAW_SUCCESS) r = h->raw->unpack();
  if (r == LIBRAW_SUCCESS) r = h->raw->dcraw_process();
  if (r == LIBRAW_SUCCESS) {
    h->img = h->raw->dcraw_make_mem_image(&r);
    if (!h->img && r == LIBRAW_SUCCESS) r = -1;
  }
  if (r == LIBRAW_SUCCESS && (h->img->type != LIBRAW_IMAGE_BITMAP || h->img->colors != 3 || h->img->bits != 16)) r = -2;
  if (r != LIBRAW_SUCCESS) { lrn_free(h); return r; }
  write_meta(h, h->img->width, h->img->height, h->raw->imgdata.sizes.flip);
  // Free LibRaw's working buffers; keep only the output image.
  h->raw->recycle();
  *out = h;
  return 0;
}

// The camera's embedded JPEG preview (the largest LibRaw finds), without developing the RAW: copied
// into *out (free it with lrn_free_bytes), with LibRaw's orientation (0, 3, 5 or 6) in *flip.
// Returns 0, a LibRaw error code, or -3 when the preview isn't a JPEG.
int lrn_thumb(const unsigned char *buf, size_t size, unsigned char **out, size_t *len, int *flip) {
  *out = nullptr;
  *len = 0;
  LibRaw raw;
  int r = raw.open_buffer(buf, size);
  if (r == LIBRAW_SUCCESS) r = raw.unpack_thumb();
  if (r != LIBRAW_SUCCESS) return r;
  const libraw_thumbnail_t &t = raw.imgdata.thumbnail;
  if (t.tformat != LIBRAW_THUMBNAIL_JPEG || !t.thumb || t.tlength < 4) return -3;
  *out = (unsigned char *)malloc(t.tlength);
  if (!*out) return -1;
  memcpy(*out, t.thumb, t.tlength);
  *len = t.tlength;
  *flip = raw.imgdata.sizes.flip;
  return 0;
}
void lrn_free_bytes(unsigned char *p) { free(p); }

int lrn_width(const LrnImage *h) { return h->img->width; }
int lrn_height(const LrnImage *h) { return h->img->height; }
const unsigned short *lrn_data(const LrnImage *h) { return (const unsigned short *)h->img->data; }
const char *lrn_meta(const LrnImage *h) { return h->meta; }
const char *lrn_error(int code) { return code == -2 ? "Unsupported output format" : libraw_strerror(code); }

}
