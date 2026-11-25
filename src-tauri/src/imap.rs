//! Accounts on any IMAP + SMTP server, signed in with a password. Each message is fetched whole and turned into the
//! Gmail API's message shape (`to_gmail`), so the cache, the reader and every list work on it unchanged. Folders
//! stand in for labels: Inbox, Sent, Drafts, Trash and Junk map to Gmail's system labels, other folders show as
//! user labels, and Seen / Flagged become UNREAD / STARRED.

use crate::{Account, db, gmail};
use anyhow::{Context, Result, bail};
use async_imap::imap_proto::{Response, ResponseCode, rfc4315::UidSetMember};
use async_imap::types::{Fetch, Flag, NameAttribute, UnsolicitedResponse};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures::TryStreamExt;
use mail_parser::{AddressList, MessageParser, MessagePart, PartKind};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::{TlsConnector, client::TlsStream};

/// How to reach an account's servers. Port 993 / 465 speak TLS from the start; 587 upgrades with STARTTLS.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub user: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
}

pub type Session = async_imap::Session<TlsStream<TcpStream>>;

/// Newest messages fetched per folder the first time it syncs.
// shortcut: older mail isn't reachable on IMAP accounts (no `load_more`), add a backwards page fetch when asked for.
const WINDOW: usize = 200;
const TIMEOUT: Duration = Duration::from_secs(20);

fn tls() -> Result<TlsConnector> {
    use rustls_platform_verifier::BuilderVerifierExt;
    let config = tokio_rustls::rustls::ClientConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::aws_lc_rs::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_platform_verifier()?
    .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

async fn tls_stream(host: &str, port: u16) -> Result<TlsStream<TcpStream>> {
    let tcp = tokio::time::timeout(TIMEOUT, TcpStream::connect((host, port)))
        .await
        .with_context(|| format!("{host} didn't answer"))?
        .with_context(|| format!("Couldn't reach {host}:{port}"))?;
    let name = tokio_rustls::rustls::pki_types::ServerName::try_from(host.to_string())?;
    tokio::time::timeout(TIMEOUT, tls()?.connect(name, tcp))
        .await
        .with_context(|| format!("{host} didn't answer"))?
        .with_context(|| format!("Couldn't open a secure connection to {host}:{port}"))
}

pub async fn connect(cfg: &Config, password: &str) -> Result<Session> {
    let mut client = async_imap::Client::new(tls_stream(&cfg.imap_host, cfg.imap_port).await?);
    client
        .read_response()
        .await?
        .context("The mail server closed the connection")?;
    client
        .login(&cfg.user, password)
        .await
        .map_err(|(e, _)| anyhow::Error::new(e))
        .with_context(|| format!("{} refused the email address or password", cfg.imap_host))
}

/// Sends one message over SMTP to `to` (every recipient, Bcc included).
pub async fn send(
    cfg: &Config,
    password: &str,
    from: &str,
    to: &[String],
    raw: &[u8],
) -> Result<()> {
    let message = mail_send::smtp::message::Message::new(from, to.iter().map(String::as_str), raw);
    smtp(cfg, password)?
        .connect()
        .await
        .with_context(|| format!("Couldn't sign in to {}", cfg.smtp_host))?
        .send(message)
        .await
        .with_context(|| format!("{} didn't take the email", cfg.smtp_host))?;
    Ok(())
}

fn smtp(cfg: &Config, password: &str) -> Result<mail_send::SmtpClientBuilder<String>> {
    Ok(mail_send::SmtpClientBuilder::new_with_tls_connector(
        cfg.smtp_host.clone(),
        cfg.smtp_port,
        tls()?,
    )
    .implicit_tls(cfg.smtp_port == 465)
    .credentials((cfg.user.clone(), password.to_string()))
    .timeout(TIMEOUT))
}

/// Signs in to both servers, so a wrong password or server is reported while the user is still in the form.
pub async fn check(cfg: &Config, password: &str) -> Result<()> {
    let mut s = connect(cfg, password).await?;
    let _ = s.logout().await;
    smtp(cfg, password)?
        .connect()
        .await
        .with_context(|| format!("{} refused the email address or password", cfg.smtp_host))?;
    Ok(())
}

/// Server settings for an address: known providers by domain, otherwise `imap.<domain>` or `mail.<domain>`,
/// whichever answers over TLS.
pub async fn guess(email: &str) -> Result<Config> {
    let domain = email
        .rsplit_once('@')
        .map(|(_, d)| d.trim().to_lowercase())
        .filter(|d| d.contains('.'))
        .context("That doesn't look like an email address")?;
    let preset = |imap: &str, smtp: &str, smtp_port| Config {
        user: email.to_string(),
        imap_host: imap.into(),
        imap_port: 993,
        smtp_host: smtp.into(),
        smtp_port,
    };
    match domain.as_str() {
        "gmail.com" | "googlemail.com" => {
            bail!("Gmail addresses sign in with Google: choose \"Sign in with Google\" instead")
        }
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => {
            bail!("Outlook accounts need Microsoft sign-in, which Shift doesn't support yet")
        }
        "icloud.com" | "me.com" | "mac.com" => {
            Ok(preset("imap.mail.me.com", "smtp.mail.me.com", 587))
        }
        "fastmail.com" | "fastmail.fm" => Ok(preset("imap.fastmail.com", "smtp.fastmail.com", 465)),
        "yahoo.com" | "ymail.com" => Ok(preset("imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465)),
        "aol.com" => Ok(preset("imap.aol.com", "smtp.aol.com", 465)),
        "zoho.com" => Ok(preset("imap.zoho.com", "smtp.zoho.com", 465)),
        _ => {
            for host in [format!("imap.{domain}"), format!("mail.{domain}")] {
                if tls_stream(&host, 993).await.is_ok() {
                    let smtp_port = if tls_stream(&host, 465).await.is_ok() {
                        465
                    } else {
                        587
                    };
                    return Ok(preset(&host, &host, smtp_port));
                }
            }
            bail!("Couldn't find the mail server for {domain}: enter it below")
        }
    }
}

/// A folder synced as a label.
#[derive(Debug, PartialEq)]
pub struct Folder {
    pub name: String,
    /// INBOX, SENT, DRAFT, TRASH, SPAM or ARCHIVE for special folders, otherwise the folder's own name.
    pub label: String,
    /// What the sidebar shows: the path without a leading `INBOX.`, levels joined by `/` like Gmail's nested labels.
    pub display: String,
}

const SYSTEM: [&str; 6] = ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "ARCHIVE"];

/// Special-use attributes first, then the usual English names for servers without them.
fn special(name: &str, delimiter: Option<&str>, attrs: &[NameAttribute]) -> Option<&'static str> {
    if name.eq_ignore_ascii_case("INBOX") {
        return Some("INBOX");
    }
    for a in attrs {
        match a {
            NameAttribute::Sent => return Some("SENT"),
            NameAttribute::Drafts => return Some("DRAFT"),
            NameAttribute::Trash => return Some("TRASH"),
            NameAttribute::Junk => return Some("SPAM"),
            NameAttribute::Archive => return Some("ARCHIVE"),
            _ => {}
        }
    }
    let leaf = delimiter
        .and_then(|d| name.rsplit(d).next())
        .unwrap_or(name)
        .to_lowercase();
    match leaf.as_str() {
        "sent" | "sent items" | "sent messages" | "sent mail" => Some("SENT"),
        "drafts" | "draft" => Some("DRAFT"),
        "trash" | "deleted items" | "deleted messages" | "bin" => Some("TRASH"),
        "junk" | "spam" | "junk e-mail" | "junk email" | "bulk mail" => Some("SPAM"),
        "archive" | "archives" => Some("ARCHIVE"),
        _ => None,
    }
}

fn display(name: &str, delimiter: Option<&str>) -> String {
    let Some(d) = delimiter.filter(|d| !d.is_empty()) else {
        return name.to_string();
    };
    let inner = name
        .get(..6)
        .filter(|p| p.eq_ignore_ascii_case(&format!("INBOX{d}")))
        .map_or(name, |p| &name[p.len()..]);
    inner.replace(d, "/")
}

/// Selectable folders, each special label claimed once (special-use attributes win over names).
pub async fn folders(s: &mut Session) -> Result<Vec<Folder>> {
    let names: Vec<_> = s.list(Some(""), Some("*")).await?.try_collect().await?;
    let mut by_attr = Vec::new();
    for n in &names {
        let attrs = n.attributes();
        let skip = attrs.iter().any(|a| {
            matches!(
                a,
                NameAttribute::NoSelect | NameAttribute::All | NameAttribute::Flagged
            ) || matches!(a, NameAttribute::Extension(e) if e.eq_ignore_ascii_case("\\NonExistent"))
        });
        if !skip {
            let has_use = attrs.iter().any(|a| {
                matches!(
                    a,
                    NameAttribute::Sent
                        | NameAttribute::Drafts
                        | NameAttribute::Trash
                        | NameAttribute::Junk
                        | NameAttribute::Archive
                )
            });
            by_attr.push((!has_use, n.name(), n.delimiter(), attrs));
        }
    }
    by_attr.sort_by_key(|(named_only, ..)| *named_only);
    let mut taken = HashSet::new();
    let mut out: Vec<Folder> = by_attr
        .into_iter()
        .map(|(_, name, delimiter, attrs)| {
            let label = special(name, delimiter, attrs)
                .filter(|l| taken.insert(*l))
                .map_or_else(|| name.to_string(), String::from);
            Folder {
                name: name.to_string(),
                display: display(name, delimiter),
                label,
            }
        })
        .collect();
    // Inbox first: it's the list most people look at, so it fills first.
    out.sort_by_key(|f| {
        SYSTEM
            .iter()
            .position(|l| *l == f.label)
            .unwrap_or(SYSTEM.len())
    });
    Ok(out)
}

fn flag_text(f: &Fetch) -> String {
    let mut flags: Vec<String> = f
        .flags()
        .filter_map(|f| match f {
            Flag::Seen => Some("\\Seen".into()),
            Flag::Flagged => Some("\\Flagged".into()),
            Flag::Answered => Some("\\Answered".into()),
            Flag::Draft => Some("\\Draft".into()),
            Flag::Deleted => Some("\\Deleted".into()),
            Flag::Custom(c) => Some(c.into_owned()),
            _ => None,
        })
        .collect();
    flags.sort();
    flags.join(" ")
}

fn hash_id(prefix: &str, key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..10].iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}{hex}")
}

