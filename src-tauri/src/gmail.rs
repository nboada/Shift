use anyhow::Result;
use base64::{
    Engine,
    alphabet::URL_SAFE,
    engine::{
        DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig, general_purpose::URL_SAFE_NO_PAD,
    },
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;
use std::time::Duration;

const BASE: &str = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD: &str = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
/// Raw messages up to this size are sent inline as base64 JSON; bigger ones use the upload endpoint.
const MAX_JSON_RAW: usize = 3 * 1024 * 1024;
const BOUNDARY: &str = "shift-upload-7d1f3a9c2b";

// Gmail pads base64url bodies inconsistently.
const B64: GeneralPurpose = GeneralPurpose::new(
    &URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    #[serde(default)]
    pub label_ids: Vec<String>,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub internal_date: String,
    pub payload: Option<Part>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    #[serde(default)]
    pub mime_type: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub headers: Vec<Header>,
    pub body: Option<Body>,
    #[serde(default)]
    pub parts: Vec<Part>,
}

#[derive(Deserialize, Debug)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Body {
    pub data: Option<String>,
    /// Set for attachments stored apart from the message; fetch with `attachment`.
    pub attachment_id: Option<String>,
    #[serde(default)]
    pub size: i64,
}

/// A file part of a message. Without `attachment_id` the bytes came inline in `data`.
#[derive(Debug, PartialEq)]
pub struct Attachment {
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    pub attachment_id: Option<String>,
    /// Content-ID without angle brackets, for inline images referenced as `cid:` in the HTML.
    pub content_id: Option<String>,
    pub data: Option<Vec<u8>>,
}

#[derive(Deserialize)]
pub struct Label {
    pub id: String,
    pub name: String,
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub color: Option<LabelColor>,
}

/// A Gmail draft and the message holding its current content.
#[derive(Deserialize)]
pub struct DraftRef {
    pub id: String,
    pub message: DraftMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftMessage {
    pub id: String,
    pub thread_id: String,
}

#[derive(Deserialize)]
pub struct LabelColor {
    #[serde(rename = "backgroundColor")]
    pub background: String,
}

impl Message {
    pub fn header(&self, name: &str) -> String {
        self.payload
            .as_ref()
            .and_then(|p| p.headers.iter().find(|h| h.name.eq_ignore_ascii_case(name)))
            .map(|h| h.value.clone())
            .unwrap_or_default()
    }

    pub fn date_ms(&self) -> i64 {
        self.internal_date.parse().unwrap_or(0)
    }

    /// First inline (non-attachment) body of the given MIME type, decoded.
    pub fn body(&self, mime: &str) -> Option<String> {
        fn walk(p: &Part, mime: &str) -> Option<String> {
            if p.mime_type == mime && p.filename.is_empty() {
                let data = p.body.as_ref()?.data.as_ref()?;
                return B64
                    .decode(data)
                    .ok()
                    .map(|b| String::from_utf8_lossy(&b).into_owned());
            }
            p.parts.iter().find_map(|c| walk(c, mime))
        }
        walk(self.payload.as_ref()?, mime)
    }

    /// Every part with a filename, plus inline non-text parts referenced by Content-ID.
    pub fn attachments(&self) -> Vec<Attachment> {
        fn walk(p: &Part, out: &mut Vec<Attachment>) {
            let content_id = p
                .headers
                .iter()
                .find(|h| h.name.eq_ignore_ascii_case("Content-ID"))
                .map(|h| h.value.trim().trim_matches(['<', '>']).to_string())
                .filter(|c| !c.is_empty());
            let file = !p.filename.is_empty()
                || (content_id.is_some() && !p.mime_type.starts_with("text/"));
            if file && !p.mime_type.starts_with("multipart/") {
                let body = p.body.as_ref();
                out.push(Attachment {
                    filename: p.filename.clone(),
                    mime_type: p.mime_type.clone(),
                    size: body.map_or(0, |b| b.size),
                    attachment_id: body.and_then(|b| b.attachment_id.clone()),
                    content_id,
                    data: body
                        .and_then(|b| b.data.as_deref())
                        .and_then(|d| B64.decode(d).ok()),
                });
            }
            p.parts.iter().for_each(|c| walk(c, out));
        }
        let mut out = Vec::new();
        if let Some(p) = &self.payload {
            walk(p, &mut out);
        }
        out
    }
}

pub struct Gmail<'a> {
    pub http: &'a reqwest::Client,
    pub token: &'a str,
}

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub body: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(
            f,
            "Gmail API {}: {}",
            self.status,
            self.body.chars().take(300).collect::<String>()
        )
    }
}
impl std::error::Error for ApiError {}

