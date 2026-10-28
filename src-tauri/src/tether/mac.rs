// Tethering on macOS with ImageCaptureCore, the system's own camera framework (as Image Capture and
// Photos use): it finds cameras on USB, opens a session, fires the shutter, and reports each new
// photo, which is downloaded into the tether folder. No driver to install; Nikon, Canon, Sony and
// most PTP cameras work.
//
// ImageCaptureCore calls back on the thread that started it, here the main thread (its run loop is
// the app's), so everything below runs there; commands hop over with run_on_main_thread.

use std::cell::RefCell;
use std::sync::OnceLock;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, MainThreadMarker, MainThreadOnly, Message};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSData, NSDictionary, NSError, NSNumber, NSString, NSURL};
use objc2_image_capture_core::{
    ICCameraDevice, ICCameraDeviceCanTakePicture, ICCameraDeviceDelegate, ICCameraDeviceDownloadDelegate, ICCameraFile,
    ICCameraItem, ICDevice, ICDeviceBrowser, ICDeviceBrowserDelegate, ICDeviceDelegate, ICDeviceLocationTypeMask,
    ICDeviceTypeMask, ICDownloadOption, ICDownloadsDirectoryURL, ICOverwrite, ICSavedFilename,
};

use super::{emit, Camera, Event};

static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

struct State {
    browser: Retained<ICDeviceBrowser>,
    delegate: Retained<Delegate>,
    cameras: Vec<Retained<ICCameraDevice>>,
    active: Option<Retained<ICCameraDevice>>,
    // The card's photos are listed when a session opens: only photos added after that are new shots.
    ready: bool,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn handle() -> &'static tauri::AppHandle {
    APP.get().expect("tethering started")
}

fn id_of(d: &ICDevice) -> String {
    unsafe { d.UUIDString() }.map(|s| s.to_string()).unwrap_or_default()
}

fn name_of(d: &ICDevice) -> String {
    unsafe { d.name() }.map(|s| s.to_string()).unwrap_or_else(|| "Camera".into())
}

// Objective-C exceptions (a call the system doesn't support, a camera in a strange state) become an
// error in the Tether bar: the release build ends the app on anything that unwinds.
fn guarded<R>(what: &str, f: impl FnOnce() -> R) -> Option<R> {
    match objc2::exception::catch(std::panic::AssertUnwindSafe(f)) {
        Ok(r) => Some(r),
        Err(e) => {
            let why = e.map(|e| format!("{e:?}")).unwrap_or_default();
            emit(handle(), Event::Error { message: format!("The camera system refused to {what}. {why}") });
            None
        }
    }
}

