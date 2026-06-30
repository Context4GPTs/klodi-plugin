//! Wake forwarder — shared across all Rust adapters.
//!
//! Subscribes the [`KlodiClient`] to both consumers and dispatches each
//! delivered notification or channel message through a per-adapter
//! [`WakeHandler`]. Adapters wire the handler to whatever shape their
//! host expects:
//!
//! - Moltis / IronClaw — POST a structured envelope to a local agent
//!   wake URL. See [`HttpStructuredHandler`].
//! - ZeroClaw — dispatch the event into an [`crate::operator_session::OperatorInbox`]
//!   so the per-operator worker can run one zeroclaw `/ws/chat` turn
//!   per event and forward the agent's reply to Telegram.
//!
//! Failure semantics: a handler that returns `Err` causes a JetStream
//! NAK and redelivery per the consumer's `max_deliver`. The forwarder
//! never silently drops a wake.

use anyhow::{Context, Result};
use klodi_logger::{KlodiLogger, LoggerSink};
use klodi_nats_client::{
    ChannelMessageEvent, KlodiClient, KlodiError, NotificationEvent,
};
use reqwest::Client as HttpClient;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

/// Structured wake envelope. Moltis and IronClaw consume this directly
/// via HTTP POST; ZeroClaw composes its prompt from the same shape.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "channel")]
pub enum WakeEvent {
    #[serde(rename = "notification")]
    Notification {
        kind: String,
        event_id: String,
        user_id: String,
        payload: NotificationEvent,
    },
    #[serde(rename = "channel.message")]
    ChannelMessage {
        kind: &'static str,
        event_id: String,
        user_id: String,
        payload: ChannelMessageEvent,
    },
}

impl WakeEvent {
    pub fn kind(&self) -> &str {
        match self {
            Self::Notification { kind, .. } => kind.as_str(),
            Self::ChannelMessage { kind, .. } => kind,
        }
    }

    pub fn event_id(&self) -> &str {
        match self {
            Self::Notification { event_id, .. } | Self::ChannelMessage { event_id, .. } => {
                event_id.as_str()
            }
        }
    }
}

/// Boxed-future shape the handler returns. Required for trait-object
/// dispatch; the concrete adapter implementations use plain `async fn`.
pub type WakeHandlerFuture<'a> =
    Pin<Box<dyn Future<Output = Result<(), KlodiError>> + Send + 'a>>;

/// Per-adapter wake handler. Owns whatever transport state it needs;
/// the forwarder hands it one [`WakeEvent`] at a time. Two writes can
/// arrive concurrently (one per NATS consumer) so handlers must be
/// `Sync` — the forwarder serialises calls via a per-daemon mutex on
/// the trait-object side, but a handler that keeps its own state should
/// still be safe to share.
pub trait WakeHandler: Send + Sync {
    fn handle<'a>(&'a self, event: &'a WakeEvent) -> WakeHandlerFuture<'a>;
}

/// Daemon configuration. Per-adapter binaries build this from CLI/env.
pub struct ForwarderConfig {
    /// Path to `nats.creds`.
    pub creds_path: PathBuf,
    /// Path to `config.json`.
    pub config_path: PathBuf,
    /// Per-adapter wake handler.
    pub handler: Arc<dyn WakeHandler>,
    /// Per-adapter log namespace. Example: `"klodi_moltis"`. Used in
    /// `tracing` event names so operator dashboards stay legible across
    /// hosts.
    pub log_event_prefix: String,
    /// Optional `/healthz` HTTP probe (P2-25). When `Some(port)` the
    /// daemon binds `0.0.0.0:<port>` and serves `GET /healthz` →
    /// `200 OK` if NATS connected, `503` otherwise.
    pub health_port: Option<u16>,
}

