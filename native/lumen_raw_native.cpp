// Thin C API over LibRaw for the desktop app's native core (src-tauri/build.rs compiles it with LibRaw).
// Same development as lumen_raw.cpp (the WebAssembly build): linear (gamma 1.0) 16-bit RGB with
// sRGB primaries, the camera's white balance and colour matrix, no tone curve or auto-brightening.
// Unlike that build, each decode has its own LibRaw instance, so decodes can run on several threads.
// Copyright © 2026 the Rembrandt contributors. Licensed under the GNU GPL v3 or later (see LICENSE).

#include <cmath>
#include <cstdio>
#include <cstring>
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

extern "C" {

void lrn_free(LrnImage *h) {
  if (!h) return;
  if (h->img) LibRaw::dcraw_clear_mem(h->img);
  delete h->raw;
  delete h;
}

// quality: LibRaw user_qual (0 linear, 1 VNG, 2 PPG, 3 AHD, 4 DCB, 11 DHT, 12 AAHD). half: 1 = half size.
// Returns 0 and sets *out on success (free it with lrn_free), otherwise a LibRaw error code (lrn_error).
int lrn_decode(const unsigned char *buf, size_t size, int quality, int half, LrnImage **out) {
  *out = nullptr;
  LrnImage *h = new LrnImage();
  h->raw = new LibRaw();
  h->img = nullptr;
  libraw_output_params_t &o = h->raw->imgdata.params;
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
  int r = h->raw->open_buffer(buf, size);
  if (r == LIBRAW_SUCCESS) r = h->raw->unpack();
  if (r == LIBRAW_SUCCESS) r = h->raw->dcraw_process();
  if (r == LIBRAW_SUCCESS) {
    h->img = h->raw->dcraw_make_mem_image(&r);
    if (!h->img && r == LIBRAW_SUCCESS) r = -1;
  }
  if (r == LIBRAW_SUCCESS && (h->img->type != LIBRAW_IMAGE_BITMAP || h->img->colors != 3 || h->img->bits != 16)) r = -2;
  if (r != LIBRAW_SUCCESS) { lrn_free(h); return r; }

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
           make, model, lens, ot.iso_speed, ot.shutter, ot.aperture, ot.focal_len, (long long)ot.timestamp,
           h->raw->imgdata.sizes.flip, baseline, h->img->width, h->img->height);
  // Free LibRaw's working buffers; keep only the output image.
  h->raw->recycle();
  *out = h;
  return 0;
}

int lrn_width(const LrnImage *h) { return h->img->width; }
int lrn_height(const LrnImage *h) { return h->img->height; }
const unsigned short *lrn_data(const LrnImage *h) { return (const unsigned short *)h->img->data; }
const char *lrn_meta(const LrnImage *h) { return h->meta; }
const char *lrn_error(int code) { return code == -2 ? "Unsupported output format" : libraw_strerror(code); }

}
