use super::gesture::TriggerGesture;
use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use once_cell::sync::Lazy;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, AtomicI32, AtomicIsize, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use windows::{
    core::{HSTRING, PWSTR},
    Win32::{
        Foundation::{CloseHandle, HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM},
        System::{
            LibraryLoader::GetModuleHandleW,
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Input::KeyboardAndMouse::GetAsyncKeyState,
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::*,
        },
    },
};

static ID: AtomicU64 = AtomicU64::new(1);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static HOOK_ENABLED: AtomicBool = AtomicBool::new(false);
static TAP_MODE: AtomicBool = AtomicBool::new(true);
static TRIGGER_KEY: AtomicI32 = AtomicI32::new(0xa2);
static STARTED_AT: Lazy<Instant> = Lazy::new(Instant::now);
static GESTURE: Lazy<Mutex<TriggerGesture>> = Lazy::new(|| Mutex::new(TriggerGesture::default()));
static TAPS: Lazy<Mutex<VecDeque<(Instant, Point)>>> = Lazy::new(|| Mutex::new(VecDeque::new()));
static CLOSE_REQUEST: AtomicBool = AtomicBool::new(false);
static STARTED: Lazy<Mutex<Option<Instant>>> = Lazy::new(|| Mutex::new(None));
static TIMINGS: Lazy<Mutex<Value>> = Lazy::new(|| Mutex::new(json!({})));
static READY: AtomicBool = AtomicBool::new(false);
static ARMED: AtomicBool = AtomicBool::new(false);
static MOUSE_CAPTURED: AtomicBool = AtomicBool::new(false);
static SCROLLED: AtomicBool = AtomicBool::new(false);
static POINT_AT_PROBE: Lazy<Mutex<Point>> = Lazy::new(|| Mutex::new(Point::default()));
static TARGET: Lazy<Mutex<Option<Rect>>> = Lazy::new(|| Mutex::new(None));
static POPUP: Lazy<Mutex<Option<Rect>>> = Lazy::new(|| Mutex::new(None));
static DRAG: Lazy<Mutex<Option<Drag>>> = Lazy::new(|| Mutex::new(None));
static LAST_ERROR: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
static PROBES: AtomicU64 = AtomicU64::new(0);
static CAPTURES: AtomicU64 = AtomicU64::new(0);
// Windows drops low level hooks whose owner looks unresponsive, which silently
// kills the global trigger until the app restarts. Keep the handles so the
// watchdog can reinstall them.
static KEYBOARD_HOOK: AtomicIsize = AtomicIsize::new(0);
static MOUSE_HOOK: AtomicIsize = AtomicIsize::new(0);
static TAP_SEEN: AtomicU64 = AtomicU64::new(0);
// Recogniser that won the last automatic language decision. Keeping it avoids
// paying for a speculative second full OCR pass on every lookup.
static OCR_PREFERENCE: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));
// Top-left corner captured when the user starts dragging the popup.
static POPUP_DRAG: Lazy<Mutex<Option<(i32, i32)>>> = Lazy::new(|| Mutex::new(None));
// Once the user moves the popup, later content updates must not re-anchor it.
static MOVED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    enabled: bool,
    trigger: String,
    activation_mode: String,
    interval_ms: u64,
    width: u32,
    height: u32,
    offset_x: i32,
    offset_y: i32,
    ocr_engine: String,
    ocr_language: String,
    app_mode: String,
    applications: Vec<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            trigger: "LeftControl".into(),
            activation_mode: "tap".into(),
            interval_ms: 250,
            width: 100,
            height: 40,
            offset_x: -50,
            offset_y: -20,
            ocr_engine: "auto".into(),
            ocr_language: "auto".into(),
            app_mode: "blacklist".into(),
            applications: vec![],
        }
    }
}
fn settings() -> Settings {
    crate::config::get("hover_settings")
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}
fn key(code: i32) -> bool {
    unsafe { GetAsyncKeyState(code) < 0 }
}
fn trigger_code(name: &str) -> i32 {
    match name {
        "LeftAlt" => 0xa4,
        "RightAlt" => 0xa5,
        "LeftShift" => 0xa0,
        "RightControl" => 0xa3,
        _ => 0xa2,
    }
}
#[allow(dead_code)]
fn chord_pressed(trigger: i32) -> bool {
    // Do not turn a normal Ctrl+C/Ctrl+V (or another modified shortcut) into a lookup.
    (0x20..=0x7f).any(key)
        || key(0x5b)
        || key(0x5c)
        || (trigger != 0xa0 && key(0x10))
        || (trigger != 0xa4 && trigger != 0xa5 && key(0x12))
}
fn point() -> Point {
    let mut p = POINT::default();
    unsafe {
        let _ = GetCursorPos(&mut p);
    }
    Point { x: p.x, y: p.y }
}
fn foreground() -> (isize, String, u32) {
    unsafe {
        let hwnd = GetForegroundWindow();
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let mut name = String::new();
        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buffer = vec![0u16; 4096];
            let mut length = buffer.len() as u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut length,
            )
            .is_ok()
            {
                name = String::from_utf16_lossy(&buffer[..length as usize])
                    .rsplit(['\\', '/'])
                    .next()
                    .unwrap_or("")
                    .to_lowercase();
            }
            let _ = CloseHandle(handle);
        }
        (hwnd.0 as isize, name, pid)
    }
}
fn allowed(s: &Settings, name: &str) -> bool {
    let listed = s.applications.iter().any(|entry| {
        entry
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case(name)
    });
    if s.app_mode == "whitelist" {
        !name.is_empty() && listed
    } else {
        !listed
    }
}
pub fn valid(id: u64) -> bool {
    READY.load(Ordering::SeqCst) && ACTIVE.load(Ordering::SeqCst) && ID.load(Ordering::SeqCst) == id
}
pub fn ready() {
    READY.store(true, Ordering::SeqCst);
    log::info!("Ctrlword hover renderer ready after {}ms", STARTED_AT.elapsed().as_millis());
}
pub fn status() -> Value {
    json!({"supported":true,"ready":READY.load(Ordering::SeqCst),"probes":PROBES.load(Ordering::Relaxed),
    "captures":CAPTURES.load(Ordering::Relaxed),"lastError":LAST_ERROR.lock().unwrap().clone(),
    "activationMode":if TAP_MODE.load(Ordering::SeqCst) {"tap"} else {"hold"},
    "timings":TIMINGS.lock().unwrap().clone()})
}
pub fn timing(id: u64, phase: &str) {
    if !valid(id) || !["popupMs", "firstDefinitionMs", "completeMs"].contains(&phase) {
        return;
    }
    if let Some(start) = *STARTED.lock().unwrap() {
        let elapsed = start.elapsed().as_millis() as u64;
        let mut values = TIMINGS.lock().unwrap();
        if values.get(phase).is_none() {
            values[phase] = json!(elapsed);
            log::info!("Ctrlword timing: {}={}ms", phase, elapsed);
        }
    }
}
pub fn target(id: u64, rect: Rect) -> bool {
    if !valid(id) {
        return false;
    }
    *TARGET.lock().unwrap() = Some(rect);
    true
}
pub fn drag_state() -> Option<Drag> {
    DRAG.lock().unwrap().clone()
}
pub fn finish_drag() {
    *DRAG.lock().unwrap() = None;
}
pub fn invalidate(app: &tauri::AppHandle) {
    ACTIVE.store(false, Ordering::SeqCst);
    ID.fetch_add(1, Ordering::SeqCst);
    *TARGET.lock().unwrap() = None;
    *POPUP.lock().unwrap() = None;
    *POPUP_DRAG.lock().unwrap() = None;
    // Every new lookup anchors itself next to the word again.
    MOVED.store(false, Ordering::SeqCst);
    if let Some(window) = app.get_window("hover") {
        let _ = window.emit("chd:cancel", ());
        // Tauri's hide occasionally leaves the window on screen, which turns into a
        // transparent ghost that keeps swallowing the scroll wheel over the word.
        // Hide through the raw handle as well and verify it really went away.
        if let Ok(handle) = window.hwnd() {
            unsafe {
                let _ = ShowWindow(HWND(handle.0 as _), SW_HIDE);
            }
        }
        let _ = window.hide();
        if window.is_visible().unwrap_or(false) {
            log::warn!("Ctrlword popup is still visible after hiding");
        } else {
            log::debug!("Ctrlword popup hidden");
        }
    }
    crate::dictionary::cancel_hover_requests();
}