/// Brings every folder up to date. Returns whether anything changed.
pub async fn sync(a: &Account, cfg: &Config, password: &str) -> Result<bool> {
    let mut s = connect(cfg, password).await?;
    {
        let _order = a.changes.lock().await;
        replay(&mut s, a).await?;
    }
    let mut folders = folders(&mut s).await?;
    let mut touched: BTreeSet<String> = save_labels(&mut a.db(), &mut folders)?
        .into_iter()
        .collect();
    for f in &folders {
        if let Err(e) = sync_folder(&mut s, a, f, &mut touched).await {
            // One folder the server won't open (a shared or broken one) mustn't stop the others.
            eprintln!("{} folder {}: {e:#}", a.email, f.name);
        }
    }
    let _ = s.logout().await;
    rebuild(&mut a.db(), &touched)?;
    Ok(!touched.is_empty())
}

/// Records the server's folders as labels. A user folder keeps the label id it was first given, so renaming it in
/// Shift doesn't change the id conversations carry. Returns the messages of folders that no longer exist.
fn save_labels(c: &mut Connection, folders: &mut [Folder]) -> Result<Vec<String>> {
    let colors: HashMap<String, String> = db::labels(c)?
        .into_iter()
        .filter_map(|l| Some((l.id, l.color?)))
        .collect();
    let known: HashMap<String, String> = {
        let mut st = c.prepare("SELECT name, label FROM imap_folders")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?
    };
    for f in folders.iter_mut() {
        if let Some(old) = known.get(&f.name)
            && !SYSTEM.contains(&f.label.as_str())
            && !SYSTEM.contains(&old.as_str())
        {
            f.label.clone_from(old);
        }
    }
    let labels: Vec<gmail::Label> = folders
        .iter()
        .filter(|f| f.label != "ARCHIVE")
        .map(|f| {
            let system = SYSTEM.contains(&f.label.as_str());
            gmail::Label {
                id: f.label.clone(),
                name: if system {
                    f.label.clone()
                } else {
                    f.display.clone()
                },
                kind: if system { "system" } else { "user" }.into(),
                color: colors.get(&f.label).map(|c| gmail::LabelColor {
                    background: c.clone(),
                }),
            }
        })
        .collect();
    db::replace_labels(c, &labels)?;
    let mut gone = Vec::new();
    for name in known.keys() {
        if !folders.iter().any(|f| f.name == *name) {
            gone.extend(forget_folder(c, name)?);
            c.execute("DELETE FROM imap_folders WHERE name = ?1", [name])?;
        }
    }
    let tx = c.transaction()?;
    for f in folders.iter() {
        tx.execute(
            "INSERT INTO imap_folders (name, label, validity, next) VALUES (?1, ?2, 0, 0)
             ON CONFLICT(name) DO UPDATE SET label = excluded.label",
            params![f.name, f.label],
        )?;
    }
    tx.commit()?;
    Ok(gone)
}

