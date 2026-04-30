//! KlodiClient — single persistent NATS-WS connection per session.
//!
//! Public surface mirrors `klodi-plugin/packages/nats-client-ts/src/client.ts`:
//!
//!   - `new`                     load creds + config from disk
//!   - `connect`                 open NATS-WS (NKey auth via creds file)
//!   - `request`                 NATS request/reply for tool calls
//!   - `subscribe_notifications` durable JetStream consumer + handler
//!   - `subscribe_channels`      durable JetStream consumer + handler
//!   - `publish_channel_message` direct JetStream publish to a channel
//!   - `close`                   drain + close
//!   - `is_connected`            liveness for health checks
//!
//! Adapters never touch `async-nats` directly.

use crate::backoff::default_reconnect_delay;
use crate::config::{KlodiConfig, assert_wss_or_localhost, load_config, load_creds};
use crate::consumers::{
    ActiveSubscription, ChannelHandler, NotificationHandler, subscribe_channels,
    subscribe_notifications,
};
use crate::error::KlodiError;
use crate::metrics::{ClientMetrics, MetricsRecorder};
use crate::publish::{PublishAck, publish_channel_message};
use async_nats::{Client, ConnectOptions, HeaderMap, Request};
use async_nats::header::HeaderName;
use async_nats::jetstream::{self, Context as JetStreamContext};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::Path;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

/// Default request/reply timeout for tool calls.
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Mirror server-side ping_interval in `nats-server.conf`.
const WS_PING_INTERVAL: Duration = Duration::from_secs(20);
/// Tighter than nats-core's 20s default — lifecycle on hosts with
/// limited supervision benefits from fast failure.
const WS_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

const HEADER_USER_ID: &str = "X-User-Id";
const HEADER_NKEY_PUBLIC: &str = "X-Nkey-Public";

/// Per-call options for [`KlodiClient::request`].
#[derive(Default, Clone, Copy, Debug)]
pub struct RequestOptions {
    /// Override the default 10s timeout.
    pub timeout: Option<Duration>,
}

#[derive(Clone, Debug, serde::Deserialize)]
struct ErrorEnvelope {
    error: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    details: Option<Value>,
}

struct Connected {
    client: Client,
    ctx: JetStreamContext,
}

/// Single persistent NATS-WS client. Cloning is cheap — internals are
/// shared via `Arc`. Shareable across tokio tasks for adapters that
/// register tool calls + wake handlers concurrently.
#[derive(Clone)]
pub struct KlodiClient {
    config: Arc<KlodiConfig>,
    creds: Arc<String>,
    state: Arc<Mutex<Option<Connected>>>,
    notifications_sub: Arc<Mutex<Option<ActiveSubscription>>>,
    channels_sub: Arc<Mutex<Option<ActiveSubscription>>>,
    /// Per-client counters (P2-27). Shared via `Arc<Atomic*>` inside
    /// the recorder so concurrent consumer tasks can increment safely.
    metrics: MetricsRecorder,
}

impl KlodiClient {
    /// Load creds + config from disk. Does not connect — call
    /// [`connect`](Self::connect) once construction succeeds.
    pub async fn new(creds_path: &Path, config_path: &Path) -> Result<Self, KlodiError> {
        let config = load_config(config_path)?;
        let creds = load_creds(creds_path)?;
        Ok(Self {
            config: Arc::new(config),
            creds: Arc::new(creds),
            state: Arc::new(Mutex::new(None)),
            notifications_sub: Arc::new(Mutex::new(None)),
            channels_sub: Arc::new(Mutex::new(None)),
            metrics: MetricsRecorder::new(),
        })
    }

    /// Read-only snapshot of per-client counters (P2-27).
    ///
    /// Call this from the `--health-port /metrics` exporter, an
    /// in-process operator dashboard, or an ad-hoc diagnostic. The
    /// snapshot is consistent at the moment of the call but not
    /// monotonic across snapshots — call again for a refreshed view.
    pub fn metrics(&self) -> ClientMetrics {
        self.metrics.snapshot()
    }

