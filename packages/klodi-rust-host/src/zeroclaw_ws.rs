//! Minimal WebSocket client for the ZeroClaw `/ws/chat` surface.
//!
//! Used only by `klodi-zeroclaw-register` to bootstrap the operator
//! session with a single hello line. The daemon does NOT touch WS —
//! per `docs/plans/2026-05-12-klodi-wake-agent-spawn.md` §2, wakes flow
//! NATS → daemon → `POST /api/cron` + `POST /api/cron/{id}/run`, and
//! every operator-facing message comes from the LLM via `sessions_send`
//! inside the spawned agent turn.
//!
//! Gateway contract (observed against ZeroClaw ≥ 0.7.4):
//!
//! - `WS /ws/chat` with no `session_id` query → server emits a
//!   `session_start` frame with a fresh UUID. Used to bootstrap a session.
//! - `WS /ws/chat?session_id=<uuid>` → resumes; emits `session_start`
//!   with `resumed: true` only when `message_count > 0`.
//! - The only accepted send shape is `{"type":"message","content":"<text>"}`.

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use http::{HeaderValue, Request};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

/// Wire-level configuration for talking to a ZeroClaw gateway over WS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZeroClawWsConfig {
    /// `ws://host:port/ws/chat` (or `wss://…` for TLS deployments).
    pub ws_url: String,
    /// `http://host:port` — base URL for the gateway's `/api/...` REST
    /// surface (no trailing slash). Used by the spawn client.
    pub http_base: String,
    /// `zc_<hex>` bearer minted by `/pair`.
    pub bearer: String,
}

impl ZeroClawWsConfig {
    /// Derive a `ZeroClawWsConfig` from the gateway's base URL plus the
    /// resolved bearer. The base is `http(s)://host:port` (no path); WS
    /// path defaults to `/ws/chat`.
    pub fn from_http_base(http_base: &str, bearer: String) -> Result<Self> {
        let trimmed = http_base.trim_end_matches('/');
        let ws_url = http_base_to_ws(trimmed, "/ws/chat")?;
        Ok(Self {
            ws_url,
            http_base: trimmed.to_string(),
            bearer,
        })
    }
}

fn http_base_to_ws(http_base: &str, ws_path: &str) -> Result<String> {
    let (rest, scheme) = if let Some(r) = http_base.strip_prefix("https://") {
        (r, "wss://")
    } else if let Some(r) = http_base.strip_prefix("http://") {
        (r, "ws://")
    } else {
        bail!(
            "ZeroClaw HTTP base {http_base:?} must start with http:// or https:// \
             (refusing to silently downgrade to plaintext WS without an explicit scheme)"
        );
    };
    Ok(format!("{scheme}{rest}{ws_path}"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundFrame {
    SessionStart {
        session_id: String,
        #[serde(default)]
        resumed: bool,
        #[serde(default)]
        message_count: Option<u64>,
    },
    Error {
        code: Option<String>,
        message: Option<String>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Serialize)]
struct OutboundMessage<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    content: &'a str,
}

/// Outcome of [`bootstrap_session_with_first_message`] /
/// [`send_session_message`].
#[derive(Debug, Clone)]
pub struct SessionOutcome {
    pub session_id: String,
    pub resumed: bool,
    pub message_count: Option<u64>,
}

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_ERROR_GRACE: Duration = Duration::from_secs(5);
const SESSION_START_TIMEOUT: Duration = Duration::from_secs(15);

/// Atomic "create a session AND write its first message in one
/// connection." Used by `register` so the operator's chat opens with a
/// single hello line — closes the empty-session GC window the gateway
/// applies to zero-message sessions.
pub async fn bootstrap_session_with_first_message(
    cfg: &ZeroClawWsConfig,
    content: &str,
) -> Result<SessionOutcome> {
    let req = build_ws_request(&cfg.ws_url, &cfg.bearer)?;
    let (mut ws, _resp) = timeout(HANDSHAKE_TIMEOUT, connect_async(req))
        .await
        .with_context(|| format!("WS handshake to {} timed out", cfg.ws_url))?
        .with_context(|| format!("WS handshake to {} failed", cfg.ws_url))?;

    let outcome = await_session_start(&mut ws).await?;
    write_message_and_drain(&mut ws, content).await?;
    let _ = ws.close(None).await;
    Ok(outcome)
}

/// Resume `session_id` and append `content` as a user-role message.
/// Used by register's adopt-existing-session path; agents call
/// `sessions_send` (a ZeroClaw-supplied MCP tool) for their own writes.
pub async fn send_session_message(
    cfg: &ZeroClawWsConfig,
    session_id: &str,
    content: &str,
) -> Result<SessionOutcome> {
    let url = ws_url_with_session(&cfg.ws_url, session_id)?;
    let req = build_ws_request(&url, &cfg.bearer)?;
    let (mut ws, _resp) = timeout(HANDSHAKE_TIMEOUT, connect_async(req))
        .await
        .with_context(|| format!("WS handshake to {url} timed out"))?
        .with_context(|| format!("WS handshake to {url} failed"))?;

    let session_outcome = await_session_start(&mut ws).await?;
    write_message_and_drain(&mut ws, content).await?;
    let _ = ws.close(None).await;
    Ok(session_outcome)
}

async fn write_message_and_drain<S>(ws: &mut S, content: &str) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    let payload = OutboundMessage {
        kind: "message",
        content,
    };
    let bytes =
        serde_json::to_string(&payload).context("encoding ZeroClaw WS message frame")?;
    timeout(SEND_TIMEOUT, ws.send(Message::Text(bytes)))
        .await
        .context("WS send timed out")?
        .context("WS send failed")?;

    // Brief error-grace read — surfaces gateway `error` frames (auth,
    // schema mismatch). Window elapsing is the success signal.
    let drain = async {
        while let Some(frame) = ws.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(err) => bail!("WS read error after send: {err}"),
            };
            if let Message::Text(text) = msg {
                if let Ok(InboundFrame::Error { code, message }) =
                    serde_json::from_str::<InboundFrame>(&text)
                {
                    bail!(
                        "gateway error frame after send: code={} message={}",
                        code.unwrap_or_default(),
                        message.unwrap_or_default(),
                    );
                }
            }
        }
        Ok(())
    };
    match timeout(SEND_ERROR_GRACE, drain).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(err)) => Err(err),
        Err(_elapsed) => Ok(()),
    }
}

