// Systems without tethering support yet (Windows): the panel says so.

pub fn start(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("Tethered shooting isn’t available on Windows yet.".into())
}
pub fn connect(_app: &tauri::AppHandle, _id: String) -> Result<(), String> {
    Err("Tethered shooting isn’t available here".into())
}
pub fn capture(_app: &tauri::AppHandle) -> Result<(), String> {
    Err("Tethered shooting isn’t available here".into())
}
pub fn disconnect(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
