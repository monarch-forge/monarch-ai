//! Mobile (Android) build: a remote client for the Monarch core running on the user's laptop.
//! The bundled page (mobile-shell/) asks for the laptop's Tailscale/LAN address and pairing code, then
//! navigates the webview to the laptop's own UI. Nothing runs locally: no core, no Node, no localhost server.
//! Android's back button steps back through the webview history (wry default).

#[tauri::mobile_entry_point]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running Monarch");
}
