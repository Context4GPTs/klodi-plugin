//! Durable JetStream consumer wiring + dedup LRU.
//!
//! Two consumers per user, both attached to host wake handlers via
//! `KlodiClient`:
//!
//!   - `klodi-notifications-<user_id>` on `P2P_NOTIFICATIONS`
//!     `filter_subject = p2p.v1.notifications.<user_id>` (fixed)
//!
//!   - `klodi-channels-<user_id>` on `P2P_CHANNELS`
//!     `filter_subjects = []` (server-managed by marketplace)
//!
//! Library responsibilities (from `2026-04-25-0012-shared-contracts.md`):
//!
//!   - ensure-and-bind: get-or-create the consumer matching the pinned
//!     config below; never mutate `filter_subjects` on the channels consumer.
//!   - in-memory LRU dedup keyed on `event_id` (capacity 1000 per consumer).
//!   - explicit ack on handler success; nak on handler error.
//!   - parse + dispatch loop runs in a background tokio task; the
//!     [`ActiveSubscription`] handle drives a clean shutdown via a
//!     `tokio::sync::watch` channel (P3-16) so in-flight ack/nak land
//!     on the wire before the task exits.

use crate::error::KlodiError;
use crate::events::{ChannelMessageEvent, NotificationEvent};
use crate::metrics::MetricsRecorder;
use async_nats::jetstream::consumer::pull::Config as PullConfig;
use async_nats::jetstream::{self, Context as JetStreamContext};
use futures_util::StreamExt;
use lru::LruCache;
use std::future::Future;
use std::num::NonZeroUsize;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::{Mutex, watch};
use tokio::task::JoinHandle;

const NOTIFICATIONS_STREAM: &str = "P2P_NOTIFICATIONS";
const CHANNELS_STREAM: &str = "P2P_CHANNELS";

/// In-memory dedup window per consumer.
///
/// Per **R § P3-15**: declared as a compile-time `const NonZeroUsize`
/// so the `LruCache::new(...)` call site stops carrying a runtime
/// `.expect("…")` for what is statically a 1000. Rust 1.83+ stabilises
/// `Option::expect` in const context — the workspace pins
/// `rust-version = "1.85"` (see `Cargo.toml`) so this is safe.
const DEDUP_CAPACITY: NonZeroUsize = match NonZeroUsize::new(1000) {
    Some(n) => n,
    None => panic!("DEDUP_CAPACITY must be non-zero"),
};

/// Async handler invoked for each delivered notification. Returning
/// `Err` causes the message to be naked and redelivered per
/// `max_deliver: 5`; the LRU records the event_id only on success.
pub type NotificationHandler = Arc<
    dyn Fn(NotificationEvent) -> Pin<Box<dyn Future<Output = Result<(), KlodiError>> + Send>>
        + Send
        + Sync,
>;

/// Async handler invoked for each delivered channel message.
pub type ChannelHandler = Arc<
    dyn Fn(ChannelMessageEvent) -> Pin<Box<dyn Future<Output = Result<(), KlodiError>> + Send>>
        + Send
        + Sync,
>;

/// Active consumer subscription handle.
///
/// Per **R § P3-16**: shutdown is driven by [`stop`](Self::stop) which
/// signals a `tokio::sync::watch` channel and awaits the background
/// task's [`JoinHandle`]. The previous implementation aborted the task
/// in `Drop`, which can race between handler success and `msg.ack()`
/// landing on the wire — a redelivery storm in disguise. Callers
/// SHOULD invoke `stop()` explicitly so the loop drains in-flight work
/// before the runtime tears down.
///
/// `Drop` no longer aborts; if the caller forgets to `stop()`, the
/// `Arc<...>` reference dropping will cause the `watch` channel to
/// signal automatically (the receiver returns `Err` on sender drop) so
/// the task still exits cleanly — just without the deterministic
/// "drained" guarantee `stop().await` provides.
pub struct ActiveSubscription {
    handle: Option<JoinHandle<()>>,
    shutdown_tx: watch::Sender<bool>,
}

