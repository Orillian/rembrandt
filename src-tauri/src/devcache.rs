// Developed RAW photos kept on disk, so opening a photo again (in this session or a later one) reads
// its developed pixels instead of running LibRaw again: a few tens of milliseconds from an SSD
// instead of a second or more of demosaicing.
//
// An entry is raw::decode's reply, named by the SHA-256 of the RAW file and the develop settings, in
// the app's cache folder (developed/). A full-size develop is stored with the small preview of the
// half-size one, so it can stand in for both. The app's version is in the name: a new version, which
// may develop differently, starts afresh. The oldest entries go once the folder passes LIMIT.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::SystemTime;

use sha2::{Digest, Sha256};
use tauri::Manager;

const LIMIT: u64 = 16 << 30;   // 16 GB: about 55 full-size 36 MP photos, or 220 half-size ones

pub fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

fn dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("developed"))
}

fn path(app: &tauri::AppHandle, hash: &str, quality: i32, half: bool, long: usize) -> Option<PathBuf> {
    let size = if half { "half" } else { "full" };
    dir(app).map(|d| d.join(format!("{hash}-{}-q{quality}-{size}-{long}.lrn", env!("CARGO_PKG_VERSION"))))
}

/// The header of a reply: [w, h, preview w, preview h, meta length].
fn header(b: &[u8]) -> Option<[usize; 5]> {
    if b.len() < 24 || &b[0..4] != b"LRN1" {
        return None;
    }
    let n = |i: usize| u32::from_le_bytes(b[4 + i * 4..8 + i * 4].try_into().unwrap()) as usize;
    Some([n(0), n(1), n(2), n(3), n(4)])
}

/// A stored develop: the open file and its length, if there is one (with a preview when `preview`).
pub fn find(app: &tauri::AppHandle, hash: &str, quality: i32, half: bool, long: usize, preview: bool) -> Option<(fs::File, u64)> {
    let p = path(app, hash, quality, half, long)?;
    let mut f = fs::File::open(&p).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = [0u8; 24];
    f.read_exact(&mut head).ok()?;
    let [w, h, pw, _, _] = header(&head)?;
    if (preview && pw == 0) || w == 0 || h == 0 {
        return None;
    }
    // Recently used: last to go.
    if let Ok(t) = fs::File::options().write(true).open(&p) {
        let _ = t.set_modified(SystemTime::now());
    }
    let f = fs::File::open(&p).ok()?;
    Some((f, len))
}

/// Stores a develop (on its own thread: the reply has already gone to the app).
pub fn store(app: &tauri::AppHandle, hash: String, quality: i32, half: bool, long: usize, reply: Vec<u8>) {
    let app = app.clone();
    let _ = std::thread::Builder::new().name("devcache".into()).spawn(move || {
        let Some(d) = dir(&app) else { return };
        let Some(p) = path(&app, &hash, quality, half, long) else { return };
        if fs::create_dir_all(&d).is_err() {
            return;
        }
        let mut reply = reply;
        // A full-size develop without a preview borrows the half-size one's.
        if !half {
            if let (Some([w, h, 0, _, ml]), Some(small)) = (header(&reply), path(&app, &hash, quality, true, long).and_then(|s| fs::read(s).ok())) {
                if let Some([_, _, pw, ph, sml]) = header(&small) {
                    let pad = |n: usize| (4 - n % 4) % 4;
                    let (at, sat) = (24 + ml + pad(ml), 24 + sml + pad(sml));
                    if pw > 0 && small.len() >= sat + pw * ph * 4 && reply.len() == at + w * h * 8 {
                        let mut out = Vec::with_capacity(reply.len() + pw * ph * 4);
                        out.extend_from_slice(&reply[..at]);
                        out[12..16].copy_from_slice(&(pw as u32).to_le_bytes());
                        out[16..20].copy_from_slice(&(ph as u32).to_le_bytes());
                        out.extend_from_slice(&small[sat..sat + pw * ph * 4]);
                        out.extend_from_slice(&reply[at..]);
                        reply = out;
                    }
                }
            }
        }
        // Its own temporary name: two develops of one photo may finish together.
        let n = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let tmp = p.with_extension(format!("{n}.part"));
        let ok = fs::File::create(&tmp).and_then(|mut f| f.write_all(&reply)).is_ok();
        drop(reply);
        if !ok || fs::rename(&tmp, &p).is_err() {
            let _ = fs::remove_file(&tmp);
            return;
        }
        trim(&d);
    });
}

/// Removes the least recently used entries (and those of older versions first) over LIMIT.
fn trim(d: &std::path::Path) {
    let Ok(list) = fs::read_dir(d) else { return };
    let version = format!("-{}-", env!("CARGO_PKG_VERSION"));
    let mut files: Vec<(bool, SystemTime, u64, PathBuf)> = list
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            Some((name.contains(&version), m.modified().ok()?, m.len(), e.path()))
        })
        .collect();
    files.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)));
    let mut total: u64 = files.iter().map(|f| f.2).sum();
    for (current, _, len, p) in files {
        if total <= LIMIT && current {
            break;
        }
        if fs::remove_file(&p).is_ok() {
            total -= len;
        }
    }
}
