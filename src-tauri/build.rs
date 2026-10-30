// Builds the Tauri app, and on desktop compiles LibRaw (native/LibRaw) with Rembrandt's native wrapper
// (native/lumen_raw_native.cpp) so RAW files develop in native code on every core instead of in
// WebAssembly. The same LibRaw sources as the WebAssembly build (native/build-libraw.sh).
use std::path::Path;

// LibRaw's sources, as native/build-libraw.sh lists them.
const LIBRAW: &[&str] = &[
    "libraw_datastream",
    "libraw_c_api",
    "cameralist",
    "fuji_compressed",
    "crx",
    "fp_dng",
    "decoders_libraw",
    "unpack",
    "unpack_thumb",
    "colorconst",
    "utils_libraw",
    "init_close_utils",
    "decoder_info",
    "open",
    "phaseone_processing",
    "thumb_utils",
    "tiff_writer",
    "subtract_black",
    "postprocessing_utils",
    "dcraw_process",
    "raw2image",
    "mem_image",
    "x3f_utils_patched",
    "x3f_parse_process",
    "read_utils",
    "curves",
    "utils_dcraw",
    "colordata",
    "canon_600",
    "decoders_dcraw",
    "decoders_libraw_dcrdefs",
    "generic",
    "kodak_decoders",
    "dng",
    "smal",
    "load_mfbacks",
    "sony",
    "nikon",
    "samsung",
    "cr3_parser",
    "canon",
    "epson",
    "olympus",
    "leica",
    "fuji",
    "adobepano",
    "pentax",
    "p1",
    "makernotes",
    "exif_gps",
    "kodak",
    "tiff",
    "ciff",
    "mediumformat",
    "minolta",
    "identify_tools",
    "hasselblad_model",
    "normalize_model",
    "identify",
    "misc_parsers",
    "wblists",
    "postprocessing_aux",
    "postprocessing_utils_dcrdefs",
    "aspect_ratio",
    "misc_demosaic",
    "xtrans_demosaic",
    "ahd_demosaic",
    "dht_demosaic",
    "aahd_demosaic",
    "dcb_demosaic",
    "file_write",
    "ext_preprocess",
    "apply_profile",
];

fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    // Apple silicon: ONNX Runtime (Generative Remove, src/inpaint.rs) checks the macOS version with
    // ___isPlatformVersionAtLeast, from the compiler's runtime library, which Rust's link leaves out.
    if os == "macos" && std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("aarch64") {
        if let Ok(out) = std::process::Command::new("xcrun").args(["clang", "--print-resource-dir"]).output() {
            let dir = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !dir.is_empty() {
                println!("cargo:rustc-link-search=native={dir}/lib/darwin");
                println!("cargo:rustc-link-lib=static=clang_rt.osx");
            }
        }
    }
    if matches!(os.as_str(), "macos" | "windows" | "linux") {
        let native = Path::new("../native");
        let mut b = cc::Build::new();
        b.cpp(true).include(native.join("LibRaw")).warnings(false).opt_level(3);
        // Not LIBRAW_NOTHREADS (the WebAssembly build's setting): that makes LibRaw's decoders share
        // global state, and the app develops on several threads at once.
        b.define("NO_LCMS", None).define("NO_JASPER", None).define("NO_JPEG", None);
        if os == "windows" {
            b.define("LIBRAW_NODLL", None).define("_CRT_SECURE_NO_WARNINGS", None).flag_if_supported("/EHsc");
            println!("cargo:rustc-link-lib=ws2_32");
        }
        // Release builds are fast whatever the profile: a debug LibRaw would take many seconds per photo.
        b.debug(false);
        for name in LIBRAW {
            let root = native.join("LibRaw/src");
            let dirs = std::iter::once(root.clone()).chain(std::fs::read_dir(&root).unwrap().flatten().map(|d| d.path()).filter(|p| p.is_dir()));
            let src = dirs.map(|d| d.join(format!("{name}.cpp"))).find(|p| p.exists()).unwrap_or_else(|| panic!("LibRaw source {name}.cpp not found"));
            b.file(src);
        }
        b.file(native.join("lumen_raw_native.cpp"));
        b.compile("lumen_raw");
        println!("cargo:rerun-if-changed=../native/lumen_raw_native.cpp");
    }
    tauri_build::build()
}
