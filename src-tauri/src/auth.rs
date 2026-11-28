use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};
#[cfg(not(target_os = "ios"))]
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
    // iOS has its own OAuth client: no secret, and a custom-scheme redirect instead of loopback.
    if cfg!(target_os = "ios") {
        let id = option_env!("GOOGLE_IOS_CLIENT_ID")
            .map(String::from)
            .context("GOOGLE_IOS_CLIENT_ID is not set (see README)")?;
        return Ok((id, String::new()));
    }
    let id = get("GOOGLE_CLIENT_ID")
        .or(option_env!("GOOGLE_CLIENT_ID").map(String::from))
        .context("GOOGLE_CLIENT_ID is not set (see README)")?;
    // Google requires the "secret" of a Desktop OAuth client even with PKCE; it is not confidential.
    let secret = get("GOOGLE_CLIENT_SECRET")
        .or(option_env!("GOOGLE_CLIENT_SECRET").map(String::from))
        .unwrap_or_default();
    Ok((id, secret))
}

#[cfg(any(test, target_os = "ios"))]
/// An iOS client's redirect scheme: its client ID reversed (`com.googleusercontent.apps.<number>-<hash>`).
pub fn ios_redirect_scheme(client_id: &str) -> String {
    let prefix = client_id.trim_end_matches(".apps.googleusercontent.com");
    format!("com.googleusercontent.apps.{prefix}")
}

fn random_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("os rng");
    URL_SAFE_NO_PAD.encode(buf)
}

/// A Keychain item. On iOS, the `keyring` crate has no default store, so this uses the data-protection keychain
/// directly, with items readable after the first unlock so a background sync can sign in.
pub fn keychain_entry(service: &str, user: &str) -> Result<keyring_core::Entry> {
    #[cfg(target_os = "ios")]
    {
        static STORE: std::sync::Once = std::sync::Once::new();
        STORE.call_once(|| {
            if let Ok(store) = apple_native_keyring_store::protected::Store::new() {
                keyring_core::set_default_store(store);
            }
        });
        let policy = std::collections::HashMap::from([("access-policy", "after-first-unlock")]);
        Ok(keyring_core::Entry::new_with_modifiers(
            service, user, &policy,
        )?)
    }
    #[cfg(not(target_os = "ios"))]
    Ok(keyring::Entry::new(service, user)?.inner)
}

