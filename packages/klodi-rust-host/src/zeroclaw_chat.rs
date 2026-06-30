//! Wake-time WebSocket client for the ZeroClaw `/ws/chat` surface.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md` zeroclaw is the
//! agent runtime — never the operator UX. The daemon resumes a single
//! persistent operator session per chat, sends one `message` frame per
//! event, and waits for the corresponding `done.full_response` reply.
//!
//! The client is single-flight per session: callers hold the controller
//! mutex around `send_and_wait` so only one turn is in flight at a time.
//! That matches the gateway's behaviour (concurrent writes on the same
//! session interleave at random) and keeps the agent's `sessions_history`
//! coherent.
//!
//! A fresh WS connection per turn keeps the implementation small: there
//! is no long-lived stream to manage, no reconnect logic, no heartbeat.
//! The cost is one extra handshake per event, which is negligible next
//! to the LLM turn duration.

use futures_util::{SinkExt, StreamExt};
use http::{HeaderValue, Request};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest},
};

/// Outcome of a single `/ws/chat` turn.
#[derive(Debug, Clone)]
pub struct TurnOutcome {
    /// The agent's `done.full_response`. This is the text the daemon
    /// forwards to Telegram.
    pub full_response: String,
    /// Wall-clock duration from `send_and_wait` entry to the `done`
    /// frame. Used for telemetry.
    pub turn_duration: Duration,
}

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("WS handshake: {0}")]
    Handshake(String),
    #[error("WS stream closed before done frame")]
    EarlyClose,
    #[error("WS read/write: {0}")]
    Transport(String),
    #[error("turn timeout after {0:?}")]
    Timeout(Duration),
    #[error("gateway error frame: code={code} message={message}")]
    Gateway { code: String, message: String },
    #[error("encoding outbound frame: {0}")]
    Encode(String),
    #[error("constructing WS request: {0}")]
    Request(String),
}

/// Per-turn ceiling. Long-running LLM reasoning is fine; an
/// indefinitely-stalled WS is not.
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(600);
/// Handshake ceiling. The gateway is local; if the TLS / TCP handshake
/// hasn't finished by here the gateway is down.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
/// Tolerance window for the post-handshake `session_start` frame.
const SESSION_START_TIMEOUT: Duration = Duration::from_secs(15);

