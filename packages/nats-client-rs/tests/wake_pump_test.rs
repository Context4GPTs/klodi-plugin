//! Adversarial unit tests for the host-agnostic `WakePump` Rust port.
//!
//! The pump owns subscribe ownership for both notification and channel
//! consumers and exposes a uniform start/stop/health surface that every
//! Rust adapter (Moltis, IronClaw, ZeroClaw) plugs handlers into. These
//! tests pin the contract against the TS and Python ports
//! byte-for-byte: idempotent start, deterministic dispatch, error
//! propagation so the inner consume loop can nak, idempotent stop,
//! per-`user_id` singleton with registry release on stop, retry-on-
//! transient-subscribe-failure, and faithful health reporting from the
//! inner subscriptions.
//!
//! Mirror of `klodi-plugin/packages/nats-client-ts/tests/wake-pump.test.ts`
//! and `klodi-plugin/packages/nats-client-py/tests/test_wake_pump.py`.
//!
//! The implementation does not exist yet — running this suite is
//! expected to fail (RED phase of TDD).
//!
//! Trait shape: `WakePumpClient` and `ActiveSubscriptionLike` use
//! boxed-future return types (matching `consumers.rs::NotificationHandler`
//! / `ChannelHandler`) instead of `#[async_trait]`. The crate already
//! standardises on this idiom; pulling in `async_trait` purely for
//! tests would violate the workspace's NO BLOAT rule. Timestamps use
//! `Option<std::time::SystemTime>` rather than `chrono::DateTime` for
//! the same reason — the crate ships no chrono dep today.

use klodi_nats_client::error::KlodiError;
use klodi_nats_client::events::{ChannelMessageEvent, NotificationEvent};
use klodi_nats_client::wake_pump::{
    ActiveSubscriptionLike, WakePump, WakePumpClient, WakePumpHealth,
    __reset_wake_pump_registry_for_tests, create_wake_pump,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::time::SystemTime;
use tokio::sync::Mutex;

// ── Test helpers ─────────────────────────────────────────────────────

type BoxedFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Async handler signature shared by both inner subscribes. Mirrors the
/// `NotificationHandler` / `ChannelHandler` aliases in `consumers.rs`.
type NotifyHandlerFn = Arc<
    dyn Fn(NotificationEvent) -> BoxedFut<'static, Result<(), KlodiError>>
        + Send
        + Sync,
>;
type ChannelHandlerFn = Arc<
    dyn Fn(ChannelMessageEvent) -> BoxedFut<'static, Result<(), KlodiError>>
        + Send
        + Sync,
>;

/// Minimal stand-in for the production `ActiveSubscription`. The pump
/// only consumes three methods. Atomics + locks let each test assert
/// call counts and seed return values.
struct FakeInnerSub {
    stop_calls: AtomicUsize,
    last_event_at: Mutex<Option<SystemTime>>,
    inactive_threshold_ms: Mutex<Option<u64>>,
}

impl FakeInnerSub {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            stop_calls: AtomicUsize::new(0),
            last_event_at: Mutex::new(None),
            inactive_threshold_ms: Mutex::new(None),
        })
    }

    fn with_health(
        last_event_at: Option<SystemTime>,
        inactive_threshold_ms: Option<u64>,
    ) -> Arc<Self> {
        Arc::new(Self {
            stop_calls: AtomicUsize::new(0),
            last_event_at: Mutex::new(last_event_at),
            inactive_threshold_ms: Mutex::new(inactive_threshold_ms),
        })
    }

    fn stop_count(&self) -> usize {
        self.stop_calls.load(Ordering::SeqCst)
    }
}

impl ActiveSubscriptionLike for FakeInnerSub {
    fn stop<'a>(&'a self) -> BoxedFut<'a, ()> {
        Box::pin(async move {
            self.stop_calls.fetch_add(1, Ordering::SeqCst);
        })
    }

    fn get_last_event_at(&self) -> Option<SystemTime> {
        // try_lock is fine: the pump never holds this lock concurrently
        // across health() calls. Contention here is a contract break
        // and the panic surfaces it loudly.
        *self
            .last_event_at
            .try_lock()
            .expect("last_event_at lock contended in test")
    }

    fn get_inactive_threshold_ms(&self) -> Option<u64> {
        *self
            .inactive_threshold_ms
            .try_lock()
            .expect("inactive_threshold_ms lock contended in test")
    }
}

