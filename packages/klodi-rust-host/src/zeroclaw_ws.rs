//! Minimal WebSocket client for the ZeroClaw `/ws/chat` surface.
//!
//! Gateway contract (observed against ZeroClaw ≥ 0.7.4):
//!
//! - `WS /ws/chat` with no `session_id` query → server emits a
//!   `session_start` frame with a fresh UUID. Used to bootstrap a session.
//! - `WS /ws/chat?session_id=<uuid>` → resumes; emits `session_start`
//!   with `resumed: true`.
//! - The only accepted send shape is `{"type":"message","content":"<text>"}`.
//!   Anything else returns `UNKNOWN_MESSAGE_TYPE`.
//! - Sending the message persists it as a `user`-role message **and**
//!   triggers the agent loop. The 30s `TimeoutLayer` on `/webhook` does
//!   not apply here — frame writes return as soon as the gateway
//!   acknowledges the WS message, independent of how long the agent
//!   takes to reason about it. This is the architectural primitive that
//!   the wake-delivery path relies on.
//!
//! Connection lifecycle in this module is **short-lived**: every public
//! function opens its own connection, performs one round-trip, and closes.
//! The forwarder and MCP server both pay the WS handshake cost per send
//! (~50–200ms over loopback against the local ZeroClaw gateway), but each
//! call is independent — no long-lived state to reconnect / authorize /
//! reason about across processes. A future revision can pool connections
//! per-process if measured latency demands it.

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

/// Wire-level configuration for talking to a ZeroClaw gateway over both
/// WS (`/ws/chat`) and HTTP (`/api/sessions/...`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZeroClawWsConfig {
    /// `ws://host:port/ws/chat` (or `wss://…` for TLS deployments).
    pub ws_url: String,
    /// `http://host:port` — base URL for the gateway's `/api/...` REST
    /// surface (no trailing slash).
    pub http_base: String,
    /// `zc_<hex>` bearer minted by `/pair`. Sent as
    /// `Authorization: Bearer …` on both WS upgrades and REST calls.
    pub bearer: String,
}

