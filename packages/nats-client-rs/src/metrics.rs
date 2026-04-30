//! KlodiClient metrics surface — P2-27.
//!
//! Per-client counters exposed to operator dashboards and to the
//! `klodi-rust-host` daemons' `--health-port /metrics` Prometheus
//! exporter. The metric names mirror the per-language analogs in
//! `klodi_nats_client.metrics` (Python) and `metrics.ts` (TS) so the
//! cross-language wire is comparable in a single dashboard.
//!
//! Counters are monotonic within a process lifetime; restart resets
//! them all to 0. The single mutator surface (`MetricsRecorder`) lives
//! behind an `Arc<AtomicU64>` so increments from concurrent consumer
//! tasks don't race.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Read-only snapshot of all counters at a point in time.
///
/// Safe to clone, freeze, and pass across threads. Surfaced through
/// [`KlodiClient::metrics`](crate::client::KlodiClient::metrics).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClientMetrics {
    /// Wakes received from JetStream (pre-dedup, pre-handler).
    pub consumed: u64,
    /// Successful `msg.ack()` count.
    pub acked: u64,
    /// `msg.nak()` count (handler raised).
    pub naked: u64,
    /// Wakes whose `event_id` was already in the LRU window.
    pub dedup_hit: u64,
    /// Sum of "this is the Nth redelivery" across delivered messages.
    pub redelivery_count: u64,
    /// JetStream consumer pending count, refreshed best-effort on
    /// subscribe and per-fetch. Zero until the first refresh lands.
    pub pending_count: u64,
}

impl ClientMetrics {
    /// All-zeros snapshot — matches a fresh [`MetricsRecorder`].
    pub const fn zero() -> Self {
        Self {
            consumed: 0,
            acked: 0,
            naked: 0,
            dedup_hit: 0,
            redelivery_count: 0,
            pending_count: 0,
        }
    }
}

/// Internal mutable counters. `Arc`-shared between the consumer task
/// and the public `metrics()` accessor — every increment uses
/// `Ordering::Relaxed` because counters are observability, not
/// correctness signals.
#[derive(Clone, Debug, Default)]
pub struct MetricsRecorder {
    inner: Arc<MetricsInner>,
}

#[derive(Debug, Default)]
struct MetricsInner {
    consumed: AtomicU64,
    acked: AtomicU64,
    naked: AtomicU64,
    dedup_hit: AtomicU64,
    redelivery_count: AtomicU64,
    pending_count: AtomicU64,
}

impl MetricsRecorder {
    /// Construct a fresh, all-zero recorder.
    pub fn new() -> Self {
        Self::default()
    }

    pub fn inc_consumed(&self) {
        self.inner.consumed.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_acked(&self) {
        self.inner.acked.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_naked(&self) {
        self.inner.naked.fetch_add(1, Ordering::Relaxed);
    }

    pub fn inc_dedup_hit(&self) {
        self.inner.dedup_hit.fetch_add(1, Ordering::Relaxed);
    }

    /// Add the message's redelivery count (0 for first delivery).
    pub fn add_redelivery(&self, count: u64) {
        if count > 0 {
            self.inner
                .redelivery_count
                .fetch_add(count, Ordering::Relaxed);
        }
    }

    /// Replace the pending-count gauge with a fresh JetStream snapshot.
    pub fn set_pending(&self, count: u64) {
        self.inner.pending_count.store(count, Ordering::Relaxed);
    }

    /// Atomic snapshot of every counter.
    pub fn snapshot(&self) -> ClientMetrics {
        ClientMetrics {
            consumed: self.inner.consumed.load(Ordering::Relaxed),
            acked: self.inner.acked.load(Ordering::Relaxed),
            naked: self.inner.naked.load(Ordering::Relaxed),
            dedup_hit: self.inner.dedup_hit.load(Ordering::Relaxed),
            redelivery_count: self.inner.redelivery_count.load(Ordering::Relaxed),
            pending_count: self.inner.pending_count.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_snapshot_is_all_zeros() {
        let r = MetricsRecorder::new();
        assert_eq!(r.snapshot(), ClientMetrics::zero());
    }

    #[test]
    fn increments_isolated() {
        let r = MetricsRecorder::new();
        r.inc_consumed();
        r.inc_consumed();
        r.inc_acked();
        r.inc_naked();
        r.inc_dedup_hit();
        let s = r.snapshot();
        assert_eq!(s.consumed, 2);
        assert_eq!(s.acked, 1);
        assert_eq!(s.naked, 1);
        assert_eq!(s.dedup_hit, 1);
    }

    #[test]
    fn redelivery_accumulator_ignores_zero() {
        let r = MetricsRecorder::new();
        r.add_redelivery(0);
        r.add_redelivery(2);
        r.add_redelivery(5);
        assert_eq!(r.snapshot().redelivery_count, 7);
    }

    #[test]
    fn set_pending_replaces_value() {
        let r = MetricsRecorder::new();
        r.set_pending(10);
        r.set_pending(2);
        r.set_pending(7);
        assert_eq!(r.snapshot().pending_count, 7);
    }

    #[test]
    fn shared_recorder_observes_concurrent_increments() {
        let r = MetricsRecorder::new();
        let r1 = r.clone();
        let r2 = r.clone();
        let h1 = std::thread::spawn(move || {
            for _ in 0..1000 {
                r1.inc_consumed();
            }
        });
        let h2 = std::thread::spawn(move || {
            for _ in 0..1000 {
                r2.inc_consumed();
            }
        });
        h1.join().unwrap();
        h2.join().unwrap();
        assert_eq!(r.snapshot().consumed, 2000);
    }
}
