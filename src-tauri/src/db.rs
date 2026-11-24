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
  full INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS threads_date ON threads(date DESC);
CREATE TABLE IF NOT EXISTS thread_labels (
  label_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  PRIMARY KEY (label_id, thread_id)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_labels_thread ON thread_labels(thread_id);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender TEXT NOT NULL, recipients TEXT NOT NULL, cc TEXT NOT NULL, date INTEGER NOT NULL,
  subject TEXT NOT NULL, message_id TEXT NOT NULL, refs TEXT NOT NULL,
  html TEXT, text TEXT);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, date);
CREATE TABLE IF NOT EXISTS attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, idx INTEGER NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  attachment_id TEXT, content_id TEXT, data BLOB,
  PRIMARY KEY (message_id, idx)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY, draft_id TEXT, send_at INTEGER NOT NULL, draft TEXT NOT NULL, ui TEXT NOT NULL);
";

pub fn open(path: &std::path::Path) -> Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let had_attachments: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'attachments')",
        [],
        |r| r.get(0),
    )?;
    conn.execute_batch(SCHEMA)?;
    // Databases created before bodies were loaded lazily lack the column; the error just means it exists.
    let _ = conn.execute(
        "ALTER TABLE threads ADD COLUMN full INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE labels ADD COLUMN color TEXT", []);
    // Bodies cached before attachments were stored carry none; mark them for a re-fetch on open.
    if !had_attachments {
        conn.execute("UPDATE threads SET full = 0", [])?;
    }
    Ok(conn)
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

/// Every scheduled email, soonest first; with `due_by`, only those due by then.
pub fn scheduled(conn: &Connection, due_by: Option<i64>) -> Result<Vec<ScheduledRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, draft_id, send_at, draft, ui FROM scheduled WHERE ?1 IS NULL OR send_at <= ?1 ORDER BY send_at",
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
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Moves a scheduled email to a new time, or with `None` drops the schedule (the Gmail draft stays).
pub fn reschedule(conn: &Connection, id: i64, send_at: Option<i64>) -> Result<()> {
    match send_at {
        Some(t) => conn.execute(
            "UPDATE scheduled SET send_at = ?2 WHERE id = ?1",
            params![id, t],
        )?,
        None => conn.execute("DELETE FROM scheduled WHERE id = ?1", [id])?,
    };
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
    conn.execute_batch("DELETE FROM messages; DELETE FROM thread_labels; DELETE FROM threads; DELETE FROM labels; DELETE FROM meta;")?;
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
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT OR REPLACE INTO threads (id, subject, sender, snippet, date, count, full) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![t.id, first.header("Subject"), sender, last.snippet, last.date_ms(), t.messages.len() as i64, full],
    )?;
    tx.execute("DELETE FROM thread_labels WHERE thread_id = ?1", [&t.id])?;
    tx.execute("DELETE FROM messages WHERE thread_id = ?1", [&t.id])?;
    for m in &t.messages {
        for l in &m.label_ids {
            tx.execute(
                "INSERT OR IGNORE INTO thread_labels (label_id, thread_id) VALUES (?1, ?2)",
                [l, &t.id],
            )?;
        }
        tx.execute(
            "INSERT INTO messages (id, thread_id, sender, recipients, cc, date, subject, message_id, refs, html, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                m.id, t.id, m.header("From"), m.header("To"), m.header("Cc"), m.date_ms(), m.header("Subject"),
                m.header("Message-ID"), m.header("References"), m.body("text/html"), m.body("text/plain")
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

pub fn delete_thread(conn: &Connection, id: &str) -> Result<()> {
    conn.execute("DELETE FROM threads WHERE id = ?1", [id])?;
    Ok(())
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
    for id in &ids {
        change_labels(conn, id, &[], &["UNREAD".into()])?;
    }
    Ok(ids)
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
    Ok(rows.collect::<Result<_, _>>()?)
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
           AND (?1 IN ('TRASH', 'SPAM') OR NOT EXISTS(
             SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN ('TRASH', 'SPAM')))
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
    pub sender: String,
    pub subject: String,
    pub date: i64,
    /// False for Gmail's Promotions/Social/Updates/Forums tabs.
    pub primary: bool,
}

/// Unread Inbox threads whose latest message is newer than `since` (ms), oldest first.
pub fn new_mail(conn: &Connection, since: i64) -> Result<Vec<NewMail>> {
    let mut out: Vec<NewMail> = threads(conn, Some("INBOX"))?
        .into_iter()
        .filter(|t| t.unread && t.date > since)
        .map(|t| NewMail {
            sender: t.sender,
            subject: t.subject,
            date: t.date,
            primary: t.primary,
        })
        .collect();
    out.reverse();
    Ok(out)
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
           AND NOT EXISTS(SELECT 1 FROM thread_labels x WHERE x.thread_id = t.id AND x.label_id IN ('TRASH', 'SPAM'))
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
    id: String,
    sender: String,
    recipients: String,
    cc: String,
    date: i64,
    subject: String,
    message_id: String,
    refs: String,
    pub html: Option<String>,
    text: Option<String>,
    pub attachments: Vec<AttachmentRow>,
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
        "SELECT id, sender, recipients, cc, date, subject, message_id, refs, html, text
         FROM messages WHERE thread_id = ?1 ORDER BY date",
    )?;
    let rows = st.query_map([thread], |r| {
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
            attachments: Vec::new(),
        })
    })?;
    let mut out: Vec<MessageRow> = rows.collect::<Result<_, _>>()?;
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
