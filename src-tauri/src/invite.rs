//! Calendar invites by email (iMIP, RFC 6047): the event in a message's `text/calendar` part, and the reply that
//! answers it. Replying by email needs no Calendar access and works for any organizer, Google or not.

use jiff::Timestamp;
use jiff::civil::{Date, DateTime, Time, Weekday};
use jiff::tz::{Offset, TimeZone};
use serde::Serialize;

/// The answers an attendee can send, as iCalendar `PARTSTAT` values.
pub const ANSWERS: [&str; 3] = ["ACCEPTED", "TENTATIVE", "DECLINED"];

#[derive(Serialize, Debug, PartialEq)]
pub struct Invite {
    /// REQUEST (an invitation or update), CANCEL, or REPLY (someone answering one of the user's events).
    pub method: String,
    pub uid: String,
    pub sequence: i64,
    pub summary: String,
    pub location: String,
    /// Milliseconds since the epoch. For all-day events, midnight UTC of the first day.
    pub start: Option<i64>,
    /// Exclusive, as in iCalendar: an all-day event's end is the day after its last.
    pub end: Option<i64>,
    pub all_day: bool,
    pub organizer: Person,
    pub attendees: Vec<Person>,
    /// The user's own answer (a `PARTSTAT`), `NEEDS-ACTION` until they reply.
    pub status: String,
}

#[derive(Serialize, Debug, PartialEq, Default)]
pub struct Person {
    pub name: String,
    pub email: String,
    pub status: String,
}

struct Prop {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

impl Prop {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Default)]
struct Component {
    name: String,
    props: Vec<Prop>,
    children: Vec<Component>,
}

impl Component {
    fn prop(&self, name: &str) -> Option<&Prop> {
        self.props.iter().find(|p| p.name == name)
    }

    fn text(&self, name: &str) -> String {
        self.prop(name)
            .map(|p| unescape(&p.value))
            .unwrap_or_default()
    }

    fn child(&self, name: &str) -> Option<&Component> {
        self.children.iter().find(|c| c.name == name)
    }
}

/// The event in a `text/calendar` body, seen from `me` (the account's address). None if it holds no event.
pub fn parse(ics: &str, me: &str) -> Option<Invite> {
    let cal = calendar(ics)?;
    let event = cal.child("VEVENT")?;
    let start = event.prop("DTSTART");
    let attendees: Vec<Person> = event
        .props
        .iter()
        .filter(|p| p.name == "ATTENDEE")
        .map(person)
        .collect();
    let status = attendees
        .iter()
        .find(|a| a.email.eq_ignore_ascii_case(me))
        .map_or("NEEDS-ACTION", |a| a.status.as_str())
        .to_string();
    Some(Invite {
        method: cal
            .prop("METHOD")
            .map(|p| p.value.to_uppercase())
            .unwrap_or_default(),
        uid: event.text("UID"),
        sequence: event
            .prop("SEQUENCE")
            .and_then(|p| p.value.trim().parse().ok())
            .unwrap_or(0),
        summary: event.text("SUMMARY"),
        location: event.text("LOCATION"),
        start: start.and_then(|p| millis(p, &cal)),
        end: event.prop("DTEND").and_then(|p| millis(p, &cal)),
        all_day: start.is_some_and(is_date),
        organizer: event.prop("ORGANIZER").map(person).unwrap_or_default(),
        attendees,
        status,
    })
}

/// A sent answer: who it goes to and the `text/calendar` body that carries it.
pub struct Reply {
    pub to: String,
    pub summary: String,
    pub uid: String,
    pub sequence: i64,
    pub ics: String,
}

