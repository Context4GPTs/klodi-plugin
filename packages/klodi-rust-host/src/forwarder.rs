//! Wake-forwarder daemon — shared across all Rust adapters.
//!
//! Subscribes the [`KlodiClient`] to both consumers, then dispatches
//! each delivered notification or channel message according to the
//! adapter's body shape: HTTP POST to a local host wake URL for
//! Moltis + IronClaw (`BodyShape::Structured`), or — for the ZeroClaw
//! adapter — through a [`crate::channels::ChannelRegistry`] that picks
//! one agent surface per wake and falls through to lower-floor
//! surfaces on Err (`BodyShape::ZeroClawRegistry`). Adapter-specific
//! knobs:
//!
//! - `wake_url`         where to POST (HTTP path); unused on the
//!                      ZeroClaw WS path.
//! - `bearer_token`     optional `Authorization: Bearer …`.
//! - `user_agent`       per-adapter UA string.
//! - `log_event_prefix` per-adapter log namespace (e.g. `"klodi_moltis"`).
//! - `health_port`      optional `--health-port` for `/healthz` probe.
//! - `body_shape`       see [`BodyShape`].
//!
//! Failure semantics: a non-2xx HTTP response, a WS frame error, or a
//! transport error returns `Err` from the consumer handler, which
//! causes a JetStream NAK and redelivery per `max_deliver: 5`. The
//! daemon never silently drops a wake.
//!
//! Per **D § D8** + P1-13 + P1-14 + P2-25: SIGTERM handling, optional
//! bearer-token auth, and optional health endpoint all land here in
//! one place. Three adapters consume the single implementation.

use anyhow::{Context, Result};
use klodi_logger::KlodiLogger;
use klodi_nats_client::{
    ChannelMessageEvent, KlodiClient, KlodiError, NotificationEvent,
};
use reqwest::Client as HttpClient;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Body shape the host's wake endpoint accepts. Picked per-adapter at
/// daemon startup; the forwarder dispatches on it in [`forward`].
///
/// `Structured` goes to the HTTP wake URL. `ZeroClawRegistry` routes
/// each wake through a single-destination channel registry that picks
/// the highest-floor agent surface accepting the notification, falling
/// through to lower-floor agent surfaces on Err (the dedicated session
/// is the natural backstop; chronicle of record per plan §1). Replaces
/// the 0.2.10 `ZeroClawSession` single-target variant that pinned
/// every wake to the daemon's boot-time session id and left the
/// dashboard tab silent during autonomous negotiations (see
/// `docs/reports/2026-05-11-klodi-zeroclaw-0.2.10-session-routing-no-fanout.md`).
#[derive(Clone)]
pub enum BodyShape {
    /// Structured envelope: `{ channel, kind, event_id, user_id, payload }`.
    /// Moltis and IronClaw consume this directly via HTTP POST.
    Structured,
    /// Route the wake through the registered klodi channels. The
    /// carried `ChannelRegistry` is shared with the daemon's
    /// reply-attribution task and the MCP server's approval gate —
    /// every klodi notification path runs through the same registry
    /// shape so routing is consistent.
    ///
    /// The registry guarantees single-destination among agent surfaces
    /// (dedicated session + dashboard); failures fall through to
    /// lower-floor agent surfaces automatically. Only when **every**
    /// accepting agent surface fails does the forwarder NAK so
    /// JetStream redelivers. Upstream notification sinks fan
    /// alongside; their failures are best-effort and don't gate the
    /// NATS ack.
    ///
    /// Only the `klodi-zeroclaw-daemon` builds this variant; the
    /// `zeroclaw_session` Cargo feature gates the supporting modules.
    #[cfg(feature = "zeroclaw_session")]
    ZeroClawRegistry {
        registry: crate::channels::ChannelRegistry,
        /// Dedicated klodi session UUID — surfaced in log fields so
        /// `klodi_wake_forwarded_via_ws` stays grep-friendly when
        /// diagnosing routing decisions. The registry's
        /// [`crate::channels::DedicatedSessionChannel`] owns the actual
        /// WS write; this field is informational only.
        dedicated_session_id: String,
    },
}

// Single Debug impl with a cfg-gated arm — avoids the
// positive+negative cfg split that `adapters/zeroclaw/scripts/vendor.py`
// can't safely strip (it removes `#[cfg(feature = "zeroclaw_session")]`
// but leaves `#[cfg(not(feature = ...))]`, so both halves of a split
// would compile in the staged crate and conflict on the impl). See the
// matching note in `mcp/tools.rs::dispatch` for the same rule applied
// to a mutable binding.
impl std::fmt::Debug for BodyShape {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Structured => f.debug_struct("Structured").finish(),
            #[cfg(feature = "zeroclaw_session")]
            Self::ZeroClawRegistry {
                dedicated_session_id,
                ..
            } => f
                .debug_struct("ZeroClawRegistry")
                .field("dedicated_session_id", dedicated_session_id)
                .field("registry", &"<…>")
                .finish(),
        }
    }
}

