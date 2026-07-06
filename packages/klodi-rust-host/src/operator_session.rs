//! Per-operator coordinator wiring NATS + Telegram inbound events into
//! the single-flight ZeroClaw chat session.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md`:
//!
//! - One [`OperatorSessionController`] per operator (one `chat_id` =
//!   one zeroclaw session).
//! - The controller's `dispatch` is a non-blocking mpsc send; sources
//!   (NATS subscriber, Telegram poller) fan in here.
//! - The worker task drains the inbox serially, runs one `/ws/chat`
//!   turn per event, forwards the agent's reply to Telegram.
//! - Bursts that overflow the inbox drop oldest. The agent re-grounds
//!   from `klodi_*` tools each turn, so transient drops don't corrupt
//!   marketplace state.

use crate::forwarder::WakeEvent;
use crate::telegram::{TelegramClient, TelegramError};
use crate::telegram_config;
use crate::wake_session::derive_wake_session;
use crate::zeroclaw_chat::{ChatClient, ChatError};
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::mpsc;

const INBOX_CAPACITY: usize = 64;

/// Event types the controller serialises through the zeroclaw session.
#[derive(Debug, Clone)]
pub enum InboundEvent {
    /// Marketplace wake from NATS (offer, channel message, transaction…).
    /// Boxed: `WakeEvent` dwarfs the other variant (272 vs 32 bytes), so an
    /// unboxed enum would bloat every queued `InboundEvent` in the inbox
    /// channel (clippy `large_enum_variant`).
    Wake(Box<WakeEvent>),
    /// Operator-typed message from Telegram.
    OperatorMessage {
        text: String,
        telegram_message_id: i64,
    },
}

#[derive(Debug, Error)]
pub enum DispatchError {
    #[error("operator inbox closed")]
    Closed,
    #[error("operator inbox full ({0} pending)")]
    Full(usize),
}

/// Hand to `OperatorSessionController::spawn` to send events into the
/// worker. Cheap to clone — the underlying mpsc::Sender is `Arc`-backed.
#[derive(Clone)]
pub struct OperatorInbox {
    tx: mpsc::Sender<InboundEvent>,
}

impl OperatorInbox {
    /// Non-blocking enqueue. Returns `Full` on burst — the caller should
    /// log + drop + emit a metric, then continue.
    pub fn dispatch(&self, event: InboundEvent) -> Result<(), DispatchError> {
        match self.tx.try_send(event) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                Err(DispatchError::Full(self.tx.capacity()))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(DispatchError::Closed),
        }
    }
}

/// Long-running worker that drains the inbox and runs one zeroclaw turn
/// per event. Construct with [`spawn`]; hold the returned `JoinHandle`
/// to observe shutdown.
pub struct OperatorSessionController {
    pub inbox: OperatorInbox,
    pub join: tokio::task::JoinHandle<()>,
}

impl OperatorSessionController {
    pub fn spawn(
        chat_id: i64,
        operator_session_id: String,
        chat: Arc<ChatClient>,
        telegram: Arc<TelegramClient>,
        klodi_home: PathBuf,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<InboundEvent>(INBOX_CAPACITY);
        let inbox = OperatorInbox { tx };
        let join = tokio::spawn(run_worker(
            WorkerCtx {
                chat_id,
                operator_session_id,
                chat,
                telegram,
                klodi_home,
            },
            rx,
        ));
        Self { inbox, join }
    }
}

struct WorkerCtx {
    chat_id: i64,
    chat: Arc<ChatClient>,
    telegram: Arc<TelegramClient>,
    klodi_home: PathBuf,
    /// The operator's own (non-wake) session — the daemon-resolved
    /// `${KLODI_HOME}/zeroclaw.session`. `run_worker` runs `OperatorMessage`
    /// turns on this (BR-6); `Wake` turns run on `derive_wake_session(wake)`.
    operator_session_id: String,
}

