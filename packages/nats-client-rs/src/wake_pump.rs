//! Host-agnostic wake pump (Rust port).
//!
//! Mirrors `klodi-plugin/packages/nats-client-ts/src/wake-pump.ts` and
//! `klodi-plugin/packages/nats-client-py/src/klodi_nats_client/wake_pump.py`.
//! The pump composes both subscribe calls (notifications + channels) on
//! a `KlodiClient`-shaped client into one cohesive lifecycle (start /
//! stop / health) and singletonises per `user_id` so the same persona
//! never accidentally runs two competing pumps inside the same process.
//!
//! Subscribe ownership lives in this shared library so adapters
//! (Moltis, IronClaw, ZeroClaw) shrink to handler wiring (~20 lines)
//! and never depend on a host SDK lifecycle event for wake delivery.

use crate::error::KlodiError;
use crate::events::{ChannelMessageEvent, NotificationEvent};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime};
use tokio::sync::Mutex;

/// Boxed-future return type used across the pump's trait surfaces.
pub type BoxedFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Async notification handler the adapter installs on the pump.
pub type NotifyHandlerFn = Arc<
    dyn Fn(NotificationEvent) -> BoxedFut<'static, Result<(), KlodiError>>
        + Send
        + Sync,
>;

/// Async channel-event handler the adapter installs on the pump.
pub type ChannelHandlerFn = Arc<
    dyn Fn(ChannelMessageEvent) -> BoxedFut<'static, Result<(), KlodiError>>
        + Send
        + Sync,
>;

/// Narrow surface the pump needs from an inner subscription. The
/// production [`crate::consumers::ActiveSubscription`] already supplies
/// these; the trait is exposed so tests can plug in fakes without
/// spinning up async-nats.
pub trait ActiveSubscriptionLike: Send + Sync {
    fn stop<'a>(&'a self) -> BoxedFut<'a, ()>;
    fn get_last_event_at(&self) -> Option<SystemTime>;
    fn get_inactive_threshold_ms(&self) -> Option<u64>;
}

/// Minimal client surface the pump depends on. Production passes a real
/// [`crate::KlodiClient`] adapter (see `WakePumpKlodiClient` in
/// `client.rs`); tests pass a fake so the contract is exercised without
/// async-nats.
pub trait WakePumpClient: Send + Sync {
    fn is_connected(&self) -> bool;
    fn subscribe_notifications<'a>(
        &'a self,
        handler: NotifyHandlerFn,
    ) -> BoxedFut<'a, Result<Arc<dyn ActiveSubscriptionLike>, KlodiError>>;
    fn subscribe_channels<'a>(
        &'a self,
        handler: ChannelHandlerFn,
    ) -> BoxedFut<'a, Result<Arc<dyn ActiveSubscriptionLike>, KlodiError>>;
}

/// Diagnostic snapshot of pump state. Exposed via `WakePump::health` for
/// `klodi_setup_status`-style callers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WakePumpHealth {
    pub running: bool,
    pub user_id: String,
    pub notifications_last_event_at: Option<SystemTime>,
    pub channels_last_event_at: Option<SystemTime>,
    pub notifications_inactive_threshold_ms: Option<u64>,
    pub channels_inactive_threshold_ms: Option<u64>,
}

const DEFAULT_MAX_START_ATTEMPTS: u32 = 5;

fn default_retry_delay(attempt: u32) -> Duration {
    let secs = u64::from(attempt).min(30);
    Duration::from_secs(secs)
}

/// Internal per-pump state kept under a single mutex so start/stop don't
/// race. Held in an `Arc<Mutex<_>>` so the pump itself can be shared
/// freely across tasks.
struct PumpState {
    user_id: String,
    on_notification: NotifyHandlerFn,
    on_channel_event: ChannelHandlerFn,
    max_start_attempts: u32,
    retry_delay: fn(u32) -> Duration,
    running: bool,
    notifications_sub: Option<Arc<dyn ActiveSubscriptionLike>>,
    channels_sub: Option<Arc<dyn ActiveSubscriptionLike>>,
}

/// Host-agnostic wake pump. Construct via [`create_wake_pump`]; the
/// registry de-dupes instances per `user_id`.
pub struct WakePump {
    client: Arc<dyn WakePumpClient>,
    state: Mutex<PumpState>,
}

impl WakePump {
    /// Attach both consumers. Idempotent — re-call is a no-op when the
    /// pump is already running.
    pub async fn start(&self) -> Result<(), KlodiError> {
        let state = self.state.lock().await;
        if state.running {
            return Ok(());
        }
        let on_notification = state.on_notification.clone();
        let on_channel_event = state.on_channel_event.clone();
        let max = state.max_start_attempts;
        let retry = state.retry_delay;

        // Drop the lock before awaiting subscribe — the lock guards
        // local pump state, not the network operation.
        drop(state);

        let notif_sub = self
            .attach_notifications(on_notification, max, retry)
            .await?;
        let chan_sub = match self
            .attach_channels(on_channel_event, max, retry)
            .await
        {
            Ok(sub) => sub,
            Err(err) => {
                // Notifications attached but channels failed: drain
                // notifications so the pump never half-starts.
                notif_sub.stop().await;
                return Err(err);
            }
        };

        let mut state = self.state.lock().await;
        state.notifications_sub = Some(notif_sub);
        state.channels_sub = Some(chan_sub);
        state.running = true;
        tracing::info!(
            user_id = %state.user_id,
            "klodi_wake_pump_started"
        );
        Ok(())
    }