fn invalidate_at(app: &tauri::AppHandle, reason: &str) {
    log::debug!("Ctrlword invalidate: {reason}");
    invalidate(app);
}

unsafe extern "system" fn keyboard_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 && HOOK_ENABLED.load(Ordering::SeqCst) {
        let data = &*(l.0 as *const KBDLLHOOKSTRUCT);
        let message = w.0 as u32;
        if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP) {
            let down = matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN);
            let trigger = TRIGGER_KEY.load(Ordering::SeqCst);
            let key_code = match data.vkCode {
                0x11 => {
                    if data.flags.0 & 1 != 0 {
                        0xa3
                    } else {
                        0xa2
                    }
                }
                0x12 => {
                    if data.flags.0 & 1 != 0 {
                        0xa5
                    } else {
                        0xa4
                    }
                }
                0x10 => {
                    if data.scanCode == 0x36 {
                        0xa1
                    } else {
                        0xa0
                    }
                }
                value => value as i32,
            };
            if key_code == trigger {
                log::debug!(
                    "Ctrlword trigger key down={down} key={key_code} state={:?}",
                    GESTURE.lock().unwrap().state()
                );
            }
            if down && key_code != trigger && TAP_MODE.load(Ordering::SeqCst) {
                CLOSE_REQUEST.store(true, Ordering::SeqCst);
            }
            let chord = false;
            if let Some(p) = GESTURE
                .lock()
                .unwrap()
                .key(key_code, down, trigger, point(), chord)
            {
                if TAP_MODE.load(Ordering::SeqCst) {
                    let mut taps = TAPS.lock().unwrap();
                    if taps.len() < 4 {
                        taps.push_back((Instant::now(), p));
                        TAP_SEEN.fetch_add(1, Ordering::Relaxed);
                        log::debug!("Ctrlword tap queued {},{} len={}", p.x, p.y, taps.len());
                    }
                }
            }
        }
    }
    // Never swallow Ctrl+C/Ctrl+V or other application keyboard shortcuts.
    CallNextHookEx(None, code, w, l)
}

unsafe extern "system" fn mouse_hook(code: i32, w: WPARAM, l: LPARAM) -> LRESULT {
    if code >= 0 {
        let data = &*(l.0 as *const MSLLHOOKSTRUCT);
        let p = Point {
            x: data.pt.x,
            y: data.pt.y,
        };
        if process_mouse(w.0 as u32, p) {
            return LRESULT(1);
        }
    }
    CallNextHookEx(None, code, w, l)
}