fn send_cameras() {
    let cameras = STATE.with_borrow(|s| {
        s.as_ref().map(|s| s.cameras.iter().map(|c| Camera { id: id_of(c), name: name_of(c) }).collect()).unwrap_or_default()
    });
    emit(handle(), Event::Cameras { cameras });
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and the delegate keeps no state of its own.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "RembrandtTetherDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl ICDeviceBrowserDelegate for Delegate {
        #[unsafe(method(deviceBrowser:didAddDevice:moreComing:))]
        fn did_add_device(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more: bool) {
            if let Ok(camera) = device.retain().downcast::<ICCameraDevice>() {
                STATE.with_borrow_mut(|s| {
                    if let Some(s) = s {
                        if !s.cameras.iter().any(|c| id_of(c) == id_of(&camera)) {
                            s.cameras.push(camera);
                        }
                    }
                });
                send_cameras();
            }
        }

        #[unsafe(method(deviceBrowser:didRemoveDevice:moreGoing:))]
        fn did_remove_device(&self, _browser: &ICDeviceBrowser, device: &ICDevice, _more: bool) {
            gone(device);
        }
    }

    unsafe impl ICDeviceDelegate for Delegate {
        #[unsafe(method(device:didCloseSessionWithError:))]
        fn did_close_session(&self, device: &ICDevice, error: Option<&NSError>) {
            let was = STATE.with_borrow_mut(|s| {
                let s = s.as_mut()?;
                let active = s.active.as_ref().is_some_and(|a| id_of(a) == id_of(device));
                if active {
                    s.active = None;
                    s.ready = false;
                }
                Some(active)
            });
            if was == Some(true) {
                emit(handle(), Event::Disconnected { id: id_of(device), reason: error.map(|e| e.localizedDescription().to_string()) });
            }
        }

        #[unsafe(method(didRemoveDevice:))]
        fn did_remove(&self, device: &ICDevice) {
            gone(device);
        }

        #[unsafe(method(device:didOpenSessionWithError:))]
        fn did_open_session(&self, device: &ICDevice, error: Option<&NSError>) {
            if let Some(e) = error {
                STATE.with_borrow_mut(|s| if let Some(s) = s { s.active = None });
                emit(handle(), Event::Error { message: open_error(&e.localizedDescription().to_string()) });
                return;
            }
            let can_capture = unsafe { device.capabilities() }.iter().any(|c| &*c == unsafe { ICCameraDeviceCanTakePicture });
            emit(handle(), Event::Connected { id: id_of(device), name: name_of(device), can_capture });
        }

        #[unsafe(method(device:didEncounterError:))]
        fn did_encounter_error(&self, _device: &ICDevice, error: Option<&NSError>) {
            if let Some(e) = error {
                emit(handle(), Event::Error { message: e.localizedDescription().to_string() });
            }
        }
    }

    unsafe impl ICCameraDeviceDelegate for Delegate {
        #[unsafe(method(cameraDevice:didAddItems:))]
        fn did_add_items(&self, camera: &ICCameraDevice, items: &NSArray<ICCameraItem>) {
            let ready = STATE.with_borrow(|s| s.as_ref().is_some_and(|s| s.ready && s.active.as_ref().is_some_and(|a| id_of(a) == id_of(camera))));
            if ready {
                new_photos(camera, items);
            }
        }

        #[unsafe(method(cameraDevice:didRemoveItems:))]
        fn did_remove_items(&self, _camera: &ICCameraDevice, _items: &NSArray<ICCameraItem>) {}

        #[unsafe(method(cameraDevice:didReceiveThumbnail:forItem:error:))]
        fn did_receive_thumbnail(&self, _camera: &ICCameraDevice, _thumbnail: Option<&CGImage>, _item: &ICCameraItem, _error: Option<&NSError>) {}

        #[unsafe(method(cameraDevice:didReceiveMetadata:forItem:error:))]
        fn did_receive_metadata(&self, _camera: &ICCameraDevice, _metadata: Option<&NSDictionary>, _item: &ICCameraItem, _error: Option<&NSError>) {}

        #[unsafe(method(cameraDevice:didRenameItems:))]
        fn did_rename_items(&self, _camera: &ICCameraDevice, _items: &NSArray<ICCameraItem>) {}

        #[unsafe(method(cameraDeviceDidChangeCapability:))]
        fn did_change_capability(&self, camera: &ICCameraDevice) {
            let active = STATE.with_borrow(|s| s.as_ref().is_some_and(|s| s.ready && s.active.as_ref().is_some_and(|a| id_of(a) == id_of(camera))));
            if active {
                let can_capture = unsafe { camera.capabilities() }.iter().any(|c| &*c == unsafe { ICCameraDeviceCanTakePicture });
                emit(handle(), Event::Connected { id: id_of(camera), name: name_of(camera), can_capture });
            }
        }

        #[unsafe(method(cameraDevice:didReceivePTPEvent:))]
        fn did_receive_ptp_event(&self, _camera: &ICCameraDevice, _event: &NSData) {}

        #[unsafe(method(deviceDidBecomeReadyWithCompleteContentCatalog:))]
        fn did_become_ready(&self, device: &ICCameraDevice) {
            STATE.with_borrow_mut(|s| {
                if let Some(s) = s {
                    if s.active.as_ref().is_some_and(|a| id_of(a) == id_of(device)) {
                        s.ready = true;
                    }
                }
            });
        }

        #[unsafe(method(cameraDeviceDidRemoveAccessRestriction:))]
        fn did_remove_restriction(&self, _device: &ICDevice) {}

        #[unsafe(method(cameraDeviceDidEnableAccessRestriction:))]
        fn did_enable_restriction(&self, _device: &ICDevice) {}

        // The card's existing photos need neither thumbnails nor metadata: a session opens faster.
        #[unsafe(method(cameraDevice:shouldGetThumbnailOfItem:))]
        fn should_get_thumbnail(&self, _camera: &ICCameraDevice, _item: &ICCameraItem) -> bool {
            false
        }

        #[unsafe(method(cameraDevice:shouldGetMetadataOfItem:))]
        fn should_get_metadata(&self, _camera: &ICCameraDevice, _item: &ICCameraItem) -> bool {
            false
        }
    }

    unsafe impl ICCameraDeviceDownloadDelegate for Delegate {
        // A download finished: the file is in the folder under the name in ICSavedFilename.
        #[unsafe(method(didDownloadFile:error:options:contextInfo:))]
        fn did_download(&self, file: &ICCameraFile, error: Option<&NSError>, options: &NSDictionary<NSString, AnyObject>, _context: *mut std::ffi::c_void) {
            if let Some(e) = error {
                let name = unsafe { file.name() }.map(|n| n.to_string()).unwrap_or_default();
                return emit(handle(), Event::Error { message: format!("{name} couldn’t be saved: {}", e.localizedDescription()) });
            }
            let saved = options.objectForKey(unsafe { ICSavedFilename }).and_then(|v| v.downcast::<NSString>().ok()).map(|n| n.to_string());
            let name = saved.or_else(|| unsafe { file.name() }.map(|n| n.to_string()));
            match (super::folder(handle()), name) {
                (Ok(dir), Some(name)) => super::arrived(handle(), dir.join(name)),
                (Err(e), _) => emit(handle(), Event::Error { message: e }),
                _ => {}
            }
        }
    }
);