    /// Open the underlying NATS-WS connection. Idempotent — calling
    /// twice returns Ok if already connected.
    pub async fn connect(&self) -> Result<(), KlodiError> {
        let mut state = self.state.lock().await;
        if let Some(connected) = state.as_ref() {
            if connected.client.connection_state()
                == async_nats::connection::State::Connected
            {
                return Ok(());
            }
        }
        // Per **D § D10**: refuse plaintext nats_url unless the host
        // resolves to localhost. Closes the compound attack where a
        // compromised registration endpoint injects a `ws://` URL.
        assert_wss_or_localhost(&self.config.nats_url)?;
        // P2-5: replace async-nats's default linear delay with the
        // shared exponential-backoff-with-jitter formula. The callback
        // is `Fn(usize) -> Duration` — translates `attempts` to a
        // 1-based attempt index inside `default_reconnect_delay`.
        let client = ConnectOptions::with_credentials(self.creds.as_str())?
            .ping_interval(WS_PING_INTERVAL)
            .connection_timeout(WS_CONNECT_TIMEOUT)
            .name("klodi-rust-client")
            .max_reconnects(None)
            .reconnect_delay_callback(default_reconnect_delay)
            .retry_on_initial_connect()
            .connect(self.config.nats_url.as_str())
            .await?;
        let ctx = jetstream::new(client.clone());
        *state = Some(Connected { client, ctx });
        Ok(())
    }

    /// Liveness check — true once `connect()` succeeded and the
    /// underlying transport is currently connected.
    pub async fn is_connected(&self) -> bool {
        let state = self.state.lock().await;
        state
            .as_ref()
            .map(|c| {
                c.client.connection_state()
                    == async_nats::connection::State::Connected
            })
            .unwrap_or(false)
    }

    /// Tool-call request/reply. Adds `X-User-Id` and `X-Nkey-Public`
    /// headers the marketplace's `auth.ts` uses to resolve the caller.
    /// Returns the parsed JSON body. If the marketplace responds with
    /// an error envelope (`{"error":"...","message":"..."}`), this
    /// returns [`KlodiError::Marketplace`].
    pub async fn request<R, B>(
        &self,
        subject: &str,
        body: &B,
        options: Option<RequestOptions>,
    ) -> Result<R, KlodiError>
    where
        R: DeserializeOwned,
        B: Serialize + ?Sized,
    {
        let client = self.require_client().await?;
        let payload = serde_json::to_vec(body)?;
        let timeout = options
            .and_then(|o| o.timeout)
            .unwrap_or(DEFAULT_REQUEST_TIMEOUT);

        let mut headers = HeaderMap::new();
        let user_id_name = HeaderName::from_str(HEADER_USER_ID).map_err(|err| {
            KlodiError::JetStreamConsumer(format!("invalid header name: {err}"))
        })?;
        let nkey_name = HeaderName::from_str(HEADER_NKEY_PUBLIC).map_err(|err| {
            KlodiError::JetStreamConsumer(format!("invalid header name: {err}"))
        })?;
        headers.insert(user_id_name, self.config.user_id.as_str());
        headers.insert(nkey_name, self.config.nkey_public.as_str());

        let request = Request::new()
            .payload(payload.into())
            .headers(headers)
            .timeout(Some(timeout));
        let msg = client.send_request(subject.to_owned(), request).await?;

        let value: Value = serde_json::from_slice(&msg.payload)?;
        if let Some(envelope) = parse_error_envelope(&value) {
            return Err(KlodiError::Marketplace {
                code: envelope.error,
                message: envelope.message.unwrap_or_default(),
                details: envelope.details,
            });
        }
        let result: R = serde_json::from_value(value)?;
        Ok(result)
    }

    /// Attach a handler to the per-user notifications consumer. The
    /// library creates the durable consumer if absent and starts a
    /// background pull loop. Each delivered event is parsed, deduped on
    /// `event_id`, and passed to the handler. Handler returns `Ok` →
    /// ack; returns `Err` → nak (redelivers per `max_deliver: 5`).
    ///
    /// Calling twice replaces the previous handler — the previous
    /// background task is aborted first.
    pub async fn subscribe_notifications(
        &self,
        handler: NotificationHandler,
    ) -> Result<(), KlodiError> {
        let ctx = self.require_jetstream().await?;
        let mut current = self.notifications_sub.lock().await;
        if let Some(mut prev) = current.take() {
            // P3-16: drain the prior loop cleanly via the watch
            // shutdown rather than aborting the task in `Drop`.
            prev.stop().await;
        }
        let sub = subscribe_notifications(
            &ctx,
            &self.config.user_id,
            handler,
            self.metrics.clone(),
        )
        .await?;
        *current = Some(sub);
        Ok(())
    }

