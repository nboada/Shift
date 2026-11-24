mod ai;
mod auth;
mod db;
mod demo;
#[cfg(test)]
mod fake_gmail;
mod gmail;
mod settings;

use base64::{Engine, engine::general_purpose::STANDARD};
use futures::StreamExt;
use gmail::Gmail;
use mail_builder::{MessageBuilder, headers::address::Address, headers::message_id::MessageId};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// One signed-in Google account: its own local mail database, access token and sync lock.
struct Account {
    email: String,
    db: Mutex<Connection>,
    token: tokio::sync::Mutex<Option<auth::Token>>,
    syncing: tokio::sync::Mutex<()>,
    /// Held while due scheduled emails go out, so overlapping syncs can't send the same one twice.
    sending: tokio::sync::Mutex<()>,
    /// Held while auto-label runs, which happens beside the sync rather than inside it.
    labeling: tokio::sync::Mutex<()>,
}

impl Account {
    fn new(email: String, conn: Connection) -> Arc<Self> {
        Arc::new(Self {
            email,
            db: Mutex::new(conn),
            token: Default::default(),
            syncing: Default::default(),
            sending: Default::default(),
            labeling: Default::default(),
        })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn access_token(&self, http: &reqwest::Client) -> anyhow::Result<String> {
        let mut t = self.token.lock().await;
        if t.as_ref()
            .is_none_or(|t| t.expires <= std::time::SystemTime::now())
        {
            *t = Some(auth::refresh(http, &self.email).await?);
        }
        Ok(t.as_ref().unwrap().access.clone())
    }

    /// Drops the cached access token, so the next call refreshes it (after Gmail answered 401).
    async fn forget_token(&self) {
        *self.token.lock().await = None;
    }
}

struct State {
    /// In the order they were added; the first is the default for new emails.
    accounts: Mutex<Vec<Arc<Account>>>,
    http: reqwest::Client,
    /// For AI providers: a model can think for a while before the first byte of its answer arrives.
    ai_http: reqwest::Client,
    /// Offline demo mailbox: no network, actions only touch the local cache.
    demo: bool,
    /// App data directory (accounts/, settings.json).
    dir: PathBuf,
    /// Account databases that couldn't be opened at launch (see `load_accounts`).
    broken: Vec<String>,
}

impl State {
    fn all(&self) -> Vec<Arc<Account>> {
        self.accounts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn account(&self, email: &str) -> anyhow::Result<Arc<Account>> {
        self.all()
            .into_iter()
            .find(|a| a.email.eq_ignore_ascii_case(email))
            .ok_or_else(|| anyhow::anyhow!("{email} isn't signed in"))
    }
    /// The chosen accounts, or the unified view when none are given: every account except those switched off
    /// under Settings → Accounts → "Show in unified inbox".
    fn scope(&self, emails: Option<&[String]>) -> anyhow::Result<Vec<Arc<Account>>> {
        match emails {
            Some(list) if !list.is_empty() => list.iter().map(|e| self.account(e)).collect(),
            _ => {
                let prefs = settings::load(&self.dir);
                Ok(self
                    .all()
                    .into_iter()
                    .filter(|a| prefs["accounts"][&a.email]["unified"].as_bool() != Some(false))
                    .collect())
            }
        }
    }
}

#[derive(Debug)]
struct Error(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format!("{:#}", self.0))
    }
}
type R<T> = Result<T, Error>;

const CHANGED: &str = "mail-changed";

/// accounts/<email>.sqlite3, with anything unusual in the address replaced so it's a safe filename.
fn db_path(dir: &Path, email: &str) -> PathBuf {
    let safe: String = email
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "@._-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    dir.join("accounts").join(format!("{safe}.sqlite3"))
}