/// Daemon configuration. Per-adapter binaries build this from CLI/env.
pub struct ForwarderConfig {
    /// Path to `nats.creds`.
    pub creds_path: PathBuf,
    /// Path to `config.json`.
    pub config_path: PathBuf,
    /// Local host wake URL (e.g. Moltis's
    /// `http://127.0.0.1:5000/agents/default/wake`, IronClaw's
    /// `/event-trigger`). Unused on the ZeroClaw path — the
    /// `BodyShape::ZeroClawRegistry` variant routes through the
    /// channel registry, which owns the per-channel WS configs.
    pub wake_url: String,
    /// Optional bearer token. P1-14 promotes this from Moltis-only to
    /// shared — IronClaw + ZeroClaw inherit the mechanism.
    pub bearer_token: Option<String>,
    /// HTTP `User-Agent` the per-adapter binary identifies as. Example:
    /// `"klodi-moltis-daemon/0.2"`.
    pub user_agent: String,
    /// Per-adapter log namespace. Example: `"klodi_moltis"`. Used in
    /// `tracing` event names so operator dashboards stay legible across
    /// hosts.
    pub log_event_prefix: String,
    /// Optional `/healthz` HTTP probe (P2-25). When `Some(port)` the
    /// daemon binds `0.0.0.0:<port>` and serves `GET /healthz` →
    /// `200 OK` if NATS connected, `503` otherwise.
    pub health_port: Option<u16>,
    /// Body shape the host accepts. See [`BodyShape`].
    pub body_shape: BodyShape,
    /// Per-attempt reqwest timeout for the wake POST. Picked per-adapter
    /// for `BodyShape::Structured` consumers — asynchronous hosts that
    /// ack on receipt and run the agent in the background (Moltis,
    /// IronClaw) want a small bound — seconds — so a stalled host
    /// surfaces fast and JetStream redelivers. Unused on the
    /// `BodyShape::ZeroClawRegistry` path; ZeroClaw's daemon sets a
    /// nominal value here that's never consulted.
    pub wake_post_timeout: Duration,
}

#[derive(Serialize)]
#[serde(tag = "channel")]
enum WakePost<'a> {
    #[serde(rename = "notification")]
    Notification {
        kind: &'a str,
        event_id: &'a str,
        user_id: &'a str,
        payload: &'a NotificationEvent,
    },
    #[serde(rename = "channel.message")]
    ChannelMessage {
        kind: &'static str,
        event_id: &'a str,
        user_id: &'a str,
        payload: &'a ChannelMessageEvent,
    },
}

