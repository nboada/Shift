fn main() {
    // Bake the OAuth client from ../.env.local into the binary (read via option_env! in auth.rs).
    println!("cargo:rerun-if-changed=../.env.local");
    if let Ok(env) = std::fs::read_to_string("../.env.local") {
        for (k, v) in env.lines().filter_map(|l| l.split_once('=')) {
            if k.trim().starts_with("GOOGLE_CLIENT_") {
                println!("cargo:rustc-env={}={}", k.trim(), v.trim());
            }
        }
    }
    tauri_build::build()
}