async fn run_worker(ctx: WorkerCtx, mut rx: mpsc::Receiver<InboundEvent>) {
    while let Some(event) = rx.recv().await {
        // Per-turn session (ADR-0019): a wake runs on its own per-conversation
        // `klodi:<entity_id>` key (`derive_wake_session`); an operator-typed
        // message carries no entity and stays on the operator's session (BR-6).
        // Either way the reply is forwarded to the single operator `chat_id`
        // below, so the human keeps one unified Telegram view (BR-6).
        let session_id = match &event {
            InboundEvent::Wake(wake) => derive_wake_session(wake),
            InboundEvent::OperatorMessage { .. } => ctx.operator_session_id.clone(),
        };
        let prompt = format_prompt(&event);
        let outcome = match ctx.chat.send_and_wait(&session_id, &prompt).await {
            Ok(o) => o,
            Err(err) => {
                log_chat_turn_error(&event, &err);
                continue;
            }
        };
        let reply = outcome.full_response.trim();
        if reply.is_empty() {
            tracing::info!(
                turn_duration = ?outcome.turn_duration,
                "klodi_zeroclaw_chat_empty_reply_skipped"
            );
            continue;
        }
        match ctx.telegram.send(ctx.chat_id, reply).await {
            Ok(message_id) => {
                tracing::info!(
                    chat_id = ctx.chat_id,
                    message_id,
                    turn_duration = ?outcome.turn_duration,
                    "klodi_telegram_reply_sent"
                );
                if let Err(err) = telegram_config::write_last_send(
                    &ctx.klodi_home,
                    &iso_now(),
                ) {
                    tracing::warn!(
                        error = %err,
                        "klodi_telegram_last_send_persist_failed"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    chat_id = ctx.chat_id,
                    "klodi_telegram_send_failed_reply_lost"
                );
                if let TelegramError::BadToken = err {
                    tracing::error!(
                        "klodi_telegram_bot_token_revoked_daemon_unable_to_send"
                    );
                }
            }
        }
    }
    tracing::info!("klodi_zeroclaw_operator_session_inbox_drained");
}

/// Classify a failed `/ws/chat` turn and log it at the right severity.
///
/// zeroclaw ACKs the NATS message at *dispatch* time (`daemon.rs`), so this
/// post-ACK worker is the ONLY place a relay failure can surface — redelivery
/// is structurally impossible. A deterministic failure (a misconfig that fails
/// identically every wake — a stale/GC'd session the gateway rejects with an
/// error frame, a bad bearer, a malformed handshake/request/frame) therefore
/// gets a DISTINCT, operator-alertable ERROR alarm carrying the cause plus the
/// wake `kind`/`event_id` for correlation. A transient failure (timeout, a
/// dropped/early-closed transport) keeps the routine WARN — redelivery can't
/// help here but it is not a misconfig operators must page on. Generalises the
/// `BadToken → tracing::error!` Telegram arm; mirrors the merged hermes
/// `wake_inject_deterministic_failure` template (ADR-0019). The `ChatError`
/// match is exhaustive on purpose: a new variant must be classified, never
/// silently swept into a catch-all.
fn log_chat_turn_error(event: &InboundEvent, err: &ChatError) {
    let (kind, event_id) = chat_turn_correlation(event);
    match err {
        ChatError::Gateway { .. }
        | ChatError::Handshake(_)
        | ChatError::Request(_)
        | ChatError::Encode(_) => tracing::error!(
            error = %err,
            kind = kind,
            event_id = %event_id,
            "klodi_zeroclaw_chat_turn_deterministic_failure"
        ),
        ChatError::Timeout(_) | ChatError::Transport(_) | ChatError::EarlyClose => {
            tracing::warn!(
                error = %err,
                kind = kind,
                event_id = %event_id,
                "klodi_zeroclaw_chat_turn_failed"
            )
        }
    }
}

/// The `(kind, event_id)` correlation pair carried on a chat-turn alarm.
fn chat_turn_correlation(event: &InboundEvent) -> (&str, String) {
    match event {
        InboundEvent::Wake(wake) => (wake.kind(), wake.event_id().to_string()),
        InboundEvent::OperatorMessage {
            telegram_message_id,
            ..
        } => ("operator.message", format!("telegram:{telegram_message_id}")),
    }
}

fn format_prompt(event: &InboundEvent) -> String {
    match event {
        InboundEvent::Wake(wake) => {
            let pretty = serde_json::to_string_pretty(wake).unwrap_or_else(|_| "{}".into());
            format!(
                "[wake] kind={} event_id={}\n\nPayload:\n{}\n",
                wake.kind(),
                wake.event_id(),
                pretty,
            )
        }
        InboundEvent::OperatorMessage {
            text,
            telegram_message_id,
        } => format!(
            "[operator] telegram_message_id={telegram_message_id}\n\n{text}\n",
        ),
    }
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    // RFC3339 / ISO 8601 in UTC. Avoid pulling in `chrono` for one
    // timestamp: format manually with rough math. Precision is seconds.
    let mut secs = now.as_secs() as i64;
    // Subtract from 1970 + appropriate years/months/days.
    let mut y: i64 = 1970;
    loop {
        let days = if is_leap_year(y) { 366 } else { 365 };
        let year_secs = days * 86400;
        if secs < year_secs {
            break;
        }
        secs -= year_secs;
        y += 1;
    }
    let month_lengths = [31, if is_leap_year(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m: u32 = 0;
    while m < 12 {
        let len = month_lengths[m as usize] as i64 * 86400;
        if secs < len {
            break;
        }
        secs -= len;
        m += 1;
    }
    let day = (secs / 86400) as u32 + 1;
    secs %= 86400;
    let hour = (secs / 3600) as u32;
    secs %= 3600;
    let min = (secs / 60) as u32;
    let sec = (secs % 60) as u32;
    format!(
        "{y:04}-{:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z",
        m + 1,
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use klodi_nats_client::NotificationEvent;

    fn wake_for_test() -> WakeEvent {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e1".into(),
            listing_id: "l1".into(),
            title: Some("vintage chair".into()),
        };
        WakeEvent::Notification {
            kind: evt.kind().to_string(),
            event_id: evt.event_id().to_string(),
            user_id: "u1".into(),
            payload: evt,
        }
    }

    #[test]
    fn format_prompt_wake_includes_kind_and_payload() {
        let prompt = format_prompt(&InboundEvent::Wake(Box::new(wake_for_test())));
        assert!(prompt.starts_with("[wake] kind=listing.created event_id=e1"));
        assert!(prompt.contains("\"channel\""));
        assert!(prompt.contains("\"kind\": \"listing.created\""));
    }

    #[test]
    fn format_prompt_operator_message_includes_message_id() {
        let prompt = format_prompt(&InboundEvent::OperatorMessage {
            text: "hello from chat".into(),
            telegram_message_id: 42,
        });
        assert!(prompt.starts_with("[operator] telegram_message_id=42"));
        assert!(prompt.contains("hello from chat"));
    }

    #[test]
    fn iso_now_round_shape() {
        let ts = iso_now();
        // YYYY-MM-DDTHH:MM:SSZ = 20 chars
        assert_eq!(ts.len(), 20, "got {ts}");
        assert!(ts.ends_with('Z'));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audit all adapters for silent wake-inject failure — RED (qa-developer)
//
// Seam 1 — zeroclaw post-ACK worker classification (ACs 2, 3, 6).
//
// zeroclaw ACKs the NATS message at *dispatch* time (daemon.rs), so the
// post-ACK `run_worker` below is the ONLY place a relay failure can ever
// surface — redelivery is structurally impossible. Today the worker swallows
// EVERY `send_and_wait` error at WARN + `continue` (`run_worker` :110-116), so a
// deterministic failure (stale session → gateway error frame, bad bearer,
// handshake) is an unrecoverable SILENT loss. The fix (mirroring the existing
// `BadToken → tracing::error!` Telegram arm at :150-154, and the hermes
// `wake_inject_deterministic_failure` ERROR template) must classify `ChatError`:
//
//   - deterministic (`Gateway` / `Handshake` / `Request` / `Encode`) → a DISTINCT
//     `tracing::error!` alarm naming the cause (ACs 2, 6);
//   - transient    (`Timeout` / `Transport` / `EarlyClose`)          → stay WARN
//     only, never the deterministic ERROR alarm (ACs 3, 6).
//
// There is NO return value / telegram side effect on the error path (the worker
// `continue`s), so the only observable contract is the log SEVERITY. These tests
// install a minimal in-test `tracing::Subscriber` recorder and drive `run_worker`
// directly on the current-thread runtime (so the thread-local default captures
// the worker's events), feeding it one wake whose chat turn fails against a
// scripted WS gateway. They compile against the EXISTING worker signature and
// fail RED on the missing ERROR severity — not on a missing symbol — so the rest
// of the crate's tests still build + pass.
#[cfg(test)]
mod alarm_classification_red_tests {
    use super::*;

    use futures_util::{SinkExt, StreamExt};
    use klodi_nats_client::NotificationEvent;
    use std::sync::Mutex;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request as HsRequest, Response as HsResponse,
    };
    use tracing::field::{Field, Visit};
    use tracing::{Dispatch, Event, Level, Metadata, Subscriber, span};

    use crate::telegram::TelegramClient;
    use crate::zeroclaw_chat::ChatClient;

    /// One captured `tracing` event: its severity + a flattened render of every
    /// field (message + `error = %err`), enough to assert level and that the
    /// alarm names the failure cause.
    #[derive(Clone)]
    struct RecordedEvent {
        level: Level,
        rendered: String,
    }

    #[derive(Default)]
    struct RecorderInner {
        events: Mutex<Vec<RecordedEvent>>,
    }

    // Clone newtype over a shared `Arc` so `Dispatch::new` can own one clone
    // while the test keeps a read handle to the SAME recorder. A local type is
    // required to impl the foreign `Subscriber` trait (`Arc` is not fundamental,
    // so `impl Subscriber for Arc<_>` violates the orphan rule).
    #[derive(Clone, Default)]
    struct Recorder(Arc<RecorderInner>);

    impl Recorder {
        fn errors_containing(&self, needle: &str) -> usize {
            self.0
                .events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| e.level == Level::ERROR && e.rendered.contains(needle))
                .count()
        }

        fn any_error(&self) -> bool {
            self.0
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.level == Level::ERROR)
        }

        fn any_warn(&self) -> bool {
            self.0
                .events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e.level == Level::WARN)
        }

        fn dump(&self) -> String {
            self.0
                .events
                .lock()
                .unwrap()
                .iter()
                .map(|e| format!("[{}]{}", e.level, e.rendered))
                .collect::<Vec<_>>()
                .join(" | ")
        }
    }

    struct FieldCollector {
        out: String,
    }

    impl Visit for FieldCollector {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            use std::fmt::Write;
            let _ = write!(self.out, " {}={:?}", field.name(), value);
        }
    }

    // `enabled` is narrowed to INFO/WARN/ERROR so debug/trace noise from the WS
    // stack is dropped.
    impl Subscriber for Recorder {
        fn enabled(&self, metadata: &Metadata<'_>) -> bool {
            let l = *metadata.level();
            l == Level::ERROR || l == Level::WARN || l == Level::INFO
        }
        fn new_span(&self, _span: &span::Attributes<'_>) -> span::Id {
            span::Id::from_u64(1)
        }
        fn record(&self, _span: &span::Id, _values: &span::Record<'_>) {}
        fn record_follows_from(&self, _span: &span::Id, _follows: &span::Id) {}
        fn event(&self, event: &Event<'_>) {
            let level = *event.metadata().level();
            let mut collector = FieldCollector { out: String::new() };
            event.record(&mut collector);
            self.0
                .events
                .lock()
                .unwrap()
                .push(RecordedEvent { level, rendered: collector.out });
        }
        fn enter(&self, _span: &span::Id) {}
        fn exit(&self, _span: &span::Id) {}
    }

    /// Single-connection scripted WS gateway. Mirrors the helper in
    /// `zeroclaw_chat::tests`.
    async fn run_scripted_ws<F, Fut>(port_tx: oneshot::Sender<u16>, scenario: F)
    where
        F: FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut
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
        let callback = |_req: &HsRequest, response: HsResponse| Ok(response);
        let ws = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .unwrap();
        scenario(ws).await;
    }

    fn wake_for_test() -> WakeEvent {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e-zc-1".into(),
            listing_id: "l1".into(),
            title: Some("vintage chair".into()),
        };
        WakeEvent::Notification {
            kind: evt.kind().to_string(),
            event_id: evt.event_id().to_string(),
            user_id: "u1".into(),
            payload: evt,
        }
    }

    /// AC 2 + AC 6 — a deterministic `ChatError::Gateway` (e.g. a stale session
    /// the gateway rejects with an error frame) must surface a DISTINCT
    /// ERROR-severity alarm that names the gateway code. Today the worker logs it
    /// at WARN + `continue`, so this fails RED: zero ERROR events carry the code.
    #[tokio::test]
    async fn worker_emits_error_alarm_on_deterministic_gateway_failure() {
        let recorder = Arc::new(Recorder::default());
        let dispatch = Dispatch::new(recorder.clone());
        let _guard = tracing::dispatcher::set_default(&dispatch);

        let (port_tx, port_rx) = oneshot::channel();
        let server = tokio::spawn(run_scripted_ws(port_tx, |mut ws| async move {
            ws.send(Message::Text(
                serde_json::json!({
                    "type": "session_start",
                    "session_id": "session-1",
                    "resumed": true,
                })
                .to_string(),
            ))
            .await
            .unwrap();
            // Consume the client's outbound `message` frame, then reject with a
            // gateway error frame — the stale-session / bad-bearer shape.
            let _ = ws.next().await;
            ws.send(Message::Text(
                serde_json::json!({
                    "type": "error",
                    "code": "session_not_found",
                    "message": "no such session",
                })
                .to_string(),
            ))
            .await
            .unwrap();
        }));
        let port = port_rx.await.unwrap();

        let chat = Arc::new(ChatClient::new(
            format!("http://127.0.0.1:{port}"),
            "tok".into(),
        ));
        // Never reached on the error path (the worker `continue`s before send).
        let telegram = Arc::new(TelegramClient::with_base(
            "BOT".into(),
            "http://127.0.0.1:1".into(),
        ));
        let ctx = WorkerCtx {
            chat_id: 99,
            chat,
            telegram,
            klodi_home: PathBuf::from("/nonexistent-klodi-home"),
            operator_session_id: "session-1".into(),
        };

        let (etx, erx) = mpsc::channel::<InboundEvent>(4);
        etx.send(InboundEvent::Wake(Box::new(wake_for_test()))).await.unwrap();
        drop(etx); // close the inbox so the worker drains one event then exits

        run_worker(ctx, erx).await;
        let _ = server.await;

        assert!(
            recorder.errors_containing("session_not_found") >= 1,
            "deterministic Gateway failure must raise a DISTINCT ERROR alarm \
             naming the gateway code (post-ACK = the only possible surface); \
             recorded events: {}",
            recorder.dump(),
        );
    }

    /// AC 3 + AC 6 — a transient `ChatError::Timeout` keeps its existing WARN
    /// disposition and must NOT raise the deterministic ERROR alarm. This is the
    /// classification GUARD: it passes today (worker only WARNs) and must keep
    /// passing after the fix (Timeout stays transient).
    #[tokio::test]
    async fn worker_keeps_warn_only_on_transient_timeout_failure() {
        let recorder = Arc::new(Recorder::default());
        let dispatch = Dispatch::new(recorder.clone());
        let _guard = tracing::dispatcher::set_default(&dispatch);

        let (port_tx, port_rx) = oneshot::channel();
        let server = tokio::spawn(run_scripted_ws(port_tx, |mut ws| async move {
            ws.send(Message::Text(
                serde_json::json!({"type": "session_start"}).to_string(),
            ))
            .await
            .unwrap();
            let _ = ws.next().await;
            // Hold without `done` so the client's turn timeout fires.
            tokio::time::sleep(Duration::from_millis(500)).await;
        }));
        let port = port_rx.await.unwrap();

        let chat = Arc::new(
            ChatClient::new(
                format!("http://127.0.0.1:{port}"),
                "tok".into(),
            )
            .with_turn_timeout(Duration::from_millis(150)),
        );
        let telegram = Arc::new(TelegramClient::with_base(
            "BOT".into(),
            "http://127.0.0.1:1".into(),
        ));
        let ctx = WorkerCtx {
            chat_id: 99,
            chat,
            telegram,
            klodi_home: PathBuf::from("/nonexistent-klodi-home"),
            operator_session_id: "session-1".into(),
        };

        let (etx, erx) = mpsc::channel::<InboundEvent>(4);
        etx.send(InboundEvent::Wake(Box::new(wake_for_test()))).await.unwrap();
        drop(etx);

        run_worker(ctx, erx).await;
        let _ = server.await;

        assert!(
            !recorder.any_error(),
            "a transient Timeout must NOT raise an ERROR alarm — it stays WARN; \
             recorded events: {}",
            recorder.dump(),
        );
        assert!(
            recorder.any_warn(),
            "expected the transient timeout to still log a WARN; recorded: {}",
            recorder.dump(),
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-conversation wake-keying, openclaw + zeroclaw — Item 1 zeroclaw [integration].
//
// The two `[integration]` ACs: under per-turn session selection the worker runs
// a `Wake` on its derived per-entity session (`klodi:<entity_id>`) while an
// operator-typed message stays on the operator's own session (BR-6) — and EVERY
// reply still reaches the single operator `chat_id` (BR-6). The only observable
// contract is the session_id the worker puts on the `/ws/chat` handshake and the
// `chat_id` it forwards the reply to; both are captured at the transport boundary
// (a scripted WS + a Telegram wiremock).
//
// `run_worker` selects the session per turn —
// `Wake(w) => derive_wake_session(w)`, `OperatorMessage => ctx.operator_session_id`
// — and runs it through `ChatClient::send_and_wait(session_id, content)`. The
// ChatClient is constructed below with a SENTINEL constructor session the per-turn
// worker MUST ignore: these tests LOCK that the constructor session is never used.
// Do NOT weaken the assertions.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod per_turn_session_tests {
    use super::*;

    use crate::telegram::TelegramClient;
    use crate::zeroclaw_chat::ChatClient;
    use futures_util::{SinkExt, StreamExt};
    use klodi_nats_client::NotificationEvent;
    use std::sync::Mutex;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::handshake::server::{
        Request as HsRequest, Response as HsResponse,
    };
    use wiremock::matchers::{method as wm_method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Single-connection scripted WS that records the handshake request URI
    /// (carrying `?session_id=…`) into `captured_uri`, then runs one happy turn
    /// (session_start → consume the client's `message` frame → `done(reply)`).
    async fn run_uri_capturing_ws(
        port_tx: oneshot::Sender<u16>,
        captured_uri: Arc<Mutex<Option<String>>>,
        reply: String,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        port_tx.send(listener.local_addr().unwrap().port()).unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let slot = captured_uri.clone();
        // tungstenite's accept_hdr callback must return `Result<_, ErrorResponse>`;
        // the large Err type is the external API's, not ours.
        #[allow(clippy::result_large_err)]
        let callback = move |req: &HsRequest, response: HsResponse| {
            *slot.lock().unwrap() = Some(req.uri().to_string());
            Ok(response)
        };
        let mut ws = tokio_tungstenite::accept_hdr_async(stream, callback)
            .await
            .unwrap();
        ws.send(Message::Text(
            serde_json::json!({"type": "session_start", "resumed": false}).to_string(),
        ))
        .await
        .unwrap();
        let _ = ws.next().await; // consume the client's outbound `message` frame
        ws.send(Message::Text(
            serde_json::json!({"type": "done", "full_response": reply}).to_string(),
        ))
        .await
        .unwrap();
    }

    fn wake_offer_l1() -> WakeEvent {
        let evt = NotificationEvent::OfferProposed {
            event_id: "e-offer-l1".into(),
            offer_id: "off-1".into(),
            listing_id: "l1".into(),
            buyer_handle: "buyer".into(),
            amount: 1000,
            terms: None,
        };
        WakeEvent::Notification {
            kind: evt.kind().to_string(),
            event_id: evt.event_id().to_string(),
            user_id: "u1".into(),
            payload: evt,
        }
    }

    /// `[integration]` BR-6 — an operator-typed Telegram message (no entity) runs
    /// on the OPERATOR's own session, NOT a per-entity wake session.
    #[tokio::test]
    async fn operator_message_targets_operator_session_not_entity_key() {
        let captured = Arc::new(Mutex::new(None));
        let (port_tx, port_rx) = oneshot::channel();
        // Empty reply → worker skips the Telegram send (no telegram dep needed).
        let server = tokio::spawn(run_uri_capturing_ws(port_tx, captured.clone(), String::new()));
        let port = port_rx.await.unwrap();

        let chat = Arc::new(ChatClient::new(
            format!("http://127.0.0.1:{port}"),
            "tok".into(),
        ));
        let telegram = Arc::new(TelegramClient::with_base(
            "BOT".into(),
            "http://127.0.0.1:1".into(),
        ));
        let ctx = WorkerCtx {
            chat_id: 99,
            chat,
            telegram,
            klodi_home: PathBuf::from("/nonexistent-klodi-home"),
            operator_session_id: "operator-session-xyz".into(),
        };

        let (etx, erx) = mpsc::channel::<InboundEvent>(4);
        etx.send(InboundEvent::OperatorMessage {
            text: "yes, accept".into(),
            telegram_message_id: 7,
        })
        .await
        .unwrap();
        drop(etx);
        run_worker(ctx, erx).await;
        let _ = server.await;

        let uri = captured
            .lock()
            .unwrap()
            .clone()
            .expect("WS handshake never reached the scripted gateway");
        assert!(
            uri.contains("session_id=operator-session-xyz"),
            "an operator-typed message must run on the OPERATOR session (BR-6), not \
             the fixed constructor session and never an entity key; WS handshake URI: {uri}",
        );
        assert!(
            !uri.contains("klodi"),
            "an operator message carries no entity and must NEVER be klodi:-keyed: {uri}",
        );
    }

    /// `[integration]` BR-6 — a wake runs on its derived per-entity session
    /// (`klodi:<listing_id>`) AND its reply is forwarded to the single operator
    /// `chat_id` (the human keeps one unified Telegram view).
    #[tokio::test]
    async fn wake_runs_on_per_entity_session_and_reply_reaches_operator_chat() {
        let captured = Arc::new(Mutex::new(None));
        let (port_tx, port_rx) = oneshot::channel();
        let server =
            tokio::spawn(run_uri_capturing_ws(port_tx, captured.clone(), "agent reply".into()));
        let port = port_rx.await.unwrap();

        // Telegram wiremock to capture the chat_id the reply is sent to.
        let tg = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .and(wm_path("/botBOT/sendMessage"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ok": true,
                "result": { "message_id": 1, "date": 0, "chat": {"id": 99, "type": "private"} }
            })))
            .mount(&tg)
            .await;

        let chat = Arc::new(ChatClient::new(
            format!("http://127.0.0.1:{port}"),
            "tok".into(),
        ));
        let telegram = Arc::new(TelegramClient::with_base("BOT".into(), tg.uri()));
        let ctx = WorkerCtx {
            chat_id: 99,
            chat,
            telegram,
            klodi_home: PathBuf::from("/nonexistent-klodi-home"),
            operator_session_id: "operator-session-xyz".into(),
        };

        let (etx, erx) = mpsc::channel::<InboundEvent>(4);
        etx.send(InboundEvent::Wake(Box::new(wake_offer_l1()))).await.unwrap();
        drop(etx);
        run_worker(ctx, erx).await;
        let _ = server.await;

        let uri = captured
            .lock()
            .unwrap()
            .clone()
            .expect("WS handshake never reached the scripted gateway");
        // offer.proposed on listing "l1" → key klodi:l1 → percent-encoded klodi%3Al1.
        assert!(
            uri.contains("klodi%3Al1"),
            "a wake must run on its per-entity session (klodi:<listing_id>), not the \
             fixed operator/constructor session; WS handshake URI: {uri}",
        );

        // BR-6 — the reply still reaches the ONE operator chat_id (99).
        let requests = tg
            .received_requests()
            .await
            .expect("wiremock did not record requests");
        let send = requests
            .iter()
            .find(|r| r.url.path() == "/botBOT/sendMessage")
            .expect("the agent reply was never forwarded to Telegram");
        let body: serde_json::Value =
            serde_json::from_slice(&send.body).expect("sendMessage body must be JSON");
        assert_eq!(
            body["chat_id"].as_i64(),
            Some(99),
            "a per-entity wake's reply must still reach the single operator chat_id (BR-6)",
        );
    }
}
