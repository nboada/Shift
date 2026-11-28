//! One-time codes (sign-in, verification, 2FA) in an email, so the list, the reader and the new-mail notification can
//! offer them to copy. Precision over recall: a code needs a cue word ("code", "verification", "código") in the same
//! sentence or a line of its own next to one, and anything that reads as an order, price, phone number or date is
//! passed over.

/// How long after it arrives an email's code is offered.
// shortcut: codes are found and shown only for mail under an hour old, since they expire in minutes; keep them longer
// if people want codes from older mail.
pub const FRESH_MS: i64 = 60 * 60 * 1000;

/// How much of a body is read: codes sit near the top, and some emails are megabytes of markup.
const MAX_CHARS: usize = 20_000;

/// Furthest a code may sit from its cue word in the same sentence, in characters.
const NEAR: usize = 36;

/// Whole words that say a code follows. Words ending in "code" count too ("Bestätigungscode"), except `NOT_CUES`.
const CUES: &[&str] = &[
    "code",
    "codes",
    "passcode",
    "password",
    "otp",
    "pin",
    "2fa",
    "mfa",
    "verification",
    "verify",
    "código",
    "codigo",
    "codice",
    "kode",
    "kod",
    "koodi",
    "код",
    "verificación",
    "verificação",
    "vérification",
    "verifica",
];

const NOT_CUES: &[&str] = &[
    "postcode",
    "barcode",
    "zipcode",
    "qrcode",
    "encode",
    "decode",
    "unicode",
    "opcode",
    "geocode",
    "promocode",
    "shortcode",
    "sourcecode",
];

/// Words that make a number in the same sentence something else: an order, a price, a phone number, an address, a
/// promo code.
const NOT_CODES: &[&str] = &[
    "order",
    "orders",
    "pedido",
    "invoice",
    "receipt",
    "tracking",
    "shipment",
    "parcel",
    "ref",
    "reference",
    "transaction",
    "payment",
    "price",
    "total",
    "amount",
    "balance",
    "usd",
    "eur",
    "gbp",
    "phone",
    "call",
    "tel",
    "fax",
    "ending",
    "card",
    "number",
    "zip",
    "postal",
    "area",
    "country",
    "promo",
    "coupon",
    "discount",
    "voucher",
    "gift",
    "referral",
    "invite",
    "invitation",
    "save",
    "off",
    "sale",
    "shop",
    "checkout",
    "booking",
    "reservation",
    "itinerary",
    "flight",
    "pnr",
    "ticket",
    "dial",
    "meeting",
    "conference",
    "qr",
    "source",
    "dress",
    "error",
    "status",
    "product",
    "serial",
    "model",
    "version",
];

/// Subject words that make the whole email something other than a sign-in.
const NOT_CODE_SUBJECTS: &[&str] = &[
    "order",
    "receipt",
    "invoice",
    "booking",
    "reservation",
    "itinerary",
    "flight",
    "shipped",
    "shipping",
    "delivery",
    "tracking",
    "payment",
    "statement",
    "coupon",
    "promo",
    "sale",
    "discount",
];

pub fn fresh(date_ms: i64, now_ms: i64) -> bool {
    now_ms - date_ms < FRESH_MS
}

/// The code in a message: its plain-text body, else its HTML as text, else Gmail's snippet (a metadata-only fetch).
pub fn in_message(
    subject: &str,
    text: Option<&str>,
    html: Option<&str>,
    snippet: &str,
) -> Option<String> {
    match (text, html) {
        (Some(t), _) if !t.trim().is_empty() => find(subject, t),
        (_, Some(h)) => find(subject, &html_text(h)),
        _ => find(subject, &decode_entities(snippet)),
    }
}

