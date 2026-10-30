// A private loopback channel for big pixel buffers between the native core and the web app.
//
// Tauri's IPC is built for small messages: a developed 24 MP photo (about 170 MB of half floats)
// crossed it at 30–40 MB/s, longer than developing it. The webview's network stack moves the same
// bytes over loopback HTTP many times faster. Only this app can use it: it listens on 127.0.0.1 alone,
// and every request must carry a random secret made at launch, which only the app's own page gets
// (through IPC, `pixels_server`). One connection per request, handled on its own thread.
//
//   POST /raw?key=…&file=…&quality=3&half=1&preview=1&long=0&upgrade=1   body: the RAW file →
//                             raw::decode's reply, from the disk cache of developed photos
//                             (devcache) when it is there. `upgrade`: a stored full-size develop may
//                             answer a half-size request. Headers say which: X-Half (0 or 1), X-Cached.
//                             `store=1`: develop into the cache only (photos developed ahead, in the
//                             background); the reply is empty.
//   POST /preview?key=…&file=…&long=…   body: the RAW file → its camera JPEG, decoded (raw::embedded_preview)
//   POST /inpaint?key=…&w=…&h=…   body: planar RGB bytes, then the mask (0 = fill) → the filled image,
//                             planar RGB (inpaint::fill; 404 where there's no native inpainting)
//   POST /inpaint-warm?key=…   loads the fill model in the background
//   POST /sign?key=…&mime=image/jpeg   body: u32 length, the manifest JSON, the exported file → the file
//                             with Content Credentials (credentials::sign)
//   GET  /file?key=…&path=…   a photo the app may read (in a synced folder, or one it was asked to
//                             open: the same check as the read_file command) → its bytes
//
// `file` names the file (the web app's id for it). The last few files stay here, so a photo's
// full-size develop, after its half-size one, sends an empty body; 409 asks for the file again.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};

/// The last few RAW files, by the web app's id for them, with their hash (devcache's key).
type Kept = (Arc<Vec<u8>>, Arc<String>);
static FILES: Mutex<VecDeque<(String, Kept)>> = Mutex::new(VecDeque::new());
const KEEP_FILES: usize = 3;

fn cached(id: &str) -> Option<Kept> {
    let files = FILES.lock().unwrap();
    files.iter().find(|(k, _)| k == id).map(|(_, b)| b.clone())
}

fn keep(id: &str, kept: Kept) {
    let mut files = FILES.lock().unwrap();
    files.retain(|(k, _)| k != id);
    files.push_back((id.to_string(), kept));
    while files.len() > KEEP_FILES {
        files.pop_front();
    }
}

pub struct Server {
    pub port: u16,
    pub key: String,
}

static SERVER: OnceLock<Option<Server>> = OnceLock::new();
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Starts the server once; None if the loopback port couldn't be opened (the app then uses IPC).
pub fn start(app: &tauri::AppHandle) -> Option<&'static Server> {
    let _ = APP.set(app.clone());
    SERVER
        .get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
            let port = listener.local_addr().ok()?.port();
            let mut k = [0u8; 24];
            getrandom::fill(&mut k).ok()?;
            let key: String = k.iter().map(|b| format!("{b:02x}")).collect();
            let expected = key.clone();
            std::thread::Builder::new()
                .name("pixels".into())
                .spawn(move || {
                    for stream in listener.incoming().flatten() {
                        let expected = expected.clone();
                        let _ = std::thread::Builder::new().name("pixels-req".into()).spawn(move || {
                            let _ = handle(stream, &expected);
                        });
                    }
                })
                .ok()?;
            Some(Server { port, key })
        })
        .as_ref()
}

const MAX_BODY: usize = 1 << 30;   // 1 GB: the largest RAW files are a few hundred MB

fn query_num(query: &str, name: &str) -> usize {
    query.split('&').find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('='))).and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), target_os = "linux"))]
