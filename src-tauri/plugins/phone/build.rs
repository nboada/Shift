fn main() {
    // Its commands are called from Shift's Rust code only, never from the webview, so it grants none.
    tauri_plugin::Builder::new(&[]).ios_path("ios").build();
}
