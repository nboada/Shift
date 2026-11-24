mod auth;
mod db;
mod demo;
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
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// One signed-in Google account: its own local mail database, access token and sync lock.
struct Account {
    email: String,
    db: Mutex<Connection>,
    token: tokio::sync::Mutex<Option<auth::Token>>,
    syncing: tokio::sync::Mutex<()>,
    /// Held while due scheduled emails go out, so overlapping syncs can't send the same one twice.
    sending: tokio::sync::Mutex<()>,
}

impl Account {
    fn new(email: String, conn: Connection) -> Arc<Self> {
        Arc::new(Self {
            email,
            db: Mutex::new(conn),
            token: Default::default(),
            syncing: Default::default(),
            sending: Default::default(),
        })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    async fn access_token(&self, http: &reqwest::Client) -> anyhow::Result<String> {
        let mut t = self.token.lock().await;
        if t.as_ref().is_none_or(|t| t.expires <= Instant::now()) {
            *t = Some(auth::refresh(http, &self.email).await?);
        }
        Ok(t.as_ref().unwrap().access.clone())
    }
}

struct State {
    /// In the order they were added; the first is the default for new emails.
    accounts: Mutex<Vec<Arc<Account>>>,
    http: reqwest::Client,
    /// Offline demo mailbox: no network, actions only touch the local cache.
    demo: bool,
    /// App data directory (accounts/, settings.json).
    dir: PathBuf,
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

/// Opens every account database in accounts/, oldest first. Files without an account email are skipped.
fn load_accounts(dir: &Path) -> anyhow::Result<Vec<Arc<Account>>> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir.join("accounts"))? {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "sqlite3") {
            let conn = db::open(&path)?;
            let added = std::fs::metadata(&path).and_then(|m| m.created()).ok();
            if let Some(email) = db::get_meta(&conn, "email")? {
                found.push((added, Account::new(email, conn)));
            }
        }
    }
    found.sort_by_key(|(added, _)| *added);
    Ok(found.into_iter().map(|(_, a)| a).collect())
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

/// Fetches bodies for the newest inbox threads so opening them doesn't wait on the network.
async fn prefetch_bodies(app: &AppHandle, a: &Account, g: &Gmail<'_>) -> anyhow::Result<()> {
    let ids = db::missing_bodies(&a.db(), "INBOX", PREFETCH_PER_TICK)?;
    let jobs = ids.into_iter().map(|id| (id, true)).collect();
    fetch(app, a, g, jobs)
        .await
        .into_iter()
        .next()
        .map_or(Ok(()), |(_, e)| Err(e))
}

// Gmail allows each account about 6,000 quota units a minute; a thread costs 40 (metadata) to 120 (full).
// At the default 30 s tick these stay well under it, leaving room for history, search and what the user does.
const BACKFILL_PER_TICK: usize = 50;
const PREFETCH_PER_TICK: usize = 10;

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
    let mut n = app.notification().builder().title(title).body(body);
    if cfg.sound {
        n = n.sound("default");
    }
    n.show()?;
    Ok(())
}