fn inpaint_route(out: &mut TcpStream, path: &str, w: &usize, h: &usize, mut body: Vec<u8>, cors: &str) -> std::io::Result<()> {
    let Some(app) = APP.get() else { return write!(out, "HTTP/1.1 503 Service Unavailable\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n") };
    if path == "/inpaint-warm" {
        crate::inpaint::warm(app);
        return write!(out, "HTTP/1.1 204 No Content\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let (w, h) = (*w, *h);
    if w == 0 || h == 0 || body.len() != 4 * w * h {
        let msg = "bad size";
        return write!(out, "HTTP/1.1 400 Bad Request\r\n{cors}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{msg}", msg.len());
    }
    let mask = body.split_off(3 * w * h);
    match crate::inpaint::fill(app, w, h, body, mask) {
        Ok(img) => {
            write!(out, "HTTP/1.1 200 OK\r\n{cors}Content-Type: application/octet-stream\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", img.len())?;
            out.write_all(&img)?;
            out.flush()
        }
        Err(e) => write!(out, "HTTP/1.1 422 Unprocessable Entity\r\n{cors}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{e}", e.len()),
    }
}
// Elsewhere the web app's WebAssembly version does it.
#[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), target_os = "linux")))]
fn inpaint_route(out: &mut TcpStream, _path: &str, _w: &usize, _h: &usize, _body: Vec<u8>, cors: &str) -> std::io::Result<()> {
    write!(out, "HTTP/1.1 404 Not Found\r\n{cors}Content-Length: 0\r\nConnection: close\r\n\r\n")
}

/// Decodes %XX escapes (URLSearchParams encodes spaces as '+').
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |i: usize| b.get(i).and_then(|&c| (c as char).to_digit(16));
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], hex(i + 1), hex(i + 2)) {
            (b'%', Some(h), Some(l)) => {
                out.push((h * 16 + l) as u8);
                i += 3;
            }
            (b'+', _, _) => {
                out.push(b' ');
                i += 1;
            }
            (c, _, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn handle(stream: TcpStream, key: &str) -> std::io::Result<()> {
    stream.set_nodelay(true).ok();
    let mut reader = BufReader::with_capacity(1 << 16, stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let mut parts = line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
    let (mut length, mut origin) = (0usize, String::new());
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 || line == "\r\n" || line == "\n" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            match k.trim().to_ascii_lowercase().as_str() {
                "content-length" => length = v.trim().parse().unwrap_or(0),
                "origin" => origin = v.trim().to_string(),
                _ => {}
            }
        }
    }
    let mut out = stream;
    // Only the app's own page: tauri://localhost (macOS, Linux) or http(s)://tauri.localhost (Windows).
    let allowed = matches!(origin.as_str(), "tauri://localhost" | "http://tauri.localhost" | "https://tauri.localhost");
    let cors = if allowed {
        format!("Access-Control-Allow-Origin: {origin}\r\nAccess-Control-Expose-Headers: X-Half, X-Cached\r\nVary: Origin\r\n")
    } else {
        String::new()
    };
    if method == "OPTIONS" {
        return write!(out, "HTTP/1.1 204 No Content\r\n{cors}Access-Control-Allow-Methods: POST\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 86400\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let (path, query) = target.split_once('?').unwrap_or((target.as_str(), ""));
    let param = |name: &str| query.split('&').find_map(|kv| kv.strip_prefix(name).and_then(|v| v.strip_prefix('='))).unwrap_or("");
    let fail = |out: &mut TcpStream, code: &str, msg: &str| {
        write!(out, "HTTP/1.1 {code}\r\n{cors}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{msg}", msg.len())
    };
    // Constant-time comparison of the secret.
    let given = param("key").as_bytes();
    let ok_key = given.len() == key.len() && given.iter().zip(key.as_bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
    if !ok_key || !allowed {
        return fail(&mut out, "403 Forbidden", "forbidden");
    }
    if method == "GET" && path == "/file" {
        let wanted = percent_decode(param("path"));
        let Some(app) = APP.get() else { return fail(&mut out, "503 Service Unavailable", "starting") };
        let file = match crate::readable_path(app, std::path::Path::new(&wanted)) {
            Ok(p) => p,
            Err(e) => return fail(&mut out, "403 Forbidden", &e),
        };
        let mut f = match std::fs::File::open(&file) {
            Ok(f) => f,
            Err(e) => return fail(&mut out, "404 Not Found", &e.to_string()),
        };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        write!(out, "HTTP/1.1 200 OK\r\n{cors}Content-Type: application/octet-stream\r\nCache-Control: no-store\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n")?;
        std::io::copy(&mut f, &mut out)?;
        return out.flush();
    }
    if method == "POST" && (path == "/inpaint" || path == "/inpaint-warm") && length <= 64 << 20 {
        let mut b = vec![0u8; length];
        reader.read_exact(&mut b)?;
        return inpaint_route(&mut out, path, &query_num(query, "w"), &query_num(query, "h"), b, &cors);
    }
    if method != "POST" || (path != "/raw" && path != "/preview" && path != "/sign") {
        return fail(&mut out, "404 Not Found", "not found");
    }
    if length > MAX_BODY {
        return fail(&mut out, "413 Payload Too Large", "too large");
    }
    if path == "/sign" {
        let mut b = vec![0u8; length];
        reader.read_exact(&mut b)?;
        let Some(app) = APP.get() else { return fail(&mut out, "503 Service Unavailable", "starting") };
        let n = b.get(0..4).map(|x| u32::from_le_bytes(x.try_into().unwrap()) as usize).unwrap_or(usize::MAX);
        if b.len() < 4 + n {
            return fail(&mut out, "400 Bad Request", "bad body");
        }
        let manifest = String::from_utf8_lossy(&b[4..4 + n]).into_owned();
        return match crate::credentials::sign(app, &percent_decode(param("mime")), &manifest, &b[4 + n..]) {
            Ok(signed) => {
                write!(out, "HTTP/1.1 200 OK\r\n{cors}Content-Type: application/octet-stream\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", signed.len())?;
                out.write_all(&signed)?;
                out.flush()
            }
            Err(e) => fail(&mut out, "422 Unprocessable Entity", &e),
        };
    }
    let file = param("file");
    let (body, hash) = if length == 0 {
        match cached(file).filter(|_| !file.is_empty()) {
            Some(b) => b,
            None => return fail(&mut out, "409 Conflict", "send the file"),
        }
    } else {
        let mut b = vec![0u8; length];
        reader.read_exact(&mut b)?;
        let hash = Arc::new(crate::devcache::hash(&b));
        let kept = (Arc::new(b), hash);
        if !file.is_empty() {
            keep(file, kept.clone());
        }
        kept
    };
    let num = |name: &str| param(name).parse::<i64>().unwrap_or(0);
    let long = num("long").max(0) as usize;
    let ok = |out: &mut TcpStream, len: usize, half: bool, cached: bool| {
        write!(out, "HTTP/1.1 200 OK\r\n{cors}Content-Type: application/octet-stream\r\nCache-Control: no-store\r\nX-Half: {}\r\nX-Cached: {}\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n", half as u8, cached as u8)
    };
    if path == "/preview" {
        return match crate::raw::embedded_preview(&body, long) {
            Ok(reply) => {
                drop(body);
                ok(&mut out, reply.len(), false, false)?;
                out.write_all(&reply)?;
                out.flush()
            }
            Err(e) => fail(&mut out, "422 Unprocessable Entity", &e),
        };
    }
    let (quality, half, preview) = (num("quality") as i32, num("half") != 0, num("preview") != 0);
    // Developed before: straight from the disk cache, the full-size develop first when it may answer.
    let app = APP.get();
    if let Some(app) = app {
        let tries: &[bool] = if half && num("upgrade") != 0 { &[false, true] } else if half { &[true] } else { &[false] };
        for &h in tries {
            if let Some((mut f, len)) = crate::devcache::find(app, &hash, quality, h, long, preview) {
                drop(body);
                if num("store") != 0 {
                    return ok(&mut out, 0, h, true).and_then(|_| out.flush());
                }
                ok(&mut out, len as usize, h, true)?;
                std::io::copy(&mut f, &mut out)?;
                return out.flush();
            }
        }
    }
    match crate::raw::decode(&body, quality, half, preview, long) {
        Ok(reply) => {
            drop(body);
            if num("store") != 0 {
                ok(&mut out, 0, half, false)?;
            } else {
                ok(&mut out, reply.len(), half, false)?;
                out.write_all(&reply)?;
            }
            out.flush()?;
            if let Some(app) = app {
                crate::devcache::store(app, hash.to_string(), quality, half, long, reply);
            }
            Ok(())
        }
        Err(e) => fail(&mut out, "422 Unprocessable Entity", &e),
    }
}