/// Opens every account database in accounts/, oldest first. Files without an account email are skipped. One that
/// can't be opened is renamed `.broken` (kept, not deleted) and named in the second list, so the other accounts
/// still open; signing in again downloads that account's mail afresh.
fn load_accounts(dir: &Path) -> anyhow::Result<(Vec<Arc<Account>>, Vec<String>)> {
    let mut found = Vec::new();
    let mut broken = Vec::new();
    for entry in std::fs::read_dir(dir.join("accounts"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "sqlite3") {
            let added = std::fs::metadata(&path).and_then(|m| m.created()).ok();
            let opened = db::open(&path).and_then(|conn| Ok((db::get_meta(&conn, "email")?, conn)));
            match opened {
                Ok((Some(email), conn)) => found.push((added, Account::new(email, conn))),
                Ok((None, _)) => {}
                Err(e) => {
                    eprintln!("Couldn't open {}: {e:#}", path.display());
                    for suffix in ["", "-wal", "-shm"] {
                        let from = format!("{}{suffix}", path.display());
                        let _ = std::fs::rename(&from, format!("{from}.broken"));
                    }
                    broken.push(path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
                }
            }
        }
    }
    found.sort_by_key(|(added, _)| *added);
    Ok((found.into_iter().map(|(_, a)| a).collect(), broken))
}

/// The single-account version kept one mail.sqlite3 and one Keychain token; move both to the per-account layout.
fn migrate_single_account(dir: &Path) -> anyhow::Result<()> {
    let old = dir.join("mail.sqlite3");
    if !old.exists() {
        return Ok(());
    }
    let email = db::get_meta(&db::open(&old)?, "email")?;
    match email {
        Some(email) => {
            let new = db_path(dir, &email);
            for suffix in ["", "-wal", "-shm"] {
                let from = PathBuf::from(format!("{}{suffix}", old.display()));
                if from.exists() {
                    std::fs::rename(&from, format!("{}{suffix}", new.display()))?;
                }
            }
            auth::migrate_legacy(&email);
        }
        None => std::fs::remove_file(&old)?,
    }
    Ok(())
}

/// Fetches every thread, then reports the first failure so the caller doesn't advance the history cursor past it.
async fn fetch_threads(
    app: &AppHandle,
    a: &Account,
    g: &Gmail<'_>,
    ids: Vec<String>,
) -> anyhow::Result<()> {
    // Threads whose bodies are already cached stay full, so an opened message never drops back to a snippet.
    let jobs: Vec<(String, bool)> = ids
        .into_iter()
        .map(|id| {
            let full = db::is_full(&a.db(), &id);
            (id, full)
        })
        .collect();
    fetch(app, a, g, jobs)
        .await
        .into_iter()
        .next()
        .map_or(Ok(()), |(_, e)| Err(e))
}

/// Fetches bodies for the newest inbox threads so opening them doesn't wait on the network, within `budget` units.
async fn prefetch_bodies(app: &AppHandle, a: &Account, g: &Gmail<'_>, budget: i64) -> anyhow::Result<()> {
    let ids = db::missing_bodies(&a.db(), "INBOX", (budget / FULL_COST).max(0) as usize)?;
    let jobs = ids.into_iter().map(|id| (id, true)).collect();
    fetch(app, a, g, jobs)
        .await
        .into_iter()
        .next()
        .map_or(Ok(()), |(_, e)| Err(e))
}

// Gmail allows each account 6,000 quota units a minute; threads.get costs 40 for metadata and 120 with bodies.
// Background fetching takes at most 60% of that, so history, search, sends and the user's own actions have room.
const METADATA_COST: i64 = 40;
const FULL_COST: i64 = 120;

/// Quota units one sync tick may spend on background fetching, scaled to how often ticks run.
fn tick_budget(interval_secs: u64) -> i64 {
    6000 * 6 / 10 * interval_secs as i64 / 60
}

/// Fetches threads 4 at a time; returns the ones that failed, with why.
async fn fetch(
    app: &AppHandle,
    a: &Account,
    g: &Gmail<'_>,
    jobs: Vec<(String, bool)>,
) -> Vec<(String, anyhow::Error)> {
    let mut stream = futures::stream::iter(jobs)
        .map(|(id, full)| async move { (g.thread(&id, full).await, id, full) })
        .buffer_unordered(4);
    let (mut done, mut failed) = (0, Vec::new());
    while let Some((res, id, full)) = stream.next().await {
        let r = match res {
            // Gmail doesn't have this thread's queued changes yet; its copy would undo them on screen.
            Ok(_) if db::has_pending(&a.db(), &id) => Ok(()),
            Ok(t) => db::upsert_thread(&mut a.db(), &t, full),
            Err(e) if gmail::is_not_found(&e) => db::delete_thread(&a.db(), &id),
            Err(e) => Err(e),
        };
        if let Err(e) = r {
            eprintln!("{} thread {id}: {e:#}", a.email);
            failed.push((id, e));
        }
        done += 1;
        if done % 25 == 0 {
            let _ = app.emit(CHANGED, ());
        }
    }
    failed
}

/// Starts a (re)sync from scratch without fetching anything yet: lists the mailbox, queues the threads in the
/// `backfill` meta row and saves the history cursor, which `backfill` and the next ticks then work through.
/// Saving the cursor up front is safe: whatever changes after it comes back through history, and queued threads
/// are fetched in their current state. A failed thread just stays queued instead of restarting everything.
async fn full_sync(a: &Account, g: &Gmail<'_>) -> anyhow::Result<()> {
    let (_, history_id) = g.profile().await?;
    let mut ids = g.thread_ids("", Some("INBOX"), 100).await?;
    for id in g.thread_ids("", None, 500).await? {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    // Inbox first so the default view fills first; within that, threads not cached yet before refreshing cached ones.
    let c = a.db();
    let (mut queue, cached): (Vec<String>, Vec<String>) = ids
        .into_iter()
        .partition(|id| !db::has_thread(&c, id).unwrap_or(false));
    queue.extend(cached);
    // Cached threads outside the listed window may have changed while history was unavailable (archived or
    // deleted elsewhere); refresh them last. A deleted one comes back 404 and is dropped from the cache.
    let listed: std::collections::HashSet<String> = queue.iter().cloned().collect();
    queue.extend(
        db::all_thread_ids(&c)?
            .into_iter()
            .filter(|id| !listed.contains(id)),
    );
    db::set_meta(&c, "backfill", &serde_json::to_string(&queue)?)?;
    db::set_meta(&c, "history_id", &history_id)?;
    // Mail already there is not new: only what arrives from now on is announced.
    db::set_meta(&c, "notified_at", &now_ms().to_string())?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Shows a notification for Inbox mail that arrived since the last one (the `notified_at` watermark).
fn notify_new_mail(app: &AppHandle, a: &Account) -> anyhow::Result<()> {
    use tauri_plugin_notification::NotificationExt;
    let s = app.state::<State>();
    let cfg = settings::notifications(&s.dir);
    let mail = {
        let c = a.db();
        // Accounts synced before notifications existed start their watermark now rather than announcing their backlog.
        let Some(since) = db::get_meta(&c, "notified_at")?.and_then(|v| v.parse().ok()) else {
            db::set_meta(&c, "notified_at", &now_ms().to_string())?;
            return Ok(());
        };
        let mail = db::new_mail(&c, since)?;
        // Advanced past filtered-out mail too, so turning "only people" off later doesn't replay it.
        if let Some(latest) = mail.iter().map(|m| m.date).max() {
            db::set_meta(&c, "notified_at", &latest.to_string())?;
        }
        mail
    };
    let mail: Vec<_> = mail
        .into_iter()
        .filter(|m| m.primary || !cfg.only_people)
        .collect();
    if !cfg.enabled || mail.is_empty() {
        return Ok(());
    }
    let name = |sender: &str| {
        let n = sender
            .split('<')
            .next()
            .unwrap_or(sender)
            .trim()
            .trim_matches('"');
        if n.is_empty() {
            sender.to_string()
        } else {
            n.to_string()
        }
    };
    let (title, body) = match mail.as_slice() {
        [one] => (name(&one.sender), one.subject.clone()),
        many => {
            let mut senders: Vec<String> = many.iter().map(|m| name(&m.sender)).collect();
            senders.dedup();
            (format!("{} new emails", many.len()), senders.join(", "))
        }
    };
    // Read back by the click handler set up in `run`: one email opens itself, several open the Inbox.
    let mut n = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .extra("account", &a.email);
    if let [one] = mail.as_slice() {
        n = n.extra("thread", &one.id);
    }
    if cfg.sound {
        n = n.sound("default");
    }
    n.show()?;
    Ok(())
}

/// Fetches the next batch of queued threads. Failures go to the back of the queue so one bad thread can't block it.
/// Returns how many it took off the queue's front.
/// Scrolling to the end of a list: fetches the next older page of that mailbox from Gmail for each account, beyond
/// what the first sync listed. Returns how many threads it added and whether Gmail has more.
#[tauri::command]
async fn load_more(
    app: AppHandle,
    s: tauri::State<'_, State>,
    accounts: Option<Vec<String>>,
    label: Option<String>,
) -> R<(usize, bool)> {
    if s.demo {
        return Ok((0, false));
    }
    let (mut added, mut more) = (0, false);
    for a in s.scope(accounts.as_deref())? {
        // The mailbox as Gmail sees it: Archive is a search, a merged label is this account's label of that name.
        let (q, label) = match label.as_deref() {
            None => ("", None),
            Some("ARCHIVE") => ("-in:inbox -in:drafts -in:spam -in:trash", None),
            Some("SCHEDULED") => continue,
            Some(l) => match resolve_label(&a.db(), l)? {
                Some(id) => ("", Some(id)),
                None => continue,
            },
        };
        let key = format!("more:{}", label.as_deref().unwrap_or(if q.is_empty() { "ALL" } else { "ARCHIVE" }));
        let mut page = match db::get_meta(&a.db(), &key)? {
            Some(t) if t == "done" => continue,
            Some(t) => t,
            None => String::new(),
        };
        let token = a.access_token(&s.http).await?;
        let g = Gmail { http: &s.http, token: &token };
        // Pages already cached are skipped (up to 5, at 10 units each) until one brings threads we don't have.
        let mut fresh = Vec::new();
        for _ in 0..5 {
            let (ids, next) = g.thread_page(q, label.as_deref(), &page).await?;
            fresh.extend(ids.into_iter().filter(|id| !db::has_thread(&a.db(), id).unwrap_or(true)));
            page = next.clone().unwrap_or_default();
            db::set_meta(&a.db(), &key, next.as_deref().unwrap_or("done"))?;
            if next.is_none() || !fresh.is_empty() {
                break;
            }
        }
        more |= !page.is_empty();
        added += fresh.len();
        let failed = fetch(&app, &a, &g, fresh.into_iter().map(|id| (id, false)).collect()).await;
        if let Some((_, e)) = failed.into_iter().next() {
            return Err(e.into());
        }
    }
    let _ = app.emit(CHANGED, ());
    Ok((added, more))
}

/// Adds threads to the end of the backfill queue, skipping ones already in it.
fn enqueue(a: &Account, ids: Vec<String>) -> anyhow::Result<()> {
    let c = a.db();
    let mut queue: Vec<String> = db::get_meta(&c, "backfill")?
        .map(|j| serde_json::from_str(&j))
        .transpose()?
        .unwrap_or_default();
    for id in ids {
        if !queue.contains(&id) {
            queue.push(id);
        }
    }
    db::set_meta(&c, "backfill", &serde_json::to_string(&queue)?)?;
    Ok(())
}

/// Returns how many it took and the quota units that cost; at least one thread a tick, so the queue always moves.
async fn backfill(app: &AppHandle, a: &Account, g: &Gmail<'_>, budget: i64) -> anyhow::Result<(usize, i64)> {
    let queue: Vec<String> = match db::get_meta(&a.db(), "backfill")? {
        Some(json) => serde_json::from_str(&json)?,
        None => return Ok((0, 0)),
    };
    let mut jobs: Vec<(String, bool)> = Vec::new();
    let mut spent = 0;
    for id in &queue {
        let full = db::is_full(&a.db(), id);
        let cost = if full { FULL_COST } else { METADATA_COST };
        if !jobs.is_empty() && spent + cost > budget {
            break;
        }
        spent += cost;
        jobs.push((id.clone(), full));
    }
    let take = jobs.len();
    let rest = &queue[take..];
    let failed = fetch(app, a, g, jobs).await;
    let mut next: Vec<String> = rest.to_vec();
    next.extend(failed.into_iter().map(|(id, _)| id));
    let c = a.db();
    if next.is_empty() {
        db::delete_meta(&c, "backfill")?;
    } else {
        db::set_meta(&c, "backfill", &serde_json::to_string(&next)?)?;
    }
    Ok((take, spent))
}

async fn sync_account(app: &AppHandle, a: &Account) -> anyhow::Result<()> {
    let s = app.state::<State>();
    let Ok(_running) = a.syncing.try_lock() else {
        return Ok(());
    };
    let token = a.access_token(&s.http).await?;
    let g = Gmail {
        http: &s.http,
        token: &token,
    };
    replay_pending(app, a, &g).await?;
    let labels = g.labels().await?;
    db::replace_labels(&mut a.db(), &labels)?;
    let history = db::get_meta(&a.db(), "history_id")?;
    let mut changed = false;
    let mut budget = tick_budget(settings::sync_seconds(&s.dir));
    match history {
        None => full_sync(a, &g).await?,
        Some(h) => match g.history(&h).await {
            Ok((mut ids, new_id)) => {
                changed = !ids.is_empty();
                // A burst (a day offline, a bulk action elsewhere) is fetched over several ticks: what doesn't fit
                // this tick's budget joins the backfill queue, which already persists and retries.
                let fits = (budget / METADATA_COST).max(1) as usize;
                if ids.len() > fits {
                    enqueue(a, ids.split_off(fits))?;
                }
                budget -= ids.len() as i64 * METADATA_COST;
                fetch_threads(app, a, &g, ids).await?;
                db::set_meta(&a.db(), "history_id", &new_id)?;
                if changed {
                    // A failed notification mustn't fail the sync.
                    if let Err(e) = notify_new_mail(app, a) {
                        eprintln!("{} notification: {e:#}", a.email);
                    }
                    spawn_auto_label(app, &a.email);
                }
            }
            // Expired cursor (Gmail keeps about a week): start over, keeping the cache until threads are refetched.
            Err(e) if gmail::is_not_found(&e) => full_sync(a, &g).await?,
            Err(e) => return Err(e),
        },
    }
    let (filled, spent) = backfill(app, a, &g, budget).await?;
    // Every tick used to repaint the whole UI; now only when something came in.
    if changed || filled > 0 {
        let _ = app.emit(CHANGED, ());
    }
    // Bodies wait until the mailbox is listed, so the two don't compete for quota.
    if filled == 0 {
        prefetch_bodies(app, a, &g, budget - spent).await?;
    }
    // After this tick's fetches, so new mail isn't counted twice.
    // The cache only holds recent mail: note how many unread Inbox threads Gmail has beyond it (1 quota unit).
    if let Ok(n) = g.unread_threads("INBOX").await {
        let c = a.db();
        // `labels` already adds the last extra; take it off to get what's cached.
        let cached = db::labels(&c)?.into_iter().find(|l| l.id == "INBOX").map_or(0, |l| l.unread);
        let extra: i64 = db::get_meta(&c, "inbox_unread_extra")?.and_then(|v| v.parse().ok()).unwrap_or(0);
        db::set_meta(&c, "inbox_unread_extra", &(n - (cached - extra)).max(0).to_string())?;
    }
    Ok(())
}

/// Brackets a sync with `syncing` events so the UI can show progress.
async fn sync(app: &AppHandle) {
    let _ = app.emit("syncing", true);
    sync_all(app).await;
    let _ = app.emit("syncing", false);
}

/// Syncs every account; one failing account (e.g. signed out elsewhere) doesn't stop the others.
async fn sync_all(app: &AppHandle) {
    let s = app.state::<State>();
    for a in s.all() {
        if let Err(e) = send_due(app, &a).await {
            let _ = app.emit(
                "sync-error",
                format!("{}: scheduled send failed: {e:#}", a.email),
            );
        }
    }
    if s.demo {
        return;
    }
    // In parallel: Gmail's quota is per account, and one slow account mustn't hold the others back.
    let accounts = s.all();
    futures::future::join_all(accounts.iter().map(|a| async move {
        let mut result = sync_account(app, a).await;
        // Gmail no longer accepts the cached token (revoked, or expired early): refresh it and try once more.
        if result.as_ref().is_err_and(gmail::is_unauthorized) {
            a.forget_token().await;
            result = sync_account(app, a).await;
        }
        if let Err(e) = result {
            let _ = app.emit("sync-error", format!("{}: {e:#}", a.email));
        }
    }))
    .await;
}

/// Release builds check shift.talkk.com.au for a newer version at launch and every six hours, install it in the
/// background, then tell the UI so it can offer a restart. Dev and demo builds never update themselves.
/// Release builds only: dev and demo builds have no signed update feed to install from.
fn updates_enabled(app: &AppHandle) -> bool {
    !cfg!(debug_assertions) && !app.state::<State>().demo
}

/// Checks the update feed and installs a newer version if there is one. Returns its version; the restart is the user's.
async fn install_update(app: &AppHandle) -> anyhow::Result<Option<String>> {
    use tauri_plugin_updater::UpdaterExt;
    let Some(update) = app.updater()?.check().await? else {
        return Ok(None);
    };
    update.download_and_install(|_, _| {}, || {}).await?;
    Ok(Some(update.version))
}

fn spawn_update_checks(app: &AppHandle) {
    if !updates_enabled(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match install_update(&app).await {
                Ok(Some(version)) => {
                    let _ = app.emit("update-ready", version);
                    return;
                }
                Ok(None) => {}
                Err(e) => eprintln!("update check failed: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// Shift → Check for Updates…: the same check, now, with the outcome shown as a toast either way.
fn check_for_updates_now(app: &AppHandle) {
    if !updates_enabled(app) {
        let _ = app.emit("app-toast", "Updates only work in release builds");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match install_update(&app).await {
            Ok(Some(version)) => {
                let _ = app.emit("update-ready", version);
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

/// macOS's default menu (About, Edit, Window…) with Check for Updates… under About Shift.
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem};
    let menu = Menu::default(app)?;
    if let Some(app_menu) = menu.items()?.first().and_then(|m| m.as_submenu()) {
        let check =
            MenuItem::with_id(app, CHECK_UPDATES, "Check for Updates…", true, None::<&str>)?;
        app_menu.insert(&check, 1)?;
    }
    Ok(menu)
}

const CHECK_UPDATES: &str = "check-updates";

/// Settings → Notifications → Send a test: shows a notification the way new mail would, sound setting included.
#[tauri::command(async)]
fn test_notification(app: AppHandle) -> R<()> {
    use tauri_plugin_notification::NotificationExt;
    let cfg = settings::notifications(&app.state::<State>().dir);
    let mut n = app
        .notification()
        .builder()
        .title("Shift")
        .body("Notifications are working. New mail will look like this.");
    if cfg.sound {
        n = n.sound("default");
    }
    // The button is clicked with Shift in front, where macOS would hide the banner.
    #[cfg(target_os = "macos")]
    PRESENT_NEXT.store(true, std::sync::atomic::Ordering::SeqCst);
    n.show().map_err(anyhow::Error::from)?;
    Ok(())
}

/// Set by the test notification: show the next banner even though Shift is the frontmost app.
#[cfg(target_os = "macos")]
static PRESENT_NEXT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// macOS hides an app's notification banners while it is frontmost unless its notification-centre delegate says
/// otherwise. The delegate belongs to mac-notification-sys (under the notification plugin) and doesn't implement
/// `shouldPresentNotification`, so it's added here: yes for the test notification only, so new mail still doesn't
/// pop up over the inbox you're reading.
#[cfg(target_os = "macos")]
fn allow_test_banner() {
    use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
    unsafe extern "C-unwind" fn should_present(
        _: *mut AnyObject,
        _: Sel,
        _: *mut AnyObject,
        _: *mut AnyObject,
    ) -> Bool {
        Bool::new(PRESENT_NEXT.swap(false, std::sync::atomic::Ordering::SeqCst))
    }
    let Some(class) = AnyClass::get(c"NotificationCenterDelegate") else {
        return;
    };
    unsafe {
        let imp: Imp =
            std::mem::transmute(should_present as unsafe extern "C-unwind" fn(_, _, _, _) -> Bool);
        objc2::ffi::class_addMethod(
            class as *const AnyClass as *mut AnyClass,
            objc2::sel!(userNotificationCenter:shouldPresentNotification:),
            imp,
            c"B@:@@".as_ptr(),
        );
    }
}

// ---- AI (src/ai.rs): writing help in the composer, auto-labelling new mail, and inbox cleanup suggestions.

/// Rewrites text from the composer by an instruction ("Make it shorter").
#[tauri::command]
async fn ai_rewrite(
    s: tauri::State<'_, State>,
    text: String,
    instruction: String,
    rules: String,
) -> R<String> {
    demo_has_no_ai(&s)?;
    let cfg = ai::config(&s.dir, ai::Task::Writing)?;
    // JSON, so nothing in the text can pass for the end of it and add instructions of its own.
    let user = serde_json::json!({ "instruction": instruction, "text": text }).to_string();
    Ok(ai::complete(
        &s.ai_http,
        &cfg,
        &ai::with_rules(ai::REWRITE, &rules),
        &user,
        None,
        Some(ai::WRITING_EFFORT),
    )
    .await?)
}

/// Drafts the body of a reply. The UI sends the conversation as text (it already turns HTML bodies into text) and
/// whatever the user has typed so far as notes.
#[tauri::command]
async fn ai_draft_reply(
    s: tauri::State<'_, State>,
    conversation: String,
    notes: String,
    me: String,
    rules: String,
) -> R<String> {
    demo_has_no_ai(&s)?;
    let cfg = ai::config(&s.dir, ai::Task::Writing)?;
    let notes = notes.trim();
    let user = serde_json::json!({
        "me": me,
        "conversation": conversation,
        "notes": if notes.is_empty() { "(none: write the natural reply)" } else { notes },
    })
    .to_string();
    Ok(ai::complete(
        &s.ai_http,
        &cfg,
        &ai::with_rules(ai::DRAFT, &rules),
        &user,
        None,
        Some(ai::WRITING_EFFORT),
    )
    .await?)
}

/// Files new Inbox mail into the labels the user described in Settings → AI. Runs after a sync that brought new
/// mail; only mail newer than the `ai_labeled_at` watermark, so turning it on doesn't relabel the backlog.
/// Runs auto-label for `account` in its own task: the AI call can take minutes (300 s timeout), and inside the sync
/// it held up new mail for that account. One run at a time per account; a skipped run is caught by the next one.
fn spawn_auto_label(app: &AppHandle, account: &str) {
    let (app, account) = (app.clone(), account.to_string());
    tauri::async_runtime::spawn(async move {
        let Ok(a) = app.state::<State>().account(&account) else {
            return;
        };
        let Ok(_running) = a.labeling.try_lock() else {
            return;
        };
        if let Err(e) = auto_label(&app, &a).await {
            let _ = app.emit("sync-error", format!("{}: AI labelling: {e:#}", a.email));
        }
    });
}

async fn auto_label(app: &AppHandle, a: &Account) -> anyhow::Result<()> {
    let s = app.state::<State>();
    if settings::ai_label_rules(&s.dir).is_none() {
        return Ok(());
    }
    let mail = {
        let c = a.db();
        let Some(since) = db::get_meta(&c, "ai_labeled_at")?.and_then(|v| v.parse().ok()) else {
            db::set_meta(&c, "ai_labeled_at", &now_ms().to_string())?;
            return Ok(());
        };
        // Read or not: opening an email from its notification before this runs shouldn't keep it unlabelled.
        db::inbox_mail(&c, since, false)?
    };
    if mail.is_empty() {
        return Ok(());
    }
    let token = a.access_token(&s.http).await?;
    let g = Gmail { http: &s.http, token: &token };
    // Oldest first, 40 at a time (one AI request each); the watermark moves past a batch only once it's done, so a
    // burst of mail is labelled in full and a failure retries from the batch that failed.
    for batch in mail.chunks(40) {
        apply_label_rules(app, a, &g, batch).await?;
        let done = batch.iter().map(|m| m.date).max().unwrap_or_default();
        db::set_meta(&a.db(), "ai_labeled_at", &done.to_string())?;
    }
    Ok(())
}

/// Asks the AI which of the user's described labels fit `mail` (up to 40 emails) and adds them, locally and in Gmail,
/// recording each in `ai_labels` so the reader can show and undo it. Returns how many emails got a label.
async fn apply_label_rules(
    app: &AppHandle,
    a: &Account,
    g: &Gmail<'_>,
    mail: &[db::NewMail],
) -> anyhow::Result<usize> {
    let s = app.state::<State>();
    let Some(rules) = settings::ai_label_rules(&s.dir) else {
        return Ok(0);
    };
    // Only labels this account has: Gmail labels belong to one account.
    let ids: std::collections::HashMap<String, String> = {
        let c = a.db();
        rules
            .iter()
            .filter_map(|(name, _)| Some((name.clone(), db::label_id(&c, name).ok()??)))
            .collect()
    };
    let rules: Vec<_> = rules
        .into_iter()
        .filter(|(n, _)| ids.contains_key(n))
        .collect();
    if rules.is_empty() || mail.is_empty() {
        return Ok(0);
    }
    let cfg = ai::config(&s.dir, ai::Task::Sorting)?;
    let names: Vec<&str> = rules.iter().map(|(n, _)| n.as_str()).collect();
    let schema = ai::results_schema(
        "labels",
        serde_json::json!({ "type": "array", "items": { "type": "string", "enum": names } }),
    );
    let labels: Vec<_> = rules
        .iter()
        .map(|(n, d)| serde_json::json!({ "name": n, "description": d }))
        .collect();
    let emails: Vec<_> = mail.iter().take(40).map(|m| serde_json::json!({ "id": m.id, "from": m.sender, "subject": m.subject, "preview": m.snippet })).collect();
    let user = format!(
        "Labels:\n{}\n\nEmails:\n{}",
        serde_json::to_string(&labels)?,
        serde_json::to_string(&emails)?
    );
    let answer = ai::json_in(
        &ai::complete(
            &s.ai_http,
            &cfg,
            ai::LABEL,
            &user,
            Some(&schema),
            Some(ai::SORTING_EFFORT),
        )
        .await?,
    )?;
    let at = now_ms();
    let mut labelled = 0;
    for r in answer["results"].as_array().into_iter().flatten() {
        let Some(thread) = r["id"].as_str().filter(|t| mail.iter().any(|m| m.id == *t)) else {
            continue;
        };
        let add: Vec<String> = r["labels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|n| ids.get(n.as_str()?).cloned())
            .collect();
        if add.is_empty() {
            continue;
        }
        db::change_labels(&mut a.db(), thread, &add, &[])?;
        for l in &add {
            db::add_ai_label(&a.db(), thread, l, at)?;
        }
        g.modify(thread, &add, &[]).await?;
        labelled += 1;
    }
    if labelled > 0 {
        let _ = app.emit(CHANGED, ());
    }
    Ok(labelled)
}

/// The demo mailbox is fake, so AI features (which call a real provider with the user's key) are off there.
fn demo_has_no_ai(s: &State) -> anyhow::Result<()> {
    if s.demo {
        anyhow::bail!("AI features need a real account, not the demo");
    }
    Ok(())
}

/// Settings → AI → Auto-label → Label my Inbox now: applies the rules to the newest Inbox emails that came in before
/// they existed (auto-label only looks at new mail). Returns how many emails got a label.
#[tauri::command]
async fn ai_label_inbox(
    app: AppHandle,
    s: tauri::State<'_, State>,
    accounts: Option<Vec<String>>,
) -> R<usize> {
    demo_has_no_ai(&s)?;
    let mut labelled = 0;
    for a in s.scope(accounts.as_deref())? {
        let mut mail = db::inbox_mail(&a.db(), 0, false)?;
        // Newest 40: inbox_mail lists oldest first.
        let mail = mail.split_off(mail.len().saturating_sub(40));
        let token = a.access_token(&s.http).await?;
        let g = Gmail {
            http: &s.http,
            token: &token,
        };
        labelled += apply_label_rules(&app, &a, &g, &mail).await?;
    }
    Ok(labelled)
}

/// Labels the AI added to a thread, for the reader's "Labelled by AI" line.
#[tauri::command(async)]
fn ai_labels(s: tauri::State<State>, account: String, id: String) -> R<Vec<String>> {
    Ok(db::ai_labels(&s.account(&account)?.db(), &id)?)
}

/// Takes the AI's labels off a thread, in Gmail too.
#[tauri::command]
async fn ai_undo_labels(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    id: String,
) -> R<()> {
    let a = s.account(&account)?;
    let labels = db::ai_labels(&a.db(), &id)?;
    db::change_labels(&mut a.db(), &id, &[], &labels)?;
    db::forget_ai_labels(&a.db(), &id)?;
    let _ = app.emit(CHANGED, ());
    if !s.demo && !labels.is_empty() {
        let token = a.access_token(&s.http).await?;
        Gmail {
            http: &s.http,
            token: &token,
        }
        .modify(&id, &[], &labels)
        .await?;
    }
    Ok(())
}

#[derive(Serialize)]
struct CleanupItem {
    account: String,
    id: String,
    group: String,
    sender: String,
    subject: String,
}

/// Sorts the newest Inbox threads into newsletter / notification / done / keep for the user to review. Changes nothing.
#[tauri::command]
async fn ai_cleanup(
    s: tauri::State<'_, State>,
    accounts: Option<Vec<String>>,
) -> R<Vec<CleanupItem>> {
    demo_has_no_ai(&s)?;
    let cfg = ai::config(&s.dir, ai::Task::Sorting)?;
    let schema = ai::results_schema(
        "group",
        serde_json::json!({ "type": "string", "enum": ["newsletter", "notification", "done", "keep"] }),
    );
    let mut out = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        let brief = db::inbox_brief(&a.db(), 150)?;
        // In chunks, so each answer stays short and one failure costs only its chunk.
        for chunk in brief.chunks(50) {
            let emails: Vec<_> = chunk.iter().map(|[id, from, subject, preview]| serde_json::json!({ "id": id, "from": from, "subject": subject, "preview": preview })).collect();
            let answer = ai::json_in(
                &ai::complete(
                    &s.ai_http,
                    &cfg,
                    ai::CLEANUP,
                    &serde_json::to_string(&emails).map_err(anyhow::Error::from)?,
                    Some(&schema),
                    Some(ai::SORTING_EFFORT),
                )
                .await?,
            )?;
            for r in answer["results"].as_array().into_iter().flatten() {
                let (Some(id), Some(group)) = (r["id"].as_str(), r["group"].as_str()) else {
                    continue;
                };
                if let Some([_, sender, subject, _]) = chunk.iter().find(|[t, ..]| t == id) {
                    out.push(CleanupItem {
                        account: a.email.clone(),
                        id: id.into(),
                        group: group.into(),
                        sender: sender.clone(),
                        subject: subject.clone(),
                    });
                }
            }
        }
    }
    Ok(out)
}

/// Passed by the login item, so Shift starts hidden in the Dock and just syncs and notifies.
const LAUNCHED_AT_LOGIN: &str = "--hidden";

/// The login item: a LaunchAgent tied to Shift's bundle id, so macOS names it "Shift" in Login Items and in its
/// "can run in the background" notice, rather than the developer on the signing certificate.
fn login_item(app: &AppHandle) -> anyhow::Result<auto_launch::AutoLaunch> {
    let exe = std::env::current_exe()?;
    Ok(auto_launch::AutoLaunchBuilder::new()
        .set_app_name("Shift")
        .set_app_path(&exe.display().to_string())
        .set_macos_launch_mode(auto_launch::MacOSLaunchMode::LaunchAgent)
        .set_bundle_identifiers(&[&app.config().identifier])
        .set_args(&[LAUNCHED_AT_LOGIN])
        .build()?)
}

#[tauri::command(async)]
fn open_at_login(app: AppHandle) -> R<bool> {
    Ok(login_item(&app)?.is_enabled()?)
}

#[tauri::command(async)]
fn set_open_at_login(app: AppHandle, enabled: bool) -> R<()> {
    // A dev build would register target/debug/app as the login item.
    if cfg!(debug_assertions) {
        return Err(anyhow::anyhow!(
            "Open at login works in the installed app, not in a dev build"
        )
        .into());
    }
    let item = login_item(&app)?;
    if enabled {
        item.enable()?
    } else {
        item.disable()?
    }
    Ok(())
}

/// Restarts into the update `spawn_update_checks` installed.
#[tauri::command]
fn restart_app(app: AppHandle) {
    // macOS: relaunch through LaunchServices (`open`) once this process has exited. Tauri's restart starts the new
    // binary as a child of this one, which the Dock shows as a second Shift icon next to the pinned one.
    #[cfg(target_os = "macos")]
    if let Some(bundle) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.ancestors().find(|p| p.extension().is_some_and(|e| e == "app")).map(Path::to_path_buf))
    {
        let script = format!(
            "while kill -0 {} 2>/dev/null; do sleep 0.1; done; open \"$0\"",
            std::process::id()
        );
        if std::process::Command::new("/bin/sh").args(["-c", &script]).arg(&bundle).spawn().is_ok() {
            app.exit(0);
            return;
        }
    }
    app.restart();
}

fn spawn_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { sync(&app).await });
}

#[derive(Serialize)]
struct Status {
    accounts: Vec<String>,
    broken: Vec<String>,
}

#[tauri::command]
fn status(s: tauri::State<State>) -> Status {
    Status {
        accounts: s.all().iter().map(|a| a.email.clone()).collect(),
        broken: s.broken.clone(),
    }
}

/// Browser sign-in for a new (or re-authorised) Google account; returns its address.
#[tauri::command]
async fn add_account(app: AppHandle, s: tauri::State<'_, State>) -> R<String> {
    let (token, refresh) = auth::sign_in(&s.http, |url| {
        Ok(tauri_plugin_opener::open_url(url, None::<&str>)?)
    })
    .await?;
    let (email, _) = Gmail {
        http: &s.http,
        token: &token.access,
    }
    .profile()
    .await?;
    auth::store_refresh(&email, &refresh)?;
    let account = match s.account(&email) {
        Ok(existing) => existing, // signing in again to an account that's already here just refreshes its login
        Err(_) => {
            let conn = db::open(&db_path(&s.dir, &email))?;
            db::set_meta(&conn, "email", &email)?;
            let a = Account::new(email.clone(), conn);
            s.accounts
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(a.clone());
            a
        }
    };
    *account.token.lock().await = Some(token);
    spawn_sync(&app);
    Ok(email)
}

/// Removes one account from this Mac: its Keychain login and its local mail. Gmail itself is untouched.
#[tauri::command]
async fn sign_out(s: tauri::State<'_, State>, account: String) -> R<()> {
    let a = s.account(&account)?;
    s.accounts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|x| !Arc::ptr_eq(x, &a));
    if !s.demo {
        auth::revoke(&s.http, &a.email).await;
    }
    auth::forget(&a.email);
    db::wipe(&a.db())?;
    if !s.demo {
        let path = db_path(&s.dir, &a.email);
        drop(a);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }
    Ok(())
}

#[tauri::command]
fn sync_now(app: AppHandle) {
    spawn_sync(&app);
}

/// Labels for one account. Several accounts add up counts per system mailbox, and merge user labels by
/// name under the id `name:<name>` (label ids are per account), which `threads` resolves in each account.
// (async) on the commands below that touch SQLite or the Keychain: a plain command runs on the main thread, so a
// sync holding an account's database lock (or a Keychain prompt) would freeze the UI.
#[tauri::command(async)]
fn labels(s: tauri::State<State>, accounts: Option<Vec<String>>) -> R<Vec<db::LabelRow>> {
    let accounts = s.scope(accounts.as_deref())?;
    if let [one] = accounts.as_slice() {
        return Ok(db::labels(&one.db())?);
    }
    let mut merged: Vec<db::LabelRow> = Vec::new();
    for a in accounts {
        for mut l in db::labels(&a.db())? {
            if l.kind == "user" {
                l.id = format!("name:{}", l.name);
            }
            match merged.iter_mut().find(|m| m.id == l.id) {
                Some(m) => {
                    m.unread += l.unread;
                    m.color = m.color.take().or(l.color);
                }
                None => merged.push(l),
            }
        }
    }
    Ok(merged)
}

/// Runs `query` against each account in scope, tags rows with their account and merges newest first.
fn merged_threads(
    s: &State,
    accounts: Option<&[String]>,
    query: impl Fn(&Connection) -> anyhow::Result<Vec<db::ThreadRow>>,
) -> anyhow::Result<Vec<db::ThreadRow>> {
    let mut rows = Vec::new();
    for a in s.scope(accounts)? {
        let mut found = query(&a.db())?;
        found.iter_mut().for_each(|t| t.account = a.email.clone());
        rows.extend(found);
    }
    rows.sort_by_key(|t| std::cmp::Reverse(t.date));
    rows.truncate(1000);
    Ok(rows)
}

#[tauri::command(async)]
fn threads(
    s: tauri::State<State>,
    label: Option<String>,
    accounts: Option<Vec<String>>,
) -> R<Vec<db::ThreadRow>> {
    Ok(merged_threads(&s, accounts.as_deref(), |c| match &label {
        None => db::threads(c, None),
        Some(l) => match resolve_label(c, l)? {
            Some(id) => db::threads(c, Some(&id)),
            None => Ok(Vec::new()),
        },
    })?)
}

/// This account's id for `label`: a merged `name:<name>` label is its label of that name, `None` when it has none.
fn resolve_label(c: &Connection, label: &str) -> anyhow::Result<Option<String>> {
    match label.strip_prefix("name:") {
        Some(name) => db::label_id(c, name),
        None => Ok(Some(label.into())),
    }
}

/// Marks every thread in a mailbox read (`label` None: All Mail). Local first, then one Gmail batch call per
/// account; if Gmail fails, the changed threads are re-fetched to undo the local change.
#[tauri::command]
async fn mark_all_read(
    app: AppHandle,
    s: tauri::State<'_, State>,
    label: Option<String>,
    accounts: Option<Vec<String>>,
) -> R<()> {
    let mut changed = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        let id = match &label {
            None => None,
            Some(l) => match resolve_label(&a.db(), l)? {
                Some(id) => Some(id),
                None => continue,
            },
        };
        let ids = db::mark_read(&mut a.db(), id.as_deref())?;
        changed.push((a, id, ids));
    }
    let _ = app.emit(CHANGED, ());
    if s.demo {
        return Ok(());
    }
    for (a, id, ids) in changed {
        if ids.is_empty() {
            continue;
        }
        let token = a.access_token(&s.http).await?;
        let g = Gmail {
            http: &s.http,
            token: &token,
        };
        // Archive isn't a Gmail label; it's what the local `threads("ARCHIVE")` lists.
        let (q, labels) = match id.as_deref() {
            // All Mail as Shift lists it, which leaves out Spam and Trash.
            None => ("-in:spam -in:trash", vec!["UNREAD"]),
            Some("ARCHIVE") => ("-in:inbox -in:drafts -in:trash -in:spam", vec!["UNREAD"]),
            Some(l) => ("", vec![l, "UNREAD"]),
        };
        let remote = async {
            let msgs = g.message_ids(q, &labels).await?;
            g.batch_modify(&msgs, &[], &["UNREAD"]).await
        }
        .await;
        if let Err(e) = remote {
            let _ = fetch_threads(&app, &a, &g, ids).await;
            let _ = app.emit(CHANGED, ());
            return Err(e.into());
        }
    }
    Ok(())
}

/// Permanently deletes everything in Trash or Spam. Local first; if Gmail fails, the threads are fetched back.
#[tauri::command]
async fn empty_mailbox(
    app: AppHandle,
    s: tauri::State<'_, State>,
    label: String,
    accounts: Option<Vec<String>>,
) -> R<()> {
    if label != "TRASH" && label != "SPAM" {
        return Err(anyhow::anyhow!("Only Trash and Spam can be emptied").into());
    }
    let mut removed = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        let ids: Vec<String> = db::thread_ids(&a.db(), &label)?;
        db::delete_threads(&mut a.db(), &ids)?;
        removed.push((a, ids));
    }
    let _ = app.emit(CHANGED, ());
    if s.demo {
        return Ok(());
    }
    for (a, ids) in removed {
        let token = a.access_token(&s.http).await?;
        let g = Gmail {
            http: &s.http,
            token: &token,
        };
        let remote = async {
            let msgs = g.message_ids("", &[&label]).await?;
            g.batch_delete(&msgs).await
        }
        .await;
        if let Err(e) = remote {
            let _ = fetch_threads(&app, &a, &g, ids).await;
            let _ = app.emit(CHANGED, ());
            if gmail::is_scope_error(&e) {
                return Err(anyhow::anyhow!(
                    "{} needs to sign in again to allow permanent deletion: Settings → Accounts → Add account, then pick {} again.",
                    a.email,
                    a.email
                )
                .into());
            }
            return Err(e.into());
        }
    }
    Ok(())
}

enum LabelEdit<'a> {
    Rename(&'a str),
    Color { background: &'a str, text: &'a str },
    Delete,
}

/// Renames, recolours or deletes a user label in Gmail, then in the cache, in every account in scope that has it.
async fn edit_label(
    app: &AppHandle,
    s: &State,
    accounts: Option<&[String]>,
    label: &str,
    edit: LabelEdit<'_>,
) -> anyhow::Result<()> {
    for a in s.scope(accounts)? {
        let Some(id) = resolve_label(&a.db(), label)? else {
            continue;
        };
        if !s.demo {
            let token = a.access_token(&s.http).await?;
            let g = Gmail {
                http: &s.http,
                token: &token,
            };
            match edit {
                LabelEdit::Rename(name) => {
                    g.patch_label(&id, &serde_json::json!({ "name": name }))
                        .await?
                }
                LabelEdit::Color { background, text } => {
                    let color = serde_json::json!({ "color": { "backgroundColor": background, "textColor": text } });
                    g.patch_label(&id, &color).await?
                }
                LabelEdit::Delete => g.delete_label(&id).await?,
            }
        }
        match edit {
            LabelEdit::Rename(name) => db::rename_label(&a.db(), &id, name)?,
            LabelEdit::Color { background, .. } => db::set_label_color(&a.db(), &id, background)?,
            LabelEdit::Delete => db::delete_label(&a.db(), &id)?,
        }
    }
    let _ = app.emit(CHANGED, ());
    Ok(())
}

/// Creates a label in one account (Gmail first, since it assigns the id) and returns its id.
#[tauri::command]
async fn create_label(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    name: String,
) -> R<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("A label needs a name").into());
    }
    let a = s.account(&account)?;
    let mut label = if s.demo {
        gmail::Label {
            id: format!("Label_demo_{}", now_ms()),
            name: name.into(),
            kind: "user".into(),
            color: None,
        }
    } else {
        let token = a.access_token(&s.http).await?;
        Gmail {
            http: &s.http,
            token: &token,
        }
        .create_label(name)
        .await?
    };
    // Gmail's create response can leave out `type`; the sidebar lists only "user" labels, so the new one stayed
    // hidden until the next full label sync.
    if label.kind.is_empty() {
        label.kind = "user".into();
    }
    db::insert_label(&a.db(), &label)?;
    let _ = app.emit(CHANGED, ());
    Ok(label.id)
}

