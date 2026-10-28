// Tethered shooting: the camera on a USB cable, its shutter fired from the app (or the camera's own
// button), each photo saved into a folder on this computer and opened in the editor as it lands.
//
// One interface over each system's own camera support: ImageCaptureCore on macOS (mac.rs); libgphoto2
// on Linux, loaded only when it's installed (gphoto.rs). The web app drives it with the commands below
// and hears back through "tether" events (Event).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
use mac as backend;
#[cfg(target_os = "linux")]
mod gphoto;
#[cfg(target_os = "linux")]
use gphoto as backend;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod none;
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
use none as backend;

#[derive(Serialize, Clone)]
pub struct Camera {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Event {
    /// The cameras connected now.
    Cameras { cameras: Vec<Camera> },
    /// A session is open: `capture` says whether the app can fire the shutter (otherwise only the
    /// camera's own button works).
    #[serde(rename_all = "camelCase")]
    Connected { id: String, name: String, can_capture: bool },
    Disconnected { id: String, reason: Option<String> },
    /// The camera took a photo; it is on its way.
    Shot { name: String },
    /// A photo arrived in the folder: the web app may read it.
    Photo { path: String, name: String, size: u64, modified: u64 },
    Error { message: String },
}

pub fn emit(app: &tauri::AppHandle, ev: Event) {
    let _ = app.emit("tether", ev);
}

static FOLDER: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Where photos go: the chosen folder, or Pictures/Rembrandt Tethered.
pub fn folder(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(f) = FOLDER.lock().unwrap().clone() {
        return Ok(f);
    }
    let base = app.path().picture_dir().or_else(|_| app.path().home_dir()).map_err(|e| e.to_string())?;
    let f = base.join("Rembrandt Tethered");
    std::fs::create_dir_all(&f).map_err(|e| e.to_string())?;
    let f = f.canonicalize().map_err(|e| e.to_string())?;
    crate::allow_root(app, &f);
    *FOLDER.lock().unwrap() = Some(f.clone());
    Ok(f)
}

/// A photo landed: the web app may read it, and hears about it.
pub fn arrived(app: &tauri::AppHandle, path: PathBuf) {
    match crate::allow_photo(app, &path) {
        Some(e) => emit(app, Event::Photo { path: e.path, name: e.name, size: e.size, modified: e.modified }),
        None => emit(app, Event::Error { message: format!("{} isn't a photo Rembrandt can open", path.display()) }),
    }
}

#[derive(Serialize)]
pub struct Info {
    supported: bool,
    folder: String,
    /// What the system needs for tethering when it's missing (Linux: libgphoto2), for the web app to say.
    missing: Option<String>,
}

/// Starts looking for cameras (a Cameras event follows, and another whenever one comes or goes).
#[tauri::command]
pub async fn tether_start(app: tauri::AppHandle) -> Result<Info, String> {
    let folder = folder(&app)?.to_string_lossy().into_owned();
    match backend::start(&app) {
        Ok(()) => Ok(Info { supported: true, folder, missing: None }),
        Err(missing) => Ok(Info { supported: false, folder, missing: Some(missing) }),
    }
}

#[tauri::command]
pub async fn tether_connect(app: tauri::AppHandle, id: String) -> Result<(), String> {
    backend::connect(&app, id)
}

#[tauri::command]
pub async fn tether_capture(app: tauri::AppHandle) -> Result<(), String> {
    backend::capture(&app)
}

#[tauri::command]
pub async fn tether_disconnect(app: tauri::AppHandle) -> Result<(), String> {
    backend::disconnect(&app)
}

/// Photos go into `path` from now on: a folder the user picked (pick_folder), so already allowed.
#[tauri::command]
pub async fn tether_folder(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let p = crate::readable_path(&app, std::path::Path::new(&path))?;
    if !p.is_dir() {
        return Err("Not a folder".into());
    }
    *FOLDER.lock().unwrap() = Some(p.clone());
    Ok(p.to_string_lossy().into_owned())
}