/// Makes a folder for a new label: nested under INBOX on servers that keep folders there.
pub async fn create_folder(s: &mut Session, a: &Account, name: &str) -> Result<String> {
    let nested: bool = a.db().query_row(
        "SELECT EXISTS(SELECT 1 FROM imap_folders WHERE name LIKE 'INBOX.%')",
        [],
        |r| r.get(0),
    )?;
    let folder = if nested {
        format!("INBOX.{}", name.replace('/', "."))
    } else {
        name.to_string()
    };
    s.create(&folder).await?;
    a.db().execute(
        "INSERT INTO imap_folders (name, label, validity, next) VALUES (?1, ?1, 0, 0)",
        [&folder],
    )?;
    Ok(folder)
}

/// Renames a label's folder; the label keeps its id.
pub async fn rename_folder(s: &mut Session, a: &Account, label: &str, name: &str) -> Result<()> {
    let old = folder_for(&a.db(), label)?.context("That label's folder is gone")?;
    let new = match old.rsplit_once('.') {
        Some((parent, _)) if old.starts_with("INBOX.") => {
            format!("{parent}.{}", name.replace('/', "."))
        }
        _ => name.to_string(),
    };
    s.rename(&old, &new).await?;
    let c = a.db();
    c.execute(
        "UPDATE imap_folders SET name = ?2 WHERE name = ?1",
        [&old, &new],
    )?;
    c.execute(
        "UPDATE imap_uids SET folder = ?2 WHERE folder = ?1",
        [&old, &new],
    )?;
    Ok(())
}

/// Deletes a label's folder. Its mail moves to Archive first, as deleting a Gmail label keeps the mail.
pub async fn delete_folder(s: &mut Session, a: &Account, label: &str) -> Result<()> {
    let Some(folder) = folder_for(&a.db(), label)? else {
        return Ok(());
    };
    if s.select(&folder).await?.exists > 0 {
        let archive = archive_folder(s, a).await?;
        s.uid_mv("1:*", &archive).await?;
    }
    s.close().await?;
    s.delete(&folder).await?;
    let mut c = a.db();
    let moved = forget_folder(&c, &folder)?.into_iter().collect();
    c.execute("DELETE FROM imap_folders WHERE name = ?1", [&folder])?;
    rebuild(&mut c, &moved)
}