/// One Keychain item per account, so each Google account keeps its own refresh token.
fn keychain(email: &str) -> Result<keyring_core::Entry> {
    keychain_entry(
        KEYCHAIN_SERVICE,
        &format!("{LEGACY_KEYCHAIN_USER}:{}", email.to_lowercase()),
    )
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

/// An IMAP account's password, kept in the same Keychain item a Google account keeps its refresh token in.
pub fn password(email: &str) -> Result<String> {
    Ok(keychain(email)?.get_password()?)
}

pub fn forget(email: &str) {
    if let Ok(e) = keychain(email) {
        let _ = e.delete_credential();
    }
}

/// Moves a token saved by the single-account version to this account's own Keychain item.
pub fn migrate_legacy(email: &str) {
    let Ok(old) = keychain_entry(KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_USER) else {
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

#[cfg(not(target_os = "ios"))]
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

/// One sign-in attempt: the PKCE verifier and the `state` the redirect must echo.
struct Pkce {
    verifier: String,
    state: String,
}

impl Pkce {
    fn new() -> Self {
        Self {
            verifier: random_token(),
            state: random_token(),
        }
    }

    fn auth_url(&self, client_id: &str, redirect: &str) -> Result<reqwest::Url> {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes()));
        Ok(reqwest::Url::parse_with_params(
            AUTH_URL,
            &[
                ("client_id", client_id),
                ("redirect_uri", redirect),
                ("response_type", "code"),
                ("scope", SCOPE),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("state", &self.state),
                ("access_type", "offline"),
                // select_account: adding a second account must not silently reuse the browser's current login.
                ("prompt", "consent select_account"),
            ],
        )?)
    }

    /// Checks the redirect's `state` and trades its code for tokens: the access token and the refresh token.
    async fn finish(
        &self,
        http: &reqwest::Client,
        (client_id, secret): (&str, &str),
        redirect: &str,
        params: &reqwest::Url,
    ) -> Result<(Token, String)> {
        let param = |k: &str| {
            params
                .query_pairs()
                .find(|(q, _)| q == k)
                .map(|(_, v)| v.into_owned())
        };
        if param("state").as_deref() != Some(&self.state) {
            bail!("OAuth state mismatch");
        }
        let Some(code) = param("code") else {
            bail!("sign-in cancelled: {}", param("error").unwrap_or_default());
        };
        let mut form = vec![
            ("client_id", client_id),
            ("code", &code),
            ("code_verifier", &self.verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", redirect),
        ];
        if !secret.is_empty() {
            form.push(("client_secret", secret));
        }
        let resp: TokenResponse = http
            .post(TOKEN_URL)
            .form(&form)
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
}

#[cfg(not(target_os = "ios"))]
/// Desktop loopback OAuth flow with PKCE. Opens the system browser and waits for the redirect.
/// Returns the access token and the refresh token; the caller stores the latter once it knows the account.
pub async fn sign_in(
    http: &reqwest::Client,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<(Token, String)> {
    let (client_id, secret) = client()?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let pkce = Pkce::new();
    open(pkce.auth_url(&client_id, &redirect)?.as_str())?;

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
    pkce.finish(http, (&client_id, &secret), &redirect, &params)
        .await
}

#[cfg(target_os = "ios")]
/// iOS flow: `authenticate(url, scheme)` shows the system sign-in sheet (ASWebAuthenticationSession) and returns
/// the URL Google redirected to. iOS doesn't let an app listen on loopback for this.
pub async fn sign_in_with_sheet(
    http: &reqwest::Client,
    authenticate: impl FnOnce(String, String) -> Result<String> + Send + 'static,
) -> Result<(Token, String)> {
    let (client_id, secret) = client()?;
    let scheme = ios_redirect_scheme(&client_id);
    let redirect = format!("{scheme}:/oauthredirect");
    let pkce = Pkce::new();
    let url = pkce.auth_url(&client_id, &redirect)?.to_string();
    // The sheet blocks its thread until the user finishes or cancels.
    let callback = tokio::task::spawn_blocking(move || authenticate(url, scheme)).await??;
    let params = reqwest::Url::parse(&callback).context("sign-in returned no address")?;
    pkce.finish(http, (&client_id, &secret), &redirect, &params)
        .await
}

fn refresh_form<'a>(
    client_id: &'a str,
    secret: &'a str,
    refresh: &'a str,
) -> Vec<(&'a str, &'a str)> {
    let mut form = vec![
        ("client_id", client_id),
        ("refresh_token", refresh),
        ("grant_type", "refresh_token"),
    ];
    // iOS clients have no secret, and Google refuses an empty one.
    if !secret.is_empty() {
        form.push(("client_secret", secret));
    }
    form
}

pub async fn refresh(http: &reqwest::Client, email: &str) -> Result<Token> {
    let (client_id, secret) = client()?;
    let refresh = keychain(email)?
        .get_password()
        .with_context(|| format!("{email} is signed out; sign in again"))?;
    let resp = http
        .post(TOKEN_URL)
        .form(&refresh_form(&client_id, &secret, &refresh))
        .send()
        .await?;
    if !resp.status().is_success() {
        let (status, body) = (resp.status(), resp.text().await.unwrap_or_default());
        // Revoked in Google's settings, expired (7 days while the OAuth app is in Testing), or a changed password.
        if body.contains("invalid_grant") {
            let reason = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["error_description"].as_str().map(str::to_owned))
                .unwrap_or_default();
            bail!(
                "sign-in has expired or was revoked (Google: {reason}). Sign in again in Settings → Accounts → Add account"
            );
        }
        bail!(
            "token refresh failed ({status}): {}",
            body.chars().take(300).collect::<String>()
        );
    }
    Ok(into_token(&resp.json::<TokenResponse>().await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ios_redirect_scheme_reverses_the_client_id() {
        assert_eq!(
            ios_redirect_scheme("123-abc.apps.googleusercontent.com"),
            "com.googleusercontent.apps.123-abc"
        );
    }

    #[test]
    fn refresh_form_leaves_out_an_empty_secret() {
        assert!(
            !refresh_form("id", "", "token")
                .iter()
                .any(|(k, _)| *k == "client_secret")
        );
    }
}