impl ActiveSubscription {
    /// Stop the consume loop, waiting for the background task to drain
    /// any in-flight ack/nak before returning. Idempotent — calling
    /// twice is a no-op.
    pub async fn stop(&mut self) {
        // Already stopped — second call is a no-op.
        let Some(handle) = self.handle.take() else {
            return;
        };
        let _ = self.shutdown_tx.send(true);
        // We deliberately don't propagate join errors: if the task
        // already exited (e.g. server closed the stream) the join
        // completes immediately; if it panicked we surface that as a
        // log line via the panic hook, not as a stop() error.
        let _ = handle.await;
    }
}

impl Drop for ActiveSubscription {
    fn drop(&mut self) {
        // P3-16: never abort. Signalling the watch channel is enough —
        // the consume loop's `select!` drops out on `shutdown_rx.changed()`
        // or on the watch sender being dropped (the receiver returns
        // `Err`, which the loop treats as "stop"). We *don't* await
        // the JoinHandle here because Drop is sync; callers wanting
        // drainage MUST use `stop().await`.
        let _ = self.shutdown_tx.send(true);
    }
}

/// Subscribe to the per-user notifications consumer. Spawns a tokio task
/// that pulls, parses, dedupes, and dispatches; ack on Ok, nak on Err.
///
/// Per **D § D5 + D7** the consumer is server-managed; missing →
/// `KlodiError::Setup { code: "notifications_consumer_missing" }`.
pub async fn subscribe_notifications(
    ctx: &JetStreamContext,
    user_id: &str,
    handler: NotificationHandler,
    metrics: MetricsRecorder,
) -> Result<ActiveSubscription, KlodiError> {
    let durable = format!("klodi-notifications-{user_id}");
    let consumer = bind_pull_consumer(
        ctx,
        NOTIFICATIONS_STREAM,
        &durable,
        "notifications_consumer_missing",
    )
    .await?;
    seed_pending_from_info(&consumer, &metrics).await;
    spawn_loop_notifications(consumer, handler, durable, metrics).await
}

/// Subscribe to the per-user channels consumer. `filter_subjects` is
/// server-managed: this library never mutates it. New channels become
/// new subjects in the delivered stream automatically.
///
/// Per **D § D5 + D7** the consumer is server-managed; missing →
/// `KlodiError::Setup { code: "channels_consumer_missing" }`.
pub async fn subscribe_channels(
    ctx: &JetStreamContext,
    user_id: &str,
    handler: ChannelHandler,
    metrics: MetricsRecorder,
) -> Result<ActiveSubscription, KlodiError> {
    let durable = format!("klodi-channels-{user_id}");
    let consumer = bind_pull_consumer(
        ctx,
        CHANNELS_STREAM,
        &durable,
        "channels_consumer_missing",
    )
    .await?;
    seed_pending_from_info(&consumer, &metrics).await;
    spawn_loop_channels(consumer, handler, durable, metrics).await
}

/// Defensive bind: assert the consumer exists, never create.
///
/// Per **D § D5 + D7** the per-user JWT does not carry
/// `CONSUMER.CREATE`; consumers are server-managed. The client treats
/// absence as a setup-phase failure rather than silently fixing it.
async fn bind_pull_consumer(
    ctx: &JetStreamContext,
    stream_name: &str,
    durable: &str,
    missing_code: &'static str,
) -> Result<jetstream::consumer::Consumer<PullConfig>, KlodiError> {
    let stream = ctx.get_stream(stream_name).await.map_err(|err| {
        KlodiError::JetStreamConsumer(format!(
            "get_stream({stream_name}) failed: {err}"
        ))
    })?;
    stream
        .get_consumer::<PullConfig>(durable)
        .await
        .map_err(|err| {
            // async-nats surfaces "consumer not found" as an error string;
            // we match on the canonical NATS error code embedded in the
            // Display impl.
            let msg = err.to_string();
            if msg.contains("consumer not found") || msg.contains("404") {
                return KlodiError::Setup {
                    code: missing_code,
                    message: format!(
                        "{missing_code}: durable={durable} stream={stream_name}. \
                         Consumers are server-managed (D5/D7) — re-run klodi_register \
                         or contact support."
                    ),
                };
            }
            KlodiError::JetStreamConsumer(format!(
                "get_consumer({durable}) failed: {err}"
            ))
        })
}