fn process_mouse(message: u32, p: Point) -> bool {
    if matches!(
        message,
        WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN | WM_MOUSEWHEEL | WM_MOUSEHWHEEL
    ) {
        GESTURE.lock().unwrap().mouse();
    }
    let over = POPUP
        .lock()
        .unwrap()
        .as_ref()
        .map(|r| r.contains(p, 0))
        .unwrap_or(false);
    if matches!(message, WM_LBUTTONDOWN | WM_RBUTTONDOWN | WM_MBUTTONDOWN)
        && !over
        && TAP_MODE.load(Ordering::SeqCst)
    {
        CLOSE_REQUEST.store(true, Ordering::SeqCst);
    }
    if matches!(message, WM_MOUSEWHEEL | WM_MOUSEHWHEEL) && !over {
        SCROLLED.store(true, Ordering::SeqCst);
    }
    if message == WM_LBUTTONDOWN && ARMED.load(Ordering::SeqCst) && !over {
        *DRAG.lock().unwrap() = Some(Drag {
            start: p,
            current: p,
            end: None,
            started: false,
            cancelled: false,
        });
        MOUSE_CAPTURED.store(true, Ordering::SeqCst);
        return true;
    }
    if MOUSE_CAPTURED.load(Ordering::SeqCst) {
        if let Some(drag) = DRAG.lock().unwrap().as_mut() {
            drag.current = p;
            if message == WM_LBUTTONUP {
                drag.end = Some(p);
            }
        }
        if message == WM_LBUTTONUP {
            MOUSE_CAPTURED.store(false, Ordering::SeqCst);
            return true;
        }
    }
    false
}

unsafe extern "system" fn no_activate(
    hwnd: HWND,
    message: u32,
    w: WPARAM,
    l: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_MOUSEACTIVATE {
        return LRESULT(MA_NOACTIVATE as isize);
    }
    if message == WM_NCDESTROY {
        let _ = RemoveWindowSubclass(hwnd, Some(no_activate), id);
    }
    DefSubclassProc(hwnd, message, w, l)
}

unsafe fn remove_hooks() {
    let keyboard = KEYBOARD_HOOK.swap(0, Ordering::SeqCst);
    if keyboard != 0 {
        let _ = UnhookWindowsHookEx(HHOOK(keyboard as *mut core::ffi::c_void));
    }
    let mouse = MOUSE_HOOK.swap(0, Ordering::SeqCst);
    if mouse != 0 {
        let _ = UnhookWindowsHookEx(HHOOK(mouse as *mut core::ffi::c_void));
    }
}

unsafe fn install_hooks() {
    remove_hooks();
    let module = GetModuleHandleW(None)
        .ok()
        .map(|m| HINSTANCE(m.0))
        .unwrap_or_default();
    match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0) {
        Ok(hook) => {
            KEYBOARD_HOOK.store(hook.0 as isize, Ordering::SeqCst);
        }
        Err(error) => {
            log::error!("Ctrlword keyboard hook: {error}");
            *LAST_ERROR.lock().unwrap() = Some(format!("Keyboard hook: {error}"));
        }
    }
    match SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), module, 0) {
        Ok(hook) => {
            MOUSE_HOOK.store(hook.0 as isize, Ordering::SeqCst);
        }
        Err(error) => {
            log::error!("Ctrlword mouse hook: {error}");
            *LAST_ERROR.lock().unwrap() = Some(format!("Mouse hook: {error}"));
        }
    }
    log::debug!(
        "Ctrlword hooks installed: keyboard={} mouse={} after {}ms",
        KEYBOARD_HOOK.load(Ordering::SeqCst) != 0,
        MOUSE_HOOK.load(Ordering::SeqCst) != 0,
        STARTED_AT.elapsed().as_millis()
    );
}

unsafe extern "system" fn hook_watchdog(_window: HWND, _message: u32, _timer: usize, _time: u32) {
    // A dropped hook cannot be detected from the handle alone, so refresh them
    // periodically; the gap only lasts for the duration of this call.
    log::debug!("Ctrlword hook watchdog reinstall");
    install_hooks();
}