/// Run the forwarder until the process is signalled. Exits on Ctrl-C /
/// SIGTERM after closing the NATS connection cleanly.
pub async fn run_forwarder(config: ForwarderConfig) -> Result<()> {
    let client = KlodiClient::new(&config.creds_path, &config.config_path)
        .await
        .context("loading klodi client config + creds")?;
    client.connect().await.context("connecting to NATS")?;
    let user_id = client.config().user_id.clone();
    tracing::info!(
        user_id = %user_id,
        nats_url = %client.config().nats_url,
        prefix = %config.log_event_prefix,
        "klodi_daemon_connected"
    );

    let shared = Arc::new(SharedState {
        user_id: user_id.clone(),
        log_event_prefix: config.log_event_prefix.clone(),
        handler: config.handler,
    });

    install_subscribers(&client, shared).await?;

    if let Some(port) = config.health_port {
        let health_client = Arc::new(client.clone());
        tokio::spawn(async move {
            if let Err(err) = crate::health::serve_health(port, health_client).await {
                tracing::warn!(
                    error = %err,
                    port = port,
                    "klodi_daemon_health_endpoint_failed"
                );
            }
        });
    }

    let signal = wait_for_shutdown().await?;
    tracing::info!(
        signal = signal,
        prefix = %config.log_event_prefix,
        "klodi_daemon_shutdown_signalled"
    );
    client.close().await.context("closing klodi client")?;
    Ok(())
}

#[cfg(unix)]
async fn wait_for_shutdown() -> Result<&'static str> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigterm =
        signal(SignalKind::terminate()).context("installing SIGTERM handler")?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => Ok("SIGINT"),
        _ = sigterm.recv() => Ok("SIGTERM"),
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown() -> Result<&'static str> {
    tokio::signal::ctrl_c()
        .await
        .context("waiting for shutdown signal")?;
    Ok("SIGINT")
}

struct SharedState {
    user_id: String,
    log_event_prefix: String,
    handler: Arc<dyn WakeHandler>,
}

async fn install_subscribers(
    client: &KlodiClient,
    shared: Arc<SharedState>,
) -> Result<()> {
    let notif_state = shared.clone();
    client
        .subscribe_notifications(Arc::new(move |evt| {
            let state = notif_state.clone();
            Box::pin(async move {
                let event = WakeEvent::Notification {
                    kind: evt.kind().to_string(),
                    event_id: evt.event_id().to_string(),
                    user_id: state.user_id.clone(),
                    payload: evt,
                };
                dispatch(&state, event).await
            })
        }))
        .await
        .context("subscribing to notifications")?;

    let chan_state = shared;
    client
        .subscribe_channels(Arc::new(move |evt| {
            let state = chan_state.clone();
            Box::pin(async move {
                let event = WakeEvent::ChannelMessage {
                    kind: "channel.message",
                    event_id: evt.event_id.clone(),
                    user_id: state.user_id.clone(),
                    payload: evt,
                };
                dispatch(&state, event).await
            })
        }))
        .await
        .context("subscribing to channels")?;
    Ok(())
}

async fn dispatch(state: &SharedState, event: WakeEvent) -> Result<(), KlodiError> {
    state.handler.handle(&event).await.map(|_| {
        tracing::info!(
            user_id = %state.user_id,
            kind = %event.kind(),
            event_id = %event.event_id(),
            prefix = %state.log_event_prefix,
            "klodi_wake_dispatched"
        );
    })
}

// --- Structured-HTTP handler (Moltis / IronClaw) -----------------------------

/// Distinct, operator-alertable ERROR event for a deterministic (4xx)
/// wake-forward failure. Reconciled with the merged hermes
/// `wake_inject_deterministic_failure` template (ADR-0019); named in the
/// existing `klodi_wake_forward_*` family so dashboards stay legible.
const WAKE_FORWARD_DETERMINISTIC_FAILURE: &str = "klodi_wake_forward_deterministic_failure";

/// Wake handler that POSTs each event as JSON to a local host wake URL.
/// The host acks on receipt and runs the agent in the background, so
/// per-attempt timeouts are bounded short — a stalled host surfaces
/// fast and JetStream redelivers.
pub struct HttpStructuredHandler {
    http: HttpClient,
    wake_url: String,
    token: Option<String>,
    log_event_prefix: String,
    logger: KlodiLogger,
}

