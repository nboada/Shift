use crate::gmail;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS labels (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL, sender TEXT NOT NULL,
  snippet TEXT NOT NULL, date INTEGER NOT NULL, count INTEGER NOT NULL,
  full INTEGER NOT NULL DEFAULT 0, live INTEGER NOT NULL DEFAULT 1);
CREATE INDEX IF NOT EXISTS threads_date ON threads(date DESC);
CREATE TABLE IF NOT EXISTS thread_labels (
  label_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (label_id, thread_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_labels_thread ON thread_labels(thread_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL, date INTEGER NOT NULL,
  subject TEXT NOT NULL, message_id TEXT NOT NULL, refs TEXT NOT NULL,
  html TEXT, text TEXT, reply_to TEXT NOT NULL DEFAULT '', ics TEXT);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, date);
CREATE TABLE IF NOT EXISTS attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  attachment_id TEXT, content_id TEXT, data BLOB,
  PRIMARY KEY (message_id, idx)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY, draft_id TEXT, send_at INTEGER NOT NULL, draft TEXT NOT NULL, ui TEXT NOT NULL,
  sending INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS pending_ops (
  seq INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, add_labels TEXT NOT NULL, remove_labels TEXT NOT NULL,
  trash INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ai_labels (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, label_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, label_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS rsvps (uid TEXT PRIMARY KEY, sequence INTEGER NOT NULL, status TEXT NOT NULL);
";

/// Schema version, kept in `PRAGMA user_version`. Bump it and add an `if version < N` step to `open` for each change.
const VERSION: i64 = 3;

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let had_attachments: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'attachments')",
        [],
        |r| r.get(0),
    )?;
    conn.execute_batch(SCHEMA)?;
    // All or nothing: a step that fails rolls back and leaves the version as it was, so it runs again next launch.
    let tx = conn.transaction()?;
    if version < 1 {
        upgrade_unversioned(&tx, had_attachments)?;
    }
    if version < 2 {
        add_column(&tx, "scheduled", "error TEXT")?;
        // Older versions cached bodies Gmail stores apart as blank, and other charsets as U+FFFD: fetch them again.
        tx.execute(
            "UPDATE threads SET full = 0 WHERE full = 1 AND id IN (SELECT thread_id FROM messages
               WHERE (html IS NULL AND text IS NULL) OR instr(coalesce(html, '') || coalesce(text, ''), char(65533)) > 0)",
            [],
        )?;
    }
    if version < 3 {
        add_column(&tx, "messages", "ics TEXT")?;
        // Fetch invites again so the reader can show their events. Only those with an .ics file are known; one sent
        // as an inline calendar part alone shows once its thread is fetched again for another reason.
        tx.execute(
            "UPDATE threads SET full = 0 WHERE full = 1 AND id IN (SELECT m.thread_id FROM messages m
               JOIN attachments a ON a.message_id = m.id
               WHERE a.mime IN ('text/calendar', 'application/ics') OR lower(a.filename) LIKE '%.ics')",
            [],
        )?;
    }
    tx.execute_batch(&format!("PRAGMA user_version = {VERSION}"))?;
    tx.commit()?;
    // A send claimed when Shift quit or crashed never finished from this side: let it go out again. A draft-backed
    // send that did reach Gmail comes back 404 and is dropped, so this can't duplicate it.
    conn.execute("UPDATE scheduled SET sending = 0", [])?;
    Ok(conn)
}

/// Whether opening failed because the file is damaged or isn't a database, rather than busy or unreadable.
pub fn is_corrupt(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        c.downcast_ref::<rusqlite::Error>().is_some_and(|e| {
            matches!(
                e.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase)
            )
        })
    })
}

/// Adds a column, or returns false when the database already has it.
fn add_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    match conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column}"), []) {
        Ok(_) => Ok(true),
        Err(e) if e.to_string().contains("duplicate column name") => Ok(false),
        Err(e) => Err(e.into()),
    }
}