#[tauri::command]
async fn rename_label(
    app: AppHandle,
    s: tauri::State<'_, State>,
    label: String,
    name: String,
    accounts: Option<Vec<String>>,
) -> R<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow::anyhow!("A label needs a name").into());
    }
    Ok(edit_label(
        &app,
        &s,
        accounts.as_deref(),
        &label,
        LabelEdit::Rename(name),
    )
    .await?)
}

#[tauri::command]
async fn set_label_color(
    app: AppHandle,
    s: tauri::State<'_, State>,
    label: String,
    background: String,
    text: String,
    accounts: Option<Vec<String>>,
) -> R<()> {
    // Also what the frontend's stylesheet trusts, so nothing but a hex colour reaches it.
    let hex = |c: &str| {
        c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
    };
    if !hex(&background) || !hex(&text) {
        return Err(anyhow::anyhow!("Not a colour: {background}").into());
    }
    let edit = LabelEdit::Color {
        background: &background,
        text: &text,
    };
    Ok(edit_label(&app, &s, accounts.as_deref(), &label, edit).await?)
}

#[tauri::command]
async fn delete_label(
    app: AppHandle,
    s: tauri::State<'_, State>,
    label: String,
    accounts: Option<Vec<String>>,
) -> R<()> {
    Ok(edit_label(&app, &s, accounts.as_deref(), &label, LabelEdit::Delete).await?)
}