/// The REPLY (RFC 5546) telling the organizer of the event in `ics` that `me` answers `status`.
pub fn reply(ics: &str, me: &str, name: &str, status: &str, now: Timestamp) -> Option<Reply> {
    let cal = calendar(ics)?;
    let event = cal.child("VEVENT")?;
    let organizer = event.prop("ORGANIZER")?;
    let to = mailto(&organizer.value);
    if to.is_empty() || !ANSWERS.contains(&status) {
        return None;
    }
    // The address the organizer invited, in case it differs in case or form from the account's.
    let invited = event
        .props
        .iter()
        .filter(|p| p.name == "ATTENDEE")
        .find(|p| mailto(&p.value).eq_ignore_ascii_case(me))
        .map_or_else(|| format!("mailto:{me}"), |p| p.value.clone());
    let cn = if name.is_empty() {
        String::new()
    } else {
        format!(";CN=\"{}\"", name.replace('"', "'"))
    };
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "PRODID:-//Shift//Shift Mail//EN".to_string(),
        "VERSION:2.0".to_string(),
        "METHOD:REPLY".to_string(),
        "BEGIN:VEVENT".to_string(),
        format!("UID:{}", escape(&event.text("UID"))),
        format!("DTSTAMP:{}", now.strftime("%Y%m%dT%H%M%SZ")),
        line(organizer),
        format!("ATTENDEE;PARTSTAT={status}{cn}:{invited}"),
    ];
    // Which occurrence of a repeating event, and which version of it, this answers.
    lines.extend(
        ["RECURRENCE-ID", "SEQUENCE"]
            .iter()
            .filter_map(|n| event.prop(n).map(line)),
    );
    if let Some(s) = event.prop("SUMMARY") {
        lines.push(line(s));
    }
    lines.extend(["END:VEVENT".to_string(), "END:VCALENDAR".to_string()]);
    let mut ics = String::new();
    for l in &lines {
        fold(l, &mut ics);
    }
    Some(Reply {
        to,
        summary: event.text("SUMMARY"),
        uid: event.text("UID"),
        sequence: event
            .prop("SEQUENCE")
            .and_then(|p| p.value.trim().parse().ok())
            .unwrap_or(0),
        ics,
    })
}

fn calendar(ics: &str) -> Option<Component> {
    // Unfold first: a line that starts with a space or tab continues the one before.
    let unfolded = ics
        .replace("\r\n", "\n")
        .replace("\n ", "")
        .replace("\n\t", "");
    let mut stack: Vec<Component> = vec![Component::default()];
    for raw in unfolded.lines() {
        let Some(p) = split(raw) else { continue };
        match p.name.as_str() {
            "BEGIN" => stack.push(Component {
                name: p.value.trim().to_uppercase(),
                ..Component::default()
            }),
            "END" if stack.len() > 1 => {
                let done = stack.pop()?;
                stack.last_mut()?.children.push(done);
            }
            _ => stack.last_mut()?.props.push(p),
        }
    }
    let root = stack.into_iter().next()?;
    root.children.into_iter().find(|c| c.name == "VCALENDAR")
}

/// `NAME;KEY=value;KEY="quoted:value":the value` into its parts. Colons and semicolons inside quotes don't count.
fn split(line: &str) -> Option<Prop> {
    let mut quoted = false;
    let mut fields = Vec::new();
    let mut from = 0;
    let mut value_at = None;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                fields.push(&line[from..i]);
                from = i + 1;
            }
            ':' if !quoted => {
                fields.push(&line[from..i]);
                value_at = Some(i + 1);
                break;
            }
            _ => {}
        }
    }
    let value = line.get(value_at?..)?.to_string();
    let mut fields = fields.into_iter();
    let name = fields.next()?.trim().to_uppercase();
    let params = fields
        .filter_map(|f| f.split_once('='))
        .map(|(k, v)| {
            (
                k.trim().to_uppercase(),
                v.trim().trim_matches('"').to_string(),
            )
        })
        .collect();
    Some(Prop {
        name,
        params,
        value,
    })
}

fn line(p: &Prop) -> String {
    let mut s = p.name.clone();
    for (k, v) in &p.params {
        if v.contains([':', ';', ',']) {
            s.push_str(&format!(";{k}=\"{v}\""));
        } else {
            s.push_str(&format!(";{k}={v}"));
        }
    }
    s.push(':');
    s.push_str(&p.value);
    s
}

/// Content lines are at most 75 octets; longer ones continue on lines that start with a space.
fn fold(line: &str, out: &mut String) {
    let mut width = 0;
    for c in line.chars() {
        if width + c.len_utf8() > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += c.len_utf8();
    }
    out.push_str("\r\n");
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out
}