pub fn start(app: tauri::AppHandle) {
    match tauri::WindowBuilder::new(&app, "hover", tauri::WindowUrl::App("index.html".into()))
        .title("Ctrlword")
        .visible(false)
        .focused(false)
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .inner_size(420., 400.)
        .build()
    {
        Ok(window) => {
            if let Ok(handle) = window.hwnd() {
                unsafe {
                    let hwnd = HWND(handle.0 as _);
                    let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                    SetWindowLongPtrW(
                        hwnd,
                        GWL_EXSTYLE,
                        style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
                    );
                    if !SetWindowSubclass(hwnd, Some(no_activate), 0x434844, 0).as_bool() {
                        *LAST_ERROR.lock().unwrap() =
                            Some("Could not install non-activating tooltip behavior".into());
                    }
                }
            }
        }
        Err(error) => {
            *LAST_ERROR.lock().unwrap() = Some(error.to_string());
            return;
        }
    }
    configure_hooks(&settings());
    std::thread::spawn(|| unsafe {
        install_hooks();
        let watchdog = SetTimer(None, 0, 30_000, Some(hook_watchdog));
        if watchdog == 0 {
            log::warn!("Ctrlword hook watchdog timer unavailable");
        }
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&message);
            let _ = DispatchMessageW(&message);
        }
        if watchdog != 0 {
            let _ = KillTimer(None, watchdog);
        }
        remove_hooks();
    });
    std::thread::spawn(move || {
        let mut previous = Point::default();
        let mut stable = Instant::now();
        let mut attempted = false;
        let mut was_down = false;
        let mut suppressed = false;
        let mut left_at: Option<Instant> = None;
        let mut previous_foreground = 0isize;
        let mut app_name = String::new();
        let mut own_app = false;
        let mut s = settings();
        let mut config_at = Instant::now();
        // The startup configuration may still be empty while the store is loading, so
        // the poll thread re-applies the hooks as soon as it sees real settings.
        let mut hooks_applied = false;
        loop {
            std::thread::sleep(Duration::from_millis(if s.activation_mode == "tap" {
                10
            } else if was_down {
                16
            } else {
                50
            }));
            if config_at.elapsed() > Duration::from_millis(400) {
                let updated = settings();
                if !hooks_applied
                    || updated.enabled != s.enabled
                    || updated.trigger != s.trigger
                    || updated.activation_mode != s.activation_mode
                {
                    invalidate_at(&app, "settings applied");
                    configure_hooks(&updated);
                    hooks_applied = true;
                    was_down = false;
                    attempted = false;
                    suppressed = false;
                }
                s = updated;
                config_at = Instant::now();
            }
            let tap_mode = s.activation_mode == "tap";
            let pressed = s.enabled && key(trigger_code(&s.trigger));
            if !pressed {
                ARMED.store(false, Ordering::SeqCst);
                if was_down && !tap_mode {
                    invalidate_at(&app, "trigger released in hold mode");
                }
                was_down = false;
                suppressed = false;
                if !tap_mode {
                    attempted = false;
                    left_at = None;
                }
                {
                    let mut drag = DRAG.lock().unwrap();
                    if drag.as_ref().map(|d| !d.started).unwrap_or(false) {
                        *drag = None;
                    }
                }
                if !tap_mode {
                    continue;
                }
            }
            let p = point();
            if SCROLLED.swap(false, Ordering::SeqCst) {
                invalidate_at(&app, "wheel");
                attempted = false;
                stable = Instant::now();
            }
            if pressed && !was_down {
                stable = Instant::now();
                previous = p;
                attempted = false;
                was_down = true;
            }
            // Chords are recognised from the hook stream itself: the gesture marks a
            // tap as used as soon as another key goes down while the trigger is held.
            // Polling GetAsyncKeyState here meant one stuck key (a lost key-up, an
            // arrow key left down by another app) silently disabled every later tap.
            if key(0x1b) {
                if !suppressed {
                    invalidate_at(&app, "escape");
                }
                suppressed = true;
                if let Some(d) = DRAG.lock().unwrap().as_mut() {
                    d.cancelled = true;
                }
            }
            let foreground_hwnd = unsafe { GetForegroundWindow().0 as isize };
            if foreground_hwnd != previous_foreground {
                let (hwnd, name, pid) = foreground();
                previous_foreground = hwnd;
                invalidate_at(&app, &format!("foreground changed to {name}"));
                app_name = name;
                own_app = pid == std::process::id();
                attempted = false;
                stable = Instant::now();
            }
            let over = POPUP
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.contains(p, 0))
                .unwrap_or(false);
            let permitted = s.enabled
                && allowed(&s, &app_name)
                && (!own_app || over || DRAG.lock().unwrap().is_some());
            ARMED.store(
                pressed && !suppressed && permitted && READY.load(Ordering::SeqCst),
                Ordering::SeqCst,
            );
            if CLOSE_REQUEST.swap(false, Ordering::SeqCst) {
                // Typing while the lookup is still being recognized used to cancel the
                // pending probe before the card could appear. Only close what is on
                // screen; a probe that has not been shown yet may finish in peace.
                let shown = app
                    .get_window("hover")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if ACTIVE.load(Ordering::SeqCst) && shown {
                    invalidate_at(&app, "close request");
                }
            }
            // Keep early taps queued: the renderer takes about a second to boot, and a tap
            // pressed during that window used to be dropped, which felt like "wait after start".
            let can_probe = tap_mode && permitted && !suppressed;
            if can_probe {
                let ready_now = READY.load(Ordering::SeqCst);
                let mut queue = TAPS.lock().unwrap();
                let stale = queue.len();
                let fresh: Vec<Point> = queue
                    .iter()
                    .filter(|(at, _)| at.elapsed() < Duration::from_millis(2500))
                    .map(|(_, point)| *point)
                    .collect();
                if fresh.len() < stale {
                    queue.retain(|(at, _)| at.elapsed() < Duration::from_millis(2500));
                }
                if ready_now {
                    queue.clear();
                }
                drop(queue);
                if stale > fresh.len() && fresh.is_empty() {
                    log::debug!("Ctrlword dropped {} stale taps", stale - fresh.len());
                }
                if ready_now && !fresh.is_empty() {
                    for tapped in fresh {
                        let same_target = TARGET
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|rect| rect.contains_lookup(tapped))
                            .unwrap_or(false);
                        let old = *POINT_AT_PROBE.lock().unwrap();
                        let close = ACTIVE.load(Ordering::SeqCst)
                            && (over
                                || same_target
                                || ((tapped.x - old.x).abs() <= 3 && (tapped.y - old.y).abs() <= 3));
                        invalidate_at(&app, "new tap");
                        left_at = None;
                        if !close {
                            emit_probe(&app, tapped);
                            previous = tapped;
                        }
                    }
                }
            } else {
                let taps: Vec<_> = TAPS.lock().unwrap().drain(..).collect();
                if !taps.is_empty() {
                    log::info!(
                        "Ctrlword tap ignored: taps={} tap_mode={} permitted={} suppressed={} ready={} own_app={} app={}",
                        taps.len(),
                        tap_mode,
                        permitted,
                        suppressed,
                        READY.load(Ordering::SeqCst),
                        own_app,
                        app_name
                    );
                }
            }
            let mut start_drag = false;
            let mut has_drag = false;
            {
                let mut drag = DRAG.lock().unwrap();
                if let Some(d) = drag.as_mut() {
                    has_drag = true;
                    if !d.started
                        && !d.cancelled
                        && ((d.current.x - d.start.x).abs() > 4
                            || (d.current.y - d.start.y).abs() > 4)
                    {
                        d.started = true;
                        start_drag = true;
                    }
                    if !d.started && d.end.is_some() {
                        *drag = None;
                        has_drag = false;
                    }
                }
            }
            if start_drag {
                invalidate_at(&app, "drag started");
                crate::window::ocr_translate();
            }
            let started = DRAG
                .lock()
                .unwrap()
                .as_ref()
                .map(|drag| drag.started)
                .unwrap_or(false);
            if started && app.get_window("screenshot").is_none() {
                finish_drag();
                has_drag = false;
                attempted = false;
                stable = Instant::now();
            }
            if has_drag || MOUSE_CAPTURED.load(Ordering::SeqCst) {
                attempted = true;
                continue;
            }
            if suppressed || !permitted {
                if ACTIVE.load(Ordering::SeqCst) {
                    invalidate_at(&app, "suppressed or not permitted");
                }
                continue;
            }
            if tap_mode && !ACTIVE.load(Ordering::SeqCst) {
                continue;
            }
            if over {
                left_at = None;
                continue;
            }
            let on_word = TARGET
                .lock()
                .unwrap()
                .as_ref()
                .map(|r| r.contains_lookup(p))
                .unwrap_or(false);
            if on_word {
                left_at = None;
                continue;
            }
            if tap_mode {
                let known_target = TARGET.lock().unwrap().is_some();
                if known_target || POPUP.lock().unwrap().is_some() {
                    let since = left_at.get_or_insert_with(Instant::now);
                    if since.elapsed() >= Duration::from_millis(280) {
                        invalidate_at(&app, "left target");
                        left_at = None;
                    }
                } else {
                    // Nothing is on screen yet, so a lookup is still loading. Cursor
                    // jitter of a few pixels used to cancel it before the card could
                    // appear; only a deliberate move gives up on this probe.
                    let anchor = *POINT_AT_PROBE.lock().unwrap();
                    if (p.x - anchor.x).abs() > 60 || (p.y - anchor.y).abs() > 60 {
                        invalidate_at(&app, "anchor moved");
                    }
                }
                continue;
            }
            if POPUP.lock().unwrap().is_some() {
                let since = left_at.get_or_insert_with(Instant::now);
                if since.elapsed() < Duration::from_millis(280) {
                    continue;
                }
                invalidate_at(&app, "left popup");
                left_at = None;
                attempted = false;
                stable = Instant::now();
                previous = p;
            }
            if (p.x - previous.x).abs() > 2 || (p.y - previous.y).abs() > 2 {
                invalidate_at(&app, "pointer moved");
                previous = p;
                stable = Instant::now();
                attempted = false;
            }
            if !attempted
                && READY.load(Ordering::SeqCst)
                && stable.elapsed() >= Duration::from_millis(s.interval_ms.clamp(100, 3000))
            {
                attempted = true;
                emit_probe(&app, p);
            }
        }
    });
}

