use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
// Full access: permanently deleting mail (Empty Trash/Spam) is refused under gmail.modify.
const SCOPE: &str = "https://mail.google.com/";
const KEYCHAIN_SERVICE: &str = "com.nicboada.mail";
/// Single-account builds stored one token under this name; it moves to the per-account name on first launch.
const LEGACY_KEYCHAIN_USER: &str = "google-refresh-token";

pub struct Token {
    pub access: String,
    pub expires: Instant,
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
        expires: Instant::now() + Duration::from_secs(r.expires_in.saturating_sub(60)),
    }
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

    let (mut sock, _) = tokio::time::timeout(Duration::from_secs(300), listener.accept())
        .await
        .context("sign-in timed out")??;
    let mut buf = vec![0u8; 8192];
    let n = sock.read(&mut buf).await?;
    let request = String::from_utf8_lossy(&buf[..n]);
    let path = request.split_whitespace().nth(1).unwrap_or("/");
    let params = reqwest::Url::parse(&format!("http://localhost{path}"))?;
    let param = |k: &str| {
        params
            .query_pairs()
            .find(|(q, _)| q == k)
            .map(|(_, v)| v.into_owned())
    };
    let body = "<html><body style=\"font-family:system-ui;padding:40px\">Signed in. You can close this tab.</body></html>";
    let _ = sock
        .write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes())
        .await;

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
    let resp: TokenResponse = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", &secret),
            ("refresh_token", &refresh),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(into_token(&resp))
}