async fn await_session_start<S>(ws: &mut S) -> Result<SessionOutcome>
where
    S: futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    let wait = async {
        while let Some(frame) = ws.next().await {
            let msg = frame.context("reading WS frame")?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => bail!("gateway closed WS before session_start"),
                _ => continue,
            };
            let parsed: InboundFrame = match serde_json::from_str(&text) {
                Ok(p) => p,
                Err(_) => continue,
            };
            match parsed {
                InboundFrame::SessionStart {
                    session_id,
                    resumed,
                    message_count,
                } => {
                    return Ok(SessionOutcome {
                        session_id,
                        resumed,
                        message_count,
                    });
                }
                InboundFrame::Error { code, message } => bail!(
                    "gateway error during handshake: code={} message={}",
                    code.unwrap_or_default(),
                    message.unwrap_or_default(),
                ),
                InboundFrame::Other => continue,
            }
        }
        bail!("WS stream closed before session_start")
    };
    timeout(SESSION_START_TIMEOUT, wait)
        .await
        .context("session_start frame timed out")?
}

fn build_ws_request(
    url: &str,
    bearer: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request> {
    let mut req: Request<()> = url
        .into_client_request()
        .with_context(|| format!("constructing WS request for {url}"))?;
    let header = HeaderValue::from_str(&format!("Bearer {bearer}"))
        .context("invalid bearer in WS Authorization header")?;
    req.headers_mut().insert("Authorization", header);
    Ok(req)
}

fn ws_url_with_session(base: &str, session_id: &str) -> Result<String> {
    if session_id.is_empty() {
        bail!("session_id must not be empty");
    }
    let sep = if base.contains('?') { '&' } else { '?' };
    Ok(format!("{base}{sep}session_id={session_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_http_base_derives_ws_url() {
        let cfg =
            ZeroClawWsConfig::from_http_base("http://127.0.0.1:7070", "zc_t".into()).unwrap();
        assert_eq!(cfg.ws_url, "ws://127.0.0.1:7070/ws/chat");
        assert_eq!(cfg.http_base, "http://127.0.0.1:7070");
    }

    #[test]
    fn from_http_base_handles_https() {
        let cfg =
            ZeroClawWsConfig::from_http_base("https://gw.example", "zc_t".into()).unwrap();
        assert_eq!(cfg.ws_url, "wss://gw.example/ws/chat");
    }

    #[test]
    fn from_http_base_rejects_scheme_less() {
        assert!(ZeroClawWsConfig::from_http_base("gw.example", "zc_t".into()).is_err());
    }

    #[test]
    fn from_http_base_trims_trailing_slash() {
        let cfg = ZeroClawWsConfig::from_http_base("http://127.0.0.1:7070/", "zc_t".into())
            .unwrap();
        assert_eq!(cfg.ws_url, "ws://127.0.0.1:7070/ws/chat");
    }

    #[test]
    fn ws_url_with_session_appends_query() {
        let url = ws_url_with_session("ws://127.0.0.1/ws/chat", "abc-123").unwrap();
        assert_eq!(url, "ws://127.0.0.1/ws/chat?session_id=abc-123");
    }
}