fn configure_hooks(s: &Settings) {
    HOOK_ENABLED.store(s.enabled, Ordering::SeqCst);
    TAP_MODE.store(s.activation_mode == "tap", Ordering::SeqCst);
    TRIGGER_KEY.store(trigger_code(&s.trigger), Ordering::SeqCst);
    GESTURE.lock().unwrap().reset();
    TAPS.lock().unwrap().clear();
}

fn emit_probe(app: &tauri::AppHandle, p: Point) {
    *POINT_AT_PROBE.lock().unwrap() = p;
    *STARTED.lock().unwrap() = Some(Instant::now());
    *TIMINGS.lock().unwrap() = json!({});
    ACTIVE.store(true, Ordering::SeqCst);
    let id = ID.load(Ordering::SeqCst);
    PROBES.fetch_add(1, Ordering::Relaxed);
    log::debug!("Ctrlword probe {id} at {},{}", p.x, p.y);
    if let Some(window) = app.get_window("hover") {
        let _ = window.emit("chd:probe", json!({"id":id,"point":p}));
    }
}

pub fn show(app: tauri::AppHandle, id: u64, height: f64) -> Result<(), String> {
    if !valid(id) {
        return Err("Cancelled".into());
    }
    let window = app.get_window("hover").ok_or("Hover window unavailable")?;
    let p = *POINT_AT_PROBE.lock().unwrap();
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let r = Rect {
                x: m.position().x,
                y: m.position().y,
                width: m.size().width,
                height: m.size().height,
            };
            r.contains(p, 0)
        })
        .ok_or("Monitor unavailable")?;
    let scale = monitor.scale_factor();
    let w = ((420. * scale) as u32).min(monitor.size().width.saturating_sub(16).max(1));
    let h = ((height.clamp(130., 620.) * scale) as u32)
        .min(monitor.size().height.saturating_sub(16).max(1));
    let (mut x, mut y) = if MOVED.load(Ordering::SeqCst) {
        // The user placed the popup by hand; a streamed definition must not
        // teleport it back under the word.
        let position = window.outer_position().map_err(|e| e.to_string())?;
        (position.x, position.y)
    } else {
        let anchor = TARGET.lock().unwrap().unwrap_or(Rect {
            x: p.x,
            y: p.y,
            width: 1,
            height: 1,
        });
        let minx = monitor.position().x + 8;
        let miny = monitor.position().y + 8;
        let maxx = monitor.position().x + monitor.size().width as i32 - w as i32 - 8;
        let maxy = monitor.position().y + monitor.size().height as i32 - h as i32 - 8;
        let x = anchor.x.clamp(minx, maxx.max(minx));
        let mut y = anchor.y + anchor.height as i32 + 8;
        if y > maxy {
            y = anchor.y - h as i32 - 8;
        }
        (x, y.clamp(miny, maxy.max(miny)))
    };
    // A hand-placed popup must stay inside whichever monitor it now occupies.
    if let Some(bounds) = monitors.iter().find(|m| {
        let r = Rect {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
        };
        r.contains(
            Point {
                x: x + w as i32 / 2,
                y: y + h as i32 / 2,
            },
            0,
        )
    }) {
        let minx = bounds.position().x + 8;
        let miny = bounds.position().y + 8;
        let maxx = bounds.position().x + bounds.size().width as i32 - w as i32 - 8;
        let maxy = bounds.position().y + bounds.size().height as i32 - h as i32 - 8;
        x = x.clamp(minx, maxx.max(minx));
        y = y.clamp(miny, maxy.max(miny));
    }
    window
        .set_size(tauri::PhysicalSize::new(w, h))
        .map_err(|e| e.to_string())?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    if !valid(id) {
        return Err("Cancelled".into());
    }
    *POPUP.lock().unwrap() = Some(Rect {
        x,
        y,
        width: w,
        height: h,
    });
    if let Ok(handle) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(HWND(handle.0 as _), SW_SHOWNOACTIVATE);
        }
    }
    timing(id, "popupMs");
    Ok(())
}