/// Single-flight WS chat client. One instance per operator; the target
/// `session_id` is chosen PER TURN (`send_and_wait`), not bound at
/// construction — the zeroclaw worker keys each wake to its own
/// per-conversation session (`klodi:<entity_id>`, ADR-0019) while operator
/// messages stay on the operator's session.
///
/// `send_and_wait` serialises concurrent callers via the in-flight
/// mutex; that's the contract the gateway requires (only one in-flight
/// turn per session_id at a time).
pub struct ChatClient {
    http_base: String,
    bearer: String,
    turn_timeout: Duration,
    in_flight: tokio::sync::Mutex<()>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum InboundFrame {
    #[allow(dead_code)]
    SessionStart {
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default)]
        resumed: bool,
        #[serde(default)]
        message_count: Option<u64>,
    },
    Chunk {
        #[serde(default)]
        content: Option<String>,
    },
    ChunkReset,
    Done {
        #[serde(default)]
        full_response: Option<String>,
    },
    Error {
        #[serde(default)]
        code: Option<String>,
        #[serde(default)]
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

impl ChatClient {
    /// Build a new client. `http_base` is `http(s)://host:port` (no path).
    /// The target `session_id` is supplied per turn to `send_and_wait`, not
    /// here — each turn resumes (or, on first contact, mints on the gateway)
    /// the conversation's own session.
    pub fn new(http_base: String, bearer: String) -> Self {
        Self {
            http_base: http_base.trim_end_matches('/').to_string(),
            bearer,
            turn_timeout: DEFAULT_TURN_TIMEOUT,
            in_flight: tokio::sync::Mutex::new(()),
        }
    }

    /// Override the per-turn timeout. Used by tests; production wires
    /// the default.
    #[cfg(test)]
    pub fn with_turn_timeout(mut self, t: Duration) -> Self {
        self.turn_timeout = t;
        self
    }

    /// Send `content` as a `message` frame on `session_id` and wait for the
    /// matching `done.full_response`. Serial per ChatClient instance. The
    /// caller picks `session_id` per turn (a wake's per-conversation
    /// `klodi:<entity_id>` key, or the operator's own session).
    pub async fn send_and_wait(
        &self,
        session_id: &str,
        content: &str,
    ) -> Result<TurnOutcome, ChatError> {
        let _turn = self.in_flight.lock().await;
        let started = Instant::now();
        let ws_url = self.build_ws_url(session_id)?;
        let req = build_ws_request(&ws_url, &self.bearer)?;

        let (mut ws, _resp) = match timeout(HANDSHAKE_TIMEOUT, connect_async(req)).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(err)) => return Err(ChatError::Handshake(err.to_string())),
            Err(_) => return Err(ChatError::Timeout(HANDSHAKE_TIMEOUT)),
        };

        // Wait for the gateway's session_start handshake before sending.
        await_session_start(&mut ws).await?;

        // Send the user message.
        let payload = OutboundMessage {
            kind: "message",
            content,
        };
        let body = serde_json::to_string(&payload)
            .map_err(|err| ChatError::Encode(err.to_string()))?;
        ws.send(Message::Text(body))
            .await
            .map_err(|err| ChatError::Transport(err.to_string()))?;

        // Read frames until `done` or until the timeout fires.
        let deadline = tokio::time::sleep(self.turn_timeout);
        tokio::pin!(deadline);

        let mut buf = String::new();
        loop {
            tokio::select! {
                _ = &mut deadline => {
                    let _ = ws.close(None).await;
                    return Err(ChatError::Timeout(self.turn_timeout));
                }
                frame = ws.next() => {
                    let msg = match frame {
                        Some(Ok(m)) => m,
                        Some(Err(err)) => {
                            return Err(ChatError::Transport(err.to_string()));
                        }
                        None => return Err(ChatError::EarlyClose),
                    };
                    match msg {
                        Message::Text(text) => {
                            match serde_json::from_str::<InboundFrame>(&text) {
                                Ok(InboundFrame::SessionStart { .. }) => {
                                    // Second session_start after send is unusual but
                                    // not fatal; ignore.
                                }
                                Ok(InboundFrame::Chunk { content }) => {
                                    if let Some(c) = content {
                                        buf.push_str(&c);
                                    }
                                }
                                Ok(InboundFrame::ChunkReset) => {
                                    buf.clear();
                                }
                                Ok(InboundFrame::Done { full_response }) => {
                                    let full = full_response.unwrap_or(buf);
                                    let _ = ws.close(None).await;
                                    return Ok(TurnOutcome {
                                        full_response: full,
                                        turn_duration: started.elapsed(),
                                    });
                                }
                                Ok(InboundFrame::Error { code, message }) => {
                                    let _ = ws.close(None).await;
                                    return Err(ChatError::Gateway {
                                        code: code.unwrap_or_default(),
                                        message: message.unwrap_or_default(),
                                    });
                                }
                                Ok(InboundFrame::Other) => {
                                    tracing::debug!(frame = %text, "klodi_zeroclaw_chat_unknown_frame");
                                }
                                Err(err) => {
                                    tracing::debug!(
                                        err = %err,
                                        frame = %text,
                                        "klodi_zeroclaw_chat_undecodable_frame"
                                    );
                                }
                            }
                        }
                        Message::Close(_) => return Err(ChatError::EarlyClose),
                        Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_) => {
                            // Tungstenite handles ping/pong internally. Binary
                            // frames are not part of the contract; ignore.
                        }
                    }
                }
            }
        }
    }

    fn build_ws_url(&self, session_id: &str) -> Result<String, ChatError> {
        let ws_base = http_base_to_ws(&self.http_base)?;
        Ok(format!(
            "{ws_base}/ws/chat?session_id={}",
            percent_encode_session(session_id),
        ))
    }
}

fn http_base_to_ws(http_base: &str) -> Result<String, ChatError> {
    if let Some(rest) = http_base.strip_prefix("https://") {
        Ok(format!("wss://{rest}"))
    } else if let Some(rest) = http_base.strip_prefix("http://") {
        Ok(format!("ws://{rest}"))
    } else {
        Err(ChatError::Request(format!(
            "http_base must start with http:// or https:// (got {http_base:?})"
        )))
    }
}