#[tauri::command]
async fn thread(s: tauri::State<'_, State>, account: String, id: String) -> R<Vec<db::MessageRow>> {
    let a = s.account(&account)?;
    if db::is_full(&a.db(), &id) {
        return Ok(db::messages(&a.db(), &id)?);
    }
    let token = a.access_token(&s.http).await?;
    let t = Gmail {
        http: &s.http,
        token: &token,
    }
    .thread(&id, true)
    .await?;
    db::upsert_thread(&mut a.db(), &t, true)?;
    Ok(db::messages(&a.db(), &id)?)
}

/// Applied locally first so the UI never waits on the network; a failed remote call re-fetches the thread.
#[tauri::command]
async fn modify(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    id: String,
    add: Vec<String>,
    remove: Vec<String>,
    trash: bool,
) -> R<()> {
    let a = s.account(&account)?;
    db::change_labels(&mut a.db(), &id, &add, &remove)?;
    let _ = app.emit(CHANGED, ());
    if s.demo {
        return Ok(());
    }
    Ok(push_change(&app, &s, &a, &id, &add, &remove, trash).await?)
}

/// Sends one thread's local change to Gmail. Offline (or behind a change still waiting) it waits in `pending_ops`
/// for the sync loop (`replay_pending`); refused, the thread is re-fetched as Gmail has it.
async fn push_change(
    app: &AppHandle,
    s: &State,
    a: &Account,
    id: &str,
    add: &[String],
    remove: &[String],
    trash: bool,
) -> anyhow::Result<()> {
    if db::has_pending(&a.db(), id) {
        return db::add_pending(&a.db(), id, add, remove, trash);
    }
    let remote = match a.access_token(&s.http).await {
        Ok(token) => apply_remote(&Gmail { http: &s.http, token: &token }, id, add, remove, trash).await,
        Err(e) => Err(e),
    };
    match remote {
        Ok(()) => Ok(()),
        Err(e) if gmail::is_transient(&e) => db::add_pending(&a.db(), id, add, remove, trash),
        Err(e) => {
            if let Ok(token) = a.access_token(&s.http).await {
                refetch(app, a, &Gmail { http: &s.http, token: &token }, id).await;
            }
            Err(e)
        }
    }
}