/// Fetches the next batch of queued threads. Failures go to the back of the queue so one bad thread can't block it.
/// Returns how many it took off the queue's front.
async fn backfill(app: &AppHandle, a: &Account, g: &Gmail<'_>) -> anyhow::Result<usize> {
    let queue: Vec<String> = match db::get_meta(&a.db(), "backfill")? {
        Some(json) => serde_json::from_str(&json)?,
        None => return Ok(0),
    };
    let take = queue.len().min(BACKFILL_PER_TICK);
    let (batch, rest) = queue.split_at(take);
    let jobs = batch
        .iter()
        .map(|id| (id.clone(), db::is_full(&a.db(), id)))
        .collect();
    let failed = fetch(app, a, g, jobs).await;
    let mut next: Vec<String> = rest.to_vec();
    next.extend(failed.into_iter().map(|(id, _)| id));
    let c = a.db();
    if next.is_empty() {
        db::delete_meta(&c, "backfill")?;
    } else {
        db::set_meta(&c, "backfill", &serde_json::to_string(&next)?)?;
    }
    Ok(take)
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
    let labels = g.labels().await?;
    db::replace_labels(&mut a.db(), &labels)?;
    let history = db::get_meta(&a.db(), "history_id")?;
    let mut changed = false;
    match history {
        None => full_sync(a, &g).await?,
        Some(h) => match g.history(&h).await {
            Ok((ids, new_id)) => {
                changed = !ids.is_empty();
                fetch_threads(app, a, &g, ids).await?;
                db::set_meta(&a.db(), "history_id", &new_id)?;
                if changed {
                    // A failed notification mustn't fail the sync.
                    if let Err(e) = notify_new_mail(app, a) {
                        eprintln!("{} notification: {e:#}", a.email);
                    }
                }
            }
            // Expired cursor (Gmail keeps about a week): start over, keeping the cache until threads are refetched.
            Err(e) if gmail::is_not_found(&e) => full_sync(a, &g).await?,
            Err(e) => return Err(e),
        },
    }
    let filled = backfill(app, a, &g).await?;
    // Every tick used to repaint the whole UI; now only when something came in.
    if changed || filled > 0 {
        let _ = app.emit(CHANGED, ());
    }
    // Bodies wait until the mailbox is listed, so the two don't compete for quota.
    if filled == 0 {
        prefetch_bodies(app, a, &g).await?;
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
        if let Err(e) = sync_account(app, a).await {
            let _ = app.emit("sync-error", format!("{}: {e:#}", a.email));
        }
    }))
    .await;
}

fn spawn_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { sync(&app).await });
}

#[derive(Serialize)]
struct Status {
    accounts: Vec<String>,
}

