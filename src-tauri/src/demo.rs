//! Offline demo mailbox (`bun run demo`): fake threads in Gmail API shape, fed through the real parser and cache.

use crate::{db, gmail};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::Connection;
use serde_json::json;

pub const EMAIL: &str = "you@example.com";
const ME: &str = "Alex Rivera <you@example.com>";

/// (from, to, hours ago, body). A body starting with `<` is sent as HTML, otherwise plain text.
type Msg = (&'static str, &'static str, f64, &'static str);

fn thread(id: &str, subject: &str, labels: &[&str], msgs: &[Msg]) -> gmail::Thread {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64;
    let mut refs = String::new();
    let messages: Vec<_> = msgs
        .iter()
        .enumerate()
        .map(|(i, (from, to, hours, body))| {
            let last = i + 1 == msgs.len();
            // Only the newest message is unread, like a real conversation.
            let ids: Vec<&str> = labels.iter().copied().filter(|l| last || *l != "UNREAD").collect();
            let mid = format!("<{id}.{i}@demo>");
            let headers = json!([
                { "name": "Subject", "value": if i == 0 { subject.to_string() } else { format!("Re: {subject}") } },
                { "name": "From", "value": from }, { "name": "To", "value": to },
                { "name": "Message-ID", "value": mid }, { "name": "References", "value": refs.trim() },
            ]);
            refs = format!("{refs} {mid}");
            let snippet: String = strip_tags(body).chars().take(160).collect();
            json!({
                "id": format!("{id}-{i}"), "labelIds": ids, "snippet": snippet,
                "internalDate": ((now - hours * 3_600_000.0) as i64).to_string(),
                "payload": {
                    "mimeType": if body.starts_with('<') { "text/html" } else { "text/plain" },
                    "headers": headers, "body": { "data": URL_SAFE_NO_PAD.encode(body) }
                }
            })
        })
        .collect();
    serde_json::from_value(json!({ "id": id, "messages": messages })).expect("demo thread shape")
}

/// (filename, MIME type, bytes, Content-ID for an inline image).
type File<'a> = (&'a str, &'a str, &'a [u8], Option<&'a str>);

const WIREFRAMES: &[u8] = include_bytes!("demo-files/wireframes.png");
const LOGO: &[u8] = include_bytes!("demo-files/logo.png");
const CONTRACT: &[u8] = include_bytes!("demo-files/contract.pdf");

/// Wraps message `msg`'s body in multipart/mixed with `files` after it. Bytes go inline, so nothing is fetched.
fn attach(t: &mut gmail::Thread, msg: usize, files: &[File<'_>]) {
    let m = &mut t.messages[msg];
    let payload = m.payload.take().expect("demo payload");
    let mut parts = vec![gmail::Part {
        mime_type: payload.mime_type,
        body: payload.body,
        ..Default::default()
    }];
    for (name, mime, bytes, cid) in files {
        parts.push(gmail::Part {
            mime_type: mime.to_string(),
            filename: name.to_string(),
            headers: cid
                .map(|c| {
                    vec![gmail::Header {
                        name: "Content-ID".into(),
                        value: format!("<{c}>"),
                    }]
                })
                .unwrap_or_default(),
            body: Some(gmail::Body {
                data: Some(URL_SAFE_NO_PAD.encode(bytes)),
                attachment_id: None,
                size: bytes.len() as i64,
            }),
            parts: Vec::new(),
        });
    }
    m.payload = Some(gmail::Part {
        mime_type: "multipart/mixed".into(),
        headers: payload.headers,
        parts,
        ..Default::default()
    });
}

/// An invite for tomorrow, so the reader shows an upcoming event with Yes, Maybe and No.
fn sprint_planning() -> String {
    let hour = jiff::Timestamp::now().as_second() / 3600 * 3600;
    let at = |s: i64| {
        jiff::Timestamp::from_second(s)
            .map(|t| t.strftime("%Y%m%dT%H%M%SZ").to_string())
            .unwrap_or_default()
    };
    format!(
        "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:sprint-planning@demo\r\nSEQUENCE:0\r\n\
         DTSTART:{}\r\nDTEND:{}\r\nSUMMARY:Sprint planning\r\nLOCATION:Google Meet\r\n\
         ORGANIZER;CN=Maya Chen:mailto:maya@northwind.example\r\n\
         ATTENDEE;PARTSTAT=ACCEPTED;CN=Maya Chen:mailto:maya@northwind.example\r\n\
         ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Alex Rivera:mailto:{EMAIL}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
        at(hour + 26 * 3600),
        at(hour + 27 * 3600)
    )
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn label(id: &str, name: &str, kind: &str) -> gmail::Label {
    gmail::Label {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        color: None,
    }
}

const NEWSLETTER: &str = r#"<div style="max-width:560px;margin:auto;font-family:Georgia,serif">
<h1 style="font-size:28px">The Weekly Render</h1>
<p style="color:#666">Issue 142 &middot; Performance, design and the craft of shipping</p>
<img src="https://picsum.photos/seed/shift/560/240" width="560" height="240" alt="">
<h2>Why local-first apps feel instant</h2>
<p>When the UI reads from a database on your own machine, every click is a disk read, not a network round trip. Sync happens in the background.</p>
<p><a href="https://example.com/local-first">Read the full essay &rarr;</a></p>
<hr><p style="font-size:12px;color:#999">You're receiving this because you subscribed. <a href="https://example.com/unsubscribe">Unsubscribe</a></p></div>"#;

const INVOICE: &str = r#"<table style="font-family:-apple-system,sans-serif;max-width:480px;margin:auto;border-collapse:collapse">
<tr><td style="padding:24px 0 0"><img src="cid:logo@demo" width="48" height="48" alt="Northwind Studio"></td></tr>
<tr><td style="padding:12px 0 24px"><strong style="font-size:20px">Receipt from Stripe</strong></td></tr>
<tr><td>Amount paid <strong>$1,250.00 AUD</strong></td></tr><tr><td>Date paid 24 Nov 2026</td></tr>
<tr><td style="padding-top:16px;color:#666">Website retainer &ndash; November</td></tr></table>"#;

const VERIFY: &str = r#"<table style="font-family:-apple-system,sans-serif;max-width:480px;margin:auto">
<tr><td style="padding:24px 0 8px"><strong style="font-size:20px">Confirm it's you</strong></td></tr>
<tr><td>Enter this verification code in Fieldnote to finish setting up your account:</td></tr>
<tr><td style="padding:16px 0;font-size:32px;letter-spacing:6px;font-weight:600">FN-73920</td></tr>
<tr><td style="color:#666">The code expires in 15 minutes. Fieldnote will never ask you for it by phone.</td></tr></table>"#;

fn system_labels() -> Vec<gmail::Label> {
    [
        "INBOX",
        "STARRED",
        "IMPORTANT",
        "SENT",
        "DRAFT",
        "SPAM",
        "TRASH",
        "UNREAD",
        "CATEGORY_PERSONAL",
        "CATEGORY_UPDATES",
        "CATEGORY_PROMOTIONS",
        "CATEGORY_SOCIAL",
    ]
    .iter()
    .map(|id| label(id, id, "system"))
    .collect()
}

/// A second, smaller demo account, so the unified inbox and account switching can be tried offline.
pub const WORK_EMAIL: &str = "alex@northwind.example";

pub fn seed_work(conn: &mut Connection) -> Result<()> {
    const ME: &str = "Alex Rivera <alex@northwind.example>";
    db::wipe(conn)?;
    db::set_meta(conn, "email", WORK_EMAIL)?;
    db::set_meta(conn, "history_id", "demo")?;
    db::replace_labels(conn, &system_labels())?;
    let threads = [
        thread(
            "w01",
            "Sprint planning moved to 2pm",
            &["INBOX", "UNREAD"],
            &[(
                "Dana Whitfield <dana@northwind.example>",
                ME,
                1.5,
                "Hi team, sprint planning is moving to 2pm today. Same room. Dana",
            )],
        ),
        thread(
            "w02",
            "Q4 roadmap review",
            &["INBOX", "STARRED"],
            &[
                (
                    "Chris Okafor <chris@northwind.example>",
                    ME,
                    28.0,
                    "Roadmap draft is in the shared folder. Comments by Friday please.",
                ),
                (
                    ME,
                    "Chris Okafor <chris@northwind.example>",
                    26.0,
                    "Looks good. Added two notes on the mobile timeline.",
                ),
            ],
        ),
        thread(
            "w03",
            "Your expense report was approved",
            &["INBOX", "CATEGORY_UPDATES"],
            &[(
                "Expensify <noreply@expensify.com>",
                ME,
                50.0,
                "<p>Your expense report <strong>November travel</strong> was approved.</p>",
            )],
        ),
    ];
    for t in &threads {
        db::upsert_thread(conn, t, true)?;
    }
    Ok(())
}

pub fn seed(conn: &mut Connection) -> Result<()> {
    db::wipe(conn)?;
    db::set_meta(conn, "email", EMAIL)?;
    db::set_meta(conn, "history_id", "demo")?;
    let mut labels = system_labels();
    // Colours from the label colour picker's palette (LABEL_COLORS in main.ts).
    for (id, name, color) in [
        ("Label_clients", "Clients", "#4a86e8"),
        ("Label_receipts", "Receipts", "#16a766"),
    ] {
        labels.push(gmail::Label {
            color: Some(gmail::LabelColor {
                background: color.into(),
            }),
            ..label(id, name, "user")
        });
    }
    db::replace_labels(conn, &labels)?;

    let mut threads = [
        thread(
            "t01",
            "Homepage wireframes, round two",
            &["INBOX", "STARRED", "UNREAD", "Label_clients"],
            &[
                (
                    ME,
                    "Maya Chen <maya@northwind.example>",
                    30.0,
                    "Hi Maya,\n\nAttached are the updated wireframes with the new hero and the shorter nav. Let me know what you think.\n\nAlex",
                ),
                (
                    "Maya Chen <maya@northwind.example>",
                    ME,
                    2.0,
                    "Hi Alex,\n\nThese look great. Two small things:\n\n1. Can the hero headline sit on two lines on mobile?\n2. The pricing table feels busy, could we drop the comparison column?\n\nHappy to jump on a call Thursday.\n\nMaya",
                ),
            ],
        ),
        thread(
            "t02",
            "Quick question about the invoice",
            &["INBOX", "UNREAD", "CATEGORY_PERSONAL"],
            &[(
                "Sam O'Neill <sam.oneill@gmail.com>",
                ME,
                0.5,
                "Hey Alex, just checking whether the November invoice includes the hosting migration or if that's billed separately? Cheers, Sam",
            )],
        ),
        thread(
            "t03",
            "Coffee next week?",
            &["INBOX", "UNREAD"],
            &[(
                "Priya Natarajan <priya@hollowtree.example>",
                ME,
                4.0,
                "Hey! I'm in town Tuesday to Thursday next week. Want to grab a coffee and catch up on the agency stuff? Priya",
            )],
        ),
        thread(
            "t04",
            "[shift] Fix sync stalling on large mailboxes (#42)",
            &["INBOX", "UNREAD", "CATEGORY_UPDATES"],
            &[(
                "GitHub <notifications@github.com>",
                ME,
                1.0,
                "<p><strong>octo-reviewer</strong> approved this pull request.</p><blockquote>Looks good, the backoff on 403 rate limits fixes it for me.</blockquote><p><a href=\"https://github.com\">View it on GitHub</a></p>",
            )],
        ),
        thread(
            "t05",
            "Your receipt from Northwind Studio",
            &["INBOX", "UNREAD", "CATEGORY_UPDATES", "Label_receipts"],
            &[("Stripe <receipts@stripe.com>", ME, 6.0, INVOICE)],
        ),
        thread(
            "t06",
            "The Weekly Render #142: Why local-first apps feel instant",
            &["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"],
            &[(
                "The Weekly Render <hello@substack.com>",
                ME,
                9.0,
                NEWSLETTER,
            )],
        ),
        thread(
            "t07",
            "Figma: Maya commented on Homepage v2",
            &["INBOX", "CATEGORY_UPDATES"],
            &[(
                "Figma <comments@figma.com>",
                ME,
                3.0,
                "<p><strong>Maya Chen</strong> commented on <strong>Homepage v2</strong>:</p><blockquote>Love the new spacing here!</blockquote>",
            )],
        ),
        thread(
            "t08",
            "Re: Launch checklist",
            &["INBOX", "IMPORTANT"],
            &[
                (
                    "Jordan Blake <jordan@lumen.example>",
                    ME,
                    50.0,
                    "Here's the launch checklist. DNS, redirects, analytics and the cookie banner still need a final check.",
                ),
                (
                    ME,
                    "Jordan Blake <jordan@lumen.example>",
                    48.0,
                    "Thanks Jordan. I'll do DNS and redirects tonight.",
                ),
                (
                    "Jordan Blake <jordan@lumen.example>",
                    ME,
                    26.0,
                    "Analytics is verified on my end.",
                ),
                (
                    ME,
                    "Jordan Blake <jordan@lumen.example>",
                    25.0,
                    "Perfect, cookie banner is live too. We're good to go.",
                ),
            ],
        ),
        thread(
            "t09",
            "Proposal: brand refresh",
            &["INBOX", "STARRED", "Label_clients"],
            &[
                (
                    ME,
                    "Leo Martins <leo@tidewater.example>",
                    75.0,
                    "Hi Leo,\n\nAs promised, here's the proposal for the brand refresh: three phases over six weeks.\n\nAlex",
                ),
                (
                    "Leo Martins <leo@tidewater.example>",
                    ME,
                    70.0,
                    "Thanks Alex, reviewing with the team this week.",
                ),
            ],
        ),
        thread(
            "t10",
            "Your Vercel deployment is ready",
            &["INBOX", "CATEGORY_UPDATES"],
            &[(
                "Vercel <notifications@vercel.com>",
                ME,
                12.0,
                "<p>Your deployment of <strong>northwind-site</strong> to production is ready.</p><p><a href=\"https://vercel.com\">Visit deployment</a></p>",
            )],
        ),
        thread(
            "t11",
            "Linear: 3 issues assigned to you",
            &["INBOX", "CATEGORY_UPDATES"],
            &[(
                "Linear <notifications@linear.app>",
                ME,
                20.0,
                "<ul><li>PIG-12 Avatar fallback for white logos</li><li>PIG-14 Attachments in reader</li><li>PIG-15 Rich text composer</li></ul>",
            )],
        ),
        thread(
            "t12",
            "Black Friday: 40% off all plans",
            &["INBOX", "CATEGORY_PROMOTIONS"],
            &[(
                "Notion <team@makenotion.com>",
                ME,
                30.0,
                "<h2>40% off Notion Plus</h2><p>This week only. <a href=\"https://notion.so\">Upgrade now</a></p>",
            )],
        ),
        thread(
            "t13",
            "Dinner Saturday",
            &["INBOX"],
            &[
                (
                    "Ella Rivera <ella.rivera@icloud.com>",
                    ME,
                    52.0,
                    "Mum says 6:30 at hers. Bring the good bread!",
                ),
                (
                    ME,
                    "Ella Rivera <ella.rivera@icloud.com>",
                    51.0,
                    "Will do, see you then",
                ),
            ],
        ),
        thread(
            "t14",
            "Contract signed",
            &["INBOX", "Label_clients"],
            &[(
                "Leo Martins <leo@tidewater.example>",
                ME,
                120.0,
                "All signed and attached. Looking forward to kicking off on Monday.",
            )],
        ),
        thread(
            "t15",
            "Welcome to the community",
            &["INBOX", "CATEGORY_SOCIAL"],
            &[(
                "Dribbble <hello@dribbble.com>",
                ME,
                200.0,
                "<p>Thanks for joining Dribbble. Here are three designers we think you'll like.</p>",
            )],
        ),
        thread(
            "t16",
            "Website retainer: December",
            &["SENT", "Label_clients"],
            &[(
                ME,
                "Maya Chen <maya@northwind.example>",
                15.0,
                "Hi Maya, sending through the December retainer summary. Same scope as November. Alex",
            )],
        ),
        thread(
            "t17",
            "Draft: talk abstract",
            &["DRAFT"],
            &[(
                ME,
                "Conference Team <talks@devconf.example>",
                40.0,
                "Local-first email clients: why your inbox should live on your machine.",
            )],
        ),
        thread(
            "t18",
            "You have won a prize!!!",
            &["SPAM"],
            &[(
                "Prize Desk <winner@totally-legit.example>",
                ME,
                10.0,
                "Click here to claim your prize.",
            )],
        ),
        thread(
            "t19",
            "Old newsletter",
            &["TRASH", "CATEGORY_PROMOTIONS"],
            &[(
                "Some Shop <news@shop.example>",
                ME,
                300.0,
                "<p>Last season's sale.</p>",
            )],
        ),
        thread(
            "t20",
            "Archived: tax documents",
            &["Label_receipts"],
            &[(
                "Morgan Lee <morgan@ledgerline.example>",
                ME,
                400.0,
                "Hi Alex, your tax return has been lodged. Copies attached for your records.",
            )],
        ),
        thread(
            "t21",
            "Invitation: Sprint planning",
            &["INBOX", "UNREAD"],
            &[(
                "Maya Chen <maya@northwind.example>",
                ME,
                1.0,
                "Maya Chen has invited you to Sprint planning.\n\nJoin with Google Meet: meet.example/abc-defg-hij",
            )],
        ),
        // One-time codes, minutes old, so the Copy chip shows.
        thread(
            "t22",
            "Your Lumen sign-in code",
            &["INBOX", "UNREAD", "CATEGORY_UPDATES"],
            &[(
                "Lumen <no-reply@lumen.example>",
                ME,
                0.05,
                "Hi Alex,\n\nUse this code to sign in to Lumen:\n\n482 913\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.\n\nThe Lumen team",
            )],
        ),
        thread(
            "t23",
            "Verify your email address",
            &["INBOX", "CATEGORY_UPDATES"],
            &[("Fieldnote <verify@fieldnote.example>", ME, 0.3, VERIFY)],
        ),
    ];
    for t in &mut threads {
        match t.id.as_str() {
            "t01" => attach(
                t,
                0,
                &[("Homepage wireframes v2.png", "image/png", WIREFRAMES, None)],
            ),
            "t05" => attach(t, 0, &[("logo.png", "image/png", LOGO, Some("logo@demo"))]),
            "t21" => {
                let ics = sprint_planning();
                attach(
                    t,
                    0,
                    &[("invite.ics", "text/calendar", ics.as_bytes(), None)],
                );
            }
            "t14" => attach(
                t,
                0,
                &[(
                    "Services Agreement (signed).pdf",
                    "application/pdf",
                    CONTRACT,
                    None,
                )],
            ),
            _ => {}
        }
    }
    for t in &threads {
        db::upsert_thread(conn, t, true)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_a_browsable_mailbox() {
        let mut c = db::open(std::path::Path::new(":memory:")).unwrap();
        seed(&mut c).unwrap();
        let inbox = db::threads(&c, Some("INBOX")).unwrap();
        assert_eq!(inbox.len(), 18);
        let code = |id: &str| {
            inbox
                .iter()
                .find(|t| t.id == id)
                .and_then(|t| t.code.clone())
        };
        assert_eq!(code("t22").as_deref(), Some("482913"));
        assert_eq!(code("t23").as_deref(), Some("FN-73920"));
        assert_eq!(code("t05"), None, "a receipt has no code");
        let old = thread(
            "old",
            "Your code",
            &["INBOX"],
            &[(ME, EMAIL, 2.0, "Your code is 551204")],
        );
        db::upsert_thread(&mut c, &old, true).unwrap();
        let rows = db::threads_by_ids(&c, &["old".into()]).unwrap();
        assert_eq!(rows[0].code, None, "a code two hours old is stale");
        assert!(
            db::messages(&c, "t21").unwrap()[0].invite.is_some(),
            "the invite has its event"
        );
        assert_eq!(db::threads(&c, Some("TRASH")).unwrap().len(), 1);
        assert_eq!(db::messages(&c, "t08").unwrap().len(), 4);
        assert!(
            db::messages(&c, "t06").unwrap()[0]
                .html
                .as_deref()
                .unwrap()
                .contains("Weekly Render")
        );
        assert_eq!(db::search_local(&c, "wireframes").unwrap().len(), 1);
        let contract = &db::messages(&c, "t14").unwrap()[0];
        assert_eq!(contract.attachments[0].mime, "application/pdf");
        assert_eq!(
            db::attachment_source(&c, "t14-0", 0).unwrap().1.as_deref(),
            Some(CONTRACT)
        );
        let receipt = &db::messages(&c, "t05").unwrap()[0];
        assert!(receipt.html.as_deref().unwrap().contains("cid:logo@demo"));
        assert_eq!(
            receipt.attachments[0].content_id.as_deref(),
            Some("logo@demo")
        );

        let mut w = db::open(std::path::Path::new(":memory:")).unwrap();
        seed_work(&mut w).unwrap();
        assert_eq!(db::threads(&w, Some("INBOX")).unwrap().len(), 3);
        assert_eq!(
            db::get_meta(&w, "email").unwrap().as_deref(),
            Some(WORK_EMAIL)
        );
    }
}