    /// Attach a handler to the per-user channels consumer.
    /// `filter_subjects` is server-managed by the marketplace — we
    /// never set or mutate it. New channels appear as new subjects in
    /// the stream of deliveries.
    pub async fn subscribe_channels(
        &self,
        handler: ChannelHandler,
    ) -> Result<(), KlodiError> {
        let ctx = self.require_jetstream().await?;
        let mut current = self.channels_sub.lock().await;
        if let Some(mut prev) = current.take() {
            prev.stop().await;
        }
        let sub = subscribe_channels(
            &ctx,
            &self.config.user_id,
            handler,
            self.metrics.clone(),
        )
        .await?;
        *current = Some(sub);
        Ok(())
    }

    /// Publish a channel message via direct JetStream publish. Returns
    /// the [`PublishAck`] with the JetStream sequence as durability
    /// confirmation.
    pub async fn publish_channel_message(
        &self,
        channel_id: &str,
        content: &str,
    ) -> Result<PublishAck, KlodiError> {
        let ctx = self.require_jetstream().await?;
        publish_channel_message(
            &ctx,
            channel_id,
            &self.config.user_id,
            &self.config.handle,
            content,
        )
        .await
    }

    /// Stop both consumer loops and drain the connection. After
    /// `close()` a fresh `connect()` re-establishes everything.
    pub async fn close(&self) -> Result<(), KlodiError> {
        if let Some(mut sub) = self.notifications_sub.lock().await.take() {
            // P3-16: await drainage so in-flight ack/nak land before
            // the NATS connection drains.
            sub.stop().await;
        }
        if let Some(mut sub) = self.channels_sub.lock().await.take() {
            sub.stop().await;
        }
        if let Some(connected) = self.state.lock().await.take() {
            connected
                .client
                .drain()
                .await
                .map_err(|err| KlodiError::NatsPublish(format!("drain failed: {err}")))?;
        }
        Ok(())
    }

    /// Read-only access to the loaded config. Adapters need
    /// `user_id` / `handle` for logging and host-side bookkeeping.
    pub fn config(&self) -> &KlodiConfig {
        &self.config
    }

    async fn require_client(&self) -> Result<Client, KlodiError> {
        let state = self.state.lock().await;
        match state.as_ref() {
            Some(connected) => Ok(connected.client.clone()),
            None => Err(KlodiError::NotConnected),
        }
    }

    async fn require_jetstream(&self) -> Result<JetStreamContext, KlodiError> {
        let state = self.state.lock().await;
        match state.as_ref() {
            Some(connected) => Ok(connected.ctx.clone()),
            None => Err(KlodiError::NotConnected),
        }
    }
}

fn parse_error_envelope(value: &Value) -> Option<ErrorEnvelope> {
    if let Value::Object(map) = value {
        if map.contains_key("error") && map.get("error").and_then(Value::as_str).is_some()
        {
            return serde_json::from_value(value.clone()).ok();
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_envelope_parses_marketplace_shape() {
        let body = serde_json::json!({
            "error": "INVALID_REQUEST",
            "message": "title required",
            "details": {"field": "title"}
        });
        let env = parse_error_envelope(&body).expect("envelope");
        assert_eq!(env.error, "INVALID_REQUEST");
        assert_eq!(env.message.as_deref(), Some("title required"));
        assert!(env.details.is_some());
    }

    #[test]
    fn error_envelope_ignored_for_success_body() {
        let body = serde_json::json!({"id": "list1", "status": "active"});
        assert!(parse_error_envelope(&body).is_none());
    }

    #[test]
    fn error_envelope_ignored_when_error_is_not_string() {
        let body = serde_json::json!({"error": 42});
        assert!(parse_error_envelope(&body).is_none());
    }

    #[test]
    fn error_envelope_handles_missing_message() {
        let body = serde_json::json!({"error": "RATE_LIMIT"});
        let env = parse_error_envelope(&body).expect("envelope");
        assert_eq!(env.error, "RATE_LIMIT");
        assert!(env.message.is_none());
    }
}
