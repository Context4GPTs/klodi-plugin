//! Thin Telegram Bot API client.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md` Telegram is
//! klodi's operator surface: every inbound message becomes an
//! `OperatorMessage` event, every agent reply ships out via
//! `sendMessage`. The client deliberately stays small — no Markdown
//! parsing, no inline keyboards, no webhook handling. The daemon binary
//! drives `poll_updates` in its own task.

use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::time::Duration;
use thiserror::Error;

/// Per-request HTTP timeout. The Telegram API is usually <1s; long-poll
/// `getUpdates` blocks for up to `timeout_secs` server-side, so the
/// client timeout sits comfortably above that.
const HTTP_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Telegram's hard cap on `sendMessage.text` length. We split anything
/// longer at newline boundaries.
const TELEGRAM_TEXT_LIMIT: usize = 4096;

/// Backoff schedule for retrying transient 5xx errors. Single retry on
/// 429 with the server-supplied `retry_after`.
const SEND_RETRY_BACKOFFS: &[Duration] = &[
    Duration::from_secs(1),
    Duration::from_secs(4),
    Duration::from_secs(16),
];

#[derive(Debug, Error)]
pub enum TelegramError {
    #[error("Telegram HTTP transport: {0}")]
    Transport(String),
    #[error("Telegram returned non-2xx: {status} {body}")]
    NonSuccess { status: u16, body: String },
    #[error("Telegram bot token rejected (401)")]
    BadToken,
    #[error("Telegram rate-limited; retry_after={retry_after_seconds}s")]
    RateLimited { retry_after_seconds: u64 },
    #[error("Telegram response decode: {0}")]
    Decode(String),
}