fn escape(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\n', "\\n")
}

fn mailto(v: &str) -> String {
    let v = v.trim();
    v.get(..7)
        .filter(|p| p.eq_ignore_ascii_case("mailto:"))
        .map_or(v, |_| &v[7..])
        .to_string()
}

fn person(p: &Prop) -> Person {
    Person {
        name: p.param("CN").unwrap_or_default().to_string(),
        email: mailto(&p.value),
        status: p.param("PARTSTAT").unwrap_or("NEEDS-ACTION").to_uppercase(),
    }
}

fn is_date(p: &Prop) -> bool {
    p.param("VALUE")
        .is_some_and(|v| v.eq_ignore_ascii_case("DATE"))
        || p.value.trim().len() == 8
}

/// A DTSTART or DTEND as milliseconds since the epoch.
fn millis(p: &Prop, cal: &Component) -> Option<i64> {
    let v = p.value.trim();
    if is_date(p) {
        let date = civil_date(v)?;
        return Some(
            TimeZone::UTC
                .to_timestamp(date.into())
                .ok()?
                .as_millisecond(),
        );
    }
    let local = civil(v.trim_end_matches(['Z', 'z']))?;
    let zone = if v.ends_with(['Z', 'z']) {
        TimeZone::UTC
    } else if let Some(tzid) = p.param("TZID") {
        // Some senders prefix the IANA name with a path, such as /mozilla.org/20050126_1/Europe/Paris.
        let iana = tzid.rsplitn(3, '/').collect::<Vec<_>>();
        let iana = match iana.as_slice() {
            [city, region, _] | [city, region] => format!("{region}/{city}"),
            _ => tzid.to_string(),
        };
        TimeZone::get(tzid)
            .or_else(|_| TimeZone::get(&iana))
            .ok()
            .or_else(|| defined_offset(cal, tzid, local).map(TimeZone::fixed))
            .unwrap_or_else(TimeZone::system)
    } else {
        // A floating time: the same wall-clock time wherever the reader is.
        TimeZone::system()
    };
    Some(zone.to_timestamp(local).ok()?.as_millisecond())
}

fn civil_date(v: &str) -> Option<Date> {
    Date::new(
        v.get(0..4)?.parse().ok()?,
        v.get(4..6)?.parse().ok()?,
        v.get(6..8)?.parse().ok()?,
    )
    .ok()
}

fn civil(v: &str) -> Option<DateTime> {
    let date = civil_date(v)?;
    let t = v.get(9..)?;
    let time = Time::new(
        t.get(0..2)?.parse().ok()?,
        t.get(2..4)?.parse().ok()?,
        t.get(4..6).and_then(|s| s.parse().ok()).unwrap_or(0),
        0,
    )
    .ok()?;
    Some(date.to_datetime(time))
}

/// The offset a VTIMEZONE in the invite gives `local`, for zone names the system doesn't know (Outlook sends
/// Windows names such as "AUS Eastern Standard Time"). Reads yearly `BYMONTH` + `BYDAY` rules, which is what
/// Outlook and Exchange write.
fn defined_offset(cal: &Component, tzid: &str, local: DateTime) -> Option<Offset> {
    let zone = cal
        .children
        .iter()
        .find(|c| c.name == "VTIMEZONE" && c.text("TZID") == tzid)?;
    let mut rules: Vec<(DateTime, Offset)> = zone
        .children
        .iter()
        .filter_map(|c| {
            let offset = utc_offset(&c.prop("TZOFFSETTO")?.value)?;
            let first = civil(c.prop("DTSTART")?.value.trim())?;
            let at = c
                .prop("RRULE")
                .and_then(|r| yearly(&r.value, first, local.year()))
                .unwrap_or(first);
            Some((at, offset))
        })
        .collect();
    rules.sort_by_key(|(at, _)| *at);
    // The latest change on or before the event; before this year's first change, last year's last one still holds.
    rules
        .iter()
        .rev()
        .find(|(at, _)| *at <= local)
        .or_else(|| rules.last())
        .map(|(_, o)| *o)
}