/// `modify` for several threads of one account (bulk actions, Clean up). Label changes reach Gmail in one
/// `messages.batchModify` per 1000 messages instead of a call per thread; Trash has no batch form, so moving in or
/// out of it goes thread by thread.
#[tauri::command]
async fn modify_many(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    ids: Vec<String>,
    add: Vec<String>,
    remove: Vec<String>,
    trash: bool,
) -> R<()> {
    let a = s.account(&account)?;
    for id in &ids {
        db::change_labels(&mut a.db(), id, &add, &remove)?;
    }
    let _ = app.emit(CHANGED, ());
    if s.demo {
        return Ok(());
    }
    let (waiting, now): (Vec<String>, Vec<String>) = ids.into_iter().partition(|id| db::has_pending(&a.db(), id));
    if trash || remove.iter().any(|l| l == "TRASH") || now.len() < 2 {
        let mut failed = None;
        for id in waiting.iter().chain(&now) {
            if let Err(e) = push_change(&app, &s, &a, id, &add, &remove, trash).await {
                failed.get_or_insert(e);
            }
        }
        return failed.map_or(Ok(()), |e| Err(e.into()));
    }
    for id in &waiting {
        db::add_pending(&a.db(), id, &add, &remove, false)?;
    }
    let queue = |ids: &[String]| ids.iter().try_for_each(|id| db::add_pending(&a.db(), id, &add, &remove, false));
    let token = match a.access_token(&s.http).await {
        Ok(t) => t,
        Err(e) if gmail::is_transient(&e) => return Ok(queue(&now)?),
        Err(e) => return Err(e.into()),
    };
    let g = Gmail { http: &s.http, token: &token };
    let msgs = db::message_ids(&a.db(), &now)?;
    let add_ids: Vec<&str> = add.iter().map(String::as_str).collect();
    let remove_ids: Vec<&str> = remove.iter().map(String::as_str).collect();
    match g.batch_modify(&msgs, &add_ids, &remove_ids).await {
        Ok(()) => Ok(()),
        Err(e) if gmail::is_transient(&e) => Ok(queue(&now)?),
        Err(e) => {
            for id in &now {
                refetch(&app, &a, &g, id).await;
            }
            Err(e.into())
        }
    }
}

/// Sends one label change to Gmail. Gmail moves threads in and out of Trash only through trash/untrash.
async fn apply_remote(g: &Gmail<'_>, id: &str, add: &[String], remove: &[String], trash: bool) -> anyhow::Result<()> {
    if trash {
        g.trash(id).await
    } else if remove.iter().any(|l| l == "TRASH") {
        let rest: Vec<String> = remove.iter().filter(|l| *l != "TRASH").cloned().collect();
        g.untrash(id).await?;
        g.modify(id, add, &rest).await
    } else {
        g.modify(id, add, remove).await
    }
}

/// Replaces the cached thread with Gmail's copy, undoing a local change Gmail didn't take.
async fn refetch(app: &AppHandle, a: &Account, g: &Gmail<'_>, id: &str) {
    let full = db::is_full(&a.db(), id);
    if let Ok(t) = g.thread(id, full).await {
        let _ = db::upsert_thread(&mut a.db(), &t, full);
        let _ = app.emit(CHANGED, ());
    }
}

/// Sends changes made while Gmail couldn't be reached, oldest first. Stops at the first one that still can't get
/// through (the rest stay queued, in order); one Gmail refuses is dropped and its thread re-fetched.
async fn replay_pending(app: &AppHandle, a: &Account, g: &Gmail<'_>) -> anyhow::Result<()> {
    let ops = db::pending_ops(&a.db())?;
    for op in ops {
        match apply_remote(g, &op.thread, &op.add, &op.remove, op.trash).await {
            Ok(()) => db::done_pending(&a.db(), op.seq)?,
            Err(e) if gmail::is_transient(&e) => return Err(e),
            Err(_) => {
                db::done_pending(&a.db(), op.seq)?;
                if !db::has_pending(&a.db(), &op.thread) {
                    refetch(app, a, g, &op.thread).await;
                }
            }
        }
    }
    Ok(())
}

