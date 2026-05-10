//! Wake-forwarder daemon — shared across all Rust adapters.
//!
//! Subscribes the [`KlodiClient`] to both consumers, then dispatches
//! each delivered notification or channel message according to the
//! adapter's body shape: HTTP POST to a local host wake URL for
//! Moltis + IronClaw (`BodyShape::Structured`), or a WebSocket write
//! into the operator's persisted ZeroClaw session for the ZeroClaw
//! adapter (`BodyShape::ZeroClawSession`). Adapter-specific knobs:
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
/// `Structured` goes to the HTTP wake URL. `ZeroClawSession` is the
/// I-1 redesign path — the wake is written into the operator's
/// persisted ZeroClaw session via WebSocket (`/ws/chat?session_id=…`),
/// bypassing `/webhook` and the 30s `TimeoutLayer` entirely.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyShape {
    /// Structured envelope: `{ channel, kind, event_id, user_id, payload }`.
    /// Moltis and IronClaw consume this directly via HTTP POST.
    Structured,
    /// Write the wake into the operator's persisted ZeroClaw session via
    /// WebSocket. The carried fields are the resolved session id and
    /// WS / HTTP base / bearer at daemon-start time. Only the
    /// `klodi-zeroclaw-daemon` builds this variant; the
    /// `zeroclaw_session` Cargo feature gates the supporting modules.
    #[cfg(feature = "zeroclaw_session")]
    ZeroClawSession {
        ws_config: crate::zeroclaw_ws::ZeroClawWsConfig,
        session_id: String,
    },
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
    /// `BodyShape::ZeroClawSession` variant carries its own WS URL on
    /// the embedded `ws_config`.
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
    /// `BodyShape::ZeroClawSession` path; ZeroClaw's daemon sets a
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
        zeroclaw_session_lock: Arc::new(tokio::sync::Mutex::new(())),
        #[cfg(feature = "zeroclaw_session")]
        zeroclaw_failure_count: Arc::new(std::sync::atomic::AtomicU32::new(0)),
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
    /// Per-session WS write lock. Only meaningful for
    /// `BodyShape::ZeroClawSession`. Per the updated plan §8.6, two
    /// independent forwarder tasks (one per NATS consumer) write to
    /// the same operator session; we acquire this mutex around the
    /// full WS lifecycle so writes land in NATS-arrival order even if
    /// the gateway's `SessionActorQueue` reordering is incomplete. The
    /// lock is held for the duration of one WS connect → send → drain
    /// cycle (typically <2s on an idle session, up to DRAIN_TIMEOUT in
    /// the worst case), so per-session throughput is bounded by drain
    /// time. Acceptable for the marketplace's expected wake volume;
    /// revisit if measured throughput becomes the bottleneck.
    #[cfg(feature = "zeroclaw_session")]
    zeroclaw_session_lock: Arc<tokio::sync::Mutex<()>>,
    /// Consecutive WS-send failure count for the operator-session
    /// path. Reset to zero on success. Used by the reconnect-backoff
    /// guard to space out retries when the gateway is unreachable —
    /// without this, every NATS redelivery hammers the gateway with a
    /// fresh handshake the moment JetStream's redelivery cadence ticks
    /// (which has its own jitter, but doesn't compound across retries
    /// when the gateway is genuinely down). Plan §9 risks row:
    /// "WebSocket reconnect storms after gateway restart".
    #[cfg(feature = "zeroclaw_session")]
    zeroclaw_failure_count: Arc<std::sync::atomic::AtomicU32>,
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
        BodyShape::ZeroClawSession {
            ws_config,
            session_id,
        } => forward_zeroclaw_session(state, body, kind, ws_config, session_id).await,
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
        BodyShape::ZeroClawSession { .. } => {
            // Unreachable: `forward` dispatches `ZeroClawSession` to the
            // WS path before calling here. Guarded so the compiler keeps
            // the match exhaustive even when the feature is on.
            return Err(KlodiError::NatsPublish(
                "forward_http called with ZeroClawSession body shape".into(),
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
async fn forward_zeroclaw_session<T: Serialize>(
    state: &SharedState,
    body: &T,
    kind: &str,
    ws_config: &crate::zeroclaw_ws::ZeroClawWsConfig,
    session_id: &str,
) -> Result<(), KlodiError> {
    // The wake message lands in the operator's chat. Render as a
    // human-readable headline plus the original structured envelope in
    // a fenced JSON block so the agent can still `JSON.parse` it.
    let envelope_value =
        serde_json::to_value(body).map_err(|err| {
            KlodiError::NatsPublish(format!("wake WS body to_value: {err}"))
        })?;
    let pretty = serde_json::to_string_pretty(&envelope_value).map_err(|err| {
        KlodiError::NatsPublish(format!("wake WS body pretty-print: {err}"))
    })?;
    let event_id = envelope_value
        .get("event_id")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let content = format!(
        "🔔 marketplace event — `{kind}` (event `{event_id}`)\n\n```json\n{pretty}\n```"
    );

    // Per-session serialisation. The two NATS subscriber tasks
    // (notifications + channel-messages) both call this function;
    // without the lock their WS handshakes can race and the gateway
    // would observe arrival order non-deterministically. See the
    // SharedState field's docstring for the throughput trade-off.
    let _guard = state.zeroclaw_session_lock.lock().await;

    // Reconnect backoff: if previous WS sends have been failing,
    // sleep before trying this one. This keeps NATS redeliveries
    // from hammering a gateway that's down or slow to recover (plan
    // §9 reconnect-storm risk). The lock is held throughout the
    // sleep so other waiters also see the backoff — that's
    // intentional: the failure is per-gateway, not per-message, and
    // parallel retries would just amplify the load.
    let prior_failures = state
        .zeroclaw_failure_count
        .load(std::sync::atomic::Ordering::Relaxed);
    if prior_failures > 0 {
        let delay = ws_backoff_for(prior_failures);
        tracing::warn!(
            user_id = %state.user_id,
            session_id = %session_id,
            consecutive_failures = prior_failures,
            backoff_ms = delay.as_millis() as u64,
            prefix = %state.log_event_prefix,
            "klodi_zeroclaw_ws_backoff_before_send"
        );
        tokio::time::sleep(delay).await;
    }

    match crate::zeroclaw_ws::send_session_message(ws_config, session_id, &content).await {
        Ok(_) => {
            // Reset the failure counter so the next send is unthrottled.
            state
                .zeroclaw_failure_count
                .store(0, std::sync::atomic::Ordering::Relaxed);
            tracing::info!(
                user_id = %state.user_id,
                kind = %kind,
                session_id = %session_id,
                prefix = %state.log_event_prefix,
                "klodi_wake_forwarded_via_ws"
            );
            Ok(())
        }
        Err(err) => {
            // Increment for the next send's backoff computation.
            state
                .zeroclaw_failure_count
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let mut fields: HashMap<String, Value> = HashMap::new();
            fields.insert("user_id".into(), json!(state.user_id));
            fields.insert("kind".into(), json!(kind));
            fields.insert("session_id".into(), json!(session_id));
            fields.insert("error".into(), json!(format!("{err:#}")));
            fields.insert("prefix".into(), json!(state.log_event_prefix));
            state.logger.warn(
                "klodi_wake_forward_ws_error",
                Some(fields),
            );
            Err(KlodiError::NatsPublish(format!(
                "wake WS send error: {err:#}"
            )))
        }
    }
}

/// Compute the backoff delay before the Nth WS retry. Built on top of
/// `klodi_nats_client::backoff::compute_backoff` so we share its tested
/// jitter semantics; we override only the `cap` (30s vs the NATS
/// default 60s) so wake forwarding doesn't queue indefinitely behind a
/// long-running backoff. JetStream's own redelivery cadence already
/// adds spacing — this caps the *additional* wait per failure.
///
/// Uses `default_reconnect_delay` under a custom config so we don't
/// have to plumb our own RNG. Tests that observe the exact value
/// would need to inject a deterministic random_unit; for the
/// integration-shaped behaviour we test (counter increments, delay
/// non-zero after first failure) the production RNG is fine.
#[cfg(feature = "zeroclaw_session")]
fn ws_backoff_for(prior_failures: u32) -> std::time::Duration {
    use klodi_nats_client::backoff::{BackoffConfig, compute_backoff};
    let attempt = prior_failures.saturating_add(1).min(WS_BACKOFF_CAP_ATTEMPTS);
    let mut cfg = BackoffConfig::default();
    cfg.cap = std::time::Duration::from_secs(30);
    // Use a fixed midpoint (0.5) for the random unit; the spread the
    // jitter adds on top would be ±25% of the (capped) value, but we
    // don't have an RNG dep here. The fixed midpoint is fine because
    // the lock is held during sleep — other waiters can't race to
    // pick a different bucket — and JetStream's redelivery cadence
    // already adds the practical jitter we need across wakes.
    compute_backoff(attempt, cfg, 0.5)
}

/// Maximum attempt index fed into `compute_backoff`. Bounded so
/// `multiplier^attempt` doesn't overflow the f64 mantissa on
/// pathological failure counts; the result is capped to `cap` long
/// before this matters.
#[cfg(feature = "zeroclaw_session")]
const WS_BACKOFF_CAP_ATTEMPTS: u32 = 16;

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "zeroclaw_session")]
    #[test]
    fn ws_backoff_zero_failures_is_unused() {
        // The forwarder never calls ws_backoff_for(0) — that branch is
        // skipped via the `if prior_failures > 0` guard. But asserting
        // it returns the base delay anyway pins the math: attempt=1
        // gives the BackoffConfig base (250ms) at random_unit 0.5
        // (no jitter offset).
        let d = ws_backoff_for(0);
        assert_eq!(d, std::time::Duration::from_millis(250));
    }

    #[cfg(feature = "zeroclaw_session")]
    #[test]
    fn ws_backoff_grows_then_caps_at_30s() {
        // With base=250ms, multiplier=2: 1→250, 2→500, 3→1000, 4→2000,
        // 5→4000, 6→8000, 7→16000, 8→30000 (capped from 32000).
        // We test a couple of points + the cap.
        assert_eq!(ws_backoff_for(1), std::time::Duration::from_millis(500));
        assert_eq!(ws_backoff_for(2), std::time::Duration::from_millis(1000));
        // Anything past the cap clamps at 30s (no jitter offset since
        // ws_backoff_for hardcodes 0.5).
        assert_eq!(ws_backoff_for(20), std::time::Duration::from_secs(30));
        assert_eq!(ws_backoff_for(u32::MAX), std::time::Duration::from_secs(30));
    }

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
