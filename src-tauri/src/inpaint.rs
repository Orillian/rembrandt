// Generative Remove natively (desktop app on Apple silicon): MI-GAN (models/inpaint-migan.onnx, the same
// network the web version runs) in ONNX Runtime through Core ML, which puts it on the Neural Engine and
// GPU, where Apple's own Clean Up runs, with every CPU core for the rest. Several times faster than the
// web view's single-threaded WebAssembly, which the web app uses elsewhere (no prebuilt ONNX Runtime
// for Intel Macs; Linux's needs a newer glibc than many systems have; Windows would need DirectML).
//
// The model comes from the app's own bundled files and is loaded once, ahead of the first fill when
// the Remove tool opens (warm).

use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

fn load(app: &tauri::AppHandle) -> Result<Session, String> {
    let asset = app.asset_resolver().get("models/inpaint-migan.onnx".into()).ok_or("the fill model isn’t in this build")?;
    let env = ort::init().with_name("rembrandt").build().map_err(|e| e.to_string())?;
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let cpu = || -> Result<Session, String> {
        Session::builder(&env)
            .map_err(|e| e.to_string())?
            .with_intra_threads(threads)
            .map_err(|e| e.to_string())?
            .commit_from_memory(&asset.bytes)
            .map_err(|e| e.to_string())
    };
    #[cfg(target_os = "macos")]
    {
        use ort::ep::coreml::{ComputeUnits, ModelFormat};
        use tauri::Manager;
        // Compiled for the Neural Engine once; later launches reuse it from the cache.
        let cache = app.path().app_cache_dir().map(|d| d.join("coreml")).ok();
        if let Some(c) = &cache {
            let _ = std::fs::create_dir_all(c);
        }
        let mut coreml = ort::ep::CoreML::default().with_compute_units(ComputeUnits::All).with_model_format(ModelFormat::MLProgram);
        if let Some(c) = cache {
            coreml = coreml.with_model_cache_dir(c.to_string_lossy());
        }
        let with_coreml = Session::builder(&env)
            .map_err(|e| e.to_string())
            .and_then(|b| b.with_intra_threads(threads).map_err(|e| e.to_string()))
            .and_then(|b| b.with_execution_providers([coreml.build()]).map_err(|e| e.to_string()))
            .and_then(|mut b| b.commit_from_memory(&asset.bytes).map_err(|e| e.to_string()));
        match with_coreml {
            Ok(s) => return Ok(s),
            // Core ML turned the model down: every CPU core still beats the web version.
            Err(e) => eprintln!("inpaint: Core ML unavailable ({e}), using the CPU"),
        }
    }
    cpu()
}

/// Loads the model in the background, so the first fill doesn't wait for it.
pub fn warm(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut s = SESSION.lock().unwrap();
        if s.is_none() {
            match load(&app) {
                Ok(session) => *s = Some(session),
                Err(e) => eprintln!("inpaint model: {e}"),
            }
        }
    });
}

/// Fills the holes of a w × h image: `image` planar RGB bytes, `mask` 0 where to fill and 255 where to
/// keep (MI-GAN's convention). Returns the filled image, planar RGB.
pub fn fill(app: &tauri::AppHandle, w: usize, h: usize, image: Vec<u8>, mask: Vec<u8>) -> Result<Vec<u8>, String> {
    if image.len() != 3 * w * h || mask.len() != w * h {
        return Err("image and mask don’t match the size".into());
    }
    let mut s = SESSION.lock().unwrap();
    if s.is_none() {
        *s = Some(load(app)?);
    }
    let session = s.as_mut().unwrap();
    let out = session
        .run(ort::inputs![
            "image" => Tensor::from_array(([1usize, 3, h, w], image)).map_err(|e| e.to_string())?,
            "mask" => Tensor::from_array(([1usize, 1, h, w], mask)).map_err(|e| e.to_string())?,
        ])
        .map_err(|e| e.to_string())?;
    let (_, data) = out["result"].try_extract_tensor::<u8>().map_err(|e| e.to_string())?;
    Ok(data.to_vec())
}