impl HttpStructuredHandler {
    pub fn new(
        wake_url: String,
        token: Option<String>,
        user_agent: String,
        log_event_prefix: String,
        timeout: Duration,
    ) -> Result<Self> {
        let http = HttpClient::builder()
            .timeout(timeout)
            .user_agent(user_agent)
            .build()
            .context("building reqwest client")?;
        let logger = KlodiLogger::new(format!(
            "klodi-rust-host.{log_event_prefix}.forwarder"
        ));
        Ok(Self {
            http,
            wake_url,
            token,
            log_event_prefix,
            logger,
        })
    }

    /// Redirect this handler's logger to an injected sink. Production wires
    /// the default `StdSink` (via `new`); tests pass a `CaptureSink` so the
    /// alarm SEVERITY (4xx ERROR vs 5xx/transport WARN) is assertable — the
    /// log stream is otherwise uncapturable from a unit test.
    pub fn with_sink(mut self, sink: Arc<dyn LoggerSink>) -> Self {
        self.logger = KlodiLogger::new(format!(
            "klodi-rust-host.{}.forwarder",
            self.log_event_prefix
        ))
        .with_sink(sink);
        self
    }

    /// Classify a non-2xx wake-forward response and pick the disposition.
    ///
    /// A **4xx** is deterministic (bad URL / bad token / malformed payload —
    /// it fails identically on every redelivery): emit the distinct ERROR
    /// alarm and ACK (`Ok`) so JetStream stops the futile redeliver-then-drop;
    /// the alarm, not redelivery, is the operator surface. Anything else
    /// non-success (5xx, and any other non-2xx) is treated as transient: keep
    /// the WARN and NAK (`Err`) so JetStream redelivers. The diagnostic rides
    /// on `response_body` (NOT in `REDACTED_FIELD_NAMES`, unlike `body`) so the
    /// alarm stays explainable. Mirrors the hermes deterministic/transient split.
    fn classify_non_success(
        &self,
        event: &WakeEvent,
        status: reqwest::StatusCode,
        body: String,
    ) -> Result<(), KlodiError> {
        if status.is_client_error() {
            let mut fields: HashMap<String, Value> = HashMap::new();
            fields.insert("kind".into(), json!(event.kind()));
            fields.insert("event_id".into(), json!(event.event_id()));
            fields.insert("status".into(), json!(status.as_u16()));
            fields.insert("response_body".into(), json!(body));
            fields.insert("prefix".into(), json!(self.log_event_prefix));
            self.logger
                .error_msg(WAKE_FORWARD_DETERMINISTIC_FAILURE, Some(fields));
            return Ok(());
        }
        let mut fields: HashMap<String, Value> = HashMap::new();
        fields.insert("kind".into(), json!(event.kind()));
        fields.insert("status".into(), json!(status.as_u16()));
        fields.insert("body".into(), json!(body));
        fields.insert("prefix".into(), json!(self.log_event_prefix));
        self.logger.warn("klodi_wake_forward_non_2xx", Some(fields));
        Err(KlodiError::NatsPublish(format!(
            "wake POST returned {status}"
        )))
    }
}