/// Run the daemon until the process is signalled. Exits on Ctrl-C /
/// SIGTERM after closing the NATS connection cleanly.
///
/// P1-13 (subsumed by D8): production sends SIGTERM (systemd, Docker,
/// launchd, k8s all default to it). Without the SIGTERM branch the
/// supervisor escalates to SIGKILL after 30-90s and severs NATS
/// without draining in-flight ack/nak — JetStream then redelivers on
/// next start, which the operator sees as duplicate wakes.
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

    let http = HttpClient::builder()
        .timeout(config.wake_post_timeout)
        .user_agent(config.user_agent.as_str())
        .build()
        .context("building reqwest client")?;
    let logger = KlodiLogger::new(format!(
        "klodi-rust-host.{}.forwarder",
        config.log_event_prefix
    ));
    let shared = Arc::new(SharedState {
        http,
        wake_url: config.wake_url,
        token: config.bearer_token,
        user_id: user_id.clone(),
        log_event_prefix: config.log_event_prefix.clone(),
        body_shape: config.body_shape,
        logger,
        #[cfg(feature = "zeroclaw_session")]
        zeroclaw_dispatch_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    install_subscribers(&client, shared.clone()).await?;

    // Optional health probe — supervisors drive restart on a wedged
    // forwarder by polling `/healthz` and treating 503 as a restart
    // trigger (P2-25).
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
    http: HttpClient,
    wake_url: String,
    token: Option<String>,
    user_id: String,
    log_event_prefix: String,
    body_shape: BodyShape,
    /// Per **D § D15** + P3-14: HTTP error bodies route through KlodiLogger
    /// so the catalog redact list (`body`, `bearer_token`, etc.) is honored
    /// before anything reaches the operator log. Replaces the previous
    /// `tracing::warn!(body = %txt, ...)` which echoed the host's verbatim
    /// 4xx/5xx body — including any token the host echoed back.
    logger: KlodiLogger,
    /// Per-daemon dispatch lock. Only meaningful for
    /// `BodyShape::ZeroClawRegistry`. Two independent forwarder tasks
    /// (one per NATS consumer — notifications + channel.messages) may
    /// call `registry.route_wake` concurrently; without this lock
    /// their writes interleave at the WS level and operators see
    /// notifications arrive out of NATS-arrival order. The lock is
    /// held for the duration of one route call (the registry runs
    /// per-channel WS writes sequentially inside); per-channel
    /// reconnect storms are the registered channel's concern, not
    /// the forwarder's — the channel impls track their own failure
    /// state and apply WS-handshake backoff (see
    /// [`crate::zeroclaw_ws::send_session_message`]).
    #[cfg(feature = "zeroclaw_session")]
    zeroclaw_dispatch_lock: Arc<tokio::sync::Mutex<()>>,
}

async fn install_subscribers(
    client: &KlodiClient,
    shared: Arc<SharedState>,
) -> Result<()> {
    let notif_state = shared.clone();
    client
        .subscribe_notifications(Arc::new(move |evt| {
            let state = notif_state.clone();
            Box::pin(async move { post_notification(state, evt).await })
        }))
        .await
        .context("subscribing to notifications")?;

    let chan_state = shared;
    client
        .subscribe_channels(Arc::new(move |evt| {
            let state = chan_state.clone();
            Box::pin(async move { post_channel(state, evt).await })
        }))
        .await
        .context("subscribing to channels")?;
    Ok(())
}

async fn post_notification(
    state: Arc<SharedState>,
    evt: NotificationEvent,
) -> Result<(), KlodiError> {
    let post = WakePost::Notification {
        kind: evt.kind(),
        event_id: evt.event_id(),
        user_id: &state.user_id,
        payload: &evt,
    };
    forward(&state, &post, evt.kind()).await
}

async fn post_channel(
    state: Arc<SharedState>,
    evt: ChannelMessageEvent,
) -> Result<(), KlodiError> {
    let post = WakePost::ChannelMessage {
        kind: "channel.message",
        event_id: &evt.event_id,
        user_id: &state.user_id,
        payload: &evt,
    };
    forward(&state, &post, "channel.message").await
}

async fn forward<T: Serialize>(
    state: &SharedState,
    body: &T,
    kind: &str,
) -> Result<(), KlodiError> {
    match &state.body_shape {
        BodyShape::Structured => forward_http(state, body, kind).await,
        #[cfg(feature = "zeroclaw_session")]
        BodyShape::ZeroClawRegistry {
            registry,
            dedicated_session_id,
        } => forward_zeroclaw_registry(state, body, kind, registry, dedicated_session_id).await,
    }
}

async fn forward_http<T: Serialize>(
    state: &SharedState,
    body: &T,
    kind: &str,
) -> Result<(), KlodiError> {
    let mut request = state
        .http
        .post(&state.wake_url)
        .header("Content-Type", "application/json");
    request = match &state.body_shape {
        BodyShape::Structured => request.json(body),
        #[cfg(feature = "zeroclaw_session")]
        BodyShape::ZeroClawRegistry { .. } => {
            // Unreachable: `forward` dispatches `ZeroClawRegistry` to
            // the registry path before calling here. Guarded so the
            // compiler keeps the match exhaustive even when the feature
            // is on.
            return Err(KlodiError::NatsPublish(
                "forward_http called with ZeroClawRegistry body shape".into(),
            ));
        }
    };
    if let Some(token) = &state.token {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::info!(
                user_id = %state.user_id,
                kind = %kind,
                status = %resp.status(),
                prefix = %state.log_event_prefix,
                "klodi_wake_forwarded"
            );
            Ok(())
        }
        Ok(resp) => {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            // P3-14: route the response body through KlodiLogger so the
            // catalog redact list (`body`) replaces the value with
            // "[redacted]" before anything reaches the operator log.
            // Anyone debugging locally can flip `LOG_LEVEL=DEBUG` to
            // see the raw body.
            let mut fields: HashMap<String, Value> = HashMap::new();
            fields.insert("user_id".into(), json!(state.user_id));
            fields.insert("kind".into(), json!(kind));
            fields.insert("status".into(), json!(status.as_u16()));
            fields.insert("body".into(), json!(txt));
            fields.insert("prefix".into(), json!(state.log_event_prefix));
            state.logger.warn("klodi_wake_forward_non_2xx", Some(fields));
            Err(KlodiError::NatsPublish(format!(
                "wake POST returned {status}"
            )))
        }
        Err(err) => {
            let mut fields: HashMap<String, Value> = HashMap::new();
            fields.insert("user_id".into(), json!(state.user_id));
            fields.insert("kind".into(), json!(kind));
            fields.insert("error".into(), json!(err.to_string()));
            fields.insert("prefix".into(), json!(state.log_event_prefix));
            state.logger.warn("klodi_wake_forward_transport_error", Some(fields));
            Err(KlodiError::NatsPublish(format!(
                "wake POST transport error: {err}"
            )))
        }
    }
}