/// Minimal percent-encoder for the session_id query parameter. Session
/// ids are gateway-minted UUIDs in practice, so unreserved chars
/// (`A-Z a-z 0-9 - _ . ~`) pass through unchanged; everything else gets
/// `%HH` encoding. Inlining keeps the dep tree narrow.
fn percent_encode_session(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        let is_unreserved = b.is_ascii_alphanumeric()
            || b == b'-'
            || b == b'_'
            || b == b'.'
            || b == b'~';
        if is_unreserved {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

fn build_ws_request(
    url: &str,
    bearer: &str,
) -> Result<tokio_tungstenite::tungstenite::handshake::client::Request, ChatError> {
    let mut req: Request<()> = url
        .into_client_request()
        .map_err(|err| ChatError::Request(format!("constructing WS request for {url}: {err}")))?;
    let header = HeaderValue::from_str(&format!("Bearer {bearer}"))
        .map_err(|err| ChatError::Request(format!("invalid bearer: {err}")))?;
    req.headers_mut().insert("Authorization", header);
    Ok(req)
}

async fn await_session_start<S>(ws: &mut S) -> Result<(), ChatError>
where
    S: futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
{
    let wait = async {
        while let Some(frame) = ws.next().await {
            let msg = match frame {
                Ok(m) => m,
                Err(err) => return Err(ChatError::Transport(err.to_string())),
            };
            match msg {
                Message::Text(text) => match serde_json::from_str::<InboundFrame>(&text) {
                    Ok(InboundFrame::SessionStart { .. }) => return Ok(()),
                    Ok(InboundFrame::Error { code, message }) => {
                        return Err(ChatError::Gateway {
                            code: code.unwrap_or_default(),
                            message: message.unwrap_or_default(),
                        });
                    }
                    _ => continue,
                },
                Message::Close(_) => return Err(ChatError::EarlyClose),
                _ => continue,
            }
        }
        Err(ChatError::EarlyClose)
    };
    match timeout(SESSION_START_TIMEOUT, wait).await {
        Ok(res) => res,
        Err(_) => Err(ChatError::Timeout(SESSION_START_TIMEOUT)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message as ServerMessage;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    /// Spin up a single-connection WS server that replies with a scripted
    /// sequence of frames. Returns the chosen port.
    async fn run_scripted_server<F, Fut>(port_tx: tokio::sync::oneshot::Sender<u16>, scenario: F)
    where
        F: FnOnce(
                tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
            ) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        port_tx.send(listener.local_addr().unwrap().port()).unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        // tungstenite's accept_hdr callback must return `Result<_, ErrorResponse>`;
        // the large Err type is the external API's, not ours.
        #[allow(clippy::result_large_err)]
        let callback = |_req: &Request, response: Response| Ok(response);
        let ws = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .unwrap();
        scenario(ws).await;
    }

    async fn make_client(port: u16) -> ChatClient {
        ChatClient::new(
            format!("http://127.0.0.1:{port}"),
            "zc_test_bearer".to_string(),
        )
    }

    #[tokio::test]
    async fn send_and_wait_returns_full_response_on_done() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(run_scripted_server(tx, |mut ws| async move {
            ws.send(ServerMessage::Text(
                serde_json::json!({
                    "type": "session_start",
                    "session_id": "session-1",
                    "resumed": true,
                    "message_count": 4,
                })
                .to_string(),
            ))
            .await
            .unwrap();
            // Consume client's outbound `message` frame.
            let _ = ws.next().await;
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "chunk", "content": "hello "}).to_string(),
            ))
            .await
            .unwrap();
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "chunk", "content": "world"}).to_string(),
            ))
            .await
            .unwrap();
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "done", "full_response": "hello world"})
                    .to_string(),
            ))
            .await
            .unwrap();
        }));
        let port = rx.await.unwrap();
        let client = make_client(port).await;
        let outcome = client.send_and_wait("session-1", "hi").await.unwrap();
        assert_eq!(outcome.full_response, "hello world");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn chunk_reset_discards_buffer() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(run_scripted_server(tx, |mut ws| async move {
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "session_start", "session_id": "s"}).to_string(),
            ))
            .await
            .unwrap();
            let _ = ws.next().await;
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "chunk", "content": "draft"}).to_string(),
            ))
            .await
            .unwrap();
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "chunk_reset"}).to_string(),
            ))
            .await
            .unwrap();
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "chunk", "content": "final"}).to_string(),
            ))
            .await
            .unwrap();
            // Omit full_response so the buffer is the source of truth.
            ws.send(ServerMessage::Text(serde_json::json!({"type": "done"}).to_string()))
                .await
                .unwrap();
        }));
        let port = rx.await.unwrap();
        let client = make_client(port).await;
        let outcome = client.send_and_wait("session-1", "hi").await.unwrap();
        assert_eq!(outcome.full_response, "final");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn early_close_returns_error() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(run_scripted_server(tx, |mut ws| async move {
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "session_start"}).to_string(),
            ))
            .await
            .unwrap();
            let _ = ws.next().await;
            // Close without `done`.
            let _ = ws.close(None).await;
        }));
        let port = rx.await.unwrap();
        let client = make_client(port).await;
        let err = client.send_and_wait("session-1", "hi").await.unwrap_err();
        assert!(matches!(err, ChatError::EarlyClose), "got {err:?}");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn turn_timeout() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(run_scripted_server(tx, |mut ws| async move {
            ws.send(ServerMessage::Text(
                serde_json::json!({"type": "session_start"}).to_string(),
            ))
            .await
            .unwrap();
            let _ = ws.next().await;
            // Hold without sending `done`. Sleep long enough for the
            // client timeout to fire.
            tokio::time::sleep(Duration::from_millis(800)).await;
        }));
        let port = rx.await.unwrap();
        let client = make_client(port)
            .await
            .with_turn_timeout(Duration::from_millis(150));
        let err = client.send_and_wait("session-1", "hi").await.unwrap_err();
        match err {
            ChatError::Timeout(d) => assert!(d >= Duration::from_millis(100)),
            other => panic!("expected Timeout, got {other:?}"),
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn single_flight_serializes() {
        // Two concurrent send_and_wait calls. The mutex must serialise
        // them — observable by counting active server connections.
        let active = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let active_clone = active.clone();
        let max_clone = max_seen.clone();

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let active = active_clone.clone();
                let max_seen = max_clone.clone();
                tokio::spawn(async move {
                    let n = active.fetch_add(1, Ordering::SeqCst) + 1;
                    let cur_max = max_seen.load(Ordering::SeqCst);
                    if n > cur_max {
                        max_seen.store(n, Ordering::SeqCst);
                    }
                    // tungstenite's accept_hdr callback must return
                    // `Result<_, ErrorResponse>`; the large Err type is the
                    // external API's, not ours.
                    #[allow(clippy::result_large_err)]
                    let cb = |_req: &Request, response: Response| Ok(response);
                    let mut ws = tokio_tungstenite::accept_hdr_async(stream, cb).await.unwrap();
                    ws.send(ServerMessage::Text(
                        serde_json::json!({"type": "session_start"}).to_string(),
                    ))
                    .await
                    .unwrap();
                    let _ = ws.next().await;
                    // Hold the connection so the second caller queues
                    // behind the in_flight mutex.
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    ws.send(ServerMessage::Text(
                        serde_json::json!({"type": "done", "full_response": "ok"})
                            .to_string(),
                    ))
                    .await
                    .unwrap();
                    active.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });

        let client = Arc::new(make_client(port).await);
        let c1 = client.clone();
        let c2 = client.clone();
        let h1 = tokio::spawn(async move { c1.send_and_wait("session-1", "a").await.unwrap() });
        let h2 = tokio::spawn(async move { c2.send_and_wait("session-1", "b").await.unwrap() });
        let (o1, o2) = tokio::join!(h1, h2);
        assert_eq!(o1.unwrap().full_response, "ok");
        assert_eq!(o2.unwrap().full_response, "ok");
        // Two concurrent connections would push max_seen to 2 — the
        // mutex forces them serial so we see at most 1.
        assert_eq!(max_seen.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn http_base_to_ws_handles_both_schemes() {
        assert_eq!(
            http_base_to_ws("http://127.0.0.1:7070").unwrap(),
            "ws://127.0.0.1:7070",
        );
        assert_eq!(
            http_base_to_ws("https://gw.example").unwrap(),
            "wss://gw.example",
        );
        assert!(http_base_to_ws("gw.example").is_err());
    }

    #[test]
    fn percent_encode_passes_uuid_through() {
        assert_eq!(
            percent_encode_session("abc-123_def.ghi~jkl"),
            "abc-123_def.ghi~jkl",
        );
        assert_eq!(percent_encode_session("a b"), "a%20b");
        assert_eq!(percent_encode_session("?&="), "%3F%26%3D");
    }
}