/// The one-time code in an email's subject and text, as it should be pasted: digits without their spaces or dashes
/// ("123 456" → "123456"), letter codes as written ("G-123456").
pub fn find(subject: &str, body: &str) -> Option<String> {
    if words(&subject.chars().collect::<Vec<_>>())
        .iter()
        .any(|w| NOT_CODE_SUBJECTS.contains(&w.2.as_str()))
    {
        return None;
    }
    let body: String = body
        .chars()
        .take(MAX_CHARS)
        .filter(|c| {
            !matches!(
                c,
                '\u{200B}'..='\u{200D}' | '\u{FEFF}' | '\u{00AD}' | '\u{034F}'
            )
        })
        .map(|c| if c == '\u{A0}' { ' ' } else { c })
        .collect();
    let units: Vec<Vec<char>> = std::iter::once(subject)
        .chain(body.lines().flat_map(sentences))
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(|u| u.chars().collect())
        .collect();
    for (i, unit) in units.iter().enumerate() {
        let ws = words(unit);
        let cues: Vec<_> = ws.iter().filter(|w| is_cue(&w.2)).collect();
        if cues.is_empty() || ws.iter().any(|w| NOT_CODES.contains(&w.2.as_str())) {
            continue;
        }
        let near = tokens(unit).into_iter().find(|t| {
            cues.iter()
                .any(|c| gap((c.0, c.1), (t.start, t.end)) <= NEAR)
                && code(unit, t).is_some()
        });
        if let Some(t) = near {
            return code(unit, &t);
        }
        // A code on a line of its own after its cue ("Your code is:\n\n482913"), or just before it.
        let around = [i + 1, i + 2].into_iter().chain(i.checked_sub(1));
        if let Some(c) = around.filter_map(|j| units.get(j)).find_map(|u| alone(u)) {
            return Some(c);
        }
    }
    None
}

fn is_cue(word: &str) -> bool {
    CUES.contains(&word) || (word.ends_with("code") && !NOT_CUES.contains(&word))
}

/// Characters between two spans of a sentence.
fn gap(a: (usize, usize), b: (usize, usize)) -> usize {
    if b.0 >= a.1 {
        b.0 - a.1
    } else {
        a.0.saturating_sub(b.1)
    }
}

/// Splits a line after each `.`, `!` or `?` that ends a sentence.
fn sentences(line: &str) -> impl Iterator<Item = &str> {
    let mut start = 0;
    let mut cuts = Vec::new();
    let mut it = line.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        if matches!(c, '.' | '!' | '?' | '。') && it.peek().is_some_and(|(_, n)| n.is_whitespace())
        {
            let end = i + c.len_utf8();
            cuts.push(&line[start..end]);
            start = end;
        }
    }
    cuts.push(&line[start..]);
    cuts.into_iter()
}

/// Words of a sentence, lower case, with their character spans.
fn words(chars: &[char]) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && chars[i].is_alphanumeric() {
            i += 1;
        }
        out.push((
            start,
            i,
            chars[start..i]
                .iter()
                .flat_map(|c| c.to_lowercase())
                .collect(),
        ));
    }
    out
}

/// A run of letters and digits: groups joined by single dashes ("G-123456", "123-456"), or by single spaces when both
/// sides are digits ("123 456"), so a phone number or date stays one token and can be turned down whole.
struct Token {
    start: usize,
    end: usize,
    groups: Vec<String>,
}

fn tokens(chars: &[char]) -> Vec<Token> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if !chars[i].is_alphanumeric() {
            i += 1;
            continue;
        }
        let start = i;
        let mut groups = Vec::new();
        loop {
            let g = i;
            while i < chars.len() && chars[i].is_alphanumeric() {
                i += 1;
            }
            let group: String = chars[g..i].iter().collect();
            let digits = group.chars().all(|c| c.is_ascii_digit());
            groups.push(group);
            match (chars.get(i), chars.get(i + 1)) {
                (Some('-'), Some(n)) if n.is_alphanumeric() => i += 1,
                (Some(' '), Some(n)) if digits && n.is_ascii_digit() => i += 1,
                _ => break,
            }
        }
        out.push(Token {
            start,
            end: i,
            groups,
        });
    }
    out
}

/// The token as a code to paste, or None when it reads as something else.
fn code(chars: &[char], t: &Token) -> Option<String> {
    if t.groups.len() > 2 {
        return None;
    }
    let before = t.start.checked_sub(1).map(|i| chars[i]);
    let after = chars.get(t.end).copied();
    // Prices, references, URLs and e-mail addresses, times and decimals.
    if before.is_some_and(|c| "#$€£¥₹+/=&?@:._\\".contains(c))
        || after.is_some_and(|c| "/%€$@_:".contains(c))
        || (matches!(after, Some('.' | ','))
            && chars.get(t.end + 1).is_some_and(|c| c.is_alphanumeric()))
    {
        return None;
    }
    let compact = t.groups.concat();
    if !compact.is_ascii() {
        return None;
    }
    if compact.bytes().all(|b| b.is_ascii_digit()) {
        let grouped_oddly = matches!(&t.groups[..], [a, b] if a.len() != b.len() || a.len() < 3);
        return ((4..=8).contains(&compact.len()) && !grouped_oddly && !is_date(&compact))
            .then_some(compact);
    }
    // Letters and digits in capitals only, so words and lower-case ids don't count.
    let letters_and_digits = compact.bytes().any(|b| b.is_ascii_digit())
        && compact.bytes().any(|b| b.is_ascii_uppercase())
        && !compact.bytes().any(|b| b.is_ascii_lowercase());
    (letters_and_digits && (4..=10).contains(&compact.len()))
        .then(|| chars[t.start..t.end].iter().collect())
}