#[tauri::command]
fn status(s: tauri::State<State>) -> Status {
    Status {
        accounts: s.all().iter().map(|a| a.email.clone()).collect(),
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
#[tauri::command]
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

#[tauri::command]
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
            None => ("", vec!["UNREAD"]),
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
        for id in &ids {
            db::delete_thread(&a.db(), id)?;
        }
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
    let token = a.access_token(&s.http).await?;
    let g = Gmail {
        http: &s.http,
        token: &token,
    };
    // Gmail moves threads in and out of Trash only through trash/untrash, not by label changes.
    let remote = if trash {
        g.trash(&id).await
    } else if remove.iter().any(|l| l == "TRASH") {
        let rest: Vec<String> = remove.iter().filter(|l| *l != "TRASH").cloned().collect();
        match g.untrash(&id).await {
            Ok(()) => g.modify(&id, &add, &rest).await,
            Err(e) => Err(e),
        }
    } else {
        g.modify(&id, &add, &remove).await
    };
    if let Err(e) = remote {
        let full = db::is_full(&a.db(), &id);
        if let Ok(t) = g.thread(&id, full).await {
            let _ = db::upsert_thread(&mut a.db(), &t, full);
            let _ = app.emit(CHANGED, ());
        }
        return Err(e.into());
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
    let mut msg = MessageBuilder::new()
        .from(Address::new_address(from_name.map(str::to_string), from))
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
#[tauri::command]
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
    let id = db::add_scheduled(
        &s.account(&account)?.db(),
        draft_id.as_deref(),
        send_at,
        &draft,
        &ui,
    )?;
    let _ = app.emit(CHANGED, ());
    Ok(id)
}

#[tauri::command]
fn scheduled(s: tauri::State<State>, accounts: Option<Vec<String>>) -> R<Vec<db::ScheduledRow>> {
    let mut all = Vec::new();
    for a in s.scope(accounts.as_deref())? {
        all.extend(
            db::scheduled(&a.db(), None)?
                .into_iter()
                .map(|r| db::ScheduledRow {
                    account: a.email.clone(),
                    ..r
                }),
        );
    }
    all.sort_by_key(|r| r.send_at);
    Ok(all)
}

/// New send time (milliseconds), or `None` to cancel the schedule and keep the draft.
#[tauri::command]
fn reschedule(
    app: AppHandle,
    s: tauri::State<State>,
    account: String,
    id: i64,
    send_at: Option<i64>,
) -> R<()> {
    db::reschedule(&s.account(&account)?.db(), id, send_at)?;
    let _ = app.emit(CHANGED, ());
    if send_at.is_some() {
        spawn_sync(&app);
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
    for r in due {
        let result = match serde_json::from_value::<Draft>(r.draft) {
            Ok(d) => deliver(&s, a, &d, r.draft_id.as_deref()).await,
            Err(e) => Err(e.into()),
        };
        match result {
            Ok(()) => {
                db::reschedule(&a.db(), r.id, None)?;
                let _ = app.emit("scheduled-sent", ());
            }
            Err(e) if gmail::is_not_found(&e) => db::reschedule(&a.db(), r.id, None)?,
            Err(e) => return Err(e),
        }
        let _ = app.emit(CHANGED, ());
    }
    Ok(())
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

/// Files that open in a viewer rather than run. Anything else (apps, scripts, installers) is revealed in Finder instead,
/// since files written by Shift carry no quarantine flag for Gatekeeper to check.
fn opens_directly(name: &str) -> bool {
    const SAFE: &[&str] = &[
        "pdf", "png", "jpg", "jpeg", "gif", "webp", "heic", "tif", "tiff", "bmp", "svg", "txt",
        "md", "csv", "rtf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key",
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
    let path = free_path(&app.path().download_dir()?, &safe_filename(&name));
    std::fs::write(&path, bytes)?;
    if opens_directly(&name) {
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

#[tauri::command]
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

#[tauri::command]
fn search_local(
    s: tauri::State<State>,
    query: String,
    accounts: Option<Vec<String>>,
) -> R<Vec<db::ThreadRow>> {
    Ok(merged_threads(&s, accounts.as_deref(), |c| {
        db::search_local(c, &query)
    })?)
}

#[tauri::command]
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

#[tauri::command]
fn set_settings(s: tauri::State<State>, value: serde_json::Value) -> R<()> {
    Ok(settings::save(&s.dir, &value)?)
}

#[tauri::command]
fn set_ai_key(provider: String, key: String) -> R<()> {
    Ok(settings::set_ai_key(&provider, &key)?)
}

#[tauri::command]
fn has_ai_key(provider: String) -> bool {
    settings::has_ai_key(&provider)
}

#[tauri::command]
fn delete_ai_key(provider: String) -> R<()> {
    Ok(settings::delete_ai_key(&provider)?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let demo = std::env::var_os("SHIFT_DEMO").is_some();
            let accounts = if demo {
                // Two in-memory demo accounts, fresh every launch.
                let mut you = db::open(Path::new(":memory:"))?;
                demo::seed(&mut you)?;
                let mut work = db::open(Path::new(":memory:"))?;
                demo::seed_work(&mut work)?;
                vec![
                    Account::new(demo::EMAIL.into(), you),
                    Account::new(demo::WORK_EMAIL.into(), work),
                ]
            } else {
                std::fs::create_dir_all(dir.join("accounts"))?;
                migrate_single_account(&dir)?;
                load_accounts(&dir)?
            };
            app.manage(State {
                demo,
                dir: dir.clone(),
                accounts: Mutex::new(accounts),
                http: reqwest::Client::builder()
                    .timeout(Duration::from_secs(30))
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
            empty_mailbox,
            rename_label,
            set_label_color,
            delete_label,
            thread,
            modify,
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
            reschedule,
            attachment_data,
            open_attachment,
            set_settings,
            set_ai_key,
            has_ai_key,
            delete_ai_key
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
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
        let accounts = load_accounts(&dir).unwrap();
        assert_eq!(
            accounts
                .iter()
                .map(|a| a.email.as_str())
                .collect::<Vec<_>>(),
            ["me@x.com"]
        );
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
        d.attachments[0].data = STANDARD.encode(vec![0u8; MAX_ATTACHMENTS + 1]);
        assert!(build_message("me@x.com".into(), &d).is_err());
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