// Manual placement of the popup. Offsets are physical pixels measured from the
// corner the window had when the drag started, so the window tracks the pointer
// even when content keeps streaming and resizing it.
pub fn popup_drag_begin(app: tauri::AppHandle) -> Result<(), String> {
    let window = app.get_window("hover").ok_or("Hover window unavailable")?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    *POPUP_DRAG.lock().unwrap() = Some((position.x, position.y));
    Ok(())
}

pub fn popup_drag_move(app: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    let Some((base_x, base_y)) = *POPUP_DRAG.lock().unwrap() else {
        return Ok(());
    };
    let window = app.get_window("hover").ok_or("Hover window unavailable")?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let x = base_x + dx.round() as i32;
    let y = base_y + dy.round() as i32;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    MOVED.store(true, Ordering::SeqCst);
    // The poll loop keeps the popup open only while the cursor is inside this
    // rectangle, so it has to follow the window during a drag.
    *POPUP.lock().unwrap() = Some(Rect {
        x,
        y,
        width: size.width,
        height: size.height,
    });
    Ok(())
}

pub fn popup_drag_end(app: tauri::AppHandle) {
    *POPUP_DRAG.lock().unwrap() = None;
    if let Some(window) = app.get_window("hover") {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) {
            MOVED.store(true, Ordering::SeqCst);
            *POPUP.lock().unwrap() = Some(Rect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            });
        }
    }
}

pub fn capture(app: tauri::AppHandle, id: u64, context: bool) -> Result<CaptureResult, String> {
    if !valid(id) {
        log::debug!("Ctrlword capture id={id} context={context} cancelled early");
        return Err("Cancelled".into());
    }
    log::debug!("Ctrlword capture id={id} context={context} started");
    let p = *POINT_AT_PROBE.lock().unwrap();
    let capture_at = Instant::now();
    let s = settings();
    let screen = screenshots::Screen::from_point(p.x, p.y).map_err(|e| e.to_string())?;
    let display = screen.display_info;
    let scale = display.scale_factor as f64;
    let width = if context { s.width.max(1280) } else { s.width }.clamp(40, 1600);
    // A bounded local viewport for long scientific sentences at high zoom.
    let height = if context {
        s.height.max(900)
    } else {
        s.height.clamp(20, 600)
    };
    let dx = if context {
        -(width as i32) / 2
    } else {
        s.offset_x.clamp(-1600, 1600)
    };
    let dy = if context {
        -(height as i32) / 2
    } else {
        s.offset_y.clamp(-600, 600)
    };
    let desired_w = ((width as f64 * scale) as u32).min(display.width);
    let desired_h = ((height as f64 * scale) as u32).min(display.height);
    let x = (p.x + (dx as f64 * scale) as i32).clamp(
        display.x,
        display.x + display.width as i32 - if context { desired_w as i32 } else { 1 },
    );
    let y = (p.y + (dy as f64 * scale) as i32).clamp(
        display.y,
        display.y + display.height as i32 - if context { desired_h as i32 } else { 1 },
    );
    let w = desired_w.min((display.x + display.width as i32 - x) as u32);
    let h = desired_h.min((display.y + display.height as i32 - y) as u32);
    let image = screen
        .capture_area(x - display.x, y - display.y, w, h)
        .map_err(|e| e.to_string())?;
    let bytes = image
        .to_png(screenshots::Compression::Fast)
        .map_err(|e| e.to_string())?;
    CAPTURES.fetch_add(1, Ordering::Relaxed);
    let mut words = vec![];
    let mut system_error = None;
    let mut used_ocr_language = None;
    let image_ms = capture_at.elapsed().as_millis() as u64;
    let ocr_at = Instant::now();
    if s.ocr_engine != "tesseract" {
        let folder = app
            .path_resolver()
            .app_cache_dir()
            .ok_or("Cache directory unavailable")?;
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(format!("hover_{id}_{}.png", u8::from(context)));
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        // Windows OCR occasionally never answers on a bad frame. A single
        // long-lived worker keeps at most one such call pending, and after a
        // timeout the session stops using the system engine instead of piling
        // up threads that wait on the same wedged engine.
        if ocr_paused() {
            system_error = Some("OCR unavailable".into());
        } else {
            let (sender, receiver) = std::sync::mpsc::channel();
            let job = OcrJob {
                path: path.clone(),
                language: s.ocr_language.clone(),
                reply: sender,
            };
            if ocr_sender().send(job).is_err() {
                system_error = Some("OCR worker stopped".into());
            } else {
                match receiver.recv_timeout(std::time::Duration::from_millis(5000)) {
                    Ok(Ok((result, language))) => {
                        words = result;
                        used_ocr_language = Some(language);
                    }
                    Ok(Err(error)) => system_error = Some(error),
                    Err(_) => {
                        *OCR_UNAVAILABLE_AT.lock().unwrap() = Some(Instant::now());
                        log::warn!(
                            "Ctrlword OCR id={id} context={context} stopped answering; using Tesseract for two minutes"
                        );
                        system_error = Some("OCR timed out".into());
                    }
                }
            }
        }
        let _ = std::fs::remove_file(path);
    }
    if !valid(id) {
        return Err("Cancelled".into());
    }
    // Explicit, process-local developer opt-in; never save images or OCR text
    // during normal operation. This lets layout regressions use real word boxes.
    if let Ok(path) = std::env::var("CHD_OCR_DIAGNOSTICS") {
        if let Ok(bytes) = serde_json::to_vec(&words) {
            let _ = std::fs::write(path, bytes);
        }
    }
    {
        let mut values = TIMINGS.lock().unwrap();
        values["captureMs"] = json!(image_ms);
        values["ocrMs"] = json!(ocr_at.elapsed().as_millis() as u64);
        if let Some(language) = &used_ocr_language {
            values["ocrLanguage"] = json!(language);
        }
    }
    log::info!(
        "Ctrlword timing: captureMs={} ocrMs={} lang={}",
        image_ms,
        ocr_at.elapsed().as_millis(),
        used_ocr_language.as_deref().unwrap_or("-")
    );
    Ok(CaptureResult {
        id,
        point: p,
        capture_rect: Rect {
            x,
            y,
            width: w,
            height: h,
        },
        words,
        base64: STANDARD.encode(bytes),
        system_error,
    })
}