/// Gmail search across the accounts in scope; results are cached locally and returned newest first.
#[tauri::command]
async fn search(
    s: tauri::State<'_, State>,
    app: AppHandle,
    query: String,
    accounts: Option<Vec<String>>,
) -> R<Vec<db::ThreadRow>> {
    if s.demo {
        return Ok(merged_threads(&s, accounts.as_deref(), |c| {
            db::search_local(c, &query)
        })?);
    }
    let mut rows = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        let token = a.access_token(&s.http).await?;
        let g = Gmail {
            http: &s.http,
            token: &token,
        };
        let ids = g.thread_ids(&query, None, 50).await?;
        let missing: Vec<String> = ids
            .iter()
            .filter(|id| !db::has_thread(&a.db(), id).unwrap_or(false))
            .cloned()
            .collect();
        // Show whatever loaded; a few failed fetches shouldn't hide the rest of the results.
        let _ = fetch_threads(&app, &a, &g, missing).await;
        let mut found = db::threads_by_ids(&a.db(), &ids)?;
        found.iter_mut().for_each(|t| t.account = a.email.clone());
        rows.extend(found);
    }
    rows.sort_by_key(|t| std::cmp::Reverse(t.date));
    Ok(rows)
}

/// Splits a header address list on commas outside quotes and angle brackets.
fn parse_addresses(list: &str) -> Vec<(String, String)> {
    let (mut parts, mut cur, mut quoted, mut angled) = (Vec::new(), String::new(), false, false);
    for c in list.chars() {
        match c {
            '"' => quoted = !quoted,
            '<' => angled = true,
            '>' => angled = false,
            ',' if !quoted && !angled => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    parts.push(cur);
    parts
        .iter()
        .filter_map(|p| {
            let p = p.trim();
            match p.split_once('<') {
                Some((name, rest)) => Some((
                    name.trim().trim_matches('"').to_string(),
                    rest.trim_end_matches('>').trim().to_string(),
                )),
                None if p.contains('@') => Some((String::new(), p.to_string())),
                None => None,
            }
        })
        .collect()
}

fn address(list: &str) -> Address<'static> {
    Address::new_list(
        parse_addresses(list)
            .into_iter()
            .map(|(n, e)| Address::new_address((!n.is_empty()).then_some(n), e))
            .collect(),
    )
}

fn bare_ids(s: &str) -> Vec<String> {
    s.split_whitespace()
        .map(|id| id.trim_matches(['<', '>']).to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

#[derive(Deserialize)]
struct Draft {
    to: String,
    #[serde(default)]
    cc: String,
    #[serde(default)]
    bcc: String,
    subject: String,
    body: String,
    thread_id: Option<String>,
    in_reply_to: Option<String>,
    references: Option<String>,
    /// Display name for the From header (Settings → Accounts → Sender's name).
    from_name: Option<String>,
    /// HTML version of `body` (sent as multipart/alternative); set when an HTML signature is used.
    html: Option<String>,
    #[serde(default)]
    attachments: Vec<OutgoingFile>,
}

#[derive(Deserialize)]
struct OutgoingFile {
    name: String,
    mime: String,
    /// Standard base64.
    data: String,
}

/// Gmail rejects messages over 25 MB; base64 makes the sent size about a third bigger than this.
const MAX_ATTACHMENTS: usize = 25 * 1024 * 1024;

/// RFC 5322 message for a draft or a send.
fn build_message(from: String, draft: &Draft) -> anyhow::Result<Vec<u8>> {
    let from_name = draft
        .from_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    // Our own Message-ID: mail-builder's default ends in this Mac's hostname, which recipients would see.
    let mut id = [0u8; 16];
    getrandom::fill(&mut id)?;
    let domain = from.rsplit_once('@').map_or("gmail.com", |(_, d)| d);
    let message_id = format!("{}@{domain}", id.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let mut msg = MessageBuilder::new()
        .message_id(message_id)
        .from(Address::new_address(from_name.map(str::to_string), from.clone()))
        .subject(draft.subject.clone())
        .text_body(draft.body.clone());
    // Drafts may be saved before any recipient is added.
    if !parse_addresses(&draft.to).is_empty() {
        msg = msg.to(address(&draft.to));
    }
    if let Some(html) = draft.html.as_deref().filter(|h| !h.trim().is_empty()) {
        msg = msg.html_body(html.to_string());
    }
    if !parse_addresses(&draft.cc).is_empty() {
        msg = msg.cc(address(&draft.cc));
    }
    // Gmail strips Bcc from what recipients see and still delivers to those addresses.
    if !parse_addresses(&draft.bcc).is_empty() {
        msg = msg.bcc(address(&draft.bcc));
    }
    if let Some(parent) = draft
        .in_reply_to
        .as_deref()
        .map(bare_ids)
        .filter(|v| !v.is_empty())
    {
        let mut refs = bare_ids(draft.references.as_deref().unwrap_or_default());
        refs.extend(parent.iter().cloned());
        msg = msg
            .in_reply_to(MessageId::new_list(parent.into_iter()))
            .references(MessageId::new_list(refs.into_iter()));
    }
    let mut total = 0;
    for f in &draft.attachments {
        let bytes = STANDARD.decode(&f.data)?;
        total += bytes.len();
        let mime = if f.mime.is_empty() {
            "application/octet-stream"
        } else {
            &f.mime
        };
        msg = msg.attachment(mime.to_string(), f.name.clone(), bytes);
    }
    if total > MAX_ATTACHMENTS {
        anyhow::bail!("Attachments are over Gmail's 25 MB limit");
    }
    Ok(msg.write_to_vec()?)
}

/// Sends a message; with `draft_id`, sends that Gmail draft (which also removes it from Drafts).
#[tauri::command]
async fn send(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    draft: Draft,
    draft_id: Option<String>,
) -> R<()> {
    if !has_recipients(&draft) {
        return Err(anyhow::anyhow!("Add at least one recipient").into());
    }
    let a = s.account(&account)?;
    deliver(&s, &a, &draft, draft_id.as_deref()).await?;
    spawn_sync(&app);
    Ok(())
}

/// Sends through Gmail; a saved draft goes out with `drafts.send`, which also removes it from Drafts.
async fn deliver(
    s: &State,
    a: &Account,
    draft: &Draft,
    draft_id: Option<&str>,
) -> anyhow::Result<()> {
    if s.demo {
        // shortcut: demo sends are accepted but not added to the mailbox; add a local Sent copy if testing threading.
        return Ok(());
    }
    let raw = build_message(a.email.clone(), draft)?;
    let token = a.access_token(&s.http).await?;
    let g = Gmail {
        http: &s.http,
        token: &token,
    };
    match draft_id.filter(|id| !id.is_empty()) {
        Some(id) => g.send_draft(id, &raw, draft.thread_id.as_deref()).await,
        None => g.send(&raw, draft.thread_id.as_deref()).await,
    }
}

fn has_recipients(d: &Draft) -> bool {
    [&d.to, &d.cc, &d.bcc]
        .iter()
        .any(|l| !parse_addresses(l).is_empty())
}

/// Send later: Gmail's API has no scheduled send, so the email waits here (and in Gmail Drafts) and the sync loop
/// sends it once due. `draft` is a `Draft`; `ui` is opaque data the composer uses to reopen it.
#[tauri::command(async)]
fn schedule_send(
    app: AppHandle,
    s: tauri::State<State>,
    account: String,
    draft: serde_json::Value,
    draft_id: Option<String>,
    send_at: i64,
    ui: serde_json::Value,
) -> R<i64> {
    if !has_recipients(&serde_json::from_value::<Draft>(draft.clone())?) {
        return Err(anyhow::anyhow!("Add at least one recipient").into());
    }
    // Sending a saved draft is safe to retry (Gmail answers 404 once it's gone out); a raw send isn't, so a lost reply
    // could send it twice. The composer saves first; without a draft id that save failed.
    if draft_id.is_none() {
        return Err(anyhow::anyhow!(
            "Couldn't save it to Drafts first, so it isn't scheduled. Check your connection and try again"
        )
        .into());
    }
    let id = db::add_scheduled(
        &s.account(&account)?.db(),
        draft_id.as_deref(),
        send_at,
        &draft,
        &ui,
    )?;
    let _ = app.emit(CHANGED, ());
    send_when_due(&app, account, send_at);
    Ok(id)
}

/// The Gmail draft in `thread`, as (draft id, message id, Bcc), so the composer can reopen and keep editing it.
#[tauri::command]
async fn find_draft(
    s: tauri::State<'_, State>,
    account: String,
    thread: String,
) -> R<Option<(String, String, String)>> {
    if s.demo {
        return Ok(None);
    }
    let a = s.account(&account)?;
    let token = a.access_token(&s.http).await?;
    let g = Gmail { http: &s.http, token: &token };
    let Some(d) = g.drafts().await?.into_iter().find(|d| d.message.thread_id == thread) else {
        return Ok(None);
    };
    let bcc = g.draft_bcc(&d.id).await?;
    Ok(Some((d.id, d.message.id, bcc)))
}

/// Runs `account`'s due sends at `at` (ms), so a short wait (undo send) doesn't depend on the sync interval.
/// The sync loop still sends anything this misses, for example after a restart.
fn send_when_due(app: &AppHandle, account: String, at: i64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let wait = at - now_ms();
        if wait > 0 {
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;
        }
        let Ok(a) = app.state::<State>().account(&account) else {
            return;
        };
        if let Err(e) = send_due(&app, &a).await {
            let _ = app.emit("sync-error", format!("{}: {e:#}", a.email));
        }
    });
}

/// The files of one scheduled email, for reopening it in the composer.
#[tauri::command(async)]
fn scheduled_files(s: tauri::State<State>, account: String, id: i64) -> R<serde_json::Value> {
    Ok(db::scheduled_files(&s.account(&account)?.db(), id)?)
}

#[tauri::command(async)]
fn scheduled(s: tauri::State<State>, accounts: Option<Vec<String>>) -> R<Vec<db::ScheduledRow>> {
    let mut all = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        all.extend(
            db::scheduled(&a.db(), None)?
                .into_iter()
                .map(|mut r| {
                    // Sent to the UI on every refresh, so without file contents (`scheduled_files`).
                    if let Some(d) = r.draft.as_object_mut() {
                        d.remove("attachments");
                    }
                    db::ScheduledRow {
                        account: a.email.clone(),
                        ..r
                    }
                }),
        );
    }
    all.sort_by_key(|r| r.send_at);
    Ok(all)
}

/// New send time (milliseconds), or `None` to cancel the schedule and keep the draft.
#[tauri::command(async)]
fn reschedule(
    app: AppHandle,
    s: tauri::State<State>,
    account: String,
    id: i64,
    send_at: Option<i64>,
) -> R<()> {
    db::reschedule(&s.account(&account)?.db(), id, send_at)?;
    let _ = app.emit(CHANGED, ());
    if let Some(at) = send_at {
        send_when_due(&app, account, at);
    }
    Ok(())
}

/// Sends what's due. A draft deleted or sent elsewhere (404) is dropped; other failures retry on the next tick.
// shortcut: only sends while Shift is running; a server-side sender would be needed to send with the Mac off.
async fn send_due(app: &AppHandle, a: &Account) -> anyhow::Result<()> {
    // Another sync is already sending; it re-reads the due rows itself, so nothing is skipped.
    let Ok(_sending) = a.sending.try_lock() else {
        return Ok(());
    };
    let s = app.state::<State>();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as i64;
    let due = db::scheduled(&a.db(), Some(now))?;
    // One email that fails (a bad address, a file too big) mustn't hold up the others: each is tried, and the first
    // error is reported once the rest have gone.
    let mut first_error = None;
    for r in due {
        // Claimed first: from here a cancel is refused instead of racing the send. Skipped if it was cancelled or
        // moved later while earlier ones went out.
        if !db::claim(&a.db(), r.id, now)? {
            continue;
        }
        let result = match serde_json::from_value::<Draft>(r.draft) {
            Ok(d) => deliver(&s, a, &d, r.draft_id.as_deref()).await,
            Err(e) => Err(e.into()),
        };
        match result {
            Ok(()) => {
                db::finish_scheduled(&a.db(), r.id)?;
                let _ = app.emit("scheduled-sent", ());
            }
            // The draft was sent or deleted elsewhere, or by an earlier attempt whose answer was lost.
            Err(e) if gmail::is_not_found(&e) => db::finish_scheduled(&a.db(), r.id)?,
            Err(e) => {
                db::release(&a.db(), r.id)?;
                first_error.get_or_insert(e);
                continue;
            }
        }
        let _ = app.emit(CHANGED, ());
    }
    first_error.map_or(Ok(()), Err)
}

/// Saves the composer to Gmail Drafts (so it follows you to other devices); returns the draft id.
#[tauri::command]
async fn save_draft(
    s: tauri::State<'_, State>,
    account: String,
    draft: Draft,
    draft_id: Option<String>,
) -> R<String> {
    if s.demo {
        return Ok(draft_id.unwrap_or_else(|| "demo-draft".into()));
    }
    let a = s.account(&account)?;
    let raw = build_message(a.email.clone(), &draft)?;
    let token = a.access_token(&s.http).await?;
    let id = Gmail {
        http: &s.http,
        token: &token,
    }
    .save_draft(
        draft_id.as_deref().filter(|id| !id.is_empty()),
        &raw,
        draft.thread_id.as_deref(),
    )
    .await?;
    Ok(id)
}

#[tauri::command]
async fn delete_draft(s: tauri::State<'_, State>, account: String, draft_id: String) -> R<()> {
    if s.demo || draft_id.is_empty() {
        return Ok(());
    }
    let token = s.account(&account)?.access_token(&s.http).await?;
    Gmail {
        http: &s.http,
        token: &token,
    }
    .delete_draft(&draft_id)
    .await?;
    Ok(())
}

/// An attachment's filename and bytes: from the cache when Gmail sent them inline, else fetched on demand.
async fn attachment_bytes(
    s: &State,
    account: &str,
    message: &str,
    idx: i64,
) -> anyhow::Result<(String, Vec<u8>)> {
    let a = s.account(account)?;
    let (name, data, id) = db::attachment_source(&a.db(), message, idx)?;
    if let Some(data) = data {
        return Ok((name, data));
    }
    let Some(id) = id.filter(|_| !s.demo) else {
        anyhow::bail!("This attachment has no data");
    };
    let token = a.access_token(&s.http).await?;
    let bytes = Gmail {
        http: &s.http,
        token: &token,
    }
    .attachment(message, &id)
    .await?;
    Ok((name, bytes))
}

/// Standard base64, for inline images and forwarding.
#[tauri::command]
async fn attachment_data(
    s: tauri::State<'_, State>,
    account: String,
    message: String,
    idx: i64,
) -> R<String> {
    let (_, bytes) = attachment_bytes(&s, &account, &message, idx).await?;
    Ok(STANDARD.encode(bytes))
}

/// The attachment's name reduced to a plain file name, so it can't point outside the folder.
fn safe_filename(name: &str) -> String {
    let name: String = name
        .chars()
        .map(|c| {
            if "/\\:".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let name = name.trim().trim_start_matches('.');
    if name.is_empty() {
        "attachment".into()
    } else {
        name.into()
    }
}

/// `dir/name`, or `dir/name (2).ext` and so on when that file already exists.
/// Writes a downloaded attachment under a free name and marks it as from the internet, as browsers do. With the
/// quarantine flag, Gatekeeper checks apps (also ones unzipped from it) and Office opens macro files in Protected View.
/// Returns the saved path and whether the quarantine flag was set.
fn write_download(dir: &Path, name: &str, bytes: &[u8]) -> anyhow::Result<(PathBuf, bool)> {
    use std::io::Write;
    let mut path = free_path(dir, name);
    // create_new: never follows a symlink or overwrites a file that appeared since free_path looked.
    let mut file = loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(f) => break f,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => path = free_path(dir, name),
            Err(e) => return Err(e.into()),
        }
    };
    file.write_all(bytes)?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let flag = format!("0081;{secs:x};Shift;");
    let quarantined = std::process::Command::new("/usr/bin/xattr")
        .args(["-w", "com.apple.quarantine", &flag])
        .arg(&path)
        .status()
        .is_ok_and(|s| s.success());
    if !quarantined {
        eprintln!("couldn't set the quarantine flag on {}", path.display());
    }
    Ok((path, quarantined))
}

fn free_path(dir: &Path, name: &str) -> PathBuf {
    let p = Path::new(name);
    let (stem, ext) = (
        p.file_stem().and_then(|s| s.to_str()).unwrap_or(name),
        p.extension().and_then(|e| e.to_str()),
    );
    (1..)
        .map(|n| match (n, ext) {
            (1, _) => dir.join(name),
            (_, Some(ext)) => dir.join(format!("{stem} ({n}).{ext}")),
            (_, None) => dir.join(format!("{stem} ({n})")),
        })
        .find(|p| !p.exists())
        .unwrap()
}

/// Files that open in a viewer rather than run. Anything else (apps, scripts, installers) is revealed in Finder instead.
/// SVG is left out: it can carry scripts, and its default app may be a browser.
fn opens_directly(name: &str) -> bool {
    const SAFE: &[&str] = &[
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp", "txt", "md",
        "csv", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
        "ics", "vcf", "mp3", "m4a", "wav", "mp4", "mov", "zip",
    ];
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SAFE.contains(&e.to_lowercase().as_str()))
}