impl ZeroClawWsConfig {
    /// Derive a `ZeroClawWsConfig` from the daemon's `--zeroclaw-webhook-url`
    /// (which today carries the gateway base in the `<scheme>://<host>:<port>`
    /// prefix) and the resolved bearer.
    ///
    /// Strips a trailing `/webhook` (the daemon's existing wake URL) and
    /// substitutes `/ws/chat`. Keeps any non-canonical sub-path intact —
    /// e.g. `https://gw.example/zc/webhook` → `wss://gw.example/zc/ws/chat`
    /// + http base `https://gw.example/zc`.
    pub fn from_webhook_url(webhook_url: &str, bearer: String) -> Result<Self> {
        let trimmed = webhook_url.trim_end_matches('/');
        let base = trimmed
            .strip_suffix("/webhook")
            .ok_or_else(|| anyhow::anyhow!(
                "cannot derive ZeroClaw WS config from webhook URL {webhook_url:?}: \
                 expected trailing '/webhook'. Set ZEROCLAW_WS_URL + ZEROCLAW_HTTP_URL \
                 explicitly when the gateway lives at a non-canonical path."
            ))?;
        let ws_url = http_base_to_ws(base, "/ws/chat")?;
        Ok(Self {
            ws_url,
            http_base: base.to_string(),
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

/// Frames the gateway emits down the WS. The variants below are the
/// subset this client cares about; everything else parses into `Other`
/// so unknown server-side additions don't break us.
///
/// Observed against the gateway (2026-05-10): only `session_start`,
/// `agent_start`, and `error` were observed during research. A
/// `turn_complete` frame is referenced in upstream source but was not
/// captured during the live probe — we deliberately don't depend on it.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundFrame {
    /// Sent immediately after a successful WS upgrade. Carries the
    /// session UUID (whether freshly minted or resumed).
    ///
    /// Observed against the gateway: `resumed` is `true` only when the
    /// resumed session has `message_count > 0`. Empty (zero-message)
    /// sessions resume with `resumed: false` despite the id matching.
    /// Treat the echoed `session_id` as the source of truth for "did
    /// the resume succeed?"; the `resumed` flag is informational.
    SessionStart {
        session_id: String,
        #[serde(default)]
        resumed: bool,
        #[serde(default)]
        message_count: Option<u64>,
    },
    /// Per-frame agent-loop signal that *some* turn started. Not
    /// necessarily *our* turn — the gateway doesn't carry a
    /// per-message ack today (known gap); this client treats it as a
    /// "your message landed and processing has begun" hint, sufficient
    /// for forwarder ack semantics. The
    /// gateway carries `provider` + `model` here; we drain them as
    /// `Other` fields rather than parse since they're only useful for
    /// human debugging.
    AgentStart {
        #[serde(default)]
        session_id: Option<String>,
    },
    /// Server-side rejection. The forwarder treats this as a NAK so
    /// JetStream redelivers; the rejection text appears in the daemon
    /// log so the operator can see why. Carries `code`, `message`,
    /// optional `component`.
    Error {
        code: Option<String>,
        message: Option<String>,
        #[serde(default)]
        component: Option<String>,
    },
    /// Catch-all for the rest of the frame zoo (`turn_complete`,
    /// streaming token frames, status updates, anything the gateway
    /// adds in a future release). Drained silently — we don't depend
    /// on the protocol beyond the three frames above.
    #[serde(other)]
    Other,
}

/// Outbound message envelope. Per §4 the gateway only accepts this exact
/// shape on the send side; alternates return `UNKNOWN_MESSAGE_TYPE`.
#[derive(Debug, Serialize)]
struct OutboundMessage<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    content: &'a str,
}

/// Outcome of [`bootstrap_session`] / [`send_session_message`]. Carries
/// the resolved session id for callers that want to persist it.
#[derive(Debug, Clone)]
pub struct SessionOutcome {
    pub session_id: String,
    pub resumed: bool,
    pub message_count: Option<u64>,
}

/// WS upgrade deadline. Bounds how long we wait for the gateway to
/// accept the connection + complete the TLS / `Sec-WebSocket-*`
/// handshake. A wedged gateway surfaces fast (NATS will redeliver) but
/// a fully-loaded gateway with a slow accept still gets through.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);

/// Per-frame-write deadline once the WS is live. The actual write is
/// near-instant on loopback / a healthy connection — this bounds the
/// "TCP buffer is wedged" pathological case. Decoupled from the
/// agent's turn duration per §3 goal 3.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// Deadline for waiting on a post-send acknowledgement frame
/// (`agent_start`). Observed against the gateway the gateway emits this as
/// soon as the agent loop picks our message up, so on an idle session
/// it lands within a second; on a busy session it lands after the
/// in-flight turn finishes (30–90s typical, 60s+ for agentic wakes per
/// operator report).
///
/// 180s gives us room for one prior in-flight turn to drain plus our
/// own to start, without holding the per-channel forwarder queue
/// indefinitely. On timeout the forwarder still acks the NATS message
/// — the WS write itself succeeded, so the wake is persisted in the
/// session even if the agent loop hasn't visibly picked it up yet.
///
/// We deliberately do NOT depend on `turn_complete` (the "turn ended
/// cleanly" frame): it was unobserved during research against the
/// gateway, and `agent_start` already proves the gateway routed the
/// message into the loop.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(180);

/// Deadline for the initial `session_start` frame after a successful
/// WS upgrade. Distinct from `DRAIN_TIMEOUT` — the gateway emits
/// `session_start` immediately after upgrade regardless of agent-loop
/// state, so a long wait here means something is actually wrong.
const SESSION_START_TIMEOUT: Duration = Duration::from_secs(15);

/// Open a fresh WS connection (no `session_id` query) and return the
/// session id the gateway minted. Closes the connection cleanly before
/// returning.
///
/// **Caution.** Observed against the gateway, ZeroClaw's empty-session GC
/// behaviour is unverified — a session created and then immediately
/// closed without any user-role messages may or may not survive the
/// gateway's next cleanup pass. Prefer
/// [`bootstrap_session_with_first_message`] for any code path where
/// the daemon will need the same `session_id` in a follow-up call,
/// since it folds the durable first write into the same WS lifecycle.
pub async fn bootstrap_session(cfg: &ZeroClawWsConfig) -> Result<SessionOutcome> {
    let req = build_ws_request(&cfg.ws_url, &cfg.bearer)?;
    let (mut ws, _resp) = timeout(HANDSHAKE_TIMEOUT, connect_async(req))
        .await
        .with_context(|| format!("WS handshake to {} timed out", cfg.ws_url))?
        .with_context(|| format!("WS handshake to {} failed", cfg.ws_url))?;

    let outcome = await_session_start(&mut ws).await?;
    let _ = ws.close(None).await;
    Ok(outcome)
}

/// Atomic "create a session AND write its first message in one
/// connection." Used by the daemon's startup path so a freshly-minted
/// session always carries at least the heartbeat before the WS closes
/// — closing the empty-session GC window the gateway has been
/// observed to apply to zero-message sessions.
///
/// Behaviour:
/// 1. Open WS without `session_id` → wait for `session_start`.
/// 2. Send `{"type":"message","content":<content>}`.
/// 3. Drain frames briefly waiting for `agent_start` (or any
///    non-error frame) so we know the gateway accepted the write.
/// 4. Close WS.
///
/// Returns the gateway-minted `SessionOutcome`. Errors propagate; the
/// caller is expected to retry or surface them.
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
    write_message_and_drain(&mut ws, &outcome.session_id, content).await?;
    let _ = ws.close(None).await;
    Ok(outcome)
}

/// Resume `session_id` and append `content` to it as a user-role message.
/// Returns once the gateway has emitted `agent_start` (the agent loop
/// picked the message up). Returns `Err` on `error` frame or transport
/// failure.
///
/// The forwarder treats a `Ok(())` return as "wake delivered, ack the
/// NATS message". This isn't a per-message correlation guarantee —
/// multiple wakes arriving in quick succession share the agent's
/// serial processing and the gateway doesn't carry a per-message ack
/// today. Acceptable for the demo / low-volume case; the README
/// documents the gap.
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
    write_message_and_drain(&mut ws, session_id, content).await?;
    let _ = ws.close(None).await;
    Ok(session_outcome)
}