impl Delegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), init] }
    }
}

// Something else has the camera (Image Capture, Photos, Nikon's own software): say what to do.
fn open_error(msg: &str) -> String {
    format!("Couldn’t connect to the camera ({msg}). Quit apps that may be using it, such as Image Capture or Photos, then switch the camera off and on.")
}

fn gone(device: &ICDevice) {
    let id = id_of(device);
    let was_active = STATE.with_borrow_mut(|s| {
        let s = s.as_mut()?;
        s.cameras.retain(|c| id_of(c) != id);
        let active = s.active.as_ref().is_some_and(|a| id_of(a) == id);
        if active {
            s.active = None;
            s.ready = false;
        }
        Some(active)
    });
    if was_active == Some(true) {
        emit(handle(), Event::Disconnected { id, reason: Some("The camera was disconnected".into()) });
    }
    send_cameras();
}

const RAW: &[&str] = &["nef", "nrw", "cr2", "cr3", "crw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "dng", "3fr", "iiq", "srw", "x3f", "erf", "kdc", "mrw", "mos"];

fn ext(name: &str) -> String {
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

// New shots: each downloaded into the folder. RAW + JPEG pairs bring only the RAW.
fn new_photos(camera: &ICCameraDevice, items: &NSArray<ICCameraItem>) {
    let Some(delegate) = STATE.with_borrow(|s| s.as_ref().map(|s| s.delegate.clone())) else { return };
    let files: Vec<Retained<ICCameraFile>> = items.iter().filter_map(|i| i.downcast::<ICCameraFile>().ok()).collect();
    let names: Vec<String> = files.iter().map(|f| unsafe { f.name() }.map(|n| n.to_string()).unwrap_or_default()).collect();
    let stem = |n: &str| n.rsplit_once('.').map(|(s, _)| s.to_ascii_lowercase()).unwrap_or_default();
    let folder = match super::folder(handle()) {
        Ok(f) => f,
        Err(e) => return emit(handle(), Event::Error { message: e }),
    };
    let dir = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&folder.to_string_lossy()), true);
    for (file, name) in files.iter().zip(&names) {
        let e = ext(name);
        let raw_twin = matches!(e.as_str(), "jpg" | "jpeg" | "heif" | "hif") && names.iter().any(|o| o != name && stem(o) == stem(name) && RAW.contains(&ext(o).as_str()));
        if raw_twin || (!RAW.contains(&e.as_str()) && !matches!(e.as_str(), "jpg" | "jpeg" | "tif" | "tiff" | "heic" | "heif" | "hif" | "png")) {
            continue;
        }
        emit(handle(), Event::Shot { name: name.clone() });
        let keys: [&ICDownloadOption; 2] = unsafe { [ICDownloadsDirectoryURL, ICOverwrite] };
        let no = NSNumber::new_bool(false);
        let values: [&AnyObject; 2] = [(*dir).as_ref(), (*no).as_ref()];
        let options = NSDictionary::from_slices(&keys, &values);
        // The long-standing macOS download call; the delegate hears when it's done (did_download).
        guarded("save the photo", || unsafe {
            camera.requestDownloadFile_options_downloadDelegate_didDownloadSelector_contextInfo(
                file,
                &options,
                ProtocolObject::from_ref(&*delegate),
                objc2::sel!(didDownloadFile:error:options:contextInfo:),
                std::ptr::null_mut(),
            )
        });
    }
}

