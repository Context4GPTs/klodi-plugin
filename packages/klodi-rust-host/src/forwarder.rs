//! Wake-forwarder daemon — shared across all Rust adapters.
//!
//! Subscribes the [`KlodiClient`] to both consumers, then translates
//! each delivered notification or channel message into an HTTP POST to
//! a local host wake URL. Three adapter-specific knobs configure this:
//!
//! - `wake_url`         where to POST.
//! - `bearer_token`     optional `Authorization: Bearer …` (Moltis).
//! - `user_agent`       per-adapter UA string.
//! - `log_event_prefix` per-adapter log namespace (e.g. `"klodi_moltis"`).
//! - `health_port`      optional `--health-port` for `/healthz` probe.
//!
//! Failure semantics: a non-2xx response or transport error from the
//! host wake POST returns `Err` from the consumer handler, which causes
//! a JetStream NAK and redelivery per `max_deliver: 5`. The daemon
//! never silently drops a wake.
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

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Daemon configuration. Per-adapter binaries build this from CLI/env.
pub struct ForwarderConfig {
    /// Path to `nats.creds`.
    pub creds_path: PathBuf,
    /// Path to `config.json`.
    pub config_path: PathBuf,
    /// Local host wake URL (e.g. Moltis's
    /// `http://127.0.0.1:5000/agents/default/wake`, IronClaw's
    /// `/event-trigger`, ZeroClaw's `/hooks/wake`).
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
        .timeout(HTTP_TIMEOUT)
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
        logger,
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
    /// Per **D § D15** + P3-14: HTTP error bodies route through KlodiLogger
    /// so the catalog redact list (`body`, `bearer_token`, etc.) is honored
    /// before anything reaches the operator log. Replaces the previous
    /// `tracing::warn!(body = %txt, ...)` which echoed the host's verbatim
    /// 4xx/5xx body — including any token the host echoed back.
    logger: KlodiLogger,
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
    let mut request = state
        .http
        .post(&state.wake_url)
        .header("Content-Type", "application/json")
        .json(body);
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