/// Write one `{"type":"message","content":...}` frame to an already-
/// established WS, then drain inbound frames until either `agent_start`
/// arrives, the gateway closes the WS, or `DRAIN_TIMEOUT` elapses.
/// Used by both [`send_session_message`] and
/// [`bootstrap_session_with_first_message`] so the post-send protocol
/// stays in one place.
async fn write_message_and_drain<S>(
    ws: &mut S,
    session_id: &str,
    content: &str,
) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        >
        + Unpin,
{
    let payload = OutboundMessage {
        kind: "message",
        content,
    };
    let bytes = serde_json::to_string(&payload)
        .context("encoding ZeroClaw WS message frame")?;
    timeout(SEND_TIMEOUT, ws.send(Message::Text(bytes)))
        .await
        .context("WS send timed out")?
        .context("WS send failed")?;

    // Wait for the gateway to react. agent_start = "your message
    // entered the agent loop". Bounded by DRAIN_TIMEOUT — see its
    // docstring for the agent-turn-duration calculus.
    let mut acked = false;
    let drain = async {
        while let Some(frame) = ws.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(err) => bail!("WS read error after send: {err}"),
            };
            let txt = match msg {
                Message::Text(t) => t,
                Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => break,
                Message::Frame(_) => continue,
            };
            match parse_inbound(&txt) {
                InboundFrame::AgentStart { .. } => {
                    acked = true;
                    break;
                }
                InboundFrame::Error { code, message, component } => {
                    bail!(
                        "ZeroClaw gateway returned error frame: code={:?} component={:?} message={:?}",
                        code,
                        component,
                        message
                    );
                }
                InboundFrame::SessionStart { .. } | InboundFrame::Other => continue,
            }
        }
        Ok::<_, anyhow::Error>(())
    };

    match timeout(DRAIN_TIMEOUT, drain).await {
        Ok(Ok(())) => {
            if !acked {
                // Gateway closed the WS without an `agent_start` frame.
                // Treat as delivered — the message is persisted
                // server-side per §4 (POST /api/sessions/{id}/messages
                // returns 405, persistence happens through the WS
                // write we already did). Surface a debug log so anyone
                // chasing weirdness can see the WS shape we got.
                tracing::debug!(
                    session_id = %session_id,
                    "klodi_zeroclaw_ws_closed_without_ack_after_send",
                );
            }
            Ok(())
        }
        Ok(Err(err)) => Err(err),
        Err(_) => {
            // Drain timed out — message is on the wire and persisted,
            // but the gateway didn't react within the window. Treat as
            // delivered (the alternative — NAK + redeliver — would
            // duplicate the message in the operator's session).
            tracing::warn!(
                session_id = %session_id,
                "klodi_zeroclaw_ws_drain_timeout_after_send",
            );
            Ok(())
        }
    }
}

