use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[cfg(windows)]
mod gesture;
#[cfg(windows)]
mod native;

#[derive(Clone, Copy, Default, Serialize, Deserialize, Debug)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
impl Rect {
    pub fn contains(&self, p: Point, slack: i32) -> bool {
        p.x >= self.x - slack
            && p.y >= self.y - slack
            && p.x <= self.x + self.width as i32 + slack
            && p.y <= self.y + self.height as i32 + slack
    }
    pub fn contains_lookup(&self, p: Point) -> bool {
        p.x >= self.x - 3
            && p.x <= self.x + self.width as i32 + 3
            && p.y >= self.y - 3
            && p.y <= self.y + self.height as i32 + 12
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OcrWord {
    pub text: String,
    pub rect: Rect,
    pub line: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub id: u64,
    pub point: Point,
    pub capture_rect: Rect,
    pub words: Vec<OcrWord>,
    pub base64: String,
    pub system_error: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct Drag {
    pub start: Point,
    pub current: Point,
    pub end: Option<Point>,
    pub started: bool,
    pub cancelled: bool,
}

pub fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    native::start(app);
    #[cfg(not(windows))]
    let _ = app;
}
pub fn valid(id: u64) -> bool {
    #[cfg(windows)]
    {
        native::valid(id)
    }
    #[cfg(not(windows))]
    {
        let _ = id;
        false
    }
}

#[tauri::command]
pub fn hover_ready(window: tauri::Window) -> Result<(), String> {
    if window.label() != "hover" {
        return Err("Invalid hover window".into());
    }
    #[cfg(windows)]
    native::ready();
    Ok(())
}
#[tauri::command(async)]
pub fn hover_capture(
    app_handle: tauri::AppHandle,
    id: u64,
    context: bool,
) -> Result<CaptureResult, String> {
    #[cfg(windows)]
    {
        native::capture(app_handle, id, context)
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, id, context);
        Err("Hover OCR currently supports Windows".into())
    }
}
#[tauri::command]
pub fn hover_target(id: u64, rect: Rect) -> bool {
    #[cfg(windows)]
    {
        native::target(id, rect)
    }
    #[cfg(not(windows))]
    {
        let _ = (id, rect);
        false
    }
}
#[tauri::command]
pub fn hover_show(app_handle: tauri::AppHandle, id: u64, height: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::show(app_handle, id, height)
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, id, height);
        Err("Unsupported platform".into())
    }
}
#[tauri::command]
pub fn hover_close(app_handle: tauri::AppHandle) {
    #[cfg(windows)]
    native::invalidate(&app_handle);
    #[cfg(not(windows))]
    let _ = app_handle;
}
#[tauri::command]
pub fn hover_status() -> Value {
    #[cfg(windows)]
    {
        native::status()
    }
    #[cfg(not(windows))]
    {
        json!({"supported":false})
    }
}
#[tauri::command]
pub fn hover_timing(id: u64, phase: String) {
    #[cfg(windows)]
    native::timing(id, &phase);
    #[cfg(not(windows))]
    let _ = (id, phase);
}
#[tauri::command]
pub fn hover_drag_state() -> Option<Drag> {
    #[cfg(windows)]
    {
        native::drag_state()
    }
    #[cfg(not(windows))]
    {
        None
    }
}
#[tauri::command]
pub fn hover_drag_finished() {
    #[cfg(windows)]
    native::finish_drag();
}
#[tauri::command]
pub fn hover_popup_drag_begin(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::popup_drag_begin(app_handle)
    }
    #[cfg(not(windows))]
    {
        let _ = app_handle;
        Err("Unsupported platform".into())
    }
}
#[tauri::command]
pub fn hover_popup_drag_move(app_handle: tauri::AppHandle, dx: f64, dy: f64) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::popup_drag_move(app_handle, dx, dy)
    }
    #[cfg(not(windows))]
    {
        let _ = (app_handle, dx, dy);
        Err("Unsupported platform".into())
    }
}
/// Temporary diagnostic sink so the renderer can write into the same log file.
#[tauri::command]
pub fn hover_trace(message: String) {
    log::info!("Ctrlword trace: {message}");
}
#[tauri::command]
pub fn hover_popup_drag_end(app_handle: tauri::AppHandle) {
    #[cfg(windows)]
    native::popup_drag_end(app_handle);
    #[cfg(not(windows))]
    let _ = app_handle;
}
