// Never install Pot's official update over this fork. Preserve the startup entry
// point; updates are manual until Ctrlword has its own release channel.
pub fn check_update(_app_handle: tauri::AppHandle) {
    log::info!("Ctrlword: automatic upstream updates are disabled");
}
