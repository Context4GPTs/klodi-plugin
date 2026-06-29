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
use klodi_logger::KlodiLogger;
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
                    let mut fields: HashMap<String, Value> = HashMap::new();
                    fields.insert("kind".into(), json!(event.kind()));
                    fields.insert("status".into(), json!(status.as_u16()));
                    fields.insert("body".into(), json!(txt));
                    fields.insert("prefix".into(), json!(self.log_event_prefix));
                    self.logger.warn("klodi_wake_forward_non_2xx", Some(fields));
                    Err(KlodiError::NatsPublish(format!(
                        "wake POST returned {status}"
                    )))
                }
                Err(err) => {
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
    // NOTE — the DISTINCT ERROR-severity alarm (ACs 2/3) is NOT asserted here:
    // `HttpStructuredHandler::new` builds its `KlodiLogger` internally on
    // `StdSink`, with no injection point, so the log stream is uncapturable from
    // a unit test. GREEN must add a `LoggerSink`/`KlodiLogger` injection on the
    // handler (the `klodi-logger` crate already ships `CaptureSink` + `with_sink`);
    // qa adds the severity assertion (4xx → one ERROR alarm carrying status+body;
    // 5xx/transport → WARN only) once that seam exists. See the GREEN handoff.
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