/// Caches from before the schema was versioned: each may lack any of the columns added since.
fn upgrade_unversioned(conn: &Connection, had_attachments: bool) -> Result<()> {
    add_column(conn, "threads", "full INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "labels", "color TEXT")?;
    add_column(conn, "scheduled", "sending INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, "messages", "reply_to TEXT NOT NULL DEFAULT ''")?;
    // `live`: the thread has a message outside Trash and Spam. Older caches only knew "has a trashed message", which hid
    // whole conversations; mark those not live and queue them for a re-fetch, which works out the real value.
    if add_column(conn, "threads", "live INTEGER NOT NULL DEFAULT 1")? {
        let mut st = conn.prepare(
            "SELECT DISTINCT thread_id FROM thread_labels WHERE label_id IN ('TRASH', 'SPAM')",
        )?;
        let ids: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        drop(st);
        conn.execute(
            "UPDATE threads SET live = 0 WHERE id IN (SELECT thread_id FROM thread_labels WHERE label_id IN ('TRASH', 'SPAM'))",
            [],
        )?;
        if !ids.is_empty() {
            let mut queue: Vec<String> = get_meta(conn, "backfill")?
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default();
            queue.extend(ids);
            set_meta(conn, "backfill", &serde_json::to_string(&queue)?)?;
        }
    }
    // Bodies cached before attachments were stored carry none; mark them for a re-fetch on open.
    if !had_attachments {
        conn.execute("UPDATE threads SET full = 0", [])?;
    }
    Ok(())
}

/// An email waiting for its send time: `draft` is the `Draft` JSON to send, `ui` what the composer needs to reopen it.
#[derive(Serialize)]
pub struct ScheduledRow {
    pub account: String,
    pub id: i64,
    pub draft_id: Option<String>,
    pub send_at: i64,
    pub draft: serde_json::Value,
    pub ui: serde_json::Value,
    /// Being sent right now (claimed).
    pub sending: bool,
    /// Why the last attempt failed; it's retried each sync.
    pub error: Option<String>,
}

pub fn add_scheduled(
    conn: &Connection,
    draft_id: Option<&str>,
    send_at: i64,
    draft: &serde_json::Value,
    ui: &serde_json::Value,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO scheduled (draft_id, send_at, draft, ui) VALUES (?1, ?2, ?3, ?4)",
        params![draft_id, send_at, draft.to_string(), ui.to_string()],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Claims scheduled row `id` for sending if it is still due and nobody else holds it. Once claimed, `reschedule`
/// refuses it, so a cancel can't race the send. Returns whether this caller got it.
pub fn claim(conn: &Connection, id: i64, now: i64) -> Result<bool> {
    Ok(conn.execute(
        "UPDATE scheduled SET sending = 1 WHERE id = ?1 AND send_at <= ?2 AND sending = 0",
        [id, now],
    )? == 1)
}

/// Gives a claimed row back after a failed send, with why, so the next tick retries it and the list says so.
pub fn release(conn: &Connection, id: i64, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE scheduled SET sending = 0, error = ?2 WHERE id = ?1",
        params![id, error],
    )?;
    Ok(())
}

/// Every scheduled email, soonest first; with `due_by`, only those due by then.
pub fn scheduled(conn: &Connection, due_by: Option<i64>) -> Result<Vec<ScheduledRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, draft_id, send_at, draft, ui, sending, error FROM scheduled WHERE ?1 IS NULL OR send_at <= ?1 ORDER BY send_at",
    )?;
    let rows = stmt.query_map([due_by], |r| {
        let json = |i| {
            r.get::<_, String>(i)
                .map(|s| serde_json::from_str(&s).unwrap_or_default())
        };
        Ok(ScheduledRow {
            account: String::new(),
            id: r.get(0)?,
            draft_id: r.get(1)?,
            send_at: r.get(2)?,
            draft: json(3)?,
            ui: json(4)?,
            sending: r.get(5)?,
            error: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Takes a scheduled email back for editing: drops its schedule and returns its files (the list leaves them out:
/// they can be megabytes each). Refused once it's being sent, or when it has already gone.
pub fn take_scheduled(conn: &mut Connection, id: i64) -> Result<serde_json::Value> {
    let tx = conn.transaction()?;
    let row: Option<(String, bool)> = tx
        .query_row(
            "SELECT draft, sending FROM scheduled WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((draft, sending)) = row else {
        anyhow::bail!("It has already been sent");
    };
    if sending {
        anyhow::bail!("It's already being sent");
    }
    tx.execute("DELETE FROM scheduled WHERE id = ?1", [id])?;
    tx.commit()?;
    let mut draft: serde_json::Value = serde_json::from_str(&draft)?;
    Ok(draft["attachments"].take())
}

/// Moves a scheduled email to a new time, or with `None` drops the schedule (the Gmail draft stays).
/// New send time, or `None` to cancel. Refused once the email is being sent (`claim`).
pub fn reschedule(conn: &Connection, id: i64, send_at: Option<i64>) -> Result<()> {
    let changed = match send_at {
        Some(t) => conn.execute(
            "UPDATE scheduled SET send_at = ?2, error = NULL WHERE id = ?1 AND sending = 0",
            params![id, t],
        )?,
        None => conn.execute("DELETE FROM scheduled WHERE id = ?1 AND sending = 0", [id])?,
    };
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM scheduled WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?;
    if changed == 0 && exists {
        anyhow::bail!("It's already being sent");
    }
    Ok(())
}

/// A label change made locally while Gmail couldn't be reached, waiting to be sent by the next sync.
#[derive(Debug, PartialEq)]
pub struct PendingOp {
    pub seq: i64,
    pub thread: String,
    pub add: Vec<String>,
    pub remove: Vec<String>,
    pub trash: bool,
}

/// Queues a label change for Gmail and returns its `seq`, which `done_pending` takes once Gmail has it.
pub fn add_pending(
    conn: &Connection,
    thread: &str,
    add: &[String],
    remove: &[String],
    trash: bool,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO pending_ops (thread_id, add_labels, remove_labels, trash) VALUES (?1, ?2, ?3, ?4)",
        params![thread, serde_json::to_string(add)?, serde_json::to_string(remove)?, trash],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Pending changes, oldest first, so they reach Gmail in the order the user made them.
pub fn pending_ops(conn: &Connection) -> Result<Vec<PendingOp>> {
    let mut st = conn.prepare(
        "SELECT seq, thread_id, add_labels, remove_labels, trash FROM pending_ops ORDER BY seq",
    )?;
    let rows = st.query_map([], |r| {
        let list = |i| {
            r.get::<_, String>(i)
                .map(|s| serde_json::from_str(&s).unwrap_or_default())
        };
        Ok(PendingOp {
            seq: r.get(0)?,
            thread: r.get(1)?,
            add: list(2)?,
            remove: list(3)?,
            trash: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn done_pending(conn: &Connection, seq: i64) -> Result<()> {
    conn.execute("DELETE FROM pending_ops WHERE seq = ?1", [seq])?;
    Ok(())
}

/// Whether `thread` has changes not yet in Gmail: a fetch of it would undo them on screen, so it waits.
pub fn has_pending(conn: &Connection, thread: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pending_ops WHERE thread_id = ?1)",
        [thread],
        |r| r.get(0),
    )
    .unwrap_or(false)
}

/// Drops a scheduled row after its send finished (sent, or its draft gone), whether or not it was claimed.
pub fn finish_scheduled(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM scheduled WHERE id = ?1", [id])?;
    Ok(())
}

pub fn get_meta(conn: &Connection, k: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT v FROM meta WHERE k = ?1", [k], |r| r.get(0))
        .optional()?)
}

pub fn delete_meta(conn: &Connection, k: &str) -> Result<()> {
    conn.execute("DELETE FROM meta WHERE k = ?1", [k])?;
    Ok(())
}

pub fn set_meta(conn: &Connection, k: &str, v: &str) -> Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?1, ?2)", [k, v])?;
    Ok(())
}

pub fn wipe(conn: &Connection) -> Result<()> {
    conn.execute_batch("DELETE FROM messages; DELETE FROM thread_labels; DELETE FROM threads; DELETE FROM labels; DELETE FROM meta; DELETE FROM ai_labels;")?;
    Ok(())
}

pub fn replace_labels(conn: &mut Connection, labels: &[gmail::Label]) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM labels", [])?;
    for l in labels {
        tx.execute(
            "INSERT INTO labels (id, name, kind, color) VALUES (?1, ?2, ?3, ?4)",
            params![
                l.id,
                l.name,
                l.kind,
                l.color.as_ref().map(|c| &c.background)
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// `full` records whether `t` carries message bodies (format=full) or only metadata.
pub fn upsert_thread(conn: &mut Connection, t: &gmail::Thread, full: bool) -> Result<()> {
    let (Some(first), Some(last)) = (t.messages.first(), t.messages.last()) else {
        return delete_thread(conn, &t.id);
    };
    // Show the other party, like Gmail: the latest sender who isn't me, or the recipient if I wrote every message.
    let me = get_meta(conn, "email")?.unwrap_or_default().to_lowercase();
    let from_me =
        |m: &&gmail::Message| !me.is_empty() && m.header("From").to_lowercase().contains(&me);
    let sender = t
        .messages
        .iter()
        .rev()
        .find(|m| !from_me(m))
        .map_or_else(|| last.header("To"), |m| m.header("From"));
    // Like Gmail, a conversation is listed by its messages outside Trash and Spam: one trashed reply doesn't take the
    // rest out of the Inbox. Its other labels come from those messages; Trash and Spam from any message, so the
    // conversation also shows there. With every message trashed, it keeps all their labels and isn't live.
    let binned = |m: &gmail::Message| m.label_ids.iter().any(|l| l == "TRASH" || l == "SPAM");
    let live = t.messages.iter().any(|m| !binned(m));
    let mut labels: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for m in &t.messages {
        for l in &m.label_ids {
            if !live || !binned(m) || l == "TRASH" || l == "SPAM" {
                labels.insert(l);
            }
        }
    }
    let tx = conn.transaction()?;
    // An upsert, not INSERT OR REPLACE: replacing deletes the row first, and the delete cascades into `ai_labels`.
    tx.execute(
        "INSERT INTO threads (id, subject, sender, snippet, date, count, full, live) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, sender = excluded.sender, snippet = excluded.snippet,
           date = excluded.date, count = excluded.count, full = excluded.full, live = excluded.live",
        params![t.id, first.header("Subject"), sender, last.snippet, last.date_ms(), t.messages.len() as i64, full, live],
    )?;
    tx.execute("DELETE FROM thread_labels WHERE thread_id = ?1", [&t.id])?;
    tx.execute("DELETE FROM messages WHERE thread_id = ?1", [&t.id])?;
    for l in labels {
        tx.execute(
            "INSERT OR IGNORE INTO thread_labels (label_id, thread_id) VALUES (?1, ?2)",
            [l, &t.id],
        )?;
    }
    for m in &t.messages {
        tx.execute(
            "INSERT INTO messages (id, thread_id, sender, recipients, cc, date, subject, message_id, refs, html, text, reply_to, ics)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                m.id, t.id, m.header("From"), m.header("To"), m.header("Cc"), m.date_ms(), m.header("Subject"),
                m.header("Message-ID"), m.header("References"), m.body("text/html"), m.body("text/plain"), m.header("Reply-To"),
                m.calendar()
            ],
        )?;
        for (i, a) in m.attachments().into_iter().enumerate() {
            tx.execute(
                "INSERT INTO attachments (message_id, idx, filename, mime, size, attachment_id, content_id, data)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![m.id, i as i64, a.filename, a.mime_type, a.size, a.attachment_id, a.content_id, a.data],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Every cached thread carrying `label`, whatever else it carries (unlike `threads`, which hides Trash/Spam elsewhere).
pub fn thread_ids(conn: &Connection, label: &str) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached("SELECT thread_id FROM thread_labels WHERE label_id = ?1")?;
    let rows = st.query_map([label], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn all_thread_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut st = conn.prepare("SELECT id FROM threads ORDER BY date DESC")?;
    let rows = st.query_map([], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// In one transaction: one commit for the whole batch instead of one per thread.
pub fn delete_threads(conn: &mut Connection, ids: &[String]) -> Result<()> {
    let tx = conn.transaction()?;
    for id in ids {
        tx.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    }
    tx.commit()?;
    Ok(())
}

/// A thread's trashed messages were deleted for good: gone if it was all in Trash, otherwise just out of Trash.
pub fn forget_trash(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM threads WHERE id = ?1 AND live = 0", [id])?;
    conn.execute(
        "DELETE FROM thread_labels WHERE thread_id = ?1 AND label_id = 'TRASH'",
        [id],
    )?;
    Ok(())
}

pub fn delete_thread(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    Ok(())
}

/// Gmail ids of the threads' messages, for `messages.batchModify`.
pub fn message_ids(conn: &Connection, threads: &[String]) -> Result<Vec<String>> {
    let mut stmt = conn.prepare_cached("SELECT id FROM messages WHERE thread_id = ?1")?;
    let mut out = Vec::new();
    for t in threads {
        out.extend(
            stmt.query_map([t], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<String>>>()?,
        );
    }
    Ok(out)
}

pub fn change_labels(
    conn: &mut Connection,
    thread: &str,
    add: &[String],
    remove: &[String],
) -> Result<()> {
    let tx = conn.transaction()?;
    for l in add {
        tx.execute(
            "INSERT OR IGNORE INTO thread_labels (label_id, thread_id) VALUES (?1, ?2)",
            [l, thread],
        )?;
    }
    for l in remove {
        tx.execute(
            "DELETE FROM thread_labels WHERE label_id = ?1 AND thread_id = ?2",
            [l, thread],
        )?;
    }
    // A local action moves the whole conversation, so Trash or Spam in or out decides whether it's live.
    let binned = |ls: &[String]| ls.iter().any(|l| l == "TRASH" || l == "SPAM");
    if binned(add) {
        tx.execute("UPDATE threads SET live = 0 WHERE id = ?1", [thread])?;
    } else if binned(remove) {
        tx.execute("UPDATE threads SET live = 1 WHERE id = ?1", [thread])?;
    }
    tx.commit()?;
    Ok(())
}

#[derive(Serialize)]
pub struct LabelRow {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub unread: i64,
    /// Gmail's background colour for the label, when one is set.
    pub color: Option<String>,
}

/// Clears UNREAD on every thread `threads(label)` lists; returns the ids it changed.
pub fn mark_read(conn: &mut Connection, label: Option<&str>) -> Result<Vec<String>> {
    let ids: Vec<String> = threads(conn, label)?
        .into_iter()
        .filter(|t| t.unread)
        .map(|t| t.id)
        .collect();
    let tx = conn.transaction()?;
    for id in &ids {
        tx.execute(
            "DELETE FROM thread_labels WHERE label_id = 'UNREAD' AND thread_id = ?1",
            [id],
        )?;
    }
    tx.commit()?;
    Ok(ids)
}

pub fn insert_label(conn: &Connection, l: &gmail::Label) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO labels (id, name, kind, color) VALUES (?1, ?2, ?3, ?4)",
        params![
            l.id,
            l.name,
            l.kind,
            l.color.as_ref().map(|c| &c.background)
        ],
    )?;
    Ok(())
}

pub fn rename_label(conn: &Connection, id: &str, name: &str) -> Result<()> {
    conn.execute("UPDATE labels SET name = ?2 WHERE id = ?1", [id, name])?;
    Ok(())
}

pub fn set_label_color(conn: &Connection, id: &str, color: &str) -> Result<()> {
    conn.execute("UPDATE labels SET color = ?2 WHERE id = ?1", [id, color])?;
    Ok(())
}

pub fn delete_label(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM thread_labels WHERE label_id = ?1", [id])?;
    conn.execute("DELETE FROM labels WHERE id = ?1", [id])?;
    Ok(())
}

/// When a thread's latest message arrived (ms), if it's cached.
pub fn thread_date(conn: &Connection, id: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row("SELECT date FROM threads WHERE id = ?1", [id], |r| r.get(0))
        .optional()?)
}

pub fn thread_label_ids(conn: &Connection, id: &str) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached("SELECT label_id FROM thread_labels WHERE thread_id = ?1")?;
    let rows = st.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn label_id(conn: &Connection, name: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT id FROM labels WHERE name = ?1", [name], |r| {
            r.get(0)
        })
        .optional()?)
}

pub fn labels(conn: &Connection) -> Result<Vec<LabelRow>> {
    let mut st = conn.prepare(
        "SELECT l.id, l.name, l.kind,
           (SELECT count(*) FROM thread_labels a JOIN thread_labels u ON u.thread_id = a.thread_id AND u.label_id = 'UNREAD'
            WHERE a.label_id = l.id), l.color
         FROM labels l ORDER BY l.kind DESC, l.name COLLATE NOCASE",
    )?;
    let rows = st.query_map([], |r| {
        Ok(LabelRow {
            id: r.get(0)?,
            name: r.get(1)?,
            kind: r.get(2)?,
            unread: r.get(3)?,
            color: r.get(4)?,
        })
    })?;
    let mut out: Vec<LabelRow> = rows.collect::<Result<_, _>>()?;
    // The cache holds recent mail only: add the unread Inbox threads Gmail has beyond it (worked out by the sync),
    // so reading one here still lowers the count at once.
    let extra: i64 = get_meta(conn, "inbox_unread_extra")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if let Some(inbox) = out.iter_mut().find(|l| l.id == "INBOX") {
        inbox.unread += extra;
    }
    Ok(out)
}

#[derive(Serialize)]
pub struct ThreadRow {
    /// Which account the thread belongs to; filled in by the caller, since each account has its own database.
    pub account: String,
    id: String,
    subject: String,
    sender: String,
    snippet: String,
    pub date: i64,
    count: i64,
    unread: bool,
    starred: bool,
    /// False for Gmail's Promotions/Social/Updates/Forums tabs.
    primary: bool,
    /// Space-separated Gmail label ids.
    labels: String,
}

const THREAD_COLS: &str = "t.id, t.subject, t.sender, t.snippet, t.date, t.count,
  EXISTS(SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id = 'UNREAD'),
  EXISTS(SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id = 'STARRED'),
  NOT EXISTS(SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id
    AND x.label_id IN ('CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS')),
  (SELECT group_concat(x.label_id, ' ') FROM thread_labels x WHERE x.thread_id = t.id)";

fn thread_row(r: &rusqlite::Row) -> rusqlite::Result<ThreadRow> {
    Ok(ThreadRow {
        account: String::new(),
        id: r.get(0)?,
        subject: r.get(1)?,
        sender: r.get(2)?,
        snippet: r.get(3)?,
        date: r.get(4)?,
        count: r.get(5)?,
        unread: r.get(6)?,
        starred: r.get(7)?,
        primary: r.get(8)?,
        labels: r.get::<_, Option<String>>(9)?.unwrap_or_default(),
    })
}

/// `label = None` is All Mail; `ARCHIVE` is everything outside the Inbox (Gmail has no archive label).
/// Spam and trash only show inside their own folders, like Gmail.
pub fn threads(conn: &Connection, label: Option<&str>) -> Result<Vec<ThreadRow>> {
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads t
         WHERE (?1 IS NULL OR ?1 = 'ARCHIVE' OR EXISTS(SELECT 1 FROM thread_labels l WHERE l.thread_id = t.id AND l.label_id = ?1))
           AND (?1 IS NOT 'ARCHIVE' OR NOT EXISTS(
             SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN ('INBOX', 'DRAFT')))
           AND (?1 IN ('TRASH', 'SPAM') OR t.live = 1)
         ORDER BY t.date DESC LIMIT 1000"
    );
    let mut st = conn.prepare_cached(&sql)?;
    let rows = st.query_map([label], thread_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn threads_by_ids(conn: &Connection, ids: &[String]) -> Result<Vec<ThreadRow>> {
    let mut st = conn.prepare_cached(&format!(
        "SELECT {THREAD_COLS} FROM threads t WHERE t.id = ?1"
    ))?;
    let mut out = Vec::new();
    for id in ids {
        if let Some(row) = st.query_row([id], thread_row).optional()? {
            out.push(row);
        }
    }
    Ok(out)
}

pub struct NewMail {
    pub id: String,
    pub sender: String,
    pub subject: String,
    pub snippet: String,
    pub date: i64,
    /// False for Gmail's Promotions/Social/Updates/Forums tabs.
    pub primary: bool,
}

/// Unread Inbox threads whose latest message is newer than `since` (ms), oldest first.
/// Unread Inbox threads newer than `since`, oldest first: what a new-mail notification announces.
pub fn new_mail(conn: &Connection, since: i64) -> Result<Vec<NewMail>> {
    inbox_mail(conn, since, true)
}

/// Inbox threads newer than `since`, oldest first; `unread_only` leaves out those already read.
pub fn inbox_mail(conn: &Connection, since: i64, unread_only: bool) -> Result<Vec<NewMail>> {
    let mut out: Vec<NewMail> = threads(conn, Some("INBOX"))?
        .into_iter()
        .filter(|t| (t.unread || !unread_only) && t.date > since)
        .map(|t| NewMail {
            id: t.id,
            sender: t.sender,
            subject: t.subject,
            snippet: t.snippet,
            date: t.date,
            primary: t.primary,
        })
        .collect();
    out.reverse();
    Ok(out)
}

/// The newest Inbox threads, briefly, for AI cleanup: id, sender, subject, preview.
pub fn inbox_brief(conn: &Connection, limit: usize) -> Result<Vec<[String; 4]>> {
    Ok(threads(conn, Some("INBOX"))?
        .into_iter()
        .take(limit)
        .map(|t| [t.id, t.sender, t.subject, t.snippet])
        .collect())
}

/// Labels the AI added to a thread (and Shift still remembers), so the reader can show and undo them.
pub fn ai_labels(conn: &Connection, thread: &str) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached("SELECT label_id FROM ai_labels WHERE thread_id = ?1")?;
    let rows = st.query_map([thread], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn add_ai_label(conn: &Connection, thread: &str, label: &str, at: i64) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO ai_labels (thread_id, label_id, at) VALUES (?1, ?2, ?3)",
        params![thread, label, at],
    )?;
    Ok(())
}

pub fn forget_ai_labels(conn: &Connection, thread: &str) -> Result<()> {
    conn.execute("DELETE FROM ai_labels WHERE thread_id = ?1", [thread])?;
    Ok(())
}

pub fn has_thread(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM threads WHERE id = ?1)",
        [id],
        |r| r.get(0),
    )?)
}

/// `%word%` for LIKE, with the user's own `%`, `_` and `\` matched literally.
fn like(word: &str) -> String {
    let escaped = word
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Instant search over the local cache. Every word must match the subject, a sender or the preview;
/// `from:x` must match a sender of any message in the thread (Gmail syntax).
// shortcut: LIKE scans every cached thread (about 1 ms per 750 threads, measured); move to an FTS5 index if search
// gets slow on a large cache, knowing FTS matches word prefixes where LIKE also matches mid-word.
pub fn search_local(conn: &Connection, query: &str) -> Result<Vec<ThreadRow>> {
    let (mut clauses, mut args) = (Vec::new(), Vec::new());
    for token in query.split_whitespace() {
        let n = args.len() + 1;
        if let Some(from) = token.strip_prefix("from:").filter(|f| !f.is_empty()) {
            clauses.push(format!(
                "EXISTS(SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.sender LIKE ?{n} ESCAPE '\\')"
            ));
            args.push(like(from));
        } else {
            clauses.push(format!(
                "(t.subject LIKE ?{n} ESCAPE '\\' OR t.snippet LIKE ?{n} ESCAPE '\\'
                  OR EXISTS(SELECT 1 FROM messages m WHERE m.thread_id = t.id AND m.sender LIKE ?{n} ESCAPE '\\'))"
            ));
            args.push(like(token));
        }
    }
    if clauses.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {THREAD_COLS} FROM threads t WHERE {}
           AND t.live = 1
         ORDER BY t.date DESC LIMIT 100",
        clauses.join(" AND ")
    );
    let mut st = conn.prepare(&sql)?;
    let rows = st.query_map(rusqlite::params_from_iter(args.iter()), thread_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Raw From/To/Cc header values from recent messages mentioning `query`, for contact autocomplete.
pub fn contact_headers(conn: &Connection, query: &str) -> Result<Vec<String>> {
    let mut st = conn.prepare_cached(
        "SELECT sender, recipients, cc FROM messages
         WHERE sender LIKE ?1 ESCAPE '\\' OR recipients LIKE ?1 ESCAPE '\\' OR cc LIKE ?1 ESCAPE '\\'
         ORDER BY date DESC LIMIT 400",
    )?;
    let rows = st.query_map([like(query.trim())], |r| {
        Ok([r.get::<_, String>(0)?, r.get(1)?, r.get(2)?])
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.extend(row?);
    }
    Ok(out)
}

/// Senders whose name or address contains `query`, most frequent first: "Name <addr>".
pub fn suggest_senders(conn: &Connection, query: &str) -> Result<Vec<String>> {
    let query = query.trim().trim_start_matches("from:");
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut st = conn.prepare_cached(
        "SELECT sender FROM messages WHERE sender LIKE ?1 ESCAPE '\\'
         GROUP BY lower(sender) ORDER BY count(*) DESC, max(date) DESC LIMIT 5",
    )?;
    let rows = st.query_map([like(query)], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn is_full(conn: &Connection, id: &str) -> bool {
    conn.query_row("SELECT full FROM threads WHERE id = ?1", [id], |r| r.get(0))
        .unwrap_or(false)
}

/// Newest threads in `label` whose bodies aren't cached yet.
pub fn missing_bodies(conn: &Connection, label: &str, limit: usize) -> Result<Vec<String>> {
    let mut st = conn.prepare(
        "SELECT t.id FROM threads t JOIN thread_labels l ON l.thread_id = t.id AND l.label_id = ?1
         WHERE t.full = 0 ORDER BY t.date DESC LIMIT ?2",
    )?;
    let rows = st.query_map(params![label, limit as i64], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[derive(Serialize)]
pub struct MessageRow {
    pub id: String,
    sender: String,
    recipients: String,
    cc: String,
    date: i64,
    subject: String,
    message_id: String,
    refs: String,
    pub html: Option<String>,
    text: Option<String>,
    /// Where replies go, when the sender set it (mailing lists, help desks); empty otherwise.
    reply_to: String,
    pub attachments: Vec<AttachmentRow>,
    /// The calendar event, when the email is an invite or an answer to one.
    pub invite: Option<crate::invite::Invite>,
}

#[derive(Serialize, Debug)]
pub struct AttachmentRow {
    pub idx: i64,
    pub filename: String,
    pub mime: String,
    pub size: i64,
    pub content_id: Option<String>,
}

pub fn messages(conn: &Connection, thread: &str) -> Result<Vec<MessageRow>> {
    let mut st = conn.prepare_cached(
        "SELECT id, sender, recipients, cc, date, subject, message_id, refs, html, text, reply_to, ics
         FROM messages WHERE thread_id = ?1 ORDER BY date",
    )?;
    let me = get_meta(conn, "email")?.unwrap_or_default();
    let rows = st.query_map([thread], |r| {
        let ics: Option<String> = r.get(11)?;
        Ok(MessageRow {
            id: r.get(0)?,
            sender: r.get(1)?,
            recipients: r.get(2)?,
            cc: r.get(3)?,
            date: r.get(4)?,
            subject: r.get(5)?,
            message_id: r.get(6)?,
            refs: r.get(7)?,
            html: r.get(8)?,
            text: r.get(9)?,
            reply_to: r.get(10)?,
            attachments: Vec::new(),
            invite: ics.and_then(|ics| crate::invite::parse(&ics, &me)),
        })
    })?;
    let mut out: Vec<MessageRow> = rows.collect::<Result<_, _>>()?;
    // An answer sent from Shift, until Gmail brings an updated invite. A newer version of the event asks again.
    for i in out.iter_mut().filter_map(|m| m.invite.as_mut()) {
        if let Some((sequence, status)) = rsvp(conn, &i.uid)?
            && sequence >= i.sequence
        {
            i.status = status;
        }
    }
    let mut st = conn.prepare_cached(
        "SELECT idx, filename, mime, size, content_id FROM attachments WHERE message_id = ?1 ORDER BY idx",
    )?;
    for m in &mut out {
        m.attachments = st
            .query_map([&m.id], |r| {
                Ok(AttachmentRow {
                    idx: r.get(0)?,
                    filename: r.get(1)?,
                    mime: r.get(2)?,
                    size: r.get(3)?,
                    content_id: r.get(4)?,
                })
            })?
            .collect::<Result<_, _>>()?;
    }
    Ok(out)
}

/// An invite and what answering it needs: (calendar data, thread id, Message-ID, References).
pub fn invite_source(conn: &Connection, message: &str) -> Result<(String, String, String, String)> {
    conn.query_row(
        "SELECT ics, thread_id, message_id, refs FROM messages WHERE id = ?1 AND ics IS NOT NULL",
        [message],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()?
    .ok_or_else(|| anyhow::anyhow!("This email has no invite"))
}

/// The answer last sent from Shift for an event: (its version, the `PARTSTAT`).
pub fn rsvp(conn: &Connection, uid: &str) -> Result<Option<(i64, String)>> {
    Ok(conn
        .query_row(
            "SELECT sequence, status FROM rsvps WHERE uid = ?1",
            [uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// Records an answer, or with `None` forgets it (when sending it failed).
pub fn set_rsvp(conn: &Connection, uid: &str, answer: Option<&(i64, String)>) -> Result<()> {
    match answer {
        Some((sequence, status)) => conn.execute(
            "INSERT INTO rsvps (uid, sequence, status) VALUES (?1, ?2, ?3)
             ON CONFLICT(uid) DO UPDATE SET sequence = excluded.sequence, status = excluded.status",
            params![uid, sequence, status],
        )?,
        None => conn.execute("DELETE FROM rsvps WHERE uid = ?1", [uid])?,
    };
    Ok(())
}

/// Where an attachment's bytes are: inline `data`, or the Gmail `attachment_id` to fetch. Also its filename.
pub fn attachment_source(
    conn: &Connection,
    message: &str,
    idx: i64,
) -> Result<(String, Option<Vec<u8>>, Option<String>)> {
    Ok(conn.query_row(
        "SELECT filename, data, attachment_id FROM attachments WHERE message_id = ?1 AND idx = ?2",
        params![message, idx],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, labels: &[&str], date: &str) -> gmail::Thread {
        let json = serde_json::json!({ "id": id, "messages": [{
            "id": format!("{id}-m"), "labelIds": labels, "snippet": "s", "internalDate": date,
            "payload": { "headers": [{ "name": "Subject", "value": "subj" }, { "name": "From", "value": "a@b.c" }, { "name": "To", "value": "to@x.y" }] }
        }]});
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn sent_answer_shows_until_the_event_changes() {
        use base64::Engine;
        let mut c = open(std::path::Path::new(":memory:")).unwrap();
        set_meta(&c, "email", "me@x.com").unwrap();
        let ics = "BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VEVENT\nUID:ev1\nSEQUENCE:1\n\
                   ORGANIZER:mailto:o@x.com\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@x.com\nEND:VEVENT\nEND:VCALENDAR";
        let data = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(ics);
        let t: gmail::Thread =
            serde_json::from_value(serde_json::json!({ "id": "t", "messages": [{
                "id": "m", "labelIds": ["INBOX"], "internalDate": "1",
                "payload": { "mimeType": "text/calendar", "body": { "data": data } }
            }]}))
            .unwrap();
        upsert_thread(&mut c, &t, true).unwrap();
        let status = |c: &Connection| {
            messages(c, "t").unwrap()[0]
                .invite
                .as_ref()
                .unwrap()
                .status
                .clone()
        };
        set_rsvp(&c, "ev1", Some(&(1, "ACCEPTED".into()))).unwrap();
        assert_eq!(status(&c), "ACCEPTED");
        set_rsvp(&c, "ev1", Some(&(0, "DECLINED".into()))).unwrap();
        assert_eq!(
            status(&c),
            "NEEDS-ACTION",
            "an answer to an older version doesn't count"
        );
    }

    #[test]
    fn scheduled_due_and_reschedule() {
        let conn = open(std::path::Path::new(":memory:")).unwrap();
        let d = serde_json::json!({"to": "a@b.c"});
        let ui = serde_json::json!({});
        let early = add_scheduled(&conn, Some("d1"), 100, &d, &ui).unwrap();
        let late = add_scheduled(&conn, None, 300, &d, &ui).unwrap();
        assert_eq!(scheduled(&conn, Some(200)).unwrap().len(), 1);
        assert_eq!(scheduled(&conn, None).unwrap()[0].draft["to"], "a@b.c");
        reschedule(&conn, late, Some(50)).unwrap();
        assert_eq!(scheduled(&conn, Some(200)).unwrap()[0].id, late);
        reschedule(&conn, early, None).unwrap();
        assert_eq!(scheduled(&conn, None).unwrap().len(), 1);
    }

    #[test]
    fn mark_read_and_delete_label() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute(
            "INSERT INTO labels (id, name, kind) VALUES ('Label_1', 'Later', 'user')",
            [],
        )
        .unwrap();
        upsert_thread(&mut c, &thread("a", &["Label_1", "UNREAD"], "2"), false).unwrap();
        upsert_thread(&mut c, &thread("b", &["INBOX", "UNREAD"], "3"), false).unwrap();
        assert_eq!(mark_read(&mut c, Some("Label_1")).unwrap(), ["a"]);
        assert!(!threads(&c, Some("Label_1")).unwrap()[0].unread);
        assert!(
            threads(&c, Some("INBOX")).unwrap()[0].unread,
            "other mailboxes untouched"
        );
        delete_label(&c, "Label_1").unwrap();
        assert!(threads(&c, Some("Label_1")).unwrap().is_empty());
        assert_eq!(label_id(&c, "Later").unwrap(), None);
    }

    /// A thread whose messages carry these labels, one message each.
    fn convo(id: &str, messages: &[&[&str]]) -> gmail::Thread {
        let msgs: Vec<_> = messages.iter().enumerate().map(|(i, labels)| serde_json::json!({
            "id": format!("{id}-{i}"), "labelIds": labels, "snippet": "s", "internalDate": format!("{}", 10 + i),
            "payload": { "headers": [{ "name": "Subject", "value": "subj" }, { "name": "From", "value": "a@b.c" }] }
        })).collect();
        serde_json::from_value(serde_json::json!({ "id": id, "messages": msgs })).unwrap()
    }

    #[test]
    fn deleting_trash_for_good_keeps_messages_outside_it() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        upsert_thread(&mut c, &convo("binned", &[&["TRASH"]]), false).unwrap();
        upsert_thread(&mut c, &convo("part", &[&["INBOX"], &["TRASH"]]), false).unwrap();
        forget_trash(&c, "binned").unwrap();
        forget_trash(&c, "part").unwrap();
        assert!(
            threads(&c, Some("TRASH")).unwrap().is_empty(),
            "nothing left in Trash"
        );
        assert_eq!(
            threads(&c, Some("INBOX")).unwrap().len(),
            1,
            "the reply outside Trash stays"
        );
    }

    #[test]
    fn one_trashed_message_keeps_the_conversation_in_the_inbox() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        upsert_thread(
            &mut c,
            &convo("part", &[&["INBOX", "UNREAD"], &["TRASH"]]),
            false,
        )
        .unwrap();
        upsert_thread(
            &mut c,
            &convo("all", &[&["TRASH", "INBOX"], &["TRASH"]]),
            false,
        )
        .unwrap();
        let ids = |c: &Connection, l: &str| {
            threads(c, Some(l))
                .unwrap()
                .into_iter()
                .map(|t| t.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(&c, "INBOX"),
            ["part"],
            "a fully trashed thread leaves the Inbox, a partly trashed one stays"
        );
        assert_eq!(ids(&c, "TRASH").len(), 2, "both show in Trash");
        // Undoing a delete brings the conversation back.
        change_labels(&mut c, "all", &["INBOX".into()], &["TRASH".into()]).unwrap();
        assert_eq!(ids(&c, "INBOX").len(), 2);
        change_labels(&mut c, "part", &["TRASH".into()], &["INBOX".into()]).unwrap();
        assert_eq!(ids(&c, "INBOX"), ["all"]);
    }

    #[test]
    fn upgrading_an_old_cache_requeues_trashed_threads() {
        let path = std::env::temp_dir().join(format!("shift-live-{}.sqlite3", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            // The cache as written before `live`: no column, labels merged across a thread's messages.
            let c = Connection::open(&path).unwrap();
            c.execute_batch(&SCHEMA.replace(", live INTEGER NOT NULL DEFAULT 1", ""))
                .unwrap();
            c.execute_batch("INSERT INTO threads (id, subject, sender, snippet, date, count) VALUES ('t', '', '', '', 1, 2), ('u', '', '', '', 1, 1);
                INSERT INTO thread_labels VALUES ('INBOX', 't'), ('TRASH', 't'), ('INBOX', 'u');").unwrap();
        }
        let c = open(&path).unwrap();
        assert_eq!(
            threads(&c, Some("INBOX")).unwrap().len(),
            1,
            "unaffected thread still listed"
        );
        assert_eq!(
            get_meta(&c, "backfill").unwrap().as_deref(),
            Some(r#"["t"]"#),
            "the trashed one is re-fetched"
        );
        let version: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, VERSION);
        set_meta(&c, "backfill", "[]").unwrap();
        drop(c);
        let c = open(&path).unwrap();
        assert_eq!(
            get_meta(&c, "backfill").unwrap().as_deref(),
            Some("[]"),
            "an upgraded cache isn't upgraded again"
        );
        drop(c);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn pending_changes_keep_their_order() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        assert!(!has_pending(&c, "t"));
        add_pending(&c, "t", &[], &["INBOX".into()], false).unwrap();
        add_pending(&c, "t", &["TRASH".into()], &[], true).unwrap();
        let ops = pending_ops(&c).unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[0].remove, ["INBOX"]);
        assert!(ops[1].trash && has_pending(&c, "t"));
        done_pending(&c, ops[0].seq).unwrap();
        done_pending(&c, ops[1].seq).unwrap();
        assert!(!has_pending(&c, "t"));
    }

    #[test]
    fn taking_a_scheduled_email_back_is_refused_once_it_is_sending_or_sent() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        let draft = serde_json::json!({ "attachments": [{ "name": "a.txt" }] });
        let id = add_scheduled(&c, Some("d"), 100, &draft, &serde_json::json!({})).unwrap();
        assert!(claim(&c, id, 100).unwrap());
        assert!(take_scheduled(&mut c, id).is_err(), "being sent");
        release(&c, id, "offline").unwrap();
        assert_eq!(take_scheduled(&mut c, id).unwrap()[0]["name"], "a.txt");
        assert!(scheduled(&c, None).unwrap().is_empty(), "off the schedule");
        assert!(take_scheduled(&mut c, id).is_err(), "already gone (sent)");
    }

    #[test]
    fn only_a_damaged_file_counts_as_corrupt() {
        let path =
            std::env::temp_dir().join(format!("shift-corrupt-{}.sqlite3", std::process::id()));
        std::fs::write(
            &path,
            b"definitely not sqlite, long enough to have a header",
        )
        .unwrap();
        assert!(is_corrupt(&open(&path).unwrap_err()));
        let _ = std::fs::remove_file(&path);
        assert!(!is_corrupt(&anyhow::anyhow!("database is locked")));
    }

    #[test]
    fn a_claimed_send_cannot_be_cancelled() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        let v = serde_json::json!({});
        let id = add_scheduled(&c, Some("d"), 100, &v, &v).unwrap();
        assert!(!claim(&c, id, 50).unwrap(), "not due yet");
        assert!(claim(&c, id, 100).unwrap());
        assert!(!claim(&c, id, 100).unwrap(), "only one sender gets it");
        assert!(
            reschedule(&c, id, None).is_err(),
            "cancel refused while sending"
        );
        assert!(scheduled(&c, None).unwrap()[0].sending);
        release(&c, id, "Gmail API 400: invalid To").unwrap();
        let row = &scheduled(&c, None).unwrap()[0];
        assert!(
            !row.sending && row.error.as_deref() == Some("Gmail API 400: invalid To"),
            "the Outbox shows why"
        );
        reschedule(&c, id, Some(200)).unwrap();
        assert_eq!(
            scheduled(&c, None).unwrap()[0].error,
            None,
            "a new time clears the old failure"
        );
        reschedule(&c, id, None).unwrap();
        assert!(
            scheduled(&c, None).unwrap().is_empty(),
            "cancelled once released"
        );
        reschedule(&c, id, None).unwrap(); // gone already: nothing to refuse
    }

    #[test]
    fn a_sync_keeps_the_ai_label_record() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        upsert_thread(&mut c, &thread("a", &["INBOX"], "2"), false).unwrap();
        add_ai_label(&c, "a", "Label_1", 1).unwrap();
        upsert_thread(&mut c, &thread("a", &["INBOX", "Label_1"], "2"), true).unwrap();
        assert_eq!(ai_labels(&c, "a").unwrap(), ["Label_1"]);
    }

    #[test]
    fn new_mail_is_unread_inbox_after_the_watermark() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        upsert_thread(&mut c, &thread("old", &["INBOX", "UNREAD"], "100"), false).unwrap();
        upsert_thread(&mut c, &thread("new", &["INBOX", "UNREAD"], "300"), false).unwrap();
        upsert_thread(&mut c, &thread("read", &["INBOX"], "400"), false).unwrap();
        upsert_thread(&mut c, &thread("archived", &["UNREAD"], "500"), false).unwrap();
        let mail = new_mail(&c, 200).unwrap();
        assert_eq!(mail.iter().map(|m| m.date).collect::<Vec<_>>(), [300]);
    }

    #[test]
    fn label_id_by_name() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c.execute(
            "INSERT INTO labels (id, name, kind) VALUES ('Label_7', 'Notes', 'user')",
            [],
        )
        .unwrap();
        upsert_thread(&mut c, &thread("a", &["Label_7"], "2"), false).unwrap();
        let id = label_id(&c, "Notes").unwrap();
        assert_eq!(id.as_deref(), Some("Label_7"));
        assert_eq!(threads(&c, id.as_deref()).unwrap().len(), 1);
        assert_eq!(label_id(&c, "Missing").unwrap(), None);
    }

    #[test]
    fn label_filtering_and_label_changes() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c.execute_batch(SCHEMA).unwrap();
        upsert_thread(&mut c, &thread("a", &["INBOX", "UNREAD"], "2"), false).unwrap();
        upsert_thread(&mut c, &thread("b", &["INBOX"], "3"), false).unwrap();
        upsert_thread(&mut c, &thread("c", &["TRASH"], "4"), false).unwrap();

        let inbox = threads(&c, Some("INBOX")).unwrap();
        assert_eq!(
            inbox.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert!(inbox[1].unread && !inbox[0].unread);
        assert_eq!(
            threads(&c, None).unwrap().len(),
            2,
            "trash hidden from All Mail"
        );
        assert_eq!(threads(&c, Some("TRASH")).unwrap().len(), 1);
        assert!(
            threads(&c, Some("ARCHIVE")).unwrap().is_empty(),
            "inbox and trash aren't archived"
        );

        change_labels(&mut c, "a", &[], &["INBOX".into()]).unwrap();
        assert_eq!(threads(&c, Some("INBOX")).unwrap().len(), 1);
        assert_eq!(
            threads(&c, Some("ARCHIVE")).unwrap()[0].id,
            "a",
            "archiving moves it to Archive"
        );

        upsert_thread(&mut c, &thread("a", &["INBOX"], "5"), false).unwrap();
        assert_eq!(
            threads(&c, Some("INBOX")).unwrap()[0].id,
            "a",
            "re-sync replaces labels and date"
        );
        assert_eq!(messages(&c, "a").unwrap().len(), 1);
        assert!(!is_full(&c, "a"));
        assert_eq!(missing_bodies(&c, "INBOX", 10).unwrap(), ["a", "b"]);
        upsert_thread(&mut c, &thread("b", &["INBOX"], "3"), true).unwrap();
        assert!(is_full(&c, "b"));
        assert_eq!(missing_bodies(&c, "INBOX", 10).unwrap(), ["a"]);

        assert_eq!(threads(&c, Some("INBOX")).unwrap()[0].sender, "a@b.c");
        upsert_thread(
            &mut c,
            &thread("p", &["INBOX", "CATEGORY_PROMOTIONS"], "1"),
            false,
        )
        .unwrap();
        let inbox = threads(&c, Some("INBOX")).unwrap();
        assert!(inbox.iter().all(|t| t.primary == (t.id != "p")));
        set_meta(&c, "email", "A@b.c").unwrap();
        upsert_thread(&mut c, &thread("a", &["INBOX"], "5"), false).unwrap();
        assert_eq!(
            threads(&c, Some("INBOX")).unwrap()[0].sender,
            "to@x.y",
            "my own thread shows the recipient"
        );

        assert_eq!(
            search_local(&c, "SUBJ").unwrap().len(),
            3,
            "case-insensitive, trash excluded"
        );
        assert_eq!(search_local(&c, "from:a@b.c subj").unwrap().len(), 3);
        assert!(search_local(&c, "from:nobody").unwrap().is_empty());
        assert!(search_local(&c, "100%").unwrap().is_empty(), "% is literal");
        assert!(search_local(&c, "  ").unwrap().is_empty());
        assert_eq!(suggest_senders(&c, "a@b").unwrap(), ["a@b.c"]);

        let with_file: gmail::Thread = serde_json::from_value(serde_json::json!({ "id": "f", "messages": [{
            "id": "f-m", "labelIds": ["INBOX"], "internalDate": "6", "payload": { "mimeType": "multipart/mixed", "parts": [
                { "mimeType": "text/plain", "body": { "data": "aGk" } },
                { "mimeType": "application/pdf", "filename": "c.pdf", "body": { "attachmentId": "A", "size": 9 } }] }
        }]}))
        .unwrap();
        upsert_thread(&mut c, &with_file, true).unwrap();
        upsert_thread(&mut c, &with_file, true).unwrap();
        let files = &messages(&c, "f").unwrap()[0].attachments;
        assert_eq!(
            (files.len(), files[0].filename.as_str(), files[0].size),
            (1, "c.pdf", 9),
            "re-sync replaces rows"
        );
        assert_eq!(
            attachment_source(&c, "f-m", 0).unwrap().2.as_deref(),
            Some("A")
        );
        delete_thread(&c, "f").unwrap();
        assert!(
            attachment_source(&c, "f-m", 0).is_err(),
            "attachments cascade"
        );

        delete_thread(&c, "a").unwrap();
        assert!(messages(&c, "a").unwrap().is_empty(), "messages cascade");
    }
}