/// Best-effort: pull a fresh `num_pending` from the consumer info and
/// publish into the metrics counter. Errors are swallowed because
/// pending-count is observability, not correctness — better to leave
/// the gauge stale than to surface a transient JetStream API blip.
async fn seed_pending_from_info(
    consumer: &jetstream::consumer::Consumer<PullConfig>,
    metrics: &MetricsRecorder,
) {
    // `cached_info` returns the snapshot the bind already gave us; for
    // a fresh value an explicit `info()` call hits the wire. We use
    // the cached one — refreshing from the wire on every subscribe
    // doubles the JetStream RTT for a value that's about to be updated
    // per-fetch from `info.pending` anyway.
    let info = consumer.cached_info();
    metrics.set_pending(info.num_pending);
}

fn new_lru() -> Arc<Mutex<LruCache<String, ()>>> {
    Arc::new(Mutex::new(LruCache::new(DEDUP_CAPACITY)))
}

async fn ack_dedup(
    msg: &async_nats::jetstream::Message,
    consumer: &str,
    reason: &'static str,
    metrics: &MetricsRecorder,
) {
    if let Err(err) = msg.ack().await {
        tracing::warn!(
            consumer = %consumer,
            error = %err,
            reason = reason,
            "klodi_consumer_ack_failed"
        );
        return;
    }
    metrics.inc_acked();
}

async fn nak_handler_error(
    msg: &async_nats::jetstream::Message,
    consumer: &str,
    err: &KlodiError,
    metrics: &MetricsRecorder,
) {
    tracing::warn!(
        consumer = %consumer,
        error = %err,
        "klodi_consumer_handler_failed_naking"
    );
    if let Err(nak_err) = msg
        .ack_with(async_nats::jetstream::AckKind::Nak(None))
        .await
    {
        tracing::warn!(
            consumer = %consumer,
            error = %nak_err,
            "klodi_consumer_nak_failed"
        );
        return;
    }
    metrics.inc_naked();
}

/// Read "this is the Nth redelivery" off a JetStream message.
///
/// `info.delivered` is 1-based (first delivery = 1, second delivery = 2 …)
/// — so the redelivery count is `delivered - 1`. Mirrors the TS / Py
/// accessors so the cross-language counter values are comparable.
fn redelivery_of(msg: &async_nats::jetstream::Message) -> u64 {
    let info = match msg.info() {
        Ok(info) => info,
        Err(_) => return 0,
    };
    if info.delivered > 1 {
        info.delivered as u64 - 1
    } else {
        0
    }
}

/// Per-message pending count for the live `pending_count` gauge.
fn pending_of(msg: &async_nats::jetstream::Message) -> Option<u64> {
    msg.info().ok().map(|info| info.pending)
}

async fn spawn_loop_notifications(
    consumer: jetstream::consumer::Consumer<PullConfig>,
    handler: NotificationHandler,
    durable: String,
    metrics: MetricsRecorder,
) -> Result<ActiveSubscription, KlodiError> {
    let mut messages = consumer.messages().await.map_err(|err| {
        KlodiError::JetStreamConsumer(format!("messages({durable}) failed: {err}"))
    })?;
    let lru = new_lru();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                // P3-16: shutdown drives via a watch channel rather
                // than a Drop-time abort. The `select!` cancels the
                // pending `next()` cleanly — but unlike `abort()` it
                // does not race with an in-flight `msg.ack().await`.
                _ = shutdown_rx.changed() => break,
                item = messages.next() => match item {
                    None => break,
                    Some(item) => {
                        process_notification(
                            item,
                            &handler,
                            &durable,
                            &lru,
                            &metrics,
                        )
                        .await;
                    }
                }
            }
        }
    });
    Ok(ActiveSubscription { handle: Some(handle), shutdown_tx })
}