fn message_json(raw: &[u8], thread_id: Option<&str>) -> Value {
    let mut m = serde_json::json!({ "raw": URL_SAFE_NO_PAD.encode(raw) });
    if let Some(t) = thread_id {
        m["threadId"] = t.into();
    }
    m
}

/// multipart/related body for the upload endpoint: JSON metadata, then the RFC 5322 message.
fn upload_body(meta: &Value, raw: &[u8]) -> Vec<u8> {
    let mut body = format!(
        "--{BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{BOUNDARY}\r\nContent-Type: message/rfc822\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(raw);
    body.extend_from_slice(format!("\r\n--{BOUNDARY}--\r\n").as_bytes());
    body
}

/// The account signed in before Shift asked for full access, so Gmail refuses calls that need it.
pub fn is_scope_error(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>().is_some_and(|e| {
        e.status == 403
            && (e.body.contains("insufficientPermissions") || e.body.contains("SCOPE_INSUFFICIENT"))
    })
}

pub fn is_unauthorized(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>()
        .is_some_and(|e| e.status == 401)
}

pub fn is_not_found(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>()
        .is_some_and(|e| e.status == 404)
}

/// Whether a failed call may work later as is: the network, a timeout, quota or a Gmail outage. Anything Gmail itself
/// refused (a bad request, a missing thread) won't, and isn't worth retrying.
pub fn is_transient(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>().is_none_or(|e| retryable(e.status, &e.body))
}

/// Gmail signals quota exhaustion as 429 or as 403 with a rateLimitExceeded reason.
fn retryable(status: u16, body: &str) -> bool {
    status == 429 || status >= 500 || (status == 403 && body.contains("ateLimitExceeded"))
}

impl Gmail<'_> {
    async fn call<T: DeserializeOwned>(
        &self,
        req: impl Fn() -> reqwest::RequestBuilder,
    ) -> Result<T> {
        self.call_opts(req, true).await
    }

    /// `retry_5xx: false` for requests that mustn't repeat: a 5xx can come after Gmail already acted on it.
    /// Rate-limit refusals are still retried, since Gmail rejected those before doing anything.
    async fn call_opts<T: DeserializeOwned>(
        &self,
        req: impl Fn() -> reqwest::RequestBuilder,
        retry_5xx: bool,
    ) -> Result<T> {
        let mut attempt = 0;
        loop {
            let resp = match req().bearer_auth(self.token).send().await {
                Ok(r) => r,
                // A dropped or stalled connection is as retryable as a 5xx, with the same caveat for writes.
                Err(e) if retry_5xx && (e.is_timeout() || e.is_connect()) && attempt < 3 => {
                    attempt += 1;
                    eprintln!("gmail retry {attempt} after network error: {e}");
                    tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
                    continue;
                }
                Err(e) => return Err(e.into()),
            };
            let status = resp.status().as_u16();
            if resp.status().is_success() {
                // Some endpoints (drafts.delete) answer 204 with no body.
                let text = resp.text().await?;
                return Ok(serde_json::from_str(if text.trim().is_empty() {
                    "null"
                } else {
                    &text
                })?);
            }
            let body = resp.text().await.unwrap_or_default();
            if retryable(status, &body) && (retry_5xx || status < 500) && attempt < 6 {
                attempt += 1;
                eprintln!(
                    "gmail retry {attempt} after {status}: {}",
                    body.split_whitespace()
                        .collect::<String>()
                        .chars()
                        .take(200)
                        .collect::<String>()
                );
                // Jitter, as Google's backoff guidance asks: 4 parallel workers otherwise retry in lockstep.
                let mut r = [0u8; 2];
                let _ = getrandom::fill(&mut r);
                let jitter = u64::from(u16::from_le_bytes(r)) % 1000;
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt) + jitter)).await;
                continue;
            }
            return Err(ApiError { status, body }.into());
        }
    }

    async fn get<T: DeserializeOwned>(&self, path: &str, query: &[(&str, &str)]) -> Result<T> {
        let url = format!("{BASE}{path}");
        self.call(|| self.http.get(&url).query(query)).await
    }

    async fn post<T: DeserializeOwned>(&self, path: &str, body: &Value) -> Result<T> {
        let url = format!("{BASE}{path}");
        self.call(|| self.http.post(&url).json(body)).await
    }

    pub async fn profile(&self) -> Result<(String, String)> {
        let v: Value = self.get("/profile", &[]).await?;
        Ok((
            v["emailAddress"].as_str().unwrap_or_default().into(),
            v["historyId"].as_str().unwrap_or_default().into(),
        ))
    }

    /// A draft's Bcc line, which the local cache doesn't keep.
    pub async fn draft_bcc(&self, id: &str) -> Result<String> {
        #[derive(Deserialize)]
        struct R {
            message: Message,
        }
        let r: R = self
            .get(&format!("/drafts/{id}"), &[("format", "metadata"), ("metadataHeaders", "Bcc")])
            .await?;
        Ok(r.message.header("Bcc"))
    }

    /// The account's drafts, newest first.
    // shortcut: first 500 only, enough for a person's Drafts; page with nextPageToken if someone has more.
    pub async fn drafts(&self) -> Result<Vec<DraftRef>> {
        #[derive(Deserialize)]
        struct R {
            #[serde(default)]
            drafts: Vec<DraftRef>,
        }
        Ok(self.get::<R>("/drafts", &[("maxResults", "500")]).await?.drafts)
    }

    pub async fn labels(&self) -> Result<Vec<Label>> {
        #[derive(Deserialize)]
        struct R {
            #[serde(default)]
            labels: Vec<Label>,
        }
        Ok(self.get::<R>("/labels", &[]).await?.labels)
    }

    /// Thread ids matching `q` (Gmail search syntax), newest first.
    pub async fn thread_ids(
        &self,
        q: &str,
        label: Option<&str>,
        max: usize,
    ) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut page = String::new();
        while ids.len() < max {
            let mut query = vec![("q", q), ("maxResults", "100")];
            if let Some(l) = label {
                query.push(("labelIds", l));
            }
            if !page.is_empty() {
                query.push(("pageToken", &page));
            }
            let v: Value = self.get("/threads", &query).await?;
            ids.extend(
                v["threads"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t["id"].as_str().map(String::from)),
            );
            match v["nextPageToken"].as_str() {
                Some(t) => page = t.into(),
                None => break,
            }
        }
        ids.truncate(max);
        Ok(ids)
    }

    /// One page of thread ids for `label` (or a search `q`), from `page` (empty: the newest), with the next page's
    /// token if there is one. Trash and Spam are only listed when asked for by label.
    pub async fn thread_page(
        &self,
        q: &str,
        label: Option<&str>,
        page: &str,
    ) -> Result<(Vec<String>, Option<String>)> {
        let mut query = vec![("q", q), ("maxResults", "50")];
        if let Some(l) = label {
            query.push(("labelIds", l));
            if l == "TRASH" || l == "SPAM" {
                query.push(("includeSpamTrash", "true"));
            }
        }
        if !page.is_empty() {
            query.push(("pageToken", page));
        }
        let v: Value = self.get("/threads", &query).await?;
        let ids = v["threads"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["id"].as_str().map(String::from))
            .collect();
        Ok((ids, v["nextPageToken"].as_str().map(String::from)))
    }

    /// How many unread threads a label has in Gmail, including ones not cached here.
    pub async fn unread_threads(&self, label: &str) -> Result<i64> {
        let v: Value = self.get(&format!("/labels/{label}"), &[]).await?;
        Ok(v["threadsUnread"].as_i64().unwrap_or(0))
    }

    /// `full: false` fetches headers, labels and snippet only. That is enough for the list and costs far less quota.
    pub async fn thread(&self, id: &str, full: bool) -> Result<Thread> {
        let path = format!("/threads/{id}");
        if full {
            return self.get(&path, &[("format", "full")]).await;
        }
        let mut q = vec![("format", "metadata")];
        q.extend(
            ["Subject", "From", "To", "Cc", "Reply-To", "Message-ID", "References"]
                .map(|h| ("metadataHeaders", h)),
        );
        self.get(&path, &q).await
    }

    /// Thread ids touched since `start`, plus the new history id. Err(not found) means resync.
    pub async fn history(&self, start: &str) -> Result<(Vec<String>, String)> {
        let mut ids = Vec::new();
        let mut page = String::new();
        loop {
            let mut query = vec![("startHistoryId", start)];
            if !page.is_empty() {
                query.push(("pageToken", &page));
            }
            let v: Value = self.get("/history", &query).await?;
            for h in v["history"].as_array().into_iter().flatten() {
                for m in h["messages"].as_array().into_iter().flatten() {
                    if let Some(t) = m["threadId"].as_str()
                        && !ids.iter().any(|i| i == t)
                    {
                        ids.push(t.to_string());
                    }
                }
            }
            match v["nextPageToken"].as_str() {
                Some(t) => page = t.into(),
                None => return Ok((ids, v["historyId"].as_str().unwrap_or(start).into())),
            }
        }
    }

    pub async fn modify(&self, thread: &str, add: &[String], remove: &[String]) -> Result<()> {
        let _: Value = self
            .post(
                &format!("/threads/{thread}/modify"),
                &serde_json::json!({ "addLabelIds": add, "removeLabelIds": remove }),
            )
            .await?;
        Ok(())
    }

    /// Ids of messages matching `q` that carry every label in `labels`.
    pub async fn message_ids(&self, q: &str, labels: &[&str]) -> Result<Vec<String>> {
        let mut ids = Vec::new();
        let mut page = String::new();
        loop {
            let mut query = vec![
                ("q", q),
                ("maxResults", "500"),
                ("includeSpamTrash", "true"),
            ];
            query.extend(labels.iter().map(|l| ("labelIds", *l)));
            if !page.is_empty() {
                query.push(("pageToken", &page));
            }
            let v: Value = self.get("/messages", &query).await?;
            ids.extend(
                v["messages"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|m| m["id"].as_str().map(String::from)),
            );
            match v["nextPageToken"].as_str() {
                Some(t) => page = t.into(),
                None => return Ok(ids),
            }
        }
    }

    /// One call per 1000 messages, against one call per thread for `modify`.
    pub async fn batch_modify(&self, ids: &[String], add: &[&str], remove: &[&str]) -> Result<()> {
        for chunk in ids.chunks(1000) {
            let _: Value = self
                .post(
                    "/messages/batchModify",
                    &serde_json::json!({ "ids": chunk, "addLabelIds": add, "removeLabelIds": remove }),
                )
                .await?;
        }
        Ok(())
    }

    /// Permanent: skips Trash. Needs the full https://mail.google.com/ scope.
    pub async fn batch_delete(&self, ids: &[String]) -> Result<()> {
        for chunk in ids.chunks(1000) {
            let _: Value = self
                .post(
                    "/messages/batchDelete",
                    &serde_json::json!({ "ids": chunk }),
                )
                .await?;
        }
        Ok(())
    }

    /// Creates a user label shown in Gmail's label list and message list; returns it with its new id.
    pub async fn create_label(&self, name: &str) -> Result<Label> {
        self.post(
            "/labels",
            &serde_json::json!({ "name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show" }),
        )
        .await
    }

    pub async fn patch_label(&self, id: &str, body: &Value) -> Result<()> {
        let url = format!("{BASE}/labels/{id}");
        let _: Value = self.call(|| self.http.patch(&url).json(body)).await?;
        Ok(())
    }

    pub async fn delete_label(&self, id: &str) -> Result<()> {
        let url = format!("{BASE}/labels/{id}");
        let _: Value = self.call(|| self.http.delete(&url)).await?;
        Ok(())
    }

    pub async fn untrash(&self, thread: &str) -> Result<()> {
        let _: Value = self
            .post(
                &format!("/threads/{thread}/untrash"),
                &serde_json::json!({}),
            )
            .await?;
        Ok(())
    }

    pub async fn trash(&self, thread: &str) -> Result<()> {
        let _: Value = self
            .post(&format!("/threads/{thread}/trash"), &serde_json::json!({}))
            .await?;
        Ok(())
    }

    /// Writes a message to `path`. `wrap` puts the message object where the endpoint wants it.
    /// Gmail rejects JSON bodies over about 5 MB, so bigger messages go to the upload endpoint as message/rfc822.
    async fn write_message(
        &self,
        method: reqwest::Method,
        path: &str,
        raw: &[u8],
        thread_id: Option<&str>,
        wrap: impl Fn(Value) -> Value,
    ) -> Result<Value> {
        // Sends and new drafts aren't retried after a 5xx or network error: Gmail may have acted already, and a repeat
        // would send twice or leave a duplicate draft. (Updating a draft with PUT is safe to repeat.)
        let retry_5xx = method != reqwest::Method::POST;
        if raw.len() <= MAX_JSON_RAW {
            let (url, body) = (format!("{BASE}{path}"), wrap(message_json(raw, thread_id)));
            return self
                .call_opts(
                    || self.http.request(method.clone(), &url).json(&body),
                    retry_5xx,
                )
                .await;
        }
        let mut meta = serde_json::json!({});
        if let Some(t) = thread_id {
            meta["threadId"] = t.into();
        }
        let (url, body) = (format!("{UPLOAD}{path}"), upload_body(&wrap(meta), raw));
        self.call_opts(
            || {
                self.http
                    .request(method.clone(), &url)
                    .query(&[("uploadType", "multipart")])
                    .header(
                        reqwest::header::CONTENT_TYPE,
                        format!("multipart/related; boundary={BOUNDARY}"),
                    )
                    .timeout(Duration::from_secs(600))
                    .body(body.clone())
            },
            retry_5xx,
        )
        .await
    }

    pub async fn send(&self, raw: &[u8], thread_id: Option<&str>) -> Result<()> {
        self.write_message(
            reqwest::Method::POST,
            "/messages/send",
            raw,
            thread_id,
            |m| m,
        )
        .await?;
        Ok(())
    }

    /// Creates (no id) or replaces a Gmail draft; returns its id.
    pub async fn save_draft(
        &self,
        id: Option<&str>,
        raw: &[u8],
        thread_id: Option<&str>,
    ) -> Result<String> {
        let wrap = |m| serde_json::json!({ "message": m });
        let v = match id {
            Some(id) => {
                self.write_message(
                    reqwest::Method::PUT,
                    &format!("/drafts/{id}"),
                    raw,
                    thread_id,
                    wrap,
                )
                .await?
            }
            None => {
                self.write_message(reqwest::Method::POST, "/drafts", raw, thread_id, wrap)
                    .await?
            }
        };
        Ok(v["id"].as_str().unwrap_or_default().to_string())
    }

    /// Sends a draft with its latest content; Gmail removes it from Drafts.
    pub async fn send_draft(&self, id: &str, raw: &[u8], thread_id: Option<&str>) -> Result<()> {
        self.write_message(
            reqwest::Method::POST,
            "/drafts/send",
            raw,
            thread_id,
            |m| serde_json::json!({ "id": id, "message": m }),
        )
        .await?;
        Ok(())
    }

    /// Bytes of an attachment stored apart from its message.
    pub async fn attachment(&self, message: &str, id: &str) -> Result<Vec<u8>> {
        let v: Value = self
            .get(&format!("/messages/{message}/attachments/{id}"), &[])
            .await?;
        Ok(B64.decode(v["data"].as_str().unwrap_or_default())?)
    }

    pub async fn delete_draft(&self, id: &str) -> Result<()> {
        let url = format!("{BASE}/drafts/{id}");
        let _: Value = self.call(|| self.http.delete(&url)).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn transient_errors_are_network_quota_and_outages() {
        let api = |status, body: &str| anyhow::Error::new(ApiError { status, body: body.into() });
        assert!(is_transient(&anyhow::anyhow!("connection refused")));
        assert!(is_transient(&api(503, "")));
        assert!(is_transient(&api(429, "")));
        assert!(!is_transient(&api(400, "invalid label")));
        assert!(!is_transient(&api(404, "")));
    }
    use super::*;

    #[test]
    fn insufficient_scope_is_recognised() {
        let err = |status, body: &str| {
            anyhow::Error::from(ApiError {
                status,
                body: body.into(),
            })
        };
        assert!(is_scope_error(&err(
            403,
            r#"{"error":{"errors":[{"reason":"insufficientPermissions"}]}}"#
        )));
        assert!(!is_scope_error(&err(403, "rateLimitExceeded")));
        assert!(!is_scope_error(&err(404, "insufficientPermissions")));
    }

    #[test]
    fn rate_limit_403_is_retryable_but_permission_403_is_not() {
        assert!(retryable(
            403,
            r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#
        ));
        assert!(retryable(429, ""));
        assert!(!retryable(
            403,
            r#"{"error":{"errors":[{"reason":"insufficientPermissions"}]}}"#
        ));
        assert!(!retryable(404, ""));
    }

    #[test]
    fn upload_body_wraps_metadata_and_message() {
        let body = String::from_utf8(upload_body(
            &serde_json::json!({ "message": { "threadId": "t" } }),
            b"Subject: hi\r\n\r\nbody",
        ))
        .unwrap();
        assert!(
            body.starts_with(&format!("--{BOUNDARY}\r\nContent-Type: application/json")),
            "{body}"
        );
        assert!(body.contains(r#"{"message":{"threadId":"t"}}"#), "{body}");
        assert!(
            body.contains("Content-Type: message/rfc822\r\n\r\nSubject: hi"),
            "{body}"
        );
        assert!(body.ends_with(&format!("--{BOUNDARY}--\r\n")), "{body}");
    }

    #[test]
    fn finds_nested_bodies_and_attachments() {
        let json = r#"{"id":"m","payload":{"mimeType":"multipart/mixed","headers":[{"name":"Subject","value":"Hi"}],"parts":[
            {"mimeType":"multipart/related","parts":[
                {"mimeType":"multipart/alternative","parts":[
                    {"mimeType":"text/plain","body":{"data":"aGVsbG8"}},
                    {"mimeType":"text/html","body":{"data":"PGI-aGk8L2I-"}}]},
                {"mimeType":"image/png","headers":[{"name":"Content-ID","value":"<logo@x>"}],"body":{"attachmentId":"A1","size":120}}]},
            {"mimeType":"text/plain","filename":"a.txt","body":{"data":"bm8","size":2}},
            {"mimeType":"application/pdf","filename":"c.pdf","body":{"attachmentId":"A2","size":5000}}]}}"#;
        let m: Message = serde_json::from_str(json).unwrap();
        assert_eq!(m.header("subject"), "Hi");
        assert_eq!(m.body("text/plain").as_deref(), Some("hello"));
        assert_eq!(m.body("text/html").as_deref(), Some("<b>hi</b>"));
        let a = m.attachments();
        assert_eq!(
            a.iter()
                .map(|a| (a.filename.as_str(), a.mime_type.as_str(), a.size))
                .collect::<Vec<_>>(),
            [
                ("", "image/png", 120),
                ("a.txt", "text/plain", 2),
                ("c.pdf", "application/pdf", 5000)
            ]
        );
        assert_eq!(a[0].content_id.as_deref(), Some("logo@x"));
        assert_eq!(a[0].attachment_id.as_deref(), Some("A1"));
        assert_eq!(a[1].data.as_deref(), Some(&b"no"[..]));
        assert_eq!(a[2].content_id, None);
    }
}
