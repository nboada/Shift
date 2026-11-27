//! Updates from getshiftmail.com: checked at launch and every six hours, installed only when the user asks
//! (the dialog's Update button), or in the background when `general.autoUpdate` is on.

use crate::{State, settings};
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The release waiting to be installed, and the download in progress (so Cancel can stop it).
#[derive(Default)]
pub struct Updates {
    found: tokio::sync::Mutex<Option<Update>>,
    download: std::sync::Mutex<Option<tokio::task::AbortHandle>>,
}

/// What the UI shows about a waiting release. `launch` asks for the dialog; otherwise only the sidebar icon shows.
#[derive(Serialize, Clone)]
pub struct Available {
    version: String,
    current: String,
    notes: Option<String>,
    launch: bool,
}

impl Available {
    fn of(update: &Update, launch: bool) -> Self {
        Self {
            version: update.version.clone(),
            current: update.current_version.clone(),
            notes: update.body.clone().filter(|n| !n.trim().is_empty()),
            launch,
        }
    }
}

/// Release builds only: dev and demo builds have no signed update feed to install from.
fn enabled(app: &AppHandle) -> bool {
    // iOS updates come through the App Store / TestFlight; the updater plugin is desktop-only.
    cfg!(desktop) && !cfg!(debug_assertions) && !app.state::<State>().demo
}

fn auto_install(app: &AppHandle) -> bool {
    settings::load(&app.state::<State>().dir)["general"]["autoUpdate"]
        .as_bool()
        .unwrap_or(false)
}

/// Asks the feed for a newer version and keeps it for `install_update`. Downloads nothing.
async fn check(app: &AppHandle) -> anyhow::Result<Option<Update>> {
    let found = app.updater()?.check().await?;
    *app.state::<Updates>().found.lock().await = found.clone();
    Ok(found)
}

/// At launch and every six hours. A release found at launch opens the dialog; one found later only shows the
/// sidebar icon. With `general.autoUpdate`, it's installed in the background instead and a restart is offered.
pub fn spawn_checks(app: &AppHandle) {
    if !enabled(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut launch = true;
        let mut announced = None;
        loop {
            match check(&app).await {
                Ok(Some(update)) if auto_install(&app) => {
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => {
                            app.state::<Updates>().found.lock().await.take();
                            let _ = app.emit("update-ready", &update.version);
                            return;
                        }
                        Err(e) => eprintln!("update install failed: {e:#}"),
                    }
                }
                Ok(Some(update)) => {
                    if announced.as_ref() != Some(&update.version) {
                        let _ = app.emit("update-available", Available::of(&update, launch));
                        announced = Some(update.version);
                    }
                }
                Ok(None) => {}
                Err(e) => eprintln!("update check failed: {e:#}"),
            }
            launch = false;
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// Shift → Check for Updates…: a newer version opens the dialog; otherwise a toast says how it went.
#[cfg(desktop)]
pub fn check_now(app: &AppHandle) {
    if !enabled(app) {
        let _ = app.emit("app-toast", "Updates only work in release builds");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Some(update)) => {
                let _ = app.emit("update-available", Available::of(&update, true));
            }
            Ok(None) => {
                let msg = format!("You're up to date (Shift {})", app.package_info().version);
                let _ = app.emit("app-toast", msg);
            }
            Err(e) => {
                let _ = app.emit("app-toast", format!("Couldn't check for updates: {e:#}"));
            }
        }
    });
}

/// The release the launch check found, for a window that wasn't listening yet when it was announced.
#[tauri::command]
pub async fn pending_update(app: AppHandle) -> Option<Available> {
    app.state::<Updates>()
        .found
        .lock()
        .await
        .as_ref()
        .map(|u| Available::of(u, true))
}

/// Settings → General → Check now.
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Result<Option<Available>, String> {
    if !enabled(&app) {
        return Err("Updates only work in release builds".into());
    }
    let found = check(&app).await.map_err(|e| format!("{e:#}"))?;
    Ok(found.map(|u| Available::of(&u, true)))
}

/// The dialog's Update button: downloads the waiting release (reporting `update-progress` as `[received, total]`)
/// and installs it. The UI restarts afterwards. Errs with "cancelled" when `cancel_update` stopped it.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .state::<Updates>()
        .found
        .lock()
        .await
        .clone()
        .ok_or("There's no update to install")?;
    let progress = app.clone();
    let task = tokio::spawn(async move {
        let mut received = 0u64;
        let mut shown = 0u64;
        update
            .download_and_install(
                |chunk, total| {
                    received += chunk as u64;
                    // About every 1%, not every chunk.
                    let step = total.map_or(256 * 1024, |t| (t / 100).max(1));
                    if received - shown >= step || Some(received) == total {
                        shown = received;
                        let _ = progress.emit("update-progress", (received, total));
                    }
                },
                || {},
            )
            .await
    });
    *app.state::<Updates>()
        .download
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(task.abort_handle());
    let result = task.await;
    app.state::<Updates>()
        .download
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    match result {
        Ok(Ok(())) => {
            app.state::<Updates>().found.lock().await.take();
            Ok(())
        }
        Ok(Err(e)) => Err(format!("{e:#}")),
        Err(e) if e.is_cancelled() => Err("cancelled".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// The dialog's Cancel during a download.
#[tauri::command]
pub fn cancel_update(app: AppHandle) {
    if let Some(task) = app
        .state::<Updates>()
        .download
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take()
    {
        task.abort();
    }
}
