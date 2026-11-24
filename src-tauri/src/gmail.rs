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

pub fn is_not_found(e: &anyhow::Error) -> bool {
    e.downcast_ref::<ApiError>()
        .is_some_and(|e| e.status == 404)
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
        let mut attempt = 0;
        loop {
            let resp = req().bearer_auth(self.token).send().await?;
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
            if retryable(status, &body) && attempt < 6 {
                attempt += 1;
                eprintln!(
                    "gmail retry {attempt} after {status}: {}",
                    body.split_whitespace()
                        .collect::<String>()
                        .chars()
                        .take(200)
                        .collect::<String>()
                );
                tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(attempt))).await;
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

    /// `full: false` fetches headers, labels and snippet only. That is enough for the list and costs far less quota.
    pub async fn thread(&self, id: &str, full: bool) -> Result<Thread> {
        let path = format!("/threads/{id}");
        if full {
            return self.get(&path, &[("format", "full")]).await;
        }
        let mut q = vec![("format", "metadata")];
        q.extend(
            ["Subject", "From", "To", "Cc", "Message-ID", "References"]
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
        if raw.len() <= MAX_JSON_RAW {
            let (url, body) = (format!("{BASE}{path}"), wrap(message_json(raw, thread_id)));
            return self
                .call(|| self.http.request(method.clone(), &url).json(&body))
                .await;
        }
        let mut meta = serde_json::json!({});
        if let Some(t) = thread_id {
            meta["threadId"] = t.into();
        }
        let (url, body) = (format!("{UPLOAD}{path}"), upload_body(&wrap(meta), raw));
        self.call(|| {
            self.http
                .request(method.clone(), &url)
                .query(&[("uploadType", "multipart")])
                .header(
                    reqwest::header::CONTENT_TYPE,
                    format!("multipart/related; boundary={BOUNDARY}"),
                )
                .timeout(Duration::from_secs(600))
                .body(body.clone())
        })
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
    use super::*;

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