struct OcrJob {
    path: std::path::PathBuf,
    language: String,
    reply: std::sync::mpsc::Sender<Result<(Vec<OcrWord>, String), String>>,
}
static OCR_QUEUE: std::sync::Mutex<Option<std::sync::mpsc::Sender<OcrJob>>> = std::sync::Mutex::new(None);
static OCR_UNAVAILABLE_AT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
const OCR_HOLD_OFF: std::time::Duration = std::time::Duration::from_secs(120);

fn ocr_paused() -> bool {
    let mut paused = OCR_UNAVAILABLE_AT.lock().unwrap();
    match *paused {
        Some(at) if at.elapsed() < OCR_HOLD_OFF => true,
        Some(_) => {
            *paused = None;
            false
        }
        None => false,
    }
}

fn ocr_sender() -> std::sync::mpsc::Sender<OcrJob> {
    let mut queue = OCR_QUEUE.lock().unwrap();
    if let Some(sender) = queue.as_ref() {
        return sender.clone();
    }
    let (sender, receiver) = std::sync::mpsc::channel::<OcrJob>();
    std::thread::spawn(move || {
        while let Ok(job) = receiver.recv() {
            let _ = job.reply.send(recognize_file(&job.path, &job.language));
        }
    });
    *queue = Some(sender.clone());
    sender
}

fn recognize_file(path: &std::path::Path, language: &str) -> Result<(Vec<OcrWord>, String), String> {
    use windows::{
        Graphics::Imaging::BitmapDecoder,
        Media::Ocr::OcrEngine,
        Storage::{FileAccessMode, StorageFile},
    };
    // StorageFile requires a normalized absolute Windows path (no ../ segments).
    let full_path = path.canonicalize().map_err(|error| error.to_string())?;
    let normalized = full_path
        .to_string_lossy()
        .trim_start_matches("\\\\?\\")
        .to_owned();
    let run = || -> windows::core::Result<(Vec<OcrWord>, String)> {
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(normalized.as_str()))?.get()?;
        let stream = file.OpenAsync(FileAccessMode::Read)?.get()?;
        let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
        let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;
        if language != "auto" {
            let engine = engine_for(language)?;
            return Ok((recognize_bitmap(&engine, &bitmap)?, language.to_owned()));
        }
        // A sticky decision makes the common case a single OCR pass: only the
        // first lookup on a Latin page pays for the speculative second engine.
        if let Some(preferred) = OCR_PREFERENCE.lock().unwrap().clone() {
            if let Ok(engine) = engine_for(&preferred) {
                if let Ok(words) = recognize_bitmap(&engine, &bitmap) {
                    if script_matches(&preferred, script_chars(&words)) {
                        return Ok((words, preferred));
                    }
                }
            }
            *OCR_PREFERENCE.lock().unwrap() = None;
        }
        let profile = OcrEngine::TryCreateFromUserProfileLanguages()?;
        let tag = profile
            .RecognizerLanguage()?
            .LanguageTag()?
            .to_string_lossy();
        let words = recognize_bitmap(&profile, &bitmap)?;
        let counts = script_chars(&words);
        // A Latin document read by a CJK recogniser keeps the prose but turns
        // symbols and short words into lookalikes (Y→丫, (→（　）, which is what
        // used to swallow context around formulas. Rerun such pages with the
        // Latin engine instead of trusting the profile language blindly. The
        // second arm covers sparse crops (one letter, a symbol) on a page whose
        // frame has no Han text at all.
        let latin_page = (counts.latin >= 4 && counts.latin > counts.han * 3)
            || (counts.latin >= 1 && counts.han == 0);
        let alternate = if is_cjk_language(&tag) && latin_page {
            Some("en-US")
        } else if !is_cjk_language(&tag) && counts.han >= 8 && counts.han > counts.latin * 2 {
            Some("zh-CN")
        } else {
            None
        };
        if let Some(alternate) = alternate {
            if let Ok(engine) = engine_for(alternate) {
                if let Ok(candidate) = recognize_bitmap(&engine, &bitmap) {
                    let alternate_counts = script_chars(&candidate);
                    let better = if is_cjk_language(&tag) {
                        // For a Latin page the CJK engine keeps the prose but
                        // rewrites symbols as Han lookalikes (Y→丫, (→（, P−→尸),
                        // so it only has to not lose text: equal letter counts are
                        // expected and fewer artifacts is strictly better.
                        alternate_counts.latin >= counts.latin
                            && alternate_counts.han <= counts.han
                    } else {
                        alternate_counts.han > counts.han
                    };
                    if better {
                        *OCR_PREFERENCE.lock().unwrap() = Some(alternate.to_owned());
                        return Ok((candidate, alternate.to_owned()));
                    }
                }
            }
        }
        if script_matches(&tag, counts) {
            *OCR_PREFERENCE.lock().unwrap() = Some(tag.clone());
        }
        Ok((words, tag))
    };
    run().map_err(|error| {
        format!("Windows OCR unavailable ({error}); check the installed recognition language")
    })
}