/// A year (1900–2099) or a compact date (20261128).
fn is_date(digits: &str) -> bool {
    let n = |r: std::ops::Range<usize>| digits[r].parse::<u32>().unwrap_or(0);
    match digits.len() {
        4 => (1900..2100).contains(&n(0..4)),
        8 => {
            (1900..2100).contains(&n(0..4))
                && (1..=12).contains(&n(4..6))
                && (1..=31).contains(&n(6..8))
        }
        _ => false,
    }
}

/// The code when a line holds nothing else, give or take punctuation around it ("482913", "Code: " doesn't count).
fn alone(unit: &[char]) -> Option<String> {
    match &tokens(unit)[..] {
        [t] if unit[..t.start]
            .iter()
            .chain(&unit[t.end..])
            .all(|c| !c.is_alphanumeric()) =>
        {
            code(unit, t)
        }
        _ => None,
    }
}

/// The readable text of an HTML email, a line per block, enough to find a code in.
pub fn html_text(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len().min(MAX_CHARS * 4));
    let mut i = 0;
    while let Some(lt) = lower[i..].find('<').map(|p| i + p) {
        out.push_str(&html[i..lt]);
        if lower[lt..].starts_with("<!--") {
            i = lower[lt..].find("-->").map_or(html.len(), |p| lt + p + 3);
            continue;
        }
        let Some(gt) = lower[lt..].find('>').map(|p| lt + p) else {
            i = html.len();
            break;
        };
        let tag = &lower[lt + 1..gt];
        let name: String = tag
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();
        i = gt + 1;
        if matches!(name.as_str(), "style" | "script" | "head" | "title") && !tag.starts_with('/') {
            i = lower[i..]
                .find(&format!("</{name}"))
                .map_or(html.len(), |p| i + p);
            continue;
        }
        let block = matches!(
            name.as_str(),
            "p" | "div"
                | "br"
                | "tr"
                | "td"
                | "th"
                | "li"
                | "table"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "center"
                | "blockquote"
                | "section"
                | "hr"
        );
        out.push(if block { '\n' } else { ' ' });
        if out.len() > MAX_CHARS * 4 {
            break;
        }
    }
    if i < html.len() {
        out.push_str(&html[i..]);
    }
    decode_entities(&out)
}

