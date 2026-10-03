use std::sync::atomic::{AtomicI8, Ordering};

const UNKNOWN: i8 = -1;
const MOUSE: i8 = 0;
const TRACKPAD: i8 = 1;

static WHEEL_DEVICE: AtomicI8 = AtomicI8::new(UNKNOWN);

pub fn current() -> Option<&'static str> {
    match WHEEL_DEVICE.load(Ordering::Relaxed) {
        MOUSE => Some("mouse"),
        TRACKPAD => Some("trackpad"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
pub fn install(app: &tauri::AppHandle) {
    use objc2_app_kit::{NSEvent, NSEventMask};
    use std::ptr::NonNull;
    use tauri::Emitter;

    let app = app.clone();
    let handler = block2::RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let precise = unsafe { event.as_ref() }.hasPreciseScrollingDeltas();
        let (device, kind) = if precise {
            (TRACKPAD, "trackpad")
        } else {
            (MOUSE, "mouse")
        };
        if WHEEL_DEVICE.swap(device, Ordering::Relaxed) != device {
            let _ = app.emit("scroll-device", kind);
        }
        event.as_ptr()
    });
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &handler)
    };
    std::mem::forget(monitor);
    std::mem::forget(handler);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &tauri::AppHandle) {}