/// Open WS, immediately close. Used by `setup_status` as a reachability
/// probe — confirms the bearer is valid and the session resumes.
pub async fn probe_session(
    cfg: &ZeroClawWsConfig,
    session_id: &str,
) -> Result<SessionOutcome> {
    let url = ws_url_with_session(&cfg.ws_url, session_id)?;
    let req = build_ws_request(&url, &cfg.bearer)?;
    let (mut ws, _resp) = timeout(HANDSHAKE_TIMEOUT, connect_async(req))
        .await
        .with_context(|| format!("WS handshake to {url} timed out"))?
        .with_context(|| format!("WS handshake to {url} failed"))?;
    let outcome = await_session_start(&mut ws).await?;
    let _ = ws.close(None).await;
    Ok(outcome)
}

async fn await_session_start<S>(ws: &mut S) -> Result<SessionOutcome>
where
    S: futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    let outcome = async {
        while let Some(frame) = ws.next().await {
            let msg = frame.context("WS read failed before session_start")?;
            let txt = match msg {
                Message::Text(t) => t,
                Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => continue,
                Message::Close(_) => bail!("WS closed before session_start"),
                Message::Frame(_) => continue,
            };
            match parse_inbound(&txt) {
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
                InboundFrame::Error { code, message, component } => {
                    bail!(
                        "ZeroClaw gateway returned error before session_start: code={:?} component={:?} message={:?}",
                        code,
                        component,
                        message
                    );
                }
                _ => continue,
            }
        }
        bail!("WS closed without emitting session_start")
    };
    timeout(SESSION_START_TIMEOUT, outcome)
        .await
        .context("WS session_start handshake timed out")?
}

fn parse_inbound(txt: &str) -> InboundFrame {
    serde_json::from_str(txt).unwrap_or(InboundFrame::Other)
}

fn build_ws_request(url: &str, bearer: &str) -> Result<Request<()>> {
    let mut req = url
        .into_client_request()
        .with_context(|| format!("invalid WS URL {url:?}"))?;
    let header = format!("Bearer {bearer}");
    let value = HeaderValue::from_str(&header)
        .context("bearer token contains characters invalid in an Authorization header")?;
    req.headers_mut().insert(http::header::AUTHORIZATION, value);
    Ok(req)
}