fn on_main(app: &tauri::AppHandle, f: impl FnOnce(MainThreadMarker) + Send + 'static) -> Result<(), String> {
    app.run_on_main_thread(move || f(MainThreadMarker::new().expect("main thread"))).map_err(|e| e.to_string())
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let _ = APP.set(app.clone());
    on_main(app, |mtm| {
        if STATE.with_borrow(|s| s.is_some()) {
            send_cameras();
            return;
        }
        // No authorization request: that call exists on iPhone and iPad only (on a Mac it throws).
        let delegate = Delegate::new(mtm);
        let Some(browser) = guarded("look for cameras", || unsafe {
            let browser = ICDeviceBrowser::init(ICDeviceBrowser::alloc());
            browser.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            browser.setBrowsedDeviceTypeMask(ICDeviceTypeMask(ICDeviceTypeMask::Camera.0 | ICDeviceLocationTypeMask::Local.0));
            browser
        }) else {
            return;
        };
        STATE.with_borrow_mut(|s| *s = Some(State { browser: browser.clone(), delegate, cameras: Vec::new(), active: None, ready: false }));
        guarded("look for cameras", || unsafe { browser.start() });
        send_cameras();
    })
}

pub fn connect(app: &tauri::AppHandle, id: String) -> Result<(), String> {
    on_main(app, move |_| {
        // Calls that may call back (closing a session) run outside the borrow of STATE.
        let mut old = None;
        let found = STATE.with_borrow_mut(|s| {
            let s = s.as_mut()?;
            let cam = s.cameras.iter().find(|c| id_of(c) == id)?.clone();
            old = s.active.take().filter(|o| id_of(o) != id);
            unsafe { cam.setDelegate(Some(ProtocolObject::from_ref(&*s.delegate))) };
            s.active = Some(cam.clone());
            s.ready = false;
            Some(cam)
        });
        if let Some(old) = old {
            guarded("close the camera", || unsafe { old.requestCloseSession() });
        }
        match found {
            Some(cam) if unsafe { cam.hasOpenSession() } => {
                let can_capture = unsafe { cam.capabilities() }.iter().any(|c| &*c == unsafe { ICCameraDeviceCanTakePicture });
                STATE.with_borrow_mut(|s| if let Some(s) = s { s.ready = true });
                emit(handle(), Event::Connected { id: id_of(&cam), name: name_of(&cam), can_capture });
            }
            Some(cam) => {
                guarded("connect to the camera", || unsafe { cam.requestOpenSession() });
            }
            None => emit(handle(), Event::Error { message: "That camera isn’t connected any more".into() }),
        }
    })
}

pub fn capture(app: &tauri::AppHandle) -> Result<(), String> {
    on_main(app, |_| {
        let cam = STATE.with_borrow(|s| s.as_ref().and_then(|s| if s.ready { s.active.clone() } else { None }));
        match cam {
            Some(cam) => {
                guarded("take a photo", || unsafe { cam.requestTakePicture() });
            }
            None => emit(handle(), Event::Error { message: "Connect a camera first".into() }),
        }
    })
}

pub fn disconnect(app: &tauri::AppHandle) -> Result<(), String> {
    on_main(app, |_| {
        let cam = STATE.with_borrow_mut(|s| {
            let s = s.as_mut()?;
            s.ready = false;
            s.active.take()
        });
        if let Some(cam) = cam {
            guarded("close the camera", || unsafe { cam.requestCloseSession() });
            emit(handle(), Event::Disconnected { id: id_of(&cam), reason: None });
        }
    })
}