async fn process_notification(
    item: Result<async_nats::jetstream::Message, async_nats::error::Error<async_nats::jetstream::consumer::pull::MessagesErrorKind>>,
    handler: &NotificationHandler,
    durable: &str,
    lru: &Arc<Mutex<LruCache<String, ()>>>,
    metrics: &MetricsRecorder,
) {
    let msg = match item {
        Ok(msg) => msg,
        Err(err) => {
            tracing::warn!(
                consumer = %durable,
                error = %err,
                "klodi_consumer_stream_error"
            );
            return;
        }
    };
    metrics.inc_consumed();
    metrics.add_redelivery(redelivery_of(&msg));
    if let Some(p) = pending_of(&msg) {
        metrics.set_pending(p);
    }
    let event: NotificationEvent = match serde_json::from_slice(&msg.payload) {
        Ok(evt) => evt,
        Err(err) => {
            tracing::error!(
                consumer = %durable,
                subject = %msg.subject,
                error = %err,
                "klodi_consumer_parse_failed"
            );
            ack_dedup(&msg, durable, "parse_failed", metrics).await;
            return;
        }
    };
    let event_id = event.event_id().to_owned();
    {
        let mut cache = lru.lock().await;
        if cache.get(&event_id).is_some() {
            drop(cache);
            metrics.inc_dedup_hit();
            ack_dedup(&msg, durable, "dedup", metrics).await;
            return;
        }
    }
    match handler(event).await {
        Ok(()) => {
            {
                let mut cache = lru.lock().await;
                cache.put(event_id, ());
            }
            if let Err(err) = msg.ack().await {
                tracing::warn!(
                    consumer = %durable,
                    error = %err,
                    "klodi_consumer_ack_failed_after_handler"
                );
                return;
            }
            metrics.inc_acked();
        }
        Err(err) => nak_handler_error(&msg, durable, &err, metrics).await,
    }
}

async fn spawn_loop_channels(
    consumer: jetstream::consumer::Consumer<PullConfig>,
    handler: ChannelHandler,
    durable: String,
    metrics: MetricsRecorder,
) -> Result<ActiveSubscription, KlodiError> {
    let mut messages = consumer.messages().await.map_err(|err| {
        KlodiError::JetStreamConsumer(format!("messages({durable}) failed: {err}"))
    })?;
    let lru = new_lru();
    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = shutdown_rx.changed() => break,
                item = messages.next() => match item {
                    None => break,
                    Some(item) => {
                        process_channel(
                            item,
                            &handler,
                            &durable,
                            &lru,
                            &metrics,
                        )
                        .await;
                    }
                }
            }
        }
    });
    Ok(ActiveSubscription { handle: Some(handle), shutdown_tx })
}