/// Saves an attachment to Downloads and opens it; returns the saved path.
#[tauri::command]
async fn open_attachment(
    app: AppHandle,
    s: tauri::State<'_, State>,
    account: String,
    message: String,
    idx: i64,
) -> R<String> {
    let (name, bytes) = attachment_bytes(&s, &account, &message, idx).await?;
    let (path, quarantined) = write_download(&app.path().download_dir()?, &safe_filename(&name), &bytes)?;
    // Without the flag macOS wouldn't check the file before it runs, so show it in Finder instead of opening it.
    if quarantined && opens_directly(&name) {
        tauri_plugin_opener::open_path(&path, None::<&str>)?;
    } else {
        tauri_plugin_opener::reveal_item_in_dir(&path)?;
    }
    Ok(path.display().to_string())
}

/// People you've emailed or heard from whose name or address contains `query`, most frequent first.
fn rank_contacts(headers: &[String], query: &str, me: &[String]) -> Vec<String> {
    let q = query.trim().to_lowercase();
    let mut seen: Vec<(String, String, usize)> = Vec::new(); // (email, best name, count)
    for (name, email) in headers.iter().flat_map(|h| parse_addresses(h)) {
        let key = email.to_lowercase();
        if me.iter().any(|m| m.eq_ignore_ascii_case(&key))
            || !(key.contains(&q) || name.to_lowercase().contains(&q))
        {
            continue;
        }
        match seen.iter_mut().find(|(e, _, _)| *e == key) {
            Some(entry) => {
                entry.2 += 1;
                if entry.1.is_empty() {
                    entry.1 = name;
                }
            }
            None => seen.push((key, name, 1)),
        }
    }
    seen.sort_by_key(|entry| std::cmp::Reverse(entry.2));
    seen.into_iter()
        .take(6)
        .map(|(email, name, _)| {
            if name.is_empty() {
                email
            } else {
                format!("{name} <{email}>")
            }
        })
        .collect()
}

#[tauri::command(async)]
fn suggest_contacts(s: tauri::State<State>, query: String) -> R<Vec<String>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    // Contacts come from every account, and none of your own addresses are suggested.
    let accounts = s.all();
    let mut headers = Vec::new();
    for a in &accounts {
        headers.extend(db::contact_headers(&a.db(), &query)?);
    }
    let me: Vec<String> = accounts.iter().map(|a| a.email.clone()).collect();
    Ok(rank_contacts(&headers, &query, &me))
}

#[tauri::command(async)]
fn search_local(
    s: tauri::State<State>,
    query: String,
    accounts: Option<Vec<String>>,
) -> R<Vec<db::ThreadRow>> {
    Ok(merged_threads(&s, accounts.as_deref(), |c| {
        db::search_local(c, &query)
    })?)
}

#[tauri::command(async)]
fn suggest_senders(
    s: tauri::State<State>,
    query: String,
    accounts: Option<Vec<String>>,
) -> R<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        for sender in db::suggest_senders(&a.db(), &query)? {
            if !out.iter().any(|o| o.eq_ignore_ascii_case(&sender)) {
                out.push(sender);
            }
        }
    }
    out.truncate(5);
    Ok(out)
}

#[tauri::command]
fn get_settings(s: tauri::State<State>) -> serde_json::Value {
    settings::load(&s.dir)
}

#[tauri::command(async)]
fn set_settings(s: tauri::State<State>, value: serde_json::Value) -> R<()> {
    Ok(settings::save(&s.dir, &value)?)
}

#[tauri::command(async)]
fn set_ai_key(provider: String, key: String) -> R<()> {
    Ok(settings::set_ai_key(&provider, &key)?)
}

#[tauri::command(async)]
fn has_ai_key(provider: String) -> bool {
    settings::has_ai_key(&provider)
}