#[derive(Debug, Clone)]
pub struct TelegramClient {
    http: HttpClient,
    bot_token: String,
    /// Configurable base for tests; production wires the real
    /// `https://api.telegram.org`.
    base_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramBot {
    pub id: i64,
    #[serde(default)]
    pub is_bot: bool,
    pub first_name: String,
    #[serde(default)]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUpdate {
    pub update_id: i64,
    #[serde(default)]
    pub message: Option<TelegramMessage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramMessage {
    pub message_id: i64,
    pub date: i64,
    pub chat: TelegramChat,
    pub from: Option<TelegramUser>,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramChat {
    pub id: i64,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub is_bot: bool,
}

#[derive(Debug, Deserialize)]
struct TelegramResponse<T> {
    ok: bool,
    result: Option<T>,
    error_code: Option<i64>,
    description: Option<String>,
    parameters: Option<ResponseParameters>,
}

#[derive(Debug, Deserialize)]
struct ResponseParameters {
    #[serde(default)]
    retry_after: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SendMessageResult {
    message_id: i64,
}

impl TelegramClient {
    pub fn new(bot_token: String) -> Self {
        Self::with_base(bot_token, "https://api.telegram.org".to_string())
    }

    /// Construct against a custom base URL — used by tests pointing
    /// `wiremock` at `http://127.0.0.1:<port>`. Production always uses
    /// `new`.
    pub fn with_base(bot_token: String, base_url: String) -> Self {
        let http = HttpClient::builder()
            .timeout(HTTP_REQUEST_TIMEOUT)
            .user_agent(concat!(
                "klodi-rust-host/",
                env!("CARGO_PKG_VERSION"),
                " (telegram)"
            ))
            .build()
            .expect("building Telegram HTTP client");
        Self {
            http,
            bot_token,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    fn endpoint(&self, method: &str) -> String {
        format!("{}/bot{}/{}", self.base_url, self.bot_token, method)
    }

    /// `POST /sendMessage`. Long texts are split at newline boundaries
    /// to stay under Telegram's 4096-char cap. Returns the `message_id`
    /// of the LAST chunk (the most useful for "did the reply land?"
    /// telemetry).
    pub async fn send(&self, chat_id: i64, text: &str) -> Result<i64, TelegramError> {
        let chunks = split_for_telegram(text);
        let mut last_id = 0;
        for chunk in chunks {
            last_id = self.send_one(chat_id, &chunk).await?;
        }
        Ok(last_id)
    }

    async fn send_one(&self, chat_id: i64, text: &str) -> Result<i64, TelegramError> {
        let url = self.endpoint("sendMessage");
        let body = serde_json::json!({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": true,
        });

        // Retry schedule applies to 5xx transport errors; 429 is honoured
        // once via `retry_after`.
        let mut last_err: Option<TelegramError> = None;
        for (attempt, backoff) in std::iter::once(Duration::ZERO)
            .chain(SEND_RETRY_BACKOFFS.iter().copied())
            .enumerate()
        {
            if attempt > 0 {
                tokio::time::sleep(backoff).await;
            }
            match self.send_request(&url, &body).await {
                Ok(id) => return Ok(id),
                Err(TelegramError::RateLimited { retry_after_seconds }) => {
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_secs(retry_after_seconds)).await;
                        last_err = Some(TelegramError::RateLimited { retry_after_seconds });
                        continue;
                    } else {
                        return Err(TelegramError::RateLimited { retry_after_seconds });
                    }
                }
                Err(err @ TelegramError::BadToken) => return Err(err),
                Err(err @ TelegramError::NonSuccess { status, .. }) if status >= 500 => {
                    last_err = Some(err);
                    continue;
                }
                Err(err @ TelegramError::Transport(_)) => {
                    last_err = Some(err);
                    continue;
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            TelegramError::Transport("retry budget exhausted with no recorded error".into())
        }))
    }

    async fn send_request(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<i64, TelegramError> {
        let resp = self
            .http
            .post(url)
            .header("Content-Type", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|err| TelegramError::Transport(err.to_string()))?;
        decode_response::<SendMessageResult>(resp).await.map(|r| r.message_id)
    }

    /// `GET /getUpdates` with long-poll. Returns `(updates, next_offset)`
    /// where `next_offset` is the value to pass on the following call.
    pub async fn poll_updates(
        &self,
        offset: i64,
        timeout_secs: u32,
    ) -> Result<(Vec<TelegramUpdate>, i64), TelegramError> {
        let url = self.endpoint("getUpdates");
        let body = serde_json::json!({
            "offset": offset,
            "timeout": timeout_secs,
            "allowed_updates": ["message"],
        });
        let resp = self
            .http
            .post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|err| TelegramError::Transport(err.to_string()))?;
        let updates: Vec<TelegramUpdate> = decode_response(resp).await?;
        let next = updates.iter().map(|u| u.update_id).max().unwrap_or(offset - 1) + 1;
        Ok((updates, next))
    }

    /// `GET /getMe` — used by `klodi-zeroclaw-register` to validate that
    /// the operator pasted a real bot token. Surfaces 401 as
    /// `BadToken` distinctly.
    pub async fn get_me(&self) -> Result<TelegramBot, TelegramError> {
        let url = self.endpoint("getMe");
        let resp = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|err| TelegramError::Transport(err.to_string()))?;
        decode_response(resp).await
    }
}

async fn decode_response<T>(resp: reqwest::Response) -> Result<T, TelegramError>
where
    T: for<'de> Deserialize<'de>,
{
    let status = resp.status().as_u16();
    let bytes = resp
        .bytes()
        .await
        .map_err(|err| TelegramError::Transport(err.to_string()))?;
    let body_string = String::from_utf8_lossy(&bytes).to_string();
    if status == 401 {
        return Err(TelegramError::BadToken);
    }
    let parsed: TelegramResponse<T> = serde_json::from_slice(&bytes).map_err(|err| {
        TelegramError::Decode(format!("status={status} body={body_string} err={err}"))
    })?;
    if parsed.ok {
        parsed
            .result
            .ok_or_else(|| TelegramError::Decode(format!("ok=true but missing result: {body_string}")))
    } else {
        if let Some(p) = parsed.parameters {
            if let Some(retry) = p.retry_after {
                return Err(TelegramError::RateLimited {
                    retry_after_seconds: retry,
                });
            }
        }
        if parsed.error_code == Some(401) {
            return Err(TelegramError::BadToken);
        }
        Err(TelegramError::NonSuccess {
            status,
            body: parsed.description.unwrap_or(body_string),
        })
    }
}

/// Split `text` into Telegram-sized chunks at newline boundaries.
/// Preserves order. When a single line exceeds the limit it is split
/// hard at the byte boundary closest to the cap that lies on a UTF-8
/// boundary.
fn split_for_telegram(text: &str) -> Vec<String> {
    if text.len() <= TELEGRAM_TEXT_LIMIT {
        return vec![text.to_string()];
    }
    let mut out: Vec<String> = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if current.len() + line.len() > TELEGRAM_TEXT_LIMIT {
            if !current.is_empty() {
                out.push(std::mem::take(&mut current));
            }
            if line.len() > TELEGRAM_TEXT_LIMIT {
                let mut remainder = line;
                while remainder.len() > TELEGRAM_TEXT_LIMIT {
                    let split_at = utf8_floor(remainder, TELEGRAM_TEXT_LIMIT);
                    out.push(remainder[..split_at].to_string());
                    remainder = &remainder[split_at..];
                }
                if !remainder.is_empty() {
                    current.push_str(remainder);
                }
            } else {
                current.push_str(line);
            }
        } else {
            current.push_str(line);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// Return the greatest index `<= limit` that is a UTF-8 char boundary.
fn utf8_floor(s: &str, limit: usize) -> usize {
    let mut i = limit.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> TelegramClient {
        TelegramClient::with_base("BOT".to_string(), server.uri())
    }

    #[tokio::test]
    async fn send_chunks_long_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/botBOT/sendMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true,
                    "result": { "message_id": 1, "date": 0, "chat": {"id": 1, "type": "private"} }
                })),
            )
            .expect(2)
            .mount(&server)
            .await;
        // 5000-char text with newlines every 1000 chars → splits into two.
        let line = "x".repeat(999);
        let text = std::iter::repeat(line).take(5).collect::<Vec<_>>().join("\n");
        let client = client_for(&server);
        client.send(123, &text).await.unwrap();
    }

