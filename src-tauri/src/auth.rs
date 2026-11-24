use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
// Full access: permanently deleting mail (Empty Trash/Spam) is refused under gmail.modify.
const SCOPE: &str = "https://mail.google.com/";
const KEYCHAIN_SERVICE: &str = "au.com.talkk.shift";
/// Single-account builds stored one token under this name; it moves to the per-account name on first launch.
const LEGACY_KEYCHAIN_USER: &str = "google-refresh-token";

pub struct Token {
    pub access: String,
    /// Wall-clock time: an `Instant` may not count time the Mac spends asleep, so a token would look valid for hours
    /// after it expired.
    pub expires: SystemTime,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

fn client() -> Result<(String, String)> {
    let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let id = get("GOOGLE_CLIENT_ID")
        .or(option_env!("GOOGLE_CLIENT_ID").map(String::from))
        .context("GOOGLE_CLIENT_ID is not set (see README)")?;
    // Google requires the "secret" of a Desktop OAuth client even with PKCE; it is not confidential.
    let secret = get("GOOGLE_CLIENT_SECRET")
        .or(option_env!("GOOGLE_CLIENT_SECRET").map(String::from))
        .unwrap_or_default();
    Ok((id, secret))
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng");
    URL_SAFE_NO_PAD.encode(buf)
}

/// One Keychain item per account, so each Google account keeps its own refresh token.
fn keychain(email: &str) -> Result<keyring::Entry> {
    Ok(keyring::Entry::new(
        KEYCHAIN_SERVICE,
        &format!("{LEGACY_KEYCHAIN_USER}:{}", email.to_lowercase()),
    )?)
}

pub fn store_refresh(email: &str, refresh: &str) -> Result<()> {
    keychain(email)?.set_password(refresh)?;
    Ok(())
}

/// Tells Google to revoke Shift's access for this account, so signing out ends the grant, not just the local copy.
/// Best effort: a failure (offline, already revoked) still lets the sign-out finish.
pub async fn revoke(http: &reqwest::Client, email: &str) {
    let Ok(token) = keychain(email).and_then(|e| Ok(e.get_password()?)) else {
        return;
    };
    if let Err(e) = http
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token.as_str())])
        .send()
        .await
    {
        eprintln!("couldn't revoke {email}'s token: {e}");
    }
}

pub fn forget(email: &str) {
    if let Ok(e) = keychain(email) {
        let _ = e.delete_credential();
    }
}

/// Moves a token saved by the single-account version to this account's own Keychain item.
pub fn migrate_legacy(email: &str) {
    let Ok(old) = keyring::Entry::new(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_USER) else {
        return;
    };
    if let Ok(token) = old.get_password()
        && store_refresh(email, &token).is_ok()
    {
        let _ = old.delete_credential();
    }
}

fn into_token(r: &TokenResponse) -> Token {
    Token {
        access: r.access_token.clone(),
        // refresh a minute early so in-flight requests never carry an expired token
        expires: SystemTime::now() + Duration::from_secs(r.expires_in.saturating_sub(60)),
    }
}

/// The path of an HTTP request's first line, read until its line break (a request can arrive in several reads).
/// None for a connection that sends nothing usable within a few seconds.
async fn read_request_path(sock: &mut tokio::net::TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    let read = async {
        while !buf.windows(2).any(|w| w == b"\r\n") && buf.len() < 16_384 {
            match sock.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
    };
    tokio::time::timeout(Duration::from_secs(5), read)
        .await
        .ok()?;
    let line = String::from_utf8_lossy(&buf);
    line.split_whitespace().nth(1).map(String::from)
}

/// Desktop loopback OAuth flow with PKCE. Opens the system browser and waits for the redirect.
/// Returns the access token and the refresh token; the caller stores the latter once it knows the account.
// shortcut: loopback redirect only works on desktop; iOS/Android need a custom-scheme deep link.
pub async fn sign_in(
    http: &reqwest::Client,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<(Token, String)> {
    let (client_id, secret) = client()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let verifier = random_token();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_token();

    let url = reqwest::Url::parse_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id.as_str()),
            ("redirect_uri", &redirect),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("access_type", "offline"),
            // select_account: adding a second account must not silently reuse the browser's current login.
            ("prompt", "consent select_account"),
        ],
    )?;
    open(url.as_str())?;

    // Browsers open speculative or extra connections (favicon, preconnect), so keep accepting until the redirect
    // itself arrives: the request that carries `state`.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    let params = loop {
        let (mut sock, _) = tokio::time::timeout_at(deadline, listener.accept())
            .await
            .context("sign-in timed out")??;
        let Some(path) = read_request_path(&mut sock).await else {
            continue;
        };
        let params = reqwest::Url::parse(&format!("http://localhost{path}"))?;
        if !params.query_pairs().any(|(k, _)| k == "state") {
            let _ = sock
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await;
            continue;
        }
        let body = "<html><body style=\"font-family:system-ui;padding:40px\">Signed in. You can close this tab.</body></html>";
        let _ = sock
            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
            .await;
        break params;
    };
    let param = |k: &str| {
        params
            .query_pairs()
            .find(|(q, _)| q == k)
            .map(|(_, v)| v.into_owned())
    };
    if param("state").as_deref() != Some(&state) {
        bail!("OAuth state mismatch");
    }
    let Some(code) = param("code") else {
        bail!("sign-in cancelled: {}", param("error").unwrap_or_default());
    };

    let resp: TokenResponse = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", &secret),
            ("code", &code),
            ("code_verifier", &verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", &redirect),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let refresh = resp
        .refresh_token
        .clone()
        .context("Google returned no refresh token")?;
    Ok((into_token(&resp), refresh))
}

pub async fn refresh(http: &reqwest::Client, email: &str) -> Result<Token> {
    let (client_id, secret) = client()?;
    let refresh = keychain(email)?
        .get_password()
        .with_context(|| format!("{email} is signed out; sign in again"))?;
    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", &secret),
            ("refresh_token", &refresh),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?;
    if !resp.status().is_success() {
        let (status, body) = (resp.status(), resp.text().await.unwrap_or_default());
        // Revoked in Google's settings, expired (7 days while the OAuth app is in Testing), or a changed password.
        if body.contains("invalid_grant") {
            bail!(
                "{email}'s sign-in has expired or was revoked: sign in again in Settings → Accounts → Add account"
            );
        }
        bail!(
            "token refresh failed ({status}): {}",
            body.chars().take(300).collect::<String>()
        );
    }
    Ok(into_token(&resp.json::<TokenResponse>().await?))
}
