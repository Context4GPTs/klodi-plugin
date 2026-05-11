//! Per-event batching window for the channel registry.
//!
//! Within `window` seconds of a notification with event_kind X firing,
//! subsequent notifications of the same kind coalesce instead of
//! dispatching individually. `ApprovalRequest`-severity notifications
//! bypass batching entirely (handled in `registry::ChannelRegistry::notify`).
//! `ChannelRegistry::new` constructs a registry with batching disabled;
//! `new_with_batching` wires this on with the configured window.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::Notification;

/// Sliding-window state per event_kind.
pub struct BatchingWindow {
    window: Duration,
    last_seen: HashMap<String, Instant>,
}

impl BatchingWindow {
    pub fn new(window: Duration) -> Self {
        Self {
            window,
            last_seen: HashMap::new(),
        }
    }

    /// Returns `Some(_)` when the notification should be batched
    /// (coalesced into the prior one) rather than dispatched
    /// independently. The `Some` value is a placeholder — Phase 6 will
    /// shape it into a real coalesced payload when the flush logic
    /// lands; for now the registry treats `Some` as "skip dispatch."
    pub fn try_coalesce(&mut self, notif: &Notification) -> Option<()> {
        let now = Instant::now();
        if let Some(prev) = self.last_seen.get(&notif.event_kind) {
            if now.duration_since(*prev) < self.window {
                return Some(());
            }
        }
        None
    }

    /// Record the dispatch time of the first notification in a fresh
    /// window. Subsequent calls within `window` for the same event kind
    /// hit `try_coalesce` returning `Some`.
    pub fn note_first(&mut self, notif: &Notification) {
        self.last_seen
            .insert(notif.event_kind.clone(), Instant::now());
    }

    pub fn window(&self) -> Duration {
        self.window
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::Severity;

    fn make(kind: &str) -> Notification {
        Notification {
            event_kind: kind.into(),
            summary: "x".into(),
            details: None,
            severity: Severity::Operator,
            structured: None,
            correlation_id: None,
            reply_hint: None,
        }
    }

    #[test]
    fn first_notification_is_not_coalesced() {
        let mut win = BatchingWindow::new(Duration::from_secs(5));
        let n = make("offer.proposed");
        assert!(win.try_coalesce(&n).is_none());
    }

    #[test]
    fn second_notification_within_window_is_coalesced() {
        let mut win = BatchingWindow::new(Duration::from_secs(60));
        let n = make("offer.proposed");
        assert!(win.try_coalesce(&n).is_none());
        win.note_first(&n);
        assert!(win.try_coalesce(&n).is_some());
    }

    #[test]
    fn different_event_kinds_dont_share_window_state() {
        let mut win = BatchingWindow::new(Duration::from_secs(60));
        let a = make("offer.proposed");
        let b = make("listing.updated");
        win.note_first(&a);
        // a is in-window, b is fresh.
        assert!(win.try_coalesce(&b).is_none());
        assert!(win.try_coalesce(&a).is_some());
    }

    #[test]
    fn window_zero_never_coalesces() {
        let mut win = BatchingWindow::new(Duration::from_secs(0));
        let n = make("offer.proposed");
        win.note_first(&n);
        assert!(win.try_coalesce(&n).is_none());
    }
}