#[cfg(feature = "zeroclaw_session")]
async fn forward_zeroclaw_registry<T: Serialize>(
    state: &SharedState,
    body: &T,
    kind: &str,
    registry: &crate::channels::ChannelRegistry,
    dedicated_session_id: &str,
) -> Result<(), KlodiError> {
    // Serialise the wake envelope so the dedicated session's agent can
    // still `JSON.parse` it; carried on the Notification's `structured`
    // field, which every channel renderer keeps in a fenced JSON block.
    let envelope_value =
        serde_json::to_value(body).map_err(|err| {
            KlodiError::NatsPublish(format!("wake registry dispatch to_value: {err}"))
        })?;
    let event_id = envelope_value
        .get("event_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?")
        .to_string();
    let summary = format!("marketplace event — `{kind}` (event `{event_id}`)");

    // Compute severity from the event kind here, at the caller — the
    // registry doesn't promote silently. Picking severity is the
    // forwarder's responsibility (it knows wake events are marketplace
    // events); the registry's only job is to route what it's handed.
    let severity = crate::channels::default_severity_for_event(kind);

    let notif = crate::channels::Notification {
        event_kind: kind.to_string(),
        summary,
        details: None,
        severity,
        structured: Some(envelope_value),
        correlation_id: Some(event_id.clone()),
        reply_hint: None,
    };

    // Per-daemon dispatch serialisation. Two NATS subscriber tasks
    // (notifications + channel-messages) both call this function;
    // without the lock their per-channel writes interleave and the
    // operator sees notifications arrive out of NATS-arrival order.
    let _guard = state.zeroclaw_dispatch_lock.lock().await;

    // Single call — the registry tries the highest-floor agent surface
    // first and falls through to lower-floor surfaces on Err (the
    // dedicated session is the natural backstop). The forwarder no
    // longer rolls its own fallback render: every render lives behind
    // its channel impl, the dedicated channel's resurrection probe
    // runs on every attempt, and there's exactly one format per
    // surface.
    let outcome = registry.route_wake(notif).await;

    if outcome.posted {
        tracing::info!(
            user_id = %state.user_id,
            kind = %kind,
            severity = %severity.as_str(),
            destination = ?outcome.destination_channel,
            event_id = %event_id,
            dedicated_session_id = %dedicated_session_id,
            prefix = %state.log_event_prefix,
            "klodi_wake_forwarded_via_ws"
        );
        return Ok(());
    }

    // Every accepting agent surface failed (including the dedicated
    // backstop). NAK so JetStream redelivers on the consumer's next
    // poll — the daemon doesn't drop wakes.
    let mut fields: HashMap<String, Value> = HashMap::new();
    fields.insert("user_id".into(), json!(state.user_id));
    fields.insert("kind".into(), json!(kind));
    fields.insert("severity".into(), json!(severity.as_str()));
    fields.insert("dedicated_session_id".into(), json!(dedicated_session_id));
    fields.insert("event_id".into(), json!(event_id));
    fields.insert(
        "last_attempted_destination".into(),
        json!(outcome.destination_channel),
    );
    fields.insert("prefix".into(), json!(state.log_event_prefix));
    state.logger.warn(
        "klodi_wake_forward_every_channel_failed",
        Some(fields),
    );
    Err(KlodiError::NatsPublish(format!(
        "wake forward exhausted every agent channel (last attempt: {:?}) \
         — JetStream will redeliver",
        outcome.destination_channel,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wake_post_notification_serialises_with_channel_tag() {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e1".into(),
            listing_id: "l1".into(),
            title: Some("vintage chair".into()),
        };
        let post = WakePost::Notification {
            kind: evt.kind(),
            event_id: evt.event_id(),
            user_id: "u1",
            payload: &evt,
        };
        let json = serde_json::to_value(&post).unwrap();
        assert_eq!(json["channel"], "notification");
        assert_eq!(json["kind"], "listing.created");
        assert_eq!(json["event_id"], "e1");
        assert_eq!(json["user_id"], "u1");
        assert_eq!(json["payload"]["listing_id"], "l1");
    }

    #[test]
    fn wake_post_channel_message_serialises_with_channel_tag() {
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
        let post = WakePost::ChannelMessage {
            kind: "channel.message",
            event_id: &evt.event_id,
            user_id: "u1",
            payload: &evt,
        };
        let json = serde_json::to_value(&post).unwrap();
        assert_eq!(json["channel"], "channel.message");
        assert_eq!(json["kind"], "channel.message");
        assert_eq!(json["event_id"], "e2");
        assert_eq!(json["payload"]["sequence"], 42);
    }

}
