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
    // Every app command needs an `allow-<name>` permission (capabilities/default.json), so only Shift's own window,
    // on its own local origin, can call them. A command missing here is refused at runtime ("not allowed").
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
        "status",
        "add_account",
        "sign_out",
        "sync_now",
        "labels",
        "threads",
        "mark_all_read",
        "restart_app",
        "ai_rewrite",
        "ai_draft_reply",
        "ai_labels",
        "ai_undo_labels",
        "ai_cleanup",
        "open_at_login",
        "set_open_at_login",
        "ai_label_inbox",
        "find_draft",
        "load_more",
        "quit_now",
        "test_notification",
        "empty_mailbox",
        "create_label",
        "rename_label",
        "set_label_color",
        "delete_label",
        "thread",
        "modify",
        "modify_many",
        "search",
        "send",
        "get_settings",
        "search_local",
        "suggest_senders",
        "suggest_contacts",
        "save_draft",
        "delete_draft",
        "schedule_send",
        "scheduled",
        "take_scheduled",
        "reschedule",
        "attachment_data",
        "open_attachment",
        "set_settings",
        "set_ai_key",
        "has_ai_key",
        "delete_ai_key",
        ]),
    ))
    .expect("failed to run tauri-build");
}