async fn sync_folder(
    s: &mut Session,
    a: &Account,
    f: &Folder,
    touched: &mut BTreeSet<String>,
) -> Result<()> {
    let mb = s.select(&f.name).await?;
    let validity = mb.uid_validity.unwrap_or(0);
    let next = {
        let c = a.db();
        let (was, next): (u32, u32) = c
            .query_row(
                "SELECT validity, next FROM imap_folders WHERE name = ?1",
                [&f.name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .unwrap_or((0, 0));
        if was != validity || next == 0 {
            // A new UIDVALIDITY means the server renumbered the folder: what we knew of it no longer applies.
            touched.extend(forget_folder(&c, &f.name)?);
            None
        } else {
            Some(next)
        }
    };

    let known = known_uids(&a.db(), &f.name)?;
    if let Some(min) = known.keys().min() {
        let fetched: Vec<Fetch> = s
            .uid_fetch(format!("{min}:*"), "(UID FLAGS)")
            .await?
            .try_collect()
            .await?;
        let mut present = HashSet::new();
        let c = a.db();
        for m in &fetched {
            let Some(uid) = m.uid else { continue };
            present.insert(uid);
            if let Some((id, old)) = known.get(&uid) {
                let flags = flag_text(m);
                if flags != *old {
                    c.execute(
                        "UPDATE imap_uids SET flags = ?3 WHERE folder = ?1 AND uid = ?2",
                        params![f.name, uid, flags],
                    )?;
                    touched.insert(id.clone());
                }
            }
        }
        for (uid, (id, _)) in &known {
            if !present.contains(uid) {
                c.execute(
                    "DELETE FROM imap_uids WHERE folder = ?1 AND uid = ?2",
                    params![f.name, uid],
                )?;
                touched.insert(id.clone());
            }
        }
    }

    let mut new: Vec<u32> = match next {
        Some(n) if mb.uid_next.is_some_and(|u| u <= n) => Vec::new(),
        Some(n) => s
            .uid_search(format!("UID {n}:*"))
            .await?
            .into_iter()
            .filter(|u| *u >= n && !known.contains_key(u))
            .collect(),
        None => {
            let mut all: Vec<u32> = s.uid_search("ALL").await?.into_iter().collect();
            all.sort_unstable();
            all.split_off(all.len().saturating_sub(WINDOW))
        }
    };
    new.sort_unstable();
    for chunk in new.chunks(25) {
        let set = chunk
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let fetched: Vec<Fetch> = s
            .uid_fetch(set, "(UID FLAGS INTERNALDATE BODY.PEEK[])")
            .await?
            .try_collect()
            .await?;
        let c = a.db();
        for m in &fetched {
            let (Some(uid), Some(raw)) = (m.uid, m.body()) else {
                continue;
            };
            let date = m.internal_date().map(|d| d.timestamp_millis());
            let key = format!("{}/{validity}/{uid}", f.name);
            touched.insert(store(&c, &f.name, uid, &flag_text(m), raw, date, &key)?);
        }
    }
    // Copies moved here by `apply` now have their real UIDs.
    {
        let c = a.db();
        let mut st =
            c.prepare("DELETE FROM imap_uids WHERE folder = ?1 AND uid <= 0 RETURNING id")?;
        let moved = st.query_map([&f.name], |r| r.get::<_, String>(0))?;
        for id in moved {
            touched.insert(id?);
        }
    }
    let uid_next = mb
        .uid_next
        .or_else(|| new.last().map(|u| u + 1))
        .or(next)
        .unwrap_or(1);
    a.db().execute(
        "UPDATE imap_folders SET validity = ?2, next = ?3 WHERE name = ?1",
        params![f.name, validity, uid_next],
    )?;
    Ok(())
}

fn known_uids(c: &Connection, folder: &str) -> Result<HashMap<u32, (String, String)>> {
    let mut st = c.prepare("SELECT uid, id, flags FROM imap_uids WHERE folder = ?1 AND uid > 0")?;
    let rows = st.query_map([folder], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn forget_folder(c: &Connection, folder: &str) -> Result<Vec<String>> {
    let ids: Vec<String> = {
        let mut st = c.prepare("SELECT id FROM imap_uids WHERE folder = ?1")?;
        st.query_map([folder], |r| r.get(0))?
            .collect::<Result<_, _>>()?
    };
    c.execute("DELETE FROM imap_uids WHERE folder = ?1", [folder])?;
    Ok(ids)
}

/// `<id>` for every Message-ID-like item, the form Gmail's headers carry and `messages.message_id` stores.
fn bracketed(ids: impl Iterator<Item = impl AsRef<str>>) -> Vec<String> {
    ids.map(|i| format!("<{}>", i.as_ref().trim().trim_matches(['<', '>'])))
        .collect()
}

/// Records one copy of a message (`folder`/`uid`), storing the message itself the first time it's seen. The same
/// message in two folders (a note to self in Inbox and Sent) is one message with both labels, as in Gmail.
fn store(
    c: &Connection,
    folder: &str,
    uid: u32,
    flags: &str,
    raw: &[u8],
    internal_date: Option<i64>,
    fallback_key: &str,
) -> Result<String> {
    let parsed = MessageParser::default()
        .parse(raw)
        .context("Couldn't read a message")?;
    let m = parsed.root();
    let msgid = bracketed(m.message_id().into_iter()).pop();
    let id = hash_id("m", msgid.as_deref().unwrap_or(fallback_key));
    let exists: bool = c.query_row(
        "SELECT EXISTS(SELECT 1 FROM imap_messages WHERE id = ?1)",
        [&id],
        |r| r.get(0),
    )?;
    if !exists {
        let mut refs = bracketed(m.references().iter().flat_map(mail_parser::TextList::iter));
        for r in bracketed(m.in_reply_to().iter().flat_map(mail_parser::TextList::iter)) {
            if !refs.contains(&r) {
                refs.push(r);
            }
        }
        let thread = thread_for(c, msgid.as_deref(), &refs, &id)?;
        let date = m
            .date()
            .map(|d| d.to_timestamp() * 1000)
            .or(internal_date)
            .unwrap_or_else(crate::now_ms);
        c.execute(
            "INSERT INTO imap_messages (id, thread_id, msgid, refs, date, raw) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, thread, msgid.unwrap_or_default(), refs.join(" "), date, raw],
        )?;
    }
    c.execute(
        "INSERT OR REPLACE INTO imap_uids (folder, uid, id, flags) VALUES (?1, ?2, ?3, ?4)",
        params![folder, uid, id, flags],
    )?;
    Ok(id)
}

/// The conversation a message joins: one holding a message it refers to, or one with a message that refers to it
/// (a reply can arrive before what it answers), otherwise a new one.
// shortcut: two conversations aren't merged when a later message links them, fine for ordinary reply chains.
fn thread_for(c: &Connection, msgid: Option<&str>, refs: &[String], id: &str) -> Result<String> {
    for r in refs.iter().rev() {
        let found: Option<String> = c
            .query_row(
                "SELECT thread_id FROM imap_messages WHERE msgid = ?1",
                [r],
                |row| row.get(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found.unwrap_or_default());
        }
    }
    if let Some(own) = msgid {
        let found: Option<String> = c
            .query_row(
                "SELECT thread_id FROM imap_messages WHERE instr(refs, ?1) > 0",
                [own],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(t) = found {
            return Ok(t);
        }
    }
    Ok(hash_id(
        "t",
        refs.first().map_or(msgid.unwrap_or(id), String::as_str),
    ))
}

/// Rebuilds the cached conversations holding these messages from their stored copies, dropping messages no folder
/// holds any more.
pub fn rebuild(c: &mut Connection, messages: &BTreeSet<String>) -> Result<()> {
    let mut threads = BTreeSet::new();
    for id in messages {
        let thread: Option<String> = c
            .query_row(
                "SELECT thread_id FROM imap_messages WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        threads.extend(thread);
        c.execute(
            "DELETE FROM imap_messages WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM imap_uids WHERE id = ?1)",
            [id],
        )?;
    }
    for t in threads {
        // Its queued changes haven't reached the server yet; the server's copy would undo them on screen.
        if db::has_pending(c, &t) {
            continue;
        }
        let thread = load_thread(c, &t)?;
        db::upsert_thread(c, &thread, true)?;
    }
    Ok(())
}

fn load_thread(c: &Connection, thread: &str) -> Result<gmail::Thread> {
    let mut st = c.prepare(
        "SELECT m.id, m.date, m.raw,
           (SELECT group_concat(f.label || ' ' || u.flags, char(10))
            FROM imap_uids u JOIN imap_folders f ON f.name = u.folder WHERE u.id = m.id)
         FROM imap_messages m WHERE m.thread_id = ?1 ORDER BY m.date",
    )?;
    let rows = st.query_map([thread], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Vec<u8>>(2)?,
            r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        ))
    })?;
    let mut messages = Vec::new();
    for row in rows {
        let (id, date, raw, copies) = row?;
        let copies: Vec<(&str, &str)> = copies
            .lines()
            .map(|l| l.split_once(' ').unwrap_or((l, "")))
            .collect();
        if let Some(m) = to_gmail(&id, date, &raw, &labels(&copies)) {
            messages.push(m);
        }
    }
    Ok(gmail::Thread {
        id: thread.to_string(),
        messages,
    })
}

/// Gmail-style labels for a message from its copies: (folder label, flags) pairs.
fn labels(copies: &[(&str, &str)]) -> Vec<String> {
    let has = |flag: &str| copies.iter().any(|(_, f)| f.split(' ').any(|x| x == flag));
    let mut out: Vec<String> = copies
        .iter()
        .map(|(l, _)| l.to_string())
        .filter(|l| l != "ARCHIVE")
        .collect();
    if !has("\\Seen") {
        out.push("UNREAD".into());
    }
    if has("\\Flagged") {
        out.push("STARRED".into());
    }
    out.sort();
    out.dedup();
    out
}

fn header(name: &str, value: impl Into<String>) -> gmail::Header {
    gmail::Header {
        name: name.into(),
        value: value.into(),
    }
}

/// `Name <address>` entries joined by commas, names quoted when they hold a separator.
fn address_text(list: Option<AddressList>) -> String {
    let Some(list) = list else {
        return String::new();
    };
    list.mailboxes()
        .filter_map(
            |m| match (m.name().filter(|n| !n.is_empty()), m.address()) {
                (Some(n), Some(a)) if n.contains([',', ';', '"', '<', '>', '@', ':']) => {
                    Some(format!("\"{}\" <{a}>", n.replace('"', "\\\"")))
                }
                (Some(n), Some(a)) => Some(format!("{n} <{a}>")),
                (None, Some(a)) => Some(a.to_string()),
                (Some(n), None) => Some(n.to_string()),
                (None, None) => None,
            },
        )
        .collect::<Vec<_>>()
        .join(", ")
}

/// One raw message in the shape `gmail::Message` takes from Gmail's API, so `db::upsert_thread` can store it.
pub fn to_gmail(id: &str, date: i64, raw: &[u8], labels: &[String]) -> Option<gmail::Message> {
    let parsed = MessageParser::default().parse(raw)?;
    let m = parsed.root();
    let mut payload = part(&m.root_part());
    let mut headers = vec![
        header("From", address_text(m.from())),
        header("To", address_text(m.to())),
        header("Cc", address_text(m.cc())),
        header("Bcc", address_text(m.bcc())),
        header("Reply-To", address_text(m.reply_to())),
        header("Subject", m.subject().unwrap_or_default()),
        header(
            "Message-ID",
            bracketed(m.message_id().into_iter())
                .pop()
                .unwrap_or_default(),
        ),
        header(
            "References",
            bracketed(m.references().iter().flat_map(mail_parser::TextList::iter)).join(" "),
        ),
        header(
            "In-Reply-To",
            bracketed(m.in_reply_to().iter().flat_map(mail_parser::TextList::iter)).join(" "),
        ),
    ];
    headers.append(&mut payload.headers);
    payload.headers = headers;
    Some(gmail::Message {
        id: id.to_string(),
        label_ids: labels.to_vec(),
        snippet: m.body_preview(200).unwrap_or_default().trim().to_string(),
        internal_date: date.to_string(),
        payload: Some(payload),
    })
}

fn mime_type(p: &MessagePart) -> String {
    p.content_type()
        .map(|c| format!("{}/{}", c.ctype(), c.subtype().unwrap_or("plain")))
        .unwrap_or_else(|| "text/plain".into())
        .to_lowercase()
}

fn data(bytes: &[u8]) -> Option<gmail::Body> {
    Some(gmail::Body {
        data: Some(URL_SAFE_NO_PAD.encode(bytes)),
        attachment_id: None,
        size: bytes.len() as i64,
    })
}

fn part(p: &MessagePart) -> gmail::Part {
    let mut mime = mime_type(p);
    let mut out = gmail::Part {
        filename: p.attachment_name().unwrap_or_default().to_string(),
        ..Default::default()
    };
    if let Some(cid) = p.content_id() {
        out.headers.push(header("Content-ID", format!("<{cid}>")));
    }
    match p.kind() {
        PartKind::Multipart => out.parts = p.children().map(|c| part(&c)).collect(),
        PartKind::Message(_) => {
            mime = "message/rfc822".into();
            if out.filename.is_empty() {
                out.filename = "message.eml".into();
            }
            out.body = data(&p.decoded());
        }
        PartKind::Text | PartKind::Html => {
            // Already decoded from its charset, so the copy we hand on is UTF-8 whatever the original said.
            out.headers
                .push(header("Content-Type", format!("{mime}; charset=utf-8")));
            out.body = data(p.text().unwrap_or_default().as_bytes());
        }
        _ => out.body = data(&p.decoded()),
    }
    out.mime_type = mime;
    out
}

/// Whether a failed call may work later as is: the network or the server going away, not a command it refused.
pub fn is_transient(e: &anyhow::Error) -> bool {
    use async_imap::error::Error;
    !e.chain().any(|c| {
        matches!(
            c.downcast_ref::<Error>(),
            Some(Error::No(_) | Error::Bad(_) | Error::Validate(_))
        )
    }) && !e
        .to_string()
        .contains("refused the email address or password")
}

/// One copy of a message on the server.
struct Copy {
    folder: String,
    uid: u32,
    label: String,
}

fn copies(c: &Connection, thread: &str) -> Result<Vec<Copy>> {
    let mut st = c.prepare(
        "SELECT u.folder, u.uid, f.label FROM imap_uids u
         JOIN imap_messages m ON m.id = u.id JOIN imap_folders f ON f.name = u.folder
         WHERE m.thread_id = ?1 AND u.uid > 0",
    )?;
    let rows = st.query_map([thread], |r| {
        Ok(Copy {
            folder: r.get(0)?,
            uid: r.get(1)?,
            label: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn folder_for(c: &Connection, label: &str) -> Result<Option<String>> {
    Ok(c.query_row(
        "SELECT name FROM imap_folders WHERE label = ?1",
        [label],
        |r| r.get(0),
    )
    .optional()?)
}

/// The Archive folder, made the first time something is archived on a server that has none.
async fn archive_folder(s: &mut Session, a: &Account) -> Result<String> {
    if let Some(name) = folder_for(&a.db(), "ARCHIVE")? {
        return Ok(name);
    }
    let nested: bool = a.db().query_row(
        "SELECT EXISTS(SELECT 1 FROM imap_folders WHERE name LIKE 'INBOX.%')",
        [],
        |r| r.get(0),
    )?;
    let name = if nested { "INBOX.Archive" } else { "Archive" };
    // It may exist without the special-use attribute we look for; then creating it fails and that's fine.
    let _ = s.create(name).await;
    a.db().execute(
        "INSERT INTO imap_folders (name, label, validity, next) VALUES (?1, 'ARCHIVE', 0, 0)
         ON CONFLICT(name) DO UPDATE SET label = 'ARCHIVE'",
        [name],
    )?;
    Ok(name.to_string())
}

/// Where a copy goes for a change, by Gmail's label semantics: Trash and Spam take the whole conversation (Spam
/// leaves what I sent), adding a folder label moves it there, taking off the label it's in moves it to the Inbox
/// when that's being added, otherwise to Archive. Sent and Drafts copies stay put except for Trash.
fn destination(copy: &str, add: &[String], remove: &[String], trash: bool) -> Option<&'static str> {
    let adds = |l: &str| add.iter().any(|x| x == l);
    let removes = |l: &str| remove.iter().any(|x| x == l);
    let fixed = matches!(copy, "SENT" | "DRAFT");
    if trash || adds("TRASH") {
        return (copy != "TRASH" && copy != "DRAFT").then_some("TRASH");
    }
    if fixed {
        return None;
    }
    if adds("SPAM") {
        return (copy != "SPAM").then_some("SPAM");
    }
    if add
        .iter()
        .any(|l| !SYSTEM.contains(&l.as_str()) && !matches!(l.as_str(), "UNREAD" | "STARRED"))
    {
        return Some("LABEL");
    }
    if removes(copy) {
        return Some(if adds("INBOX") { "INBOX" } else { "ARCHIVE" });
    }
    (adds("INBOX") && copy != "INBOX").then_some("INBOX")
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

fn expand(set: &[UidSetMember]) -> impl Iterator<Item = u32> + '_ {
    set.iter().flat_map(|m| match m {
        UidSetMember::Uid(u) => *u..=*u,
        UidSetMember::UidRange(r) => r.clone(),
    })
}

/// Moves messages to `dest`; returns their new UIDs there when the server says (UIDPLUS's COPYUID).
async fn move_uids(s: &mut Session, uids: &[u32], dest: &str) -> Result<HashMap<u32, u32>> {
    while s.unsolicited_responses.try_recv().is_ok() {}
    s.uid_mv(uid_set(uids), dest).await?;
    let mut moved = HashMap::new();
    while let Ok(r) = s.unsolicited_responses.try_recv() {
        if let UnsolicitedResponse::Other(data) = r
            && let Response::Data { outcome, .. } = data.parsed()
            && let Some(ResponseCode::CopyUid(_, from, to)) = &outcome.code
        {
            moved.extend(expand(from).zip(expand(to)));
        }
    }
    Ok(moved)
}

/// Makes one label change to a conversation on the server: flags on every copy, then copies moved between folders.
/// A moved copy keeps a placeholder row in its new folder until the next sync learns its new UID there.
pub async fn apply(
    s: &mut Session,
    a: &Account,
    thread: &str,
    add: &[String],
    remove: &[String],
    trash: bool,
) -> Result<()> {
    let copies = copies(&a.db(), thread)?;
    let mut flags = Vec::new();
    let has = |list: &[String], l: &str| list.iter().any(|x| x == l);
    if has(remove, "UNREAD") {
        flags.push("+FLAGS.SILENT (\\Seen)");
    }
    if has(add, "UNREAD") {
        flags.push("-FLAGS.SILENT (\\Seen)");
    }
    if has(add, "STARRED") {
        flags.push("+FLAGS.SILENT (\\Flagged)");
    }
    if has(remove, "STARRED") {
        flags.push("-FLAGS.SILENT (\\Flagged)");
    }
    let label_target = add
        .iter()
        .find(|l| !SYSTEM.contains(&l.as_str()) && !matches!(l.as_str(), "UNREAD" | "STARRED"));
    let mut by_folder: HashMap<&str, Vec<&Copy>> = HashMap::new();
    for c in &copies {
        by_folder.entry(&c.folder).or_default().push(c);
    }
    for (folder, list) in by_folder {
        s.select(folder).await?;
        let all: Vec<u32> = list.iter().map(|c| c.uid).collect();
        for op in &flags {
            s.uid_store(uid_set(&all), op)
                .await?
                .try_collect::<Vec<_>>()
                .await?;
        }
        let label = &list[0].label;
        let dest = match destination(label, add, remove, trash) {
            Some("ARCHIVE") => Some(archive_folder(s, a).await?),
            Some("LABEL") => label_target.filter(|l| *l != label).cloned(),
            Some(l) => folder_for(&a.db(), l)?,
            None => None,
        };
        if let Some(dest) = dest.filter(|d| d != folder) {
            let moved = move_uids(s, &all, &dest).await?;
            let c = a.db();
            for uid in &all {
                match moved.get(uid) {
                    Some(new) => c.execute(
                        "UPDATE imap_uids SET folder = ?3, uid = ?4 WHERE folder = ?1 AND uid = ?2",
                        params![folder, uid, dest, new],
                    )?,
                    None => c.execute(
                        "UPDATE imap_uids SET folder = ?3,
                           uid = (SELECT coalesce(min(uid), 0) - 1 FROM imap_uids WHERE uid <= 0)
                         WHERE folder = ?1 AND uid = ?2",
                        params![folder, uid, dest],
                    )?,
                };
            }
        }
    }
    Ok(())
}

/// Deletes a conversation's trashed copies for good (Delete inside Trash).
pub async fn delete_trashed(s: &mut Session, a: &Account, thread: &str) -> Result<()> {
    let Some(trash) = folder_for(&a.db(), "TRASH")? else {
        return Ok(());
    };
    let uids: Vec<u32> = copies(&a.db(), thread)?
        .into_iter()
        .filter(|c| c.folder == trash)
        .map(|c| c.uid)
        .collect();
    if uids.is_empty() {
        return Ok(());
    }
    s.select(&trash).await?;
    s.uid_store(uid_set(&uids), "+FLAGS.SILENT (\\Deleted)")
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    s.uid_expunge(uid_set(&uids))
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let mut c = a.db();
    let mut gone = BTreeSet::new();
    for uid in uids {
        gone.extend(
            c.query_row(
                "DELETE FROM imap_uids WHERE folder = ?1 AND uid = ?2 RETURNING id",
                params![trash, uid],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
        );
    }
    rebuild(&mut c, &gone)
}

/// Deletes everything in Trash or Spam for good.
pub async fn empty(s: &mut Session, a: &Account, label: &str) -> Result<()> {
    let Some(folder) = folder_for(&a.db(), label)? else {
        return Ok(());
    };
    if s.select(&folder).await?.exists > 0 {
        s.uid_store("1:*", "+FLAGS.SILENT (\\Deleted)")
            .await?
            .try_collect::<Vec<_>>()
            .await?;
        s.expunge().await?.try_collect::<Vec<_>>().await?;
    }
    let mut c = a.db();
    let gone = forget_folder(&c, &folder)?.into_iter().collect();
    rebuild(&mut c, &gone)
}

/// Marks everything read in one list: a folder label, Archive, or (None) every folder but Trash and Spam.
pub async fn mark_read(s: &mut Session, a: &Account, label: Option<&str>) -> Result<()> {
    let folders: Vec<String> = {
        let c = a.db();
        let mut st = c.prepare(
            "SELECT name FROM imap_folders WHERE (?1 IS NULL AND label NOT IN ('TRASH', 'SPAM')) OR label = ?1",
        )?;
        st.query_map([label], |r| r.get(0))?
            .collect::<Result<_, _>>()?
    };
    for f in folders {
        if s.select(&f).await?.exists > 0 {
            s.uid_store("1:*", "+FLAGS.SILENT (\\Seen)")
                .await?
                .try_collect::<Vec<_>>()
                .await?;
        }
    }
    Ok(())
}

/// The message without its Bcc header, for SMTP: unlike Gmail, an SMTP server passes headers on as they are, so
/// every recipient would see who was Bcc'd.
pub fn without_bcc(raw: &[u8]) -> Vec<u8> {
    let end = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map_or(raw.len(), |i| i + 2);
    let (head, body) = raw.split_at(end);
    let mut out = Vec::with_capacity(raw.len());
    let mut skipping = false;
    for line in head.split_inclusive(|b| *b == b'\n') {
        let folded = line.first().is_some_and(|b| *b == b' ' || *b == b'\t');
        if !folded {
            skipping = line.len() >= 4 && line[..4].eq_ignore_ascii_case(b"bcc:");
        }
        if !skipping {
            out.extend_from_slice(line);
        }
    }
    out.extend_from_slice(body);
    out
}

/// A built message's Message-ID, which stands in for a draft id on IMAP accounts.
pub fn message_id(raw: &[u8]) -> Option<String> {
    let parsed = MessageParser::default().parse(raw)?;
    bracketed(parsed.root().message_id().into_iter()).pop()
}

/// Files a message in a special folder (Sent, Drafts) with the given flags, e.g. `(\Seen)`.
pub async fn append(
    s: &mut Session,
    a: &Account,
    label: &str,
    flags: &str,
    raw: &[u8],
) -> Result<()> {
    let Some(folder) = folder_for(&a.db(), label)? else {
        return Ok(());
    };
    s.append(&folder, Some(flags), None, raw).await?;
    Ok(())
}

/// Deletes the copies of one message (by Message-ID) from a special folder, e.g. a draft that was sent or replaced.
pub async fn remove_by_msgid(s: &mut Session, a: &Account, label: &str, msgid: &str) -> Result<()> {
    let Some(folder) = folder_for(&a.db(), label)? else {
        return Ok(());
    };
    if msgid.contains(['"', '\\', '\r', '\n']) {
        bail!("Not a Message-ID: {msgid}");
    }
    s.select(&folder).await?;
    let uids: Vec<u32> = s
        .uid_search(format!("HEADER Message-ID \"{msgid}\""))
        .await?
        .into_iter()
        .collect();
    if uids.is_empty() {
        return Ok(());
    }
    s.uid_store(uid_set(&uids), "+FLAGS.SILENT (\\Deleted)")
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    s.uid_expunge(uid_set(&uids))
        .await?
        .try_collect::<Vec<_>>()
        .await?;
    let mut c = a.db();
    let mut gone = BTreeSet::new();
    for uid in uids {
        gone.extend(
            c.query_row(
                "DELETE FROM imap_uids WHERE folder = ?1 AND uid = ?2 RETURNING id",
                params![folder, uid],
                |r| r.get::<_, String>(0),
            )
            .optional()?,
        );
    }
    rebuild(&mut c, &gone)
}

/// The newest draft in a conversation: its Message-ID (the draft id), message id and Bcc.
pub fn draft_in(c: &Connection, thread: &str) -> Result<Option<(String, String, String)>> {
    let row: Option<(String, String, Vec<u8>)> = c
        .query_row(
            "SELECT m.msgid, m.id, m.raw FROM imap_messages m
             JOIN imap_uids u ON u.id = m.id JOIN imap_folders f ON f.name = u.folder
             WHERE m.thread_id = ?1 AND f.label = 'DRAFT' ORDER BY m.date DESC LIMIT 1",
            [thread],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row.map(|(msgid, id, raw)| {
        let bcc = MessageParser::default()
            .parse(&raw)
            .map(|p| address_text(p.root().bcc()))
            .unwrap_or_default();
        (msgid, id, bcc)
    }))
}

/// Rebuilds one conversation from what the server holds, undoing a local change it didn't take.
pub fn refresh_thread(c: &mut Connection, thread: &str) -> Result<()> {
    if db::has_pending(c, thread) {
        return Ok(());
    }
    let t = load_thread(c, thread)?;
    db::upsert_thread(c, &t, true)
}

/// Sends changes made while the server couldn't be reached, oldest first, on an open session. Stops at the first
/// one that still can't get through; one the server refuses is dropped and its conversation rebuilt.
async fn replay(s: &mut Session, a: &Account) -> Result<()> {
    let ops = db::pending_ops(&a.db())?;
    for op in ops {
        match apply(s, a, &op.thread, &op.add, &op.remove, op.trash).await {
            Ok(()) => db::done_pending(&a.db(), op.seq)?,
            Err(e) if is_transient(&e) => return Err(e),
            Err(e) => {
                eprintln!("{} change to {}: {e:#}", a.email, op.thread);
                db::done_pending(&a.db(), op.seq)?;
                refresh_thread(&mut a.db(), &op.thread)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let c = db::open(std::path::Path::new(":memory:")).expect("db");
        db::set_meta(&c, "email", "me@example.com").expect("meta");
        c
    }

    const FIRST: &[u8] = b"From: \"Ann, Smith\" <ann@example.com>\r\nTo: me@example.com\r\nSubject: =?utf-8?q?Caf=C3=A9?=\r\nMessage-ID: <1@example.com>\r\nDate: Sat, 20 Nov 2021 14:22:01 -0800\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9 tomorrow?\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Caf&eacute; tomorrow?</p>\r\n--b--\r\n";
    const REPLY: &[u8] = b"From: me@example.com\r\nTo: Ann <ann@example.com>\r\nSubject: Re: Cafe\r\nMessage-ID: <2@example.com>\r\nIn-Reply-To: <1@example.com>\r\nReferences: <1@example.com>\r\nDate: Sat, 20 Nov 2021 15:00:00 -0800\r\n\r\nYes!\r\n";

    #[test]
    fn a_raw_message_reads_like_a_gmail_one() {
        let m = to_gmail("m1", 5, FIRST, &["INBOX".into()]).expect("parsed");
        assert_eq!(
            (
                m.header("From"),
                m.header("Subject"),
                m.header("Message-ID"),
                m.body("text/plain")
            ),
            (
                "\"Ann, Smith\" <ann@example.com>".to_string(),
                "Café".to_string(),
                "<1@example.com>".to_string(),
                Some("Café tomorrow?".to_string())
            )
        );
    }

    #[test]
    fn a_reply_joins_the_conversation_it_answers_in_either_order() {
        let c = conn();
        let reply = store(&c, "Sent", 1, "\\Seen", REPLY, None, "x").expect("reply");
        let first = store(&c, "INBOX", 1, "", FIRST, None, "y").expect("first");
        let thread = |id: &str| -> String {
            c.query_row(
                "SELECT thread_id FROM imap_messages WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .expect("thread")
        };
        assert_eq!(thread(&reply), thread(&first));
    }

    #[test]
    fn bcc_is_left_out_of_what_smtp_delivers() {
        let raw = b"From: me@example.com\r\nBcc: a@example.com,\r\n b@example.com\r\nSubject: Hi\r\n\r\nBcc: stays in the body\r\n";
        assert_eq!(
            without_bcc(raw),
            b"From: me@example.com\r\nSubject: Hi\r\n\r\nBcc: stays in the body\r\n"
        );
    }

    #[test]
    fn trash_takes_sent_copies_but_spam_leaves_them() {
        let none: [String; 0] = [];
        assert_eq!(
            (
                destination("SENT", &none, &none, true),
                destination("SENT", &["SPAM".into()], &["INBOX".into()], false)
            ),
            (Some("TRASH"), None)
        );
    }

    #[test]
    fn archiving_moves_inbox_copies_to_archive() {
        assert_eq!(
            destination("INBOX", &[], &["INBOX".into()], false),
            Some("ARCHIVE")
        );
    }

    #[test]
    fn restoring_from_trash_moves_back_to_the_inbox() {
        assert_eq!(
            destination("TRASH", &["INBOX".into()], &["TRASH".into()], false),
            Some("INBOX")
        );
    }

    #[test]
    fn marking_read_moves_nothing() {
        assert_eq!(destination("INBOX", &[], &["UNREAD".into()], false), None);
    }

    #[test]
    fn folders_and_flags_become_gmail_labels() {
        assert_eq!(
            labels(&[("INBOX", "\\Flagged"), ("SENT", "\\Seen")]),
            ["INBOX", "SENT", "STARRED"]
        );
    }

    #[test]
    fn an_unread_archived_message_has_no_folder_label() {
        assert_eq!(labels(&[("ARCHIVE", "")]), ["UNREAD"]);
    }

    #[test]
    fn folders_without_special_use_are_found_by_name() {
        assert_eq!(special("INBOX.Sent Items", Some("."), &[]), Some("SENT"));
    }

    #[test]
    fn nested_folder_names_read_like_gmail_labels() {
        assert_eq!(display("INBOX.Clients.Acme", Some(".")), "Clients/Acme");
    }

    #[test]
    fn rebuilding_drops_a_message_no_folder_holds() {
        let mut c = conn();
        c.execute(
            "INSERT INTO imap_folders (name, label, validity, next) VALUES ('INBOX', 'INBOX', 1, 2)",
            [],
        )
        .expect("folder");
        let id = store(&c, "INBOX", 1, "", FIRST, None, "x").expect("stored");
        rebuild(&mut c, &BTreeSet::from([id.clone()])).expect("rebuilt");
        assert!(db::has_thread(&c, &hash_id("t", "<1@example.com>")).expect("query"));
        forget_folder(&c, "INBOX").expect("forgot");
        rebuild(&mut c, &BTreeSet::from([id])).expect("rebuilt");
        assert!(!db::has_thread(&c, &hash_id("t", "<1@example.com>")).expect("query"));
    }

    /// Syncs a real account into a throwaway database: `SHIFT_IMAP_EMAIL=… SHIFT_IMAP_PASSWORD_FILE=… cargo test
    /// live_imap -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a real IMAP account"]
    fn live_imap_sync() {
        let email = std::env::var("SHIFT_IMAP_EMAIL").expect("SHIFT_IMAP_EMAIL");
        let password = std::fs::read_to_string(
            std::env::var("SHIFT_IMAP_PASSWORD_FILE").expect("password file"),
        )
        .expect("password");
        let password = password.trim_end_matches(['\r', '\n']);
        tauri::async_runtime::block_on(async {
            let cfg = guess(&email).await.expect("servers");
            println!("{cfg:?}");
            let mut s = connect(&cfg, password).await.expect("signed in");
            for f in folders(&mut s).await.expect("folders") {
                println!("folder {f:?}");
            }
            let _ = s.logout().await;
            let a = crate::Account::new(email.clone(), conn());
            let started = std::time::Instant::now();
            println!(
                "changed: {}",
                sync(&a, &cfg, password).await.expect("synced")
            );
            println!("first sync {:?}", started.elapsed());
            let started = std::time::Instant::now();
            println!(
                "changed: {}",
                sync(&a, &cfg, password).await.expect("synced again")
            );
            println!("second sync {:?}", started.elapsed());
            for l in db::labels(&a.db()).expect("labels") {
                println!("label {} ({}) unread {}", l.id, l.name, l.unread);
            }
            let c = a.db();
            let n: i64 = c
                .query_row("SELECT count(*) FROM threads", [], |r| r.get(0))
                .expect("count");
            let m: i64 = c
                .query_row("SELECT count(*) FROM imap_messages", [], |r| r.get(0))
                .expect("count");
            println!("{n} threads, {m} messages");
        });
    }
}