/// Captures the wrapped handlers the pump passes to `subscribe_*` and
/// drives transient-failure paths via a one-shot pending-error counter.
struct FakeClient {
    notify_sub: Arc<FakeInnerSub>,
    channel_sub: Arc<FakeInnerSub>,
    is_connected: bool,
    subscribe_notifications_calls: AtomicUsize,
    subscribe_channels_calls: AtomicUsize,
    captured_notify: Mutex<Option<NotifyHandlerFn>>,
    captured_channel: Mutex<Option<ChannelHandlerFn>>,
    /// On each `subscribe_notifications` call, decrement and return Err
    /// while > 0; otherwise capture the handler and return Ok. Lets a
    /// test drive N transient failures followed by a successful retry
    /// without rebuilding the fake.
    pending_notify_errors: AtomicU32,
}

impl FakeClient {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            notify_sub: FakeInnerSub::new(),
            channel_sub: FakeInnerSub::new(),
            is_connected: true,
            subscribe_notifications_calls: AtomicUsize::new(0),
            subscribe_channels_calls: AtomicUsize::new(0),
            captured_notify: Mutex::new(None),
            captured_channel: Mutex::new(None),
            pending_notify_errors: AtomicU32::new(0),
        })
    }

    fn with_subs(
        notify_sub: Arc<FakeInnerSub>,
        channel_sub: Arc<FakeInnerSub>,
    ) -> Arc<Self> {
        Arc::new(Self {
            notify_sub,
            channel_sub,
            is_connected: true,
            subscribe_notifications_calls: AtomicUsize::new(0),
            subscribe_channels_calls: AtomicUsize::new(0),
            captured_notify: Mutex::new(None),
            captured_channel: Mutex::new(None),
            pending_notify_errors: AtomicU32::new(0),
        })
    }

    fn set_pending_notify_errors(&self, count: u32) {
        self.pending_notify_errors.store(count, Ordering::SeqCst);
    }

    fn subscribe_notifications_count(&self) -> usize {
        self.subscribe_notifications_calls.load(Ordering::SeqCst)
    }

    fn subscribe_channels_count(&self) -> usize {
        self.subscribe_channels_calls.load(Ordering::SeqCst)
    }

    async fn notify_handler(&self) -> NotifyHandlerFn {
        self.captured_notify
            .lock()
            .await
            .clone()
            .expect("notification handler not yet captured by pump.start()")
    }

    async fn channel_handler(&self) -> ChannelHandlerFn {
        self.captured_channel
            .lock()
            .await
            .clone()
            .expect("channel handler not yet captured by pump.start()")
    }
}

impl WakePumpClient for FakeClient {
    fn is_connected(&self) -> bool {
        self.is_connected
    }

    fn subscribe_notifications<'a>(
        &'a self,
        handler: NotifyHandlerFn,
    ) -> BoxedFut<'a, Result<Arc<dyn ActiveSubscriptionLike>, KlodiError>> {
        Box::pin(async move {
            self.subscribe_notifications_calls
                .fetch_add(1, Ordering::SeqCst);
            // Drain one pending error per call.
            let pending = self.pending_notify_errors.load(Ordering::SeqCst);
            if pending > 0 {
                self.pending_notify_errors
                    .store(pending - 1, Ordering::SeqCst);
                return Err(KlodiError::JetStreamConsumer(
                    "transient: socket closed".into(),
                ));
            }
            *self.captured_notify.lock().await = Some(handler);
            let sub: Arc<dyn ActiveSubscriptionLike> = self.notify_sub.clone();
            Ok(sub)
        })
    }

    fn subscribe_channels<'a>(
        &'a self,
        handler: ChannelHandlerFn,
    ) -> BoxedFut<'a, Result<Arc<dyn ActiveSubscriptionLike>, KlodiError>> {
        Box::pin(async move {
            self.subscribe_channels_calls
                .fetch_add(1, Ordering::SeqCst);
            *self.captured_channel.lock().await = Some(handler);
            let sub: Arc<dyn ActiveSubscriptionLike> = self.channel_sub.clone();
            Ok(sub)
        })
    }
}