#[tauri::command(async)]
fn delete_ai_key(provider: String) -> R<()> {
    Ok(settings::delete_ai_key(&provider)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_menu_event(|app, event| {
            if event.id() == CHECK_UPDATES {
                check_for_updates_now(app);
            }
        })
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            // The window is created hidden (tauri.conf.json) so a launch at login can stay in the Dock without a flash.
            if !std::env::args().any(|a| a == LAUNCHED_AT_LOGIN)
                && let Some(window) = app.get_webview_window("main")
            {
                window.show()?;
            }
            let dir = app.path().app_data_dir()?;
            // The app's identifier was com.nicboada.mail before it became au.com.talkk.shift: carry the mail cache
            // and settings over once. Keychain logins aren't moved; they belonged to the previous OAuth client.
            let old = dir.with_file_name("com.nicboada.mail");
            if !dir.exists() && old.is_dir() {
                std::fs::rename(&old, &dir)?;
            }
            std::fs::create_dir_all(&dir)?;
            #[cfg(target_os = "macos")]
            allow_test_banner();
            // Rewrites a login item saved by 0.2.0 and earlier, which had no bundle id and showed as the developer's name.
            if !cfg!(debug_assertions)
                && let Ok(item) = login_item(app.handle())
                && item.is_enabled().unwrap_or(false)
                && !std::fs::read_to_string(format!(
                    "{}/Library/LaunchAgents/Shift.plist",
                    std::env::var("HOME").unwrap_or_default()
                ))
                .unwrap_or_default()
                .contains(&app.config().identifier)
            {
                let _ = item.enable();
            }
            let demo = std::env::var_os("SHIFT_DEMO").is_some();
            let (accounts, broken) = if demo {
                // Two in-memory demo accounts, fresh every launch.
                let mut you = db::open(Path::new(":memory:"))?;
                demo::seed(&mut you)?;
                let mut work = db::open(Path::new(":memory:"))?;
                demo::seed_work(&mut work)?;
                let accounts = vec![
                    Account::new(demo::EMAIL.into(), you),
                    Account::new(demo::WORK_EMAIL.into(), work),
                ];
                (accounts, Vec::new())
            } else {
                std::fs::create_dir_all(dir.join("accounts"))?;
                if let Err(e) = migrate_single_account(&dir) {
                    eprintln!("Couldn't move the old single-account database: {e:#}");
                }
                load_accounts(&dir)?
            };
            app.manage(State {
                demo,
                broken,
                dir: dir.clone(),
                accounts: Mutex::new(accounts),
                // No overall deadline: a big attachment or send on a slow link would be cut off mid-body. These only
                // catch a dead connection; the upload path sets its own total timeout.
                http: reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(60))
                    .build()?,
                ai_http: reqwest::Client::builder()
                    .connect_timeout(Duration::from_secs(10))
                    .read_timeout(Duration::from_secs(300))
                    .build()?,
            });
            let handle = app.handle().clone();
            // shortcut: polls history on an interval; Gmail push (users.watch) needs a Pub/Sub backend.
            tauri::async_runtime::spawn(async move {
                loop {
                    sync(&handle).await;
                    let wait = settings::sync_seconds(&handle.state::<State>().dir);
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                }
            });
            spawn_update_checks(app.handle());
            // A click on a new-mail notification brings Shift forward and opens what it announced. Set up before
            // the first notification: ones shown earlier report no clicks.
            {
                use tauri_plugin_notification::NotificationExt;
                let handle = app.handle().clone();
                app.notification().on_action(move |action| {
                    if action.action_id() != "tap" {
                        return;
                    }
                    let Some(extra) = action.notification().map(|n| n.extra()) else {
                        return;
                    };
                    if let Some(window) = handle.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    let _ = handle.emit(
                        "open-from-notification",
                        serde_json::json!({ "account": extra.get("account"), "thread": extra.get("thread") }),
                    );
                })?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            add_account,
            sign_out,
            sync_now,
            labels,
            threads,
            mark_all_read,
            restart_app,
            ai_rewrite,
            ai_draft_reply,
            ai_labels,
            ai_undo_labels,
            ai_cleanup,
            open_at_login,
            set_open_at_login,
            ai_label_inbox,
            find_draft,
            load_more,
            quit_now,
            test_notification,
            empty_mailbox,
            create_label,
            rename_label,
            set_label_color,
            delete_label,
            thread,
            modify,
            modify_many,
            search,
            send,
            get_settings,
            search_local,
            suggest_senders,
            suggest_contacts,
            save_draft,
            delete_draft,
            schedule_send,
            scheduled,
            scheduled_files,
            reschedule,
            attachment_data,
            open_attachment,
            set_settings,
            set_ai_key,
            has_ai_key,
            delete_ai_key
        ])
        // The Mac convention for a mail app: closing the window hides it, and Shift keeps syncing and notifying
        // from the Dock. ⌘Q quits; a click on the Dock icon brings the window back.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && cfg!(target_os = "macos")
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ⌘Q (or Quit from the Dock): give the window a moment to save an open draft first. It answers with
            // `quit_now`; the timer quits anyway if it doesn't. `code` is None only for a user quit, not app.exit().
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event
                && !QUIT_READY.load(std::sync::atomic::Ordering::SeqCst)
            {
                api.prevent_exit();
                let _ = app.emit("before-quit", ());
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    QUIT_READY.store(true, std::sync::atomic::Ordering::SeqCst);
                    app.exit(0);
                });
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
}

/// Set once the window has saved its draft (or given up), so the next quit request goes through.
static QUIT_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The window's answer to `before-quit`: its draft is saved, quit now.
#[tauri::command]
fn quit_now(app: AppHandle) {
    QUIT_READY.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

#[cfg(test)]
mod tests {

    #[test]
    fn background_fetching_stays_under_gmails_quota() {
        // 6,000 units a minute per user; background work may use 60% of it at any interval.
        for secs in [15, 30, 60, 300] {
            let per_minute = tick_budget(secs) * 60 / secs as i64;
            assert_eq!(per_minute, 3600, "{secs}s interval");
        }
        assert!(tick_budget(15) >= FULL_COST, "even the shortest tick can fetch one full thread");
    }
    use super::*;

    #[test]
    fn account_files_are_safe_and_migration_moves_the_old_database() {
        let dir = std::env::temp_dir().join(format!("shift-accounts-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("accounts")).unwrap();
        assert!(
            db_path(&dir, "Nic+Work@Example.com")
                .ends_with("accounts/nic_work@example.com.sqlite3")
        );
        assert!(
            db_path(&dir, "../../etc")
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with(".._.._etc")
        );

        let old = db::open(&dir.join("mail.sqlite3")).unwrap();
        db::set_meta(&old, "email", "me@x.com").unwrap();
        drop(old);
        migrate_single_account(&dir).unwrap();
        assert!(!dir.join("mail.sqlite3").exists());
        std::fs::write(dir.join("accounts").join("bad@x.com.sqlite3"), b"not a database").unwrap();
        let (accounts, broken) = load_accounts(&dir).unwrap();
        assert_eq!(
            accounts
                .iter()
                .map(|a| a.email.as_str())
                .collect::<Vec<_>>(),
            ["me@x.com"]
        );
        assert_eq!(broken, ["bad@x.com"]);
        assert!(dir.join("accounts").join("bad@x.com.sqlite3.broken").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn parses_address_lists() {
        assert_eq!(
            parse_addresses(r#""Doe, Jane" <jane@x.com>, bob@y.com, Al <al@z.com>"#),
            vec![
                ("Doe, Jane".into(), "jane@x.com".into()),
                ("".into(), "bob@y.com".into()),
                ("Al".into(), "al@z.com".into())
            ]
        );
        assert!(parse_addresses("  ").is_empty());
    }

    #[test]
    fn ranks_contacts_by_frequency_and_skips_me() {
        let headers = [
            "Maya Chen <maya@x.com>".to_string(),
            "maya@x.com, Max <max@y.com>".to_string(),
            "Me <me@z.com>".to_string(),
        ];
        assert_eq!(
            rank_contacts(&headers, "ma", &["ME@z.com".into()]),
            ["Maya Chen <maya@x.com>", "Max <max@y.com>"]
        );
        assert!(rank_contacts(&headers, "nobody", &["me@z.com".into()]).is_empty());
    }

    #[test]
    fn drafts_build_without_recipients_and_keep_bcc() {
        let d = |to: &str, bcc: &str| Draft {
            to: to.into(),
            cc: String::new(),
            bcc: bcc.into(),
            subject: "s".into(),
            body: "b".into(),
            thread_id: None,
            in_reply_to: None,
            references: None,
            from_name: Some("Me".into()),
            html: None,
            attachments: Vec::new(),
        };
        let empty =
            String::from_utf8(build_message("me@x.com".into(), &d("", "")).unwrap()).unwrap();
        assert!(!empty.contains("To:"), "{empty}");
        let bcc =
            String::from_utf8(build_message("me@x.com".into(), &d("a@x.com", "b@x.com")).unwrap())
                .unwrap();
        assert!(
            bcc.contains("Bcc: <b@x.com>") || bcc.contains("Bcc: b@x.com"),
            "{bcc}"
        );
        assert!(
            bcc.contains("From: \"Me\" <me@x.com>") || bcc.contains("From: Me <me@x.com>"),
            "{bcc}"
        );
    }

    #[test]
    fn attachments_are_added_and_size_capped() {
        let mut d = Draft {
            to: "a@x.com".into(),
            cc: String::new(),
            bcc: String::new(),
            subject: "s".into(),
            body: "see attached".into(),
            thread_id: None,
            in_reply_to: None,
            references: None,
            from_name: None,
            html: None,
            attachments: vec![OutgoingFile {
                name: "notes.txt".into(),
                mime: "text/plain".into(),
                data: STANDARD.encode("hello file"),
            }],
        };
        let raw = String::from_utf8(build_message("me@x.com".into(), &d).unwrap()).unwrap();
        assert!(raw.contains("multipart/mixed"), "{raw}");
        assert!(raw.contains("filename=\"notes.txt\""), "{raw}");
        assert!(raw.contains("see attached"), "{raw}");
        let id = raw.lines().find(|l| l.starts_with("Message-ID:")).unwrap();
        assert!(id.ends_with("@x.com>"), "{id}");
        d.attachments[0].data = STANDARD.encode(vec![0u8; MAX_ATTACHMENTS + 1]);
        assert!(build_message("me@x.com".into(), &d).is_err());
    }

    #[test]
    fn downloads_get_a_free_name_and_the_quarantine_flag() {
        let dir = std::env::temp_dir().join(format!("shift-q-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (first, flagged) = write_download(&dir, "x.zip", b"one").unwrap();
        let (second, _) = write_download(&dir, "x.zip", b"two").unwrap();
        assert!(flagged, "the quarantine flag was set");
        assert_eq!(second, dir.join("x (2).zip"));
        assert_eq!(std::fs::read(&first).unwrap(), b"one");
        let flag = std::process::Command::new("/usr/bin/xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&second)
            .output()
            .unwrap();
        assert!(String::from_utf8_lossy(&flag.stdout).contains(";Shift;"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn attachment_files_stay_in_their_folder() {
        assert_eq!(safe_filename("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_filename(".hidden"), "hidden");
        assert_eq!(safe_filename("  "), "attachment");
        let dir = std::env::temp_dir().join(format!("shift-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.pdf"), "x").unwrap();
        assert_eq!(free_path(&dir, "a.pdf"), dir.join("a (2).pdf"));
        assert_eq!(free_path(&dir, "b.pdf"), dir.join("b.pdf"));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(opens_directly("Contract.PDF"));
        assert!(!opens_directly("invoice.pdf.command"));
        assert!(!opens_directly("noext"));
    }

    #[test]
    fn reply_headers_are_valid() {
        let raw = MessageBuilder::new()
            .from("me@x.com")
            .to(address("Doe <d@x.com>"))
            .subject("Re: hi")
            .in_reply_to(MessageId::new_list(bare_ids("<p@x>").into_iter()))
            .references(MessageId::new_list(bare_ids("<a@x> <p@x>").into_iter()))
            .text_body("body")
            .html_body("<b>body</b>")
            .write_to_string()
            .unwrap();
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("In-Reply-To: <p@x>"), "{raw}");
        assert!(raw.contains("References: <a@x> <p@x>"), "{raw}");
        assert!(
            raw.contains("To: \"Doe\" <d@x.com>") || raw.contains("To: Doe <d@x.com>"),
            "{raw}"
        );
    }
}