async fn process_channel(
    item: Result<async_nats::jetstream::Message, async_nats::error::Error<async_nats::jetstream::consumer::pull::MessagesErrorKind>>,
    handler: &ChannelHandler,
    durable: &str,
    lru: &Arc<Mutex<LruCache<String, ()>>>,
    metrics: &MetricsRecorder,
) {
    let msg = match item {
        Ok(msg) => msg,
        Err(err) => {
            tracing::warn!(
                consumer = %durable,
                error = %err,
                "klodi_consumer_stream_error"
            );
            return;
        }
    };
    metrics.inc_consumed();
    metrics.add_redelivery(redelivery_of(&msg));
    if let Some(p) = pending_of(&msg) {
        metrics.set_pending(p);
    }
    let event: ChannelMessageEvent = match serde_json::from_slice(&msg.payload) {
        Ok(evt) => evt,
        Err(err) => {
            tracing::error!(
                consumer = %durable,
                subject = %msg.subject,
                error = %err,
                "klodi_consumer_parse_failed"
            );
            ack_dedup(&msg, durable, "parse_failed", metrics).await;
            return;
        }
    };
    let event_id = event.event_id.clone();
    {
        let mut cache = lru.lock().await;
        if cache.get(&event_id).is_some() {
            drop(cache);
            metrics.inc_dedup_hit();
            ack_dedup(&msg, durable, "dedup", metrics).await;
            return;
        }
    }
    match handler(event).await {
        Ok(()) => {
            {
                let mut cache = lru.lock().await;
                cache.put(event_id, ());
            }
            if let Err(err) = msg.ack().await {
                tracing::warn!(
                    consumer = %durable,
                    error = %err,
                    "klodi_consumer_ack_failed_after_handler"
                );
                return;
            }
            metrics.inc_acked();
        }
        Err(err) => nak_handler_error(&msg, durable, &err, metrics).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lru_evicts_oldest_when_capacity_exceeded() {
        let lru = new_lru();
        let mut cache = lru.try_lock().unwrap();
        for i in 0..DEDUP_CAPACITY.get() {
            cache.put(format!("evt-{i}"), ());
        }
        assert!(cache.contains(&"evt-0".to_owned()));
        cache.put("evt-overflow".to_owned(), ());
        // First insert evicted; overflow inserted.
        assert!(!cache.contains(&"evt-0".to_owned()));
        assert!(cache.contains(&"evt-overflow".to_owned()));
    }

    #[test]
    fn dedup_capacity_is_compile_time_constant() {
        // Type-level assertion: the `const` block in the module didn't
        // need a runtime `.expect()` — if it did this test wouldn't
        // even compile.
        const _: NonZeroUsize = DEDUP_CAPACITY;
        assert_eq!(DEDUP_CAPACITY.get(), 1000);
    }

    /// P3-16: stopping a subscription drains the background task
    /// cleanly via the `tokio::sync::watch` shutdown channel — no
    /// abort, no panic on the JoinHandle.
    #[tokio::test]
    async fn stop_drains_join_handle_without_panic() {
        // Build a subscription manually (we can't reach JetStream in a
        // unit test) — use the same shutdown wiring as the production
        // path so the contract is exercised end-to-end.
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let task = tokio::spawn(async move {
            // Mirror the production loop's structure: `select!` on the
            // watch channel and an open-ended sleep that stands in for
            // the `messages.next()` future. Production has many message
            // arrivals per loop iteration; the test only fires the
            // shutdown branch once, so clippy correctly notes the
            // single-iteration shape — semantically harmless here.
            #[allow(clippy::never_loop)]
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => break,
                    _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                        // Should never be reached in this test.
                        unreachable!("test sleep elapsed before shutdown");
                    }
                }
            }
        });
        let mut sub = ActiveSubscription {
            handle: Some(task),
            shutdown_tx,
        };
        sub.stop().await;
        // After stop the handle is consumed; second stop is a no-op.
        sub.stop().await;
    }

    /// P3-16: dropping the subscription without an explicit stop()
    /// still terminates the task — Drop signals the watch channel.
    #[tokio::test]
    async fn drop_signals_shutdown_without_aborting() {
        let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
        let observed = Arc::new(Mutex::new(false));
        let observed_clone = observed.clone();
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = shutdown_rx.changed() => {
                    // Marker: clean exit observed from the watch channel.
                    *observed_clone.lock().await = true;
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                    unreachable!("test sleep elapsed before shutdown");
                }
            }
        });
        let sub = ActiveSubscription {
            handle: Some(task),
            shutdown_tx,
        };
        drop(sub);
        // Give the task a moment to observe the shutdown.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        assert!(*observed.lock().await, "shutdown not observed via watch");
    }
}