/// Build a no-op notification handler plus a counter the test can read.
fn make_notify_handler() -> (NotifyHandlerFn, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_handler = calls.clone();
    let handler: NotifyHandlerFn = Arc::new(move |_evt: NotificationEvent| {
        let calls = calls_for_handler.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), KlodiError>(())
        }) as BoxedFut<'static, Result<(), KlodiError>>
    });
    (handler, calls)
}

/// Build a no-op channel handler plus a counter the test can read.
fn make_channel_handler() -> (ChannelHandlerFn, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_handler = calls.clone();
    let handler: ChannelHandlerFn = Arc::new(move |_evt: ChannelMessageEvent| {
        let calls = calls_for_handler.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok::<(), KlodiError>(())
        }) as BoxedFut<'static, Result<(), KlodiError>>
    });
    (handler, calls)
}

/// Build a notification handler that always returns `Err`. Used by the
/// nak-propagation test.
fn make_failing_notify_handler() -> (NotifyHandlerFn, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let calls_for_handler = calls.clone();
    let handler: NotifyHandlerFn = Arc::new(move |_evt: NotificationEvent| {
        let calls = calls_for_handler.clone();
        Box::pin(async move {
            calls.fetch_add(1, Ordering::SeqCst);
            Err::<(), KlodiError>(KlodiError::JetStreamConsumer("handler boom".into()))
        }) as BoxedFut<'static, Result<(), KlodiError>>
    });
    (handler, calls)
}

/// A canonical `NotificationEvent` for dispatch tests. Variant choice
/// is arbitrary — the pump must be variant-agnostic.
fn sample_notification(event_id: &str) -> NotificationEvent {
    NotificationEvent::ListingCreated {
        event_id: event_id.into(),
        listing_id: "list1".into(),
        title: Some("Pentax K1000".into()),
    }
}

/// A canonical `ChannelMessageEvent` for dispatch tests.
fn sample_channel_event(event_id: &str) -> ChannelMessageEvent {
    ChannelMessageEvent {
        event_id: event_id.into(),
        channel_id: "ch1".into(),
        message_id: "22222222-2222-2222-2222-222222222222".into(),
        sequence: 1,
        sender_user_id: "u1".into(),
        sender_handle: "alice".into(),
        content: "hello".into(),
        created_at: "2026-04-28T10:00:00.000Z".into(),
    }
}

/// Process-wide test mutex. The pump's singleton registry is global
/// state, so tests that touch it must run serially. cargo's default
/// thread pool runs integration tests in parallel — without this guard
/// `reset_registry` from one test would yank the registry slot a
/// concurrent test still depends on.
fn test_lock() -> &'static std::sync::Mutex<()> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// Each test resets the singleton registry before constructing pumps.
/// Returns the held mutex guard so the caller pins the registry's
/// lifetime to its own scope.
fn reset_registry() -> std::sync::MutexGuard<'static, ()> {
    let guard = test_lock().lock().unwrap_or_else(|p| p.into_inner());
    __reset_wake_pump_registry_for_tests();
    guard
}

// ── Tests ────────────────────────────────────────────────────────────

#[tokio::test]
async fn start_subscribes_both_consumers_once_when_called_twice() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, _notify_calls) = make_notify_handler();
    let (on_channel, _channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );

    // Act
    pump.start().await.expect("first start succeeds");
    pump.start().await.expect("second start is a no-op");

    // Assert
    assert_eq!(
        fake.subscribe_notifications_count(),
        1,
        "subscribe_notifications must be called exactly once across two start() invocations",
    );
    assert_eq!(
        fake.subscribe_channels_count(),
        1,
        "subscribe_channels must be called exactly once across two start() invocations",
    );
    assert!(pump.health().running);
}

#[tokio::test]
async fn dispatches_notifications_through_configured_handler() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, notify_calls) = make_notify_handler();
    let (on_channel, channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );
    pump.start().await.expect("start succeeds");

    let event_a = sample_notification("evt-1");
    let event_b = sample_notification("evt-2");

    // Act — drive the wrapped handler the pump installed in the fake.
    let notify_handler = fake.notify_handler().await;
    notify_handler(event_a)
        .await
        .expect("first notification dispatch succeeds");
    notify_handler(event_b)
        .await
        .expect("second notification dispatch succeeds");

    // Assert — notification handler ran twice, channel handler never.
    assert_eq!(
        notify_calls.load(Ordering::SeqCst),
        2,
        "user-supplied notification handler must be invoked once per event",
    );
    assert_eq!(
        channel_calls.load(Ordering::SeqCst),
        0,
        "channel handler must not fire for notification events",
    );
}