impl WakeHandler for HttpStructuredHandler {
    fn handle<'a>(&'a self, event: &'a WakeEvent) -> WakeHandlerFuture<'a> {
        Box::pin(async move {
            let mut request = self
                .http
                .post(&self.wake_url)
                .header("Content-Type", "application/json")
                .json(event);
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            match request.send().await {
                Ok(resp) if resp.status().is_success() => Ok(()),
                Ok(resp) => {
                    let status = resp.status();
                    let txt = resp.text().await.unwrap_or_default();
                    self.classify_non_success(event, status, txt)
                }
                Err(err) => {
                    // Transport / timeout = transient → NAK so JetStream
                    // redelivers (a stalled or unreachable host may recover).
                    let mut fields: HashMap<String, Value> = HashMap::new();
                    fields.insert("kind".into(), json!(event.kind()));
                    fields.insert("error".into(), json!(err.to_string()));
                    fields.insert("prefix".into(), json!(self.log_event_prefix));
                    self.logger
                        .warn("klodi_wake_forward_transport_error", Some(fields));
                    Err(KlodiError::NatsPublish(format!(
                        "wake POST transport error: {err}"
                    )))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_event_notification_serialises_with_channel_tag() {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e1".into(),
            listing_id: "l1".into(),
            title: Some("vintage chair".into()),
        };
        let post = WakeEvent::Notification {
            kind: evt.kind().to_string(),
            event_id: evt.event_id().to_string(),
            user_id: "u1".into(),
            payload: evt,
        };
        let json = serde_json::to_value(&post).unwrap();
        assert_eq!(json["channel"], "notification");
        assert_eq!(json["kind"], "listing.created");
        assert_eq!(json["event_id"], "e1");
        assert_eq!(json["user_id"], "u1");
        assert_eq!(json["payload"]["listing_id"], "l1");
    }

    #[test]
    fn wake_event_channel_message_serialises_with_channel_tag() {
        let evt = ChannelMessageEvent {
            event_id: "e2".into(),
            channel_id: "c1".into(),
            message_id: "m1".into(),
            sequence: 42,
            sender_user_id: "u2".into(),
            sender_handle: "alice".into(),
            content: "hello".into(),
            created_at: "2026-04-26T10:00:00Z".into(),
        };
        let post = WakeEvent::ChannelMessage {
            kind: "channel.message",
            event_id: evt.event_id.clone(),
            user_id: "u1".into(),
            payload: evt,
        };
        let json = serde_json::to_value(&post).unwrap();
        assert_eq!(json["channel"], "channel.message");
        assert_eq!(json["kind"], "channel.message");
        assert_eq!(json["event_id"], "e2");
        assert_eq!(json["payload"]["sequence"], 42);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // card/audit-all-adapters-for-silent-wake-inject-failure — RED (qa-developer)
    //
    // Seam 2 — shared rust-http forwarder (moltis + ironclaw) (ACs 2, 3, 4).
    //
    // `HttpStructuredHandler::handle` (:267-307) today maps EVERY non-2xx AND
    // every transport error to WARN + `Err`, which `dispatch` propagates into a
    // JetStream NAK / redeliver-then-drop. There is NO 4xx-deterministic vs
    // 5xx/transient distinction, so a deterministic 4xx (bad URL / bad token /
    // bad payload) redelivers pointlessly and then drops silently after
    // `max_deliver` — never alarmed, never terminal. The fix (per ADR-0019's
    // deterministic→ACK call, mirrored per language) classifies the HTTP status:
    //
    //   - 4xx  = deterministic → `logger.error(…_deterministic_failure)` + ACK
    //            (return `Ok(())`) — stop the futile redeliver-then-drop;
    //   - 5xx / transport / timeout = transient → keep WARN + `Err` (NAK).
    //
    // These tests assert the load-bearing, observable-today DISPOSITION
    // (`Ok` = ACK vs `Err` = NAK). The 4xx test fails RED (handler returns `Err`
    // today); the 5xx + transport tests are GUARDS (already `Err`, must stay
    // `Err`).
    //
    // SEVERITY (card/openclaw-zeroclaw-per-conversation-wake-keying, Item 3) —
    // the `with_sink`/`CaptureSink` seam landed (#34), so the deferred ERROR-vs-WARN
    // severity assertion is now writable and lives in `severity_red_tests` below.
    // Because both ERROR and WARN route to `CaptureSink::stderr` (logger-rs:284),
    // the helper parses each captured line's `level` field rather than relying on
    // stream split. These severity tests are GREEN on landing (production
    // `classify_non_success` already routes 4xx→error_msg, 5xx/transport→warn):
    // they LOCK the contract — no production change is part of Item 3.
    use wiremock::matchers::method as wm_method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn wake_for_test() -> WakeEvent {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e-http-1".into(),
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

    fn handler_for(wake_url: String) -> HttpStructuredHandler {
        HttpStructuredHandler::new(
            wake_url,
            Some("tok".into()),
            "klodi-test/0".into(),
            "klodi_test".into(),
            std::time::Duration::from_secs(5),
        )
        .expect("building HttpStructuredHandler")
    }

    /// AC 4 (+ AC 2) — a deterministic 4xx must ACK (`Ok`) so the wake is not
    /// redelivered-then-silently-dropped; the alarm, not redelivery, is the
    /// surface. Fails RED: the handler returns `Err` on every non-2xx today.
    #[tokio::test]
    async fn handle_4xx_acks_with_ok_to_stop_futile_redelivery() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad token"))
            .mount(&server)
            .await;

        let handler = handler_for(server.uri());
        let event = wake_for_test();
        let result = handler.handle(&event).await;

        assert!(
            result.is_ok(),
            "a deterministic 4xx must ACK (Ok) — redelivering it just burns \
             max_deliver and drops silently; got {result:?}",
        );
    }

    /// AC 3 — a 5xx is transient: keep the NAK (`Err`) so JetStream redelivers.
    /// GUARD: passes today, must keep passing after the 4xx/5xx split lands.
    #[tokio::test]
    async fn handle_5xx_naks_with_err_to_redeliver_transient() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .mount(&server)
            .await;

        let handler = handler_for(server.uri());
        let event = wake_for_test();
        let result = handler.handle(&event).await;

        assert!(
            result.is_err(),
            "a transient 5xx must NAK (Err) so JetStream redelivers; got {result:?}",
        );
    }

    /// AC 3 — a transport error (connection refused) is transient: keep the NAK
    /// (`Err`). GUARD: passes today, must keep passing.
    #[tokio::test]
    async fn handle_transport_error_naks_with_err() {
        // Bind then drop to get a definitely-closed port → connection refused.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let handler = handler_for(format!("http://127.0.0.1:{port}/"));
        let event = wake_for_test();
        let result = handler.handle(&event).await;

        assert!(
            result.is_err(),
            "a transport error must NAK (Err) so JetStream redelivers; got {result:?}",
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// card/openclaw-zeroclaw-per-conversation-wake-keying — Item 3 (qa-developer).
//
// rust-http forwarder SEVERITY assertions, wired through `with_sink(CaptureSink)`.
// The `Ok`/`Err` DISPOSITION is already covered by `mod tests` above; this module
// asserts the LOG SEVERITY contract from ADR-0019's cross-adapter table:
//
//   - 4xx → exactly ONE ERROR `klodi_wake_forward_deterministic_failure` carrying
//           the diagnostic in the non-redacted `response_body` field plus
//           `kind`/`event_id`/`status`; no second ERROR.
//   - 5xx → a WARN `klodi_wake_forward_non_2xx` and ZERO ERROR events.
//   - transport error → a WARN `klodi_wake_forward_transport_error` and ZERO ERROR.
//
// Pure test-landing: production `classify_non_success` already routes correctly,
// so these are GREEN on landing and LOCK the contract against regression. NEVER
// weaken an assertion to match a future change — fix the production routing.
// ─────────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod severity_red_tests {
    use super::*;
    use klodi_logger::CaptureSink;
    use serde_json::Value;
    use std::sync::Arc;
    use wiremock::matchers::method as wm_method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn wake_for_test() -> WakeEvent {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e-http-1".into(),
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

    fn handler_with(wake_url: String, sink: Arc<CaptureSink>) -> HttpStructuredHandler {
        HttpStructuredHandler::new(
            wake_url,
            Some("tok".into()),
            "klodi-test/0".into(),
            "klodi_test".into(),
            std::time::Duration::from_secs(5),
        )
        .expect("building HttpStructuredHandler")
        .with_sink(sink)
    }

    /// Both WARN and ERROR route to `CaptureSink::stderr` (logger-rs), so parse
    /// every captured line as JSON and filter by the `level` field — NOT by
    /// stream. Returns `(level, msg, fields)` triples.
    fn parsed_stderr(sink: &CaptureSink) -> Vec<(String, String, Value)> {
        sink.stderr_lines()
            .iter()
            .map(|raw| {
                let v: Value = serde_json::from_str(raw).expect("logger emitted invalid JSON");
                (
                    v["level"].as_str().unwrap_or_default().to_string(),
                    v["msg"].as_str().unwrap_or_default().to_string(),
                    v["fields"].clone(),
                )
            })
            .collect()
    }

    /// AC — a deterministic 4xx records EXACTLY ONE ERROR alarm named
    /// `klodi_wake_forward_deterministic_failure` carrying the diagnostic in the
    /// non-redacted `response_body` field plus `kind`/`event_id`/`status`, and no
    /// second ERROR.
    #[tokio::test]
    async fn handle_4xx_emits_single_error_alarm_with_diagnostic_on_response_body() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad token"))
            .mount(&server)
            .await;

        let sink = Arc::new(CaptureSink::new());
        let handler = handler_with(server.uri(), sink.clone());
        let _ = handler.handle(&wake_for_test()).await;

        let lines = parsed_stderr(&sink);
        let errors: Vec<_> = lines.iter().filter(|(lvl, ..)| lvl == "ERROR").collect();
        assert_eq!(
            errors.len(),
            1,
            "a 4xx must emit exactly ONE ERROR (no second); got: {lines:?}",
        );
        let (_, msg, fields) = errors[0];
        assert_eq!(msg, "klodi_wake_forward_deterministic_failure");
        // The diagnostic body MUST ride `response_body` (not `body`, which is in
        // REDACTED_FIELD_NAMES) so the alarm stays explainable.
        assert_eq!(
            fields["response_body"].as_str(),
            Some("bad token"),
            "diagnostic must survive on the non-redacted response_body field: {fields:?}",
        );
        assert_eq!(fields["kind"].as_str(), Some("listing.created"));
        assert_eq!(fields["event_id"].as_str(), Some("e-http-1"));
        assert_eq!(fields["status"].as_u64(), Some(400));
    }

    /// AC — a 5xx records a WARN `klodi_wake_forward_non_2xx` and ZERO ERROR.
    #[tokio::test]
    async fn handle_5xx_emits_warn_and_zero_errors() {
        let server = MockServer::start().await;
        Mock::given(wm_method("POST"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .mount(&server)
            .await;

        let sink = Arc::new(CaptureSink::new());
        let handler = handler_with(server.uri(), sink.clone());
        let _ = handler.handle(&wake_for_test()).await;

        let lines = parsed_stderr(&sink);
        assert!(
            lines.iter().any(|(lvl, msg, _)| lvl == "WARN"
                && msg == "klodi_wake_forward_non_2xx"),
            "a 5xx must emit a WARN klodi_wake_forward_non_2xx; got: {lines:?}",
        );
        assert_eq!(
            lines.iter().filter(|(lvl, ..)| lvl == "ERROR").count(),
            0,
            "a transient 5xx must NOT raise an ERROR alarm; got: {lines:?}",
        );
    }

    /// AC — a transport error records a WARN `klodi_wake_forward_transport_error`
    /// and ZERO ERROR.
    #[tokio::test]
    async fn handle_transport_error_emits_warn_and_zero_errors() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let sink = Arc::new(CaptureSink::new());
        let handler = handler_with(format!("http://127.0.0.1:{port}/"), sink.clone());
        let _ = handler.handle(&wake_for_test()).await;

        let lines = parsed_stderr(&sink);
        assert!(
            lines.iter().any(|(lvl, msg, _)| lvl == "WARN"
                && msg == "klodi_wake_forward_transport_error"),
            "a transport error must emit a WARN klodi_wake_forward_transport_error; \
             got: {lines:?}",
        );
        assert_eq!(
            lines.iter().filter(|(lvl, ..)| lvl == "ERROR").count(),
            0,
            "a transient transport error must NOT raise an ERROR alarm; got: {lines:?}",
        );
    }
}