fn ws_url_with_session(base: &str, session_id: &str) -> Result<String> {
    if session_id.is_empty() {
        bail!("session_id cannot be empty when resuming a ZeroClaw session");
    }
    if base.contains('?') {
        Ok(format!("{base}&session_id={session_id}"))
    } else {
        Ok(format!("{base}?session_id={session_id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_from_canonical_webhook_url() {
        let cfg = ZeroClawWsConfig::from_webhook_url(
            "http://127.0.0.1:7070/webhook",
            "zc_abcd".into(),
        )
        .unwrap();
        assert_eq!(cfg.ws_url, "ws://127.0.0.1:7070/ws/chat");
        assert_eq!(cfg.http_base, "http://127.0.0.1:7070");
        assert_eq!(cfg.bearer, "zc_abcd");
    }

    #[test]
    fn config_handles_subpath_webhook_url_and_tls() {
        let cfg = ZeroClawWsConfig::from_webhook_url(
            "https://gw.example/zc/webhook",
            "zc_xyz".into(),
        )
        .unwrap();
        assert_eq!(cfg.ws_url, "wss://gw.example/zc/ws/chat");
        assert_eq!(cfg.http_base, "https://gw.example/zc");
    }

    #[test]
    fn config_strips_trailing_slash_on_webhook_url() {
        let cfg = ZeroClawWsConfig::from_webhook_url(
            "http://127.0.0.1:7070/webhook/",
            "zc_a".into(),
        )
        .unwrap();
        assert_eq!(cfg.ws_url, "ws://127.0.0.1:7070/ws/chat");
    }

    #[test]
    fn config_rejects_non_webhook_path() {
        let err = ZeroClawWsConfig::from_webhook_url(
            "http://127.0.0.1:7070/wakes",
            "zc_a".into(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("expected trailing '/webhook'"), "got: {err}");
    }

    #[test]
    fn http_base_to_ws_rejects_unknown_scheme() {
        assert!(http_base_to_ws("ftp://x/y", "/ws/chat").is_err());
    }

    #[test]
    fn ws_url_with_session_appends_query() {
        let url = ws_url_with_session("ws://x/ws/chat", "abc123").unwrap();
        assert_eq!(url, "ws://x/ws/chat?session_id=abc123");
    }

    #[test]
    fn ws_url_with_session_uses_amp_when_query_present() {
        let url = ws_url_with_session("ws://x/ws/chat?foo=bar", "abc").unwrap();
        assert_eq!(url, "ws://x/ws/chat?foo=bar&session_id=abc");
    }

    #[test]
    fn ws_url_with_session_rejects_empty_id() {
        assert!(ws_url_with_session("ws://x/ws/chat", "").is_err());
    }

    #[test]
    fn parse_inbound_session_start_with_resumed_and_count() {
        let txt = r#"{"type":"session_start","session_id":"u-1","resumed":true,"message_count":42}"#;
        match parse_inbound(txt) {
            InboundFrame::SessionStart {
                session_id,
                resumed,
                message_count,
            } => {
                assert_eq!(session_id, "u-1");
                assert!(resumed);
                assert_eq!(message_count, Some(42));
            }
            other => panic!("expected SessionStart, got {other:?}"),
        }
    }

    #[test]
    fn parse_inbound_session_start_minimal() {
        let txt = r#"{"type":"session_start","session_id":"u-2"}"#;
        match parse_inbound(txt) {
            InboundFrame::SessionStart {
                session_id,
                resumed,
                message_count,
            } => {
                assert_eq!(session_id, "u-2");
                assert!(!resumed);
                assert!(message_count.is_none());
            }
            other => panic!("expected SessionStart, got {other:?}"),
        }
    }

    #[test]
    fn parse_inbound_agent_start() {
        let txt = r#"{"type":"agent_start","session_id":"u-1"}"#;
        assert!(matches!(parse_inbound(txt), InboundFrame::AgentStart { .. }));
    }

    #[test]
    fn parse_inbound_error_carries_code_and_message() {
        let txt = r#"{"type":"error","code":"BAD","message":"nope"}"#;
        match parse_inbound(txt) {
            InboundFrame::Error { code, message, component } => {
                assert_eq!(code.as_deref(), Some("BAD"));
                assert_eq!(message.as_deref(), Some("nope"));
                assert!(component.is_none());
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_inbound_error_picks_up_component_when_present() {
        // Observed against the gateway, error frames now carry an optional
        // `component` field on top of `code` + `message`.
        let txt = r#"{"type":"error","code":"BAD","message":"nope","component":"llm"}"#;
        match parse_inbound(txt) {
            InboundFrame::Error { component, .. } => {
                assert_eq!(component.as_deref(), Some("llm"));
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn parse_inbound_turn_complete_falls_through_to_other() {
        // Observed against the gateway, turn_complete was unobserved during
        // research. We deliberately don't have a typed variant for it
        // — it lands in Other and the drain logic ignores it. Encoding
        // that as a regression check.
        let txt = r#"{"type":"turn_complete","session_id":"x"}"#;
        assert!(matches!(parse_inbound(txt), InboundFrame::Other));
    }

    #[test]
    fn parse_inbound_unknown_falls_through_to_other() {
        let txt = r#"{"type":"streaming_token","content":"foo"}"#;
        assert!(matches!(parse_inbound(txt), InboundFrame::Other));
    }

    #[test]
    fn parse_inbound_garbage_falls_through_to_other() {
        let txt = r#"not even json"#;
        assert!(matches!(parse_inbound(txt), InboundFrame::Other));
    }

    #[test]
    fn outbound_message_serialises_to_canonical_shape() {
        let payload = OutboundMessage {
            kind: "message",
            content: "hello world",
        };
        let json: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&payload).unwrap()).unwrap();
        assert_eq!(json["type"], "message");
        assert_eq!(json["content"], "hello world");
        // Per §4 the only accepted shape is exactly two keys —
        // anything else triggers UNKNOWN_MESSAGE_TYPE on the gateway.
        assert_eq!(json.as_object().unwrap().len(), 2);
    }

    #[test]
    fn build_ws_request_attaches_bearer() {
        let req = build_ws_request("ws://127.0.0.1:7070/ws/chat", "zc_token").unwrap();
        let auth = req
            .headers()
            .get(http::header::AUTHORIZATION)
            .expect("Authorization header set");
        assert_eq!(auth.to_str().unwrap(), "Bearer zc_token");
    }

    #[test]
    fn build_ws_request_rejects_bearer_with_invalid_chars() {
        // Bearer tokens with control bytes can't go into a header value
        // — refuse rather than letting tungstenite emit a malformed
        // upgrade request.
        let err = build_ws_request("ws://x/y", "bad\nbearer").unwrap_err();
        assert!(format!("{err:#}").contains("invalid"));
    }
}