#[tokio::test]
async fn dispatches_channel_events_through_configured_handler() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, notify_calls) = make_notify_handler();
    let (on_channel, channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );
    pump.start().await.expect("start succeeds");

    let event_a = sample_channel_event("evt-1");
    let event_b = sample_channel_event("evt-2");

    // Act
    let channel_handler = fake.channel_handler().await;
    channel_handler(event_a)
        .await
        .expect("first channel dispatch succeeds");
    channel_handler(event_b)
        .await
        .expect("second channel dispatch succeeds");

    // Assert
    assert_eq!(
        channel_calls.load(Ordering::SeqCst),
        2,
        "user-supplied channel handler must be invoked once per event",
    );
    assert_eq!(
        notify_calls.load(Ordering::SeqCst),
        0,
        "notification handler must not fire for channel events",
    );
}

#[tokio::test]
async fn propagates_handler_err_for_consume_loop_to_nak() {
    // A user-supplied notification handler returning `Err` must
    // propagate out of the pump-wrapped handler so the inner consume
    // loop can nak the message and let JetStream redeliver per
    // `max_deliver: 5`.
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, notify_calls) = make_failing_notify_handler();
    let (on_channel, _channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );
    pump.start().await.expect("start succeeds");

    // Act
    let notify_handler = fake.notify_handler().await;
    let result = notify_handler(sample_notification("evt-1")).await;

    // Assert — the wrapped handler must surface the user handler's Err
    // unchanged so consumers.rs's `nak_handler_error` path runs.
    assert!(
        result.is_err(),
        "wrapped notification handler must propagate user handler Err to the consume loop",
    );
    assert_eq!(notify_calls.load(Ordering::SeqCst), 1);
    let err = result.expect_err("checked is_err above");
    let msg = err.to_string();
    assert!(
        msg.contains("handler boom"),
        "error from user handler must propagate verbatim, got: {msg}",
    );
}

#[tokio::test]
async fn stop_stops_both_inner_subs_and_flips_running_flag() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, _notify_calls) = make_notify_handler();
    let (on_channel, _channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );

    // Act
    pump.start().await.expect("start succeeds");
    pump.stop().await;

    // Assert
    assert_eq!(
        fake.notify_sub.stop_count(),
        1,
        "notification inner sub must have stop() called exactly once",
    );
    assert_eq!(
        fake.channel_sub.stop_count(),
        1,
        "channel inner sub must have stop() called exactly once",
    );
    assert!(
        !pump.health().running,
        "pump.health().running must be false after stop()",
    );
}

#[tokio::test]
async fn stop_is_idempotent_second_call_is_noop() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify, _notify_calls) = make_notify_handler();
    let (on_channel, _channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );

    // Act
    pump.start().await.expect("start succeeds");
    pump.stop().await;
    pump.stop().await;

    // Assert — inner subs must not be stopped twice.
    assert_eq!(
        fake.notify_sub.stop_count(),
        1,
        "notification inner sub stop() must be called exactly once across two stop() invocations",
    );
    assert_eq!(
        fake.channel_sub.stop_count(),
        1,
        "channel inner sub stop() must be called exactly once across two stop() invocations",
    );
}

#[tokio::test]
async fn returns_same_singleton_for_same_user_id() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify_a, _) = make_notify_handler();
    let (on_channel_a, _) = make_channel_handler();
    let (on_notify_b, _) = make_notify_handler();
    let (on_channel_b, _) = make_channel_handler();

    // Act — two creates with the same user_id; the second caller's
    // handlers are silently discarded per the singleton contract.
    let first: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-x".into(),
        on_notify_a,
        on_channel_a,
    );
    let second: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-x".into(),
        on_notify_b,
        on_channel_b,
    );

    // Assert — the registry returns the same Arc, not just an equal
    // pump. `Arc::ptr_eq` is the Rust analogue of TS `expect(b).toBe(a)`.
    assert!(
        Arc::ptr_eq(&first, &second),
        "create_wake_pump must return the existing instance for a known user_id",
    );
}