    async fn attach_notifications(
        &self,
        handler: NotifyHandlerFn,
        max_attempts: u32,
        retry_delay: fn(u32) -> Duration,
    ) -> Result<Arc<dyn ActiveSubscriptionLike>, KlodiError> {
        let mut last_err: Option<KlodiError> = None;
        for attempt in 1..=max_attempts {
            match self
                .client
                .subscribe_notifications(handler.clone())
                .await
            {
                Ok(sub) => return Ok(sub),
                Err(err) => {
                    last_err = Some(err);
                    if attempt >= max_attempts {
                        break;
                    }
                    let delay = retry_delay(attempt);
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        Err(wrap_attach_error("notifications", last_err))
    }

    async fn attach_channels(
        &self,
        handler: ChannelHandlerFn,
        max_attempts: u32,
        retry_delay: fn(u32) -> Duration,
    ) -> Result<Arc<dyn ActiveSubscriptionLike>, KlodiError> {
        let mut last_err: Option<KlodiError> = None;
        for attempt in 1..=max_attempts {
            match self.client.subscribe_channels(handler.clone()).await {
                Ok(sub) => return Ok(sub),
                Err(err) => {
                    last_err = Some(err);
                    if attempt >= max_attempts {
                        break;
                    }
                    let delay = retry_delay(attempt);
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        Err(wrap_attach_error("channels", last_err))
    }

    /// Detach both consumers and release the registry slot. Idempotent.
    pub async fn stop(&self) {
        let mut state = self.state.lock().await;
        if !state.running
            && state.notifications_sub.is_none()
            && state.channels_sub.is_none()
        {
            release_registry(&state.user_id);
            return;
        }
        let notif = state.notifications_sub.take();
        let chan = state.channels_sub.take();
        let user_id = state.user_id.clone();
        state.running = false;
        // Release the lock before awaiting stop — same reason as
        // start(): the lock guards pump state, not network calls.
        drop(state);

        if let Some(sub) = notif {
            sub.stop().await;
        }
        if let Some(sub) = chan {
            sub.stop().await;
        }
        release_registry(&user_id);
        tracing::info!(user_id = %user_id, "klodi_wake_pump_stopped");
    }

    /// Diagnostic snapshot. Returns `running: false` when the pump is
    /// constructed but not yet started or already stopped.
    pub fn health(&self) -> WakePumpHealth {
        let state = self
            .state
            .try_lock()
            .expect("WakePump.health called while start/stop is running");
        WakePumpHealth {
            running: state.running,
            user_id: state.user_id.clone(),
            notifications_last_event_at: state
                .notifications_sub
                .as_ref()
                .and_then(|s| s.get_last_event_at()),
            channels_last_event_at: state
                .channels_sub
                .as_ref()
                .and_then(|s| s.get_last_event_at()),
            notifications_inactive_threshold_ms: state
                .notifications_sub
                .as_ref()
                .and_then(|s| s.get_inactive_threshold_ms()),
            channels_inactive_threshold_ms: state
                .channels_sub
                .as_ref()
                .and_then(|s| s.get_inactive_threshold_ms()),
        }
    }
}

fn wrap_attach_error(label: &str, last_err: Option<KlodiError>) -> KlodiError {
    let cause = last_err
        .map(|e| e.to_string())
        .unwrap_or_else(|| "unknown".into());
    KlodiError::JetStreamConsumer(format!(
        "wake_pump_{label}_attach_failed: {cause}"
    ))
}

/// Process-global registry keyed on `user_id`. The pumps themselves are
/// stored as `Weak` so a dropped pump (no remaining strong refs) clears
/// itself out without an explicit `stop()` call — defense in depth on
/// top of the explicit `release_registry` in `stop()`.
fn registry() -> &'static StdMutex<HashMap<String, std::sync::Weak<WakePump>>> {
    use std::sync::OnceLock;
    static REGISTRY: OnceLock<StdMutex<HashMap<String, std::sync::Weak<WakePump>>>> =
        OnceLock::new();
    REGISTRY.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn release_registry(user_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(user_id);
    }
}

/// Construct (or reuse) the pump for `user_id`. Subsequent calls with
/// the same `user_id` return the existing instance unchanged; the
/// second caller's handlers are silently discarded so two adapter
/// wirings for the same persona can never interleave on the same
/// JetStream consumer.
pub fn create_wake_pump(
    client: Arc<dyn WakePumpClient>,
    user_id: String,
    on_notification: NotifyHandlerFn,
    on_channel_event: ChannelHandlerFn,
) -> Arc<WakePump> {
    let mut map = registry()
        .lock()
        .expect("wake-pump registry mutex poisoned");
    if let Some(weak) = map.get(&user_id) {
        if let Some(strong) = weak.upgrade() {
            return strong;
        }
    }
    let state = PumpState {
        user_id: user_id.clone(),
        on_notification,
        on_channel_event,
        max_start_attempts: DEFAULT_MAX_START_ATTEMPTS,
        retry_delay: default_retry_delay,
        running: false,
        notifications_sub: None,
        channels_sub: None,
    };
    let pump = Arc::new(WakePump {
        client,
        state: Mutex::new(state),
    });
    map.insert(user_id, Arc::downgrade(&pump));
    pump
}

/// Test escape hatch — clear the singleton registry so a fresh
/// `create_wake_pump` call returns a new instance between tests.
///
/// Public so the integration test file can call it; gated to test
/// builds only via `cfg(any(test, feature = "test_helpers"))` would be
/// stricter, but the registry is process-global and adapters never
/// reach into it, so the looser visibility matches the TS / Python
/// ports without bloating the feature matrix.
pub fn __reset_wake_pump_registry_for_tests() {
    if let Ok(mut map) = registry().lock() {
        map.clear();
    }
}