/// The entities that turn up around codes; others are left as written.
fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let decoded = rest.find(';').filter(|&semi| semi <= 10).and_then(|semi| {
            let name = &rest[1..semi];
            let c = match name {
                "nbsp" => Some(' '),
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "zwnj" | "zwj" | "shy" => Some('\u{200B}'),
                _ => name
                    .strip_prefix("#x")
                    .or_else(|| name.strip_prefix("#X"))
                    .and_then(|h| u32::from_str_radix(h, 16).ok())
                    .or_else(|| name.strip_prefix('#').and_then(|d| d.parse().ok()))
                    .and_then(char::from_u32),
            }?;
            Some((c, semi))
        });
        match decoded {
            Some((c, semi)) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_in(subject: &str, body: &str) -> Option<String> {
        find(subject, body)
    }

    #[test]
    fn finds_codes_in_real_world_formats() {
        let cases = [
            (
                "Your verification code",
                "Your verification code is 482913. It expires in 10 minutes.",
                "482913",
            ),
            ("482913 is your Instagram code", "", "482913"),
            (
                "Google verification",
                "G-482913 is your Google verification code.",
                "G-482913",
            ),
            (
                "Sign in to Acme",
                "Your one-time passcode:\n\n  4829  \n\nDon't share it.",
                "4829",
            ),
            ("Steam", "Your Steam Guard code: F7K2P", "F7K2P"),
            (
                "Confirm your email",
                "Enter this code to confirm: ABC-123",
                "ABC-123",
            ),
            ("Your code", "Your code is 482 913.", "482913"),
            ("Your code", "Security code: 482-913", "482913"),
            ("Login", "Your 2FA code is 48291736", "48291736"),
            ("Acme", "Microsoft account\nSecurity code: 4829", "4829"),
            (
                "Apple",
                "Your Apple ID Code is: 482913. Don't share it with anyone.",
                "482913",
            ),
            (
                "Slack",
                "Your confirmation code is below — enter it in your open browser window.\n\n4F7-K2Q\n",
                "4F7-K2Q",
            ),
        ];
        for (subject, body, want) in cases {
            assert_eq!(
                code_in(subject, body).as_deref(),
                Some(want),
                "{subject} / {body}"
            );
        }
    }

    #[test]
    fn finds_codes_in_other_languages() {
        let cases = [
            ("Código", "Tu código de verificación es 482913", "482913"),
            ("Código", "Seu código é 482913", "482913"),
            (
                "Connexion",
                "Votre code de vérification est : 482913",
                "482913",
            ),
            ("Anmeldung", "Ihr Bestätigungscode lautet 482913", "482913"),
            ("Accesso", "Il tuo codice di verifica è 482913", "482913"),
            ("Вход", "Ваш код: 482913", "482913"),
        ];
        for (subject, body, want) in cases {
            assert_eq!(code_in(subject, body).as_deref(), Some(want), "{body}");
        }
    }

    #[test]
    fn finds_a_code_in_html_on_its_own_line() {
        let html = r#"<html><head><style>.c{font-size:32px}</style></head><body>
            <table><tr><td>Use the code below to sign in to Acme&nbsp;:</td></tr>
            <tr><td class="c"><strong>739&#8203;204</strong></td></tr></table><!-- 111111 --></body></html>"#;
        assert_eq!(
            in_message("Sign in", None, Some(html), "").as_deref(),
            Some("739204")
        );
    }

    #[test]
    fn falls_back_to_the_snippet() {
        assert_eq!(
            in_message(
                "Acme",
                None,
                None,
                "Your login code is 551204. If this wasn&#39;t you…"
            )
            .as_deref(),
            Some("551204")
        );
    }

    #[test]
    fn passes_over_numbers_that_are_not_codes() {
        let cases = [
            ("Your order #48291736 has shipped", "Order code 48291736"),
            ("Thanks", "Order number 482913. Your code will follow."),
            ("Hello", "Your code expires on 2026-11-28."),
            ("Hello", "Your code expires on 11/28/2026 at 10:30."),
            ("Hello", "Your code was sent 28.11.2026."),
            ("Hello", "Use the code before 2026 ends."),
            ("Hello", "Your code costs $1,250.00 or €4829."),
            ("Hello", "We sent a code to your phone ending in 4829."),
            ("Hello", "Didn't request a code? Call +1 (555) 123-4567."),
            ("Hello", "Didn't ask for this code? Call 1-800-555-0199."),
            (
                "Hello",
                "Didn't ask for this code?\nAcme Inc, 1 Main St, Springfield, IL 62704",
            ),
            (
                "Hello",
                "If you didn't request this code, write to Acme Inc, 1 Main St, Springfield, IL 62704",
            ),
            ("Hello", "Use promo code SAVE20 at checkout."),
            ("Spring sale", "Use code SPRING25 for 25% off."),
            ("Hello", "Tracking code: 1Z999AA10123456784"),
            ("Hello", "Your area code 4155 is not supported."),
            (
                "Hello",
                "Reset your password at https://acme.example/reset?code=482913",
            ),
            ("Hello", "Your code: abc123def"),
            ("Hello", "Enter the code we sent you."),
            ("Weekly digest", "482913 people read this week's issue."),
            ("Meeting", "Join the meeting, dial-in access code 482913"),
            ("Your booking", "Confirmation code: XJ4K2P"),
        ];
        for (subject, body) in cases {
            assert_eq!(code_in(subject, body), None, "{subject} / {body}");
        }
    }

    #[test]
    fn needs_a_cue_word() {
        assert_eq!(code_in("Hi", "See you at 482913 Main Road."), None);
        assert_eq!(code_in("Hi", "Thanks!\n\n482913\n\nBye"), None);
    }

    #[test]
    fn freshness_ends_after_an_hour() {
        assert!(fresh(1_000, 1_000 + FRESH_MS - 1));
        assert!(!fresh(1_000, 1_000 + FRESH_MS));
    }
}