    #[tokio::test]
    async fn get_me_validates_bot_token() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/botBOT/getMe"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true,
                    "result": { "id": 7, "is_bot": true, "first_name": "Klodi", "username": "KlodiBot" }
                })),
            )
            .mount(&server)
            .await;
        let bot = client_for(&server).get_me().await.unwrap();
        assert_eq!(bot.username.as_deref(), Some("KlodiBot"));
    }

    #[tokio::test]
    async fn get_me_surfaces_bad_token_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/botBOT/getMe"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let err = client_for(&server).get_me().await.unwrap_err();
        assert!(matches!(err, TelegramError::BadToken), "got {err:?}");
    }

    #[tokio::test]
    async fn poll_updates_advances_offset() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/botBOT/getUpdates"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true,
                    "result": [{
                        "update_id": 10,
                        "message": {
                            "message_id": 1,
                            "date": 0,
                            "chat": { "id": 42, "type": "private" },
                            "text": "hi"
                        }
                    }]
                })),
            )
            .mount(&server)
            .await;
        let client = client_for(&server);
        let (updates, next) = client.poll_updates(0, 1).await.unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(next, 11);
        assert_eq!(updates[0].message.as_ref().unwrap().chat.id, 42);
    }

    #[tokio::test]
    async fn send_retries_on_429_with_retry_after() {
        let server = MockServer::start().await;
        // First call: 429 with retry_after=1. Second call: 200.
        Mock::given(method("POST"))
            .and(path("/botBOT/sendMessage"))
            .and(body_partial_json(serde_json::json!({"chat_id": 42})))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": false,
                    "error_code": 429,
                    "description": "Too Many Requests",
                    "parameters": { "retry_after": 1 }
                })),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/botBOT/sendMessage"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "ok": true,
                    "result": { "message_id": 9, "date": 0, "chat": {"id": 42, "type": "private"} }
                })),
            )
            .mount(&server)
            .await;
        let client = client_for(&server);
        let started = std::time::Instant::now();
        let id = client.send(42, "hi").await.unwrap();
        assert_eq!(id, 9);
        // Should have waited at least the retry_after window.
        assert!(
            started.elapsed() >= Duration::from_millis(900),
            "did not honour retry_after; elapsed={:?}",
            started.elapsed(),
        );
    }

    #[test]
    fn split_for_telegram_short_returns_one() {
        let chunks = split_for_telegram("hello");
        assert_eq!(chunks, vec!["hello".to_string()]);
    }

    #[test]
    fn split_for_telegram_breaks_on_newlines() {
        let line = "x".repeat(2000);
        let text = format!("{line}\n{line}\n{line}");
        let chunks = split_for_telegram(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.len() <= TELEGRAM_TEXT_LIMIT, "chunk too long: {}", c.len());
        }
        let joined: String = chunks.concat();
        assert_eq!(joined, text);
    }
}
