//! The iPhone app's native pieces that WebKit can't reach: the keyboard's form accessory bar (hidden), haptics, and
//! background refresh (BGAppRefreshTask). iOS only; Shift depends on it for that target alone.
use tauri::{
    Manager, Runtime,
    plugin::{Builder, PluginHandle, TauriPlugin, mobile::PluginInvokeError},
};

tauri::ios_plugin_binding!(init_plugin_phone);

pub struct Phone<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Phone<R> {
    /// A tap of feedback: "light", "medium", "selection", "success" or "warning".
    pub fn haptic(&self, style: &str) -> Result<(), PluginInvokeError> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("haptic", serde_json::json!({ "style": style }))
            .map(drop)
    }

    /// Waits until iOS runs a background refresh; answer it with `refresh_done` once synced.
    pub async fn next_refresh(&self) -> Result<(), PluginInvokeError> {
        self.0
            .run_mobile_plugin_async::<serde_json::Value>("nextRefresh", ())
            .await
            .map(drop)
    }

    /// Ends the running refresh, so iOS can suspend the app again, and asks for the next one.
    pub fn refresh_done(&self, ok: bool) -> Result<(), PluginInvokeError> {
        self.0
            .run_mobile_plugin::<serde_json::Value>("refreshDone", serde_json::json!({ "ok": ok }))
            .map(drop)
    }
}

pub trait PhoneExt<R: Runtime> {
    fn phone(&self) -> &Phone<R>;
}

impl<R: Runtime, T: Manager<R>> PhoneExt<R> for T {
    fn phone(&self) -> &Phone<R> {
        self.state::<Phone<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("phone")
        .setup(|app, api| {
            app.manage(Phone(api.register_ios_plugin(init_plugin_phone)?));
            Ok(())
        })
        .build()
}
