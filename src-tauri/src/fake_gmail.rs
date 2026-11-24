//! A stand-in for Gmail's REST API in tests: a local HTTP server that answers each request through a handler and
//! records what it was sent. While one is running, `gmail::host` points the real client at it, so tests exercise the
//! same request building, parsing and retries as the app.
use std::sync::{Arc, Mutex, MutexGuard};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    /// Path and query, e.g. `/gmail/v1/users/me/threads/t1?format=full`.
    pub path: String,
    pub body: String,
}

static HOST: Mutex<Option<String>> = Mutex::new(None);
/// One fake at a time: tests run in parallel, and the host is global.
static RUNNING: Mutex<()> = Mutex::new(());

pub fn host() -> Option<String> {
    HOST.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

pub struct FakeGmail {
    pub requests: Arc<Mutex<Vec<Request>>>,
    _running: MutexGuard<'static, ()>,
}

impl FakeGmail {
    pub fn requests(&self) -> Vec<Request> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for FakeGmail {
    fn drop(&mut self) {
        *HOST.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

/// Starts the fake; `handler` gets each request with the earlier ones and returns the status and JSON body.
/// Call it inside the async runtime (`tauri::async_runtime::block_on`).
pub fn start(handler: impl Fn(&Request, &[Request]) -> (u16, String) + Send + Sync + 'static) -> FakeGmail {
    let running = RUNNING.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std_listener.set_nonblocking(true).unwrap();
    let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
    *HOST.lock().unwrap() = Some(format!("http://{}", listener.local_addr().unwrap()));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let log = requests.clone();
    let handler = Arc::new(handler);
    tauri::async_runtime::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let (log, handler) = (log.clone(), handler.clone());
            tauri::async_runtime::spawn(async move {
                let Some(req) = read_request(&mut sock).await else { return };
                let earlier: Vec<Request> = log.lock().unwrap().clone();
                let (status, body) = handler(&req, &earlier);
                log.lock().unwrap().push(req);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = sock.write_all(format!("{head}{body}").as_bytes()).await;
            });
        }
    });
    FakeGmail { requests, _running: running }
}

async fn read_request(sock: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let length: usize = head
        .lines()
        .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("content-length")))
        .and_then(|(_, v)| v.trim().parse().ok())
        .unwrap_or(0);
    while buf.len() < head_end + length {
        let n = sock.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let mut first = head.lines().next()?.split(' ');
    Some(Request {
        method: first.next()?.into(),
        path: first.next()?.into(),
        body: String::from_utf8_lossy(&buf[head_end..]).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::{self, Gmail};
    use base64::Engine;

    fn ok(body: serde_json::Value) -> (u16, String) {
        (200, body.to_string())
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn fetches_a_body_gmail_stored_apart() {
        run(async {
            let html = base64::engine::general_purpose::URL_SAFE.encode("<p>long newsletter</p>");
            let fake = start(move |r, _| {
                if r.path.contains("/attachments/B1") {
                    ok(serde_json::json!({ "data": html }))
                } else if r.path.contains("/attachments/B2") {
                    // That message was deleted after the thread was read.
                    (404, r#"{"error":{"code":404}}"#.into())
                } else {
                    ok(serde_json::json!({ "id": "t1", "messages": [{ "id": "m1", "payload": {
                        "mimeType": "text/html", "body": { "attachmentId": "B1", "size": 90000 } } },
                        { "id": "m2", "payload": { "mimeType": "text/html", "body": { "attachmentId": "B2", "size": 90000 } } }] }))
                }
            });
            let http = reqwest::Client::new();
            let t = Gmail { http: &http, token: "t" }.thread("t1", true).await.unwrap();
            assert_eq!(t.messages[0].body("text/html").as_deref(), Some("<p>long newsletter</p>"));
            assert_eq!(t.messages[1].body("text/html"), None, "a body that's gone doesn't fail the whole thread");
            let paths: Vec<String> = fake.requests().into_iter().map(|r| r.path).collect();
            assert!(paths[0].starts_with("/gmail/v1/users/me/threads/t1?format=full"), "{paths:?}");
            assert_eq!(paths[1], "/gmail/v1/users/me/messages/m1/attachments/B1");
        });
    }

    #[test]
    fn trash_and_untrash_use_their_own_endpoints() {
        run(async {
            let fake = start(|_, _| ok(serde_json::json!({})));
            let http = reqwest::Client::new();
            let g = Gmail { http: &http, token: "t" };
            crate::apply_remote(&g, "t1", &["TRASH".into()], &["INBOX".into()], true).await.unwrap();
            crate::apply_remote(&g, "t1", &["INBOX".into()], &["TRASH".into()], false).await.unwrap();
            let reqs = fake.requests();
            assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("POST", "/gmail/v1/users/me/threads/t1/trash"));
            assert_eq!(reqs[1].path, "/gmail/v1/users/me/threads/t1/untrash");
            assert_eq!(reqs[2].path, "/gmail/v1/users/me/threads/t1/modify");
            let body: serde_json::Value = serde_json::from_str(&reqs[2].body).unwrap();
            assert_eq!(body["addLabelIds"], serde_json::json!(["INBOX"]));
            assert_eq!(body["removeLabelIds"], serde_json::json!([]), "TRASH goes through untrash, not modify");
        });
    }

    #[test]
    fn batch_modify_sends_a_thousand_messages_per_call() {
        run(async {
            let fake = start(|_, _| (204, String::new()));
            let http = reqwest::Client::new();
            let ids: Vec<String> = (0..1500).map(|i| format!("m{i}")).collect();
            Gmail { http: &http, token: "t" }.batch_modify(&ids, &[], &["INBOX"]).await.unwrap();
            let sizes: Vec<usize> = fake
                .requests()
                .iter()
                .map(|r| serde_json::from_str::<serde_json::Value>(&r.body).unwrap()["ids"].as_array().unwrap().len())
                .collect();
            assert_eq!(sizes, [1000, 500]);
        });
    }

    #[test]
    fn rate_limits_are_retried_and_an_expired_history_says_so() {
        run(async {
            let fake = start(|r, earlier| {
                if r.path.contains("/history") {
                    (404, r#"{"error":{"code":404}}"#.into())
                } else if earlier.is_empty() {
                    (429, r#"{"error":{"message":"rateLimitExceeded"}}"#.into())
                } else {
                    ok(serde_json::json!({ "emailAddress": "me@x.com", "historyId": "7" }))
                }
            });
            let http = reqwest::Client::new();
            let g = Gmail { http: &http, token: "t" };
            assert_eq!(g.profile().await.unwrap().0, "me@x.com");
            assert_eq!(fake.requests().len(), 2, "one refusal, one retry");
            let err = g.history("5").await.unwrap_err();
            assert!(gmail::is_not_found(&err), "{err:#}");
        });
    }
}