#[tokio::test]
async fn returns_distinct_pumps_for_different_user_ids() {
    // Arrange
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify_a, _) = make_notify_handler();
    let (on_channel_a, _) = make_channel_handler();
    let (on_notify_b, _) = make_notify_handler();
    let (on_channel_b, _) = make_channel_handler();

    // Act
    let user_a: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify_a,
        on_channel_a,
    );
    let user_b: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-b".into(),
        on_notify_b,
        on_channel_b,
    );

    // Assert
    assert!(
        !Arc::ptr_eq(&user_a, &user_b),
        "different user_ids must produce distinct pumps",
    );
}

#[tokio::test]
async fn retries_subscribe_with_backoff_after_transient_error() {
    // The plan calls out reconnect-safety as a wake-pump
    // responsibility: the underlying NATS-WS client owns the socket
    // reconnect, but the consumer pull-loop binding can still fail
    // during the recovery window. Retrying here closes that gap.
    // Arrange — first subscribe_notifications call returns Err; the
    // second succeeds. The pump must recover.
    let _guard = reset_registry();
    let fake = FakeClient::new();
    fake.set_pending_notify_errors(1);
    let (on_notify, _notify_calls) = make_notify_handler();
    let (on_channel, _channel_calls) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );

    // Act — start must succeed despite the transient error on attempt 1.
    pump.start()
        .await
        .expect("start must recover from a single transient subscribe error");

    // Assert
    assert_eq!(
        fake.subscribe_notifications_count(),
        2,
        "subscribe_notifications must be retried exactly once after a transient error",
    );
    assert!(
        pump.health().running,
        "pump must transition to running after a successful retry",
    );
}

#[tokio::test]
async fn health_reports_last_event_timestamps_from_inner_subs() {
    // Arrange — inner subs surface specific timestamps and inactive
    // thresholds; the pump must echo them through `health()` unchanged.
    let _guard = reset_registry();
    let notify_at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_777_708_800);
    let channel_at = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_777_709_100);
    let notify_sub = FakeInnerSub::with_health(Some(notify_at), Some(30_000));
    let channel_sub = FakeInnerSub::with_health(Some(channel_at), Some(60_000));
    let fake = FakeClient::with_subs(notify_sub, channel_sub);
    let (on_notify, _) = make_notify_handler();
    let (on_channel, _) = make_channel_handler();
    let pump = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify,
        on_channel,
    );
    pump.start().await.expect("start succeeds");

    // Act
    let health: WakePumpHealth = pump.health();

    // Assert
    assert_eq!(health.user_id, "user-a");
    assert!(health.running);
    assert_eq!(
        health.notifications_last_event_at,
        Some(notify_at),
        "health must echo notifications inner sub's last_event_at",
    );
    assert_eq!(
        health.channels_last_event_at,
        Some(channel_at),
        "health must echo channels inner sub's last_event_at",
    );
    assert_eq!(
        health.notifications_inactive_threshold_ms,
        Some(30_000),
        "health must echo notifications inner sub's inactive_threshold_ms",
    );
    assert_eq!(
        health.channels_inactive_threshold_ms,
        Some(60_000),
        "health must echo channels inner sub's inactive_threshold_ms",
    );
}

#[tokio::test]
async fn disposed_pump_can_be_recreated_after_stop() {
    // Arrange — start, stop, then re-create. The registry must release
    // the slot on stop so the second create_wake_pump returns a fresh
    // instance instead of the disposed one.
    let _guard = reset_registry();
    let fake = FakeClient::new();
    let (on_notify_a, _) = make_notify_handler();
    let (on_channel_a, _) = make_channel_handler();
    let first: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify_a,
        on_channel_a,
    );

    // Act
    first.start().await.expect("start succeeds");
    first.stop().await;

    let (on_notify_b, _) = make_notify_handler();
    let (on_channel_b, _) = make_channel_handler();
    let second: Arc<WakePump> = create_wake_pump(
        fake.clone() as Arc<dyn WakePumpClient>,
        "user-a".into(),
        on_notify_b,
        on_channel_b,
    );

    // Assert
    assert!(
        !Arc::ptr_eq(&first, &second),
        "after stop(), create_wake_pump must produce a fresh instance for the same user_id",
    );
}