/// This year's change for a rule such as `FREQ=YEARLY;BYMONTH=10;BYDAY=1SU` (`-1SU` is the last Sunday).
fn yearly(rule: &str, first: DateTime, year: i16) -> Option<DateTime> {
    let part = |key: &str| {
        rule.split(';')
            .find_map(|kv| {
                kv.split_once('=')
                    .filter(|(k, _)| k.eq_ignore_ascii_case(key))
            })
            .map(|(_, v)| v)
    };
    let month: i8 = part("BYMONTH")?.parse().ok()?;
    let by_day = part("BYDAY")?;
    let (nth, day) = by_day.split_at(by_day.len().checked_sub(2)?);
    let weekday = match day {
        "MO" => Weekday::Monday,
        "TU" => Weekday::Tuesday,
        "WE" => Weekday::Wednesday,
        "TH" => Weekday::Thursday,
        "FR" => Weekday::Friday,
        "SA" => Weekday::Saturday,
        _ => Weekday::Sunday,
    };
    let nth: i8 = if nth.is_empty() { 1 } else { nth.parse().ok()? };
    let date = Date::new(year, month, 1)
        .ok()?
        .nth_weekday_of_month(nth, weekday)
        .ok()?;
    Some(date.to_datetime(first.time()))
}

/// `+1000` or `-0530` as an offset.
fn utc_offset(v: &str) -> Option<Offset> {
    let v = v.trim();
    let sign = if v.starts_with('-') { -1 } else { 1 };
    let digits = v.trim_start_matches(['+', '-']);
    let hours: i32 = digits.get(0..2)?.parse().ok()?;
    let minutes: i32 = digits.get(2..4)?.parse().ok()?;
    Offset::from_seconds(sign * (hours * 3600 + minutes * 60)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOGLE: &str = "BEGIN:VCALENDAR\r\nPRODID:-//Google Inc//Google Calendar 70.9054//EN\r\nVERSION:2.0\r\n\
METHOD:REQUEST\r\nBEGIN:VTIMEZONE\r\nTZID:Australia/Sydney\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\n\
DTSTART;TZID=Australia/Sydney:20261201T100000\r\nDTEND;TZID=Australia/Sydney:20261201T110000\r\n\
DTSTAMP:20261120T000000Z\r\nORGANIZER;CN=Ella Rivera:mailto:ella@example.com\r\nUID:abc123@google.com\r\n\
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=me@example.com;X-NUM-GUESTS=0:\r\n \
mailto:me@example.com\r\nATTENDEE;PARTSTAT=ACCEPTED;CN=Ella Rivera:mailto:ella@example.com\r\n\
SEQUENCE:2\r\nSUMMARY:Design review\\, round two\r\nLOCATION:Room 4\\; level 2\r\n\
BEGIN:VALARM\r\nACTION:DISPLAY\r\nSUMMARY:Alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    const OUTLOOK: &str = "BEGIN:VCALENDAR\nMETHOD:REQUEST\nBEGIN:VTIMEZONE\nTZID:AUS Eastern Standard Time\n\
BEGIN:STANDARD\nDTSTART:16010101T030000\nTZOFFSETFROM:+1100\nTZOFFSETTO:+1000\n\
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=4\nEND:STANDARD\nBEGIN:DAYLIGHT\nDTSTART:16010101T020000\n\
TZOFFSETFROM:+1000\nTZOFFSETTO:+1100\nRRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=10\nEND:DAYLIGHT\n\
END:VTIMEZONE\nBEGIN:VEVENT\nORGANIZER;CN=\"Rivera, Ella\":mailto:Ella@Example.com\nUID:040000008200E0\n\
DTSTART;TZID=AUS Eastern Standard Time:20260715T093000\nDTEND;TZID=AUS Eastern Standard Time:20260715T100000\n\
SUMMARY:Standup\nEND:VEVENT\nEND:VCALENDAR\n";

    fn ms(s: &str) -> i64 {
        s.parse::<Timestamp>().map_or(0, Timestamp::as_millisecond)
    }

    #[test]
    fn google_invite_reads_event_details() {
        let i = parse(GOOGLE, "Me@Example.com").expect("an event");
        assert_eq!(
            (
                i.method.as_str(),
                i.uid.as_str(),
                i.sequence,
                i.summary.as_str(),
                i.location.as_str()
            ),
            (
                "REQUEST",
                "abc123@google.com",
                2,
                "Design review, round two",
                "Room 4; level 2"
            )
        );
    }

    #[test]
    fn named_zone_converts_to_utc() {
        let i = parse(GOOGLE, "me@example.com").expect("an event");
        // Sydney is on daylight time (UTC+11) in December.
        assert_eq!(
            (i.start, i.end),
            (
                Some(ms("2026-11-30T23:00:00Z")),
                Some(ms("2026-12-01T00:00:00Z"))
            )
        );
    }

    #[test]
    fn own_answer_comes_from_matching_attendee() {
        let i = parse(GOOGLE, "me@example.com").expect("an event");
        assert_eq!(
            (i.status.as_str(), i.organizer.name.as_str()),
            ("NEEDS-ACTION", "Ella Rivera")
        );
    }

    #[test]
    fn windows_zone_falls_back_to_the_invites_own_rules() {
        let i = parse(OUTLOOK, "me@example.com").expect("an event");
        // July is standard time (UTC+10) in Sydney.
        assert_eq!(i.start, Some(ms("2026-07-14T23:30:00Z")));
    }

    #[test]
    fn quoted_parameters_keep_their_commas() {
        let i = parse(OUTLOOK, "me@example.com").expect("an event");
        assert_eq!(
            (i.organizer.name.as_str(), i.organizer.email.as_str()),
            ("Rivera, Ella", "Ella@Example.com")
        );
    }

    #[test]
    fn all_day_events_are_dates() {
        let ics = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART;VALUE=DATE:20261224\nDTEND;VALUE=DATE:20261226\n\
END:VEVENT\nEND:VCALENDAR";
        let i = parse(ics, "me@example.com").expect("an event");
        assert_eq!(
            (i.all_day, i.start, i.end),
            (
                true,
                Some(ms("2026-12-24T00:00:00Z")),
                Some(ms("2026-12-26T00:00:00Z"))
            )
        );
    }

    #[test]
    fn no_event_is_none() {
        assert!(
            parse(
                "BEGIN:VCALENDAR\nMETHOD:PUBLISH\nEND:VCALENDAR",
                "me@example.com"
            )
            .is_none()
        );
    }

    #[test]
    fn reply_answers_the_organizer_for_the_invited_address() {
        let now = "2026-11-25T01:02:03Z".parse().expect("a timestamp");
        let r = reply(GOOGLE, "ME@example.com", "Nic", "ACCEPTED", now).expect("a reply");
        let unfolded = r.ics.replace("\r\n ", "");
        assert!(
            r.to == "ella@example.com"
                && unfolded.contains("METHOD:REPLY\r\n")
                && unfolded.contains("UID:abc123@google.com\r\n")
                && unfolded.contains("SEQUENCE:2\r\n")
                && unfolded.contains("DTSTAMP:20261125T010203Z\r\n")
                && unfolded
                    .contains("ATTENDEE;PARTSTAT=ACCEPTED;CN=\"Nic\":mailto:me@example.com\r\n")
                && !unfolded.contains("VALARM"),
            "{}",
            r.ics
        );
    }

    #[test]
    fn reply_lines_fold_at_75_octets() {
        let now = "2026-11-25T01:02:03Z".parse().expect("a timestamp");
        let long = GOOGLE.replace("Design review", &"Very long title ".repeat(10));
        let r = reply(&long, "me@example.com", "", "DECLINED", now).expect("a reply");
        assert!(r.ics.split("\r\n").all(|l| l.len() <= 75), "{}", r.ics);
    }

    #[test]
    fn reply_refuses_unknown_answers() {
        let now = Timestamp::UNIX_EPOCH;
        assert!(reply(GOOGLE, "me@example.com", "", "MAYBE", now).is_none());
    }
}