fn engine_for(language: &str) -> windows::core::Result<windows::Media::Ocr::OcrEngine> {
    use windows::{Globalization::Language, Media::Ocr::OcrEngine};
    OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(&HSTRING::from(language))?)
}

fn recognize_bitmap(
    engine: &windows::Media::Ocr::OcrEngine,
    bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
) -> windows::core::Result<Vec<OcrWord>> {
    let result = engine.RecognizeAsync(bitmap)?.get()?;
    let lines = result.Lines()?;
    let mut output = vec![];
    for line in 0..lines.Size()? {
        let words = lines.GetAt(line)?.Words()?;
        for index in 0..words.Size()? {
            let word = words.GetAt(index)?;
            let rect = word.BoundingRect()?;
            output.push(OcrWord {
                text: word.Text()?.to_string_lossy(),
                line,
                rect: Rect {
                    x: rect.X as i32,
                    y: rect.Y as i32,
                    width: rect.Width.ceil() as u32,
                    height: rect.Height.ceil() as u32,
                },
            });
        }
    }
    Ok(output)
}

fn script_chars(words: &[OcrWord]) -> ScriptCounts {
    let mut counts = ScriptCounts::default();
    for word in words {
        for character in word.text.chars() {
            if character.is_ascii_alphabetic() {
                counts.latin += 1;
            } else if matches!(character as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff) {
                counts.han += 1;
            }
        }
    }
    counts
}

fn is_cjk_language(tag: &str) -> bool {
    ["zh", "ja", "ko"].iter().any(|prefix| tag.starts_with(prefix))
}

fn script_matches(tag: &str, counts: ScriptCounts) -> bool {
    if is_cjk_language(tag) {
        counts.han >= counts.latin
    } else {
        counts.latin >= counts.han * 2
    }
}

#[derive(Default)]
struct ScriptCounts {
    latin: usize,
    han: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_ocr_reads_the_fixture_with_installed_english_language() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/english-ocr.png");
        let words = recognize_file(&path, "en-US")
            .expect("Windows English OCR must recognize the fixture")
            .0;
        assert!(words
            .iter()
            .any(|word| word.text.to_lowercase().contains("emergent")));
        assert!(words
            .iter()
            .all(|word| word.rect.width > 0 && word.rect.height > 0));
    }
    #[test]
    fn automatic_language_picks_the_latin_recognizer_for_english_pages() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/english-ocr.png");
        let (words, language) =
            recognize_file(&path, "auto").expect("Windows OCR must recognize the fixture");
        assert_eq!(language, "en-US");
        assert!(words
            .iter()
            .any(|word| word.text.to_lowercase().contains("emergent")));
    }
    #[test]
    fn popup_scrolling_stays_open_and_cancelled_drag_releases_mouse_capture() {
        ARMED.store(true, Ordering::SeqCst);
        *POPUP.lock().unwrap() = None;
        assert!(process_mouse(WM_LBUTTONDOWN, Point { x: 10, y: 10 }));
        finish_drag(); // Closing a selection before mouse-up must not leave capture stuck.
        assert!(process_mouse(WM_LBUTTONUP, Point { x: 20, y: 20 }));
        assert!(!MOUSE_CAPTURED.load(Ordering::SeqCst));
        *POPUP.lock().unwrap() = Some(Rect {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        });
        SCROLLED.store(false, Ordering::SeqCst);
        process_mouse(WM_MOUSEWHEEL, Point { x: 20, y: 20 });
        assert!(!SCROLLED.load(Ordering::SeqCst));
        process_mouse(WM_MOUSEWHEEL, Point { x: 200, y: 200 });
        assert!(SCROLLED.load(Ordering::SeqCst));
        *POPUP.lock().unwrap() = None;
        ARMED.store(false, Ordering::SeqCst);
    }
}
