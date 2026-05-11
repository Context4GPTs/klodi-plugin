//! `ChannelRegistry` — fans an outbound notification across every
//! registered channel and exposes a unified inbound `OperatorReply`
//! stream. Implements the dispatch half of plan §I-1 + §I-7.
//!
//! Channel registration carries a `severity_floor` and an optional
//! `event_filter` per plan §I-7. The registry drops notifications that
//! don't clear a channel's gates before invoking `notify()`. Phase 6
//! adds the batching window (5s) on top.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio::sync::Mutex;

use super::batching::BatchingWindow;
use super::{
    Notification, NotificationId, OperatorChannel, OperatorReply, Recipient, Severity,
    default_severity_for_event,
};

/// Single registered channel — impl + the operator-supplied dispatch
/// constraints (recipient, severity floor, optional event allowlist).
pub struct RegisteredChannel {
    pub impl_: Arc<dyn OperatorChannel>,
    pub recipient: Recipient,
    pub severity_floor: Severity,
    /// Empty = all events at the severity floor or above. Non-empty =
    /// exact event_kind allowlist.
    pub event_filter: Vec<String>,
}

impl RegisteredChannel {
    fn accepts(&self, notif: &Notification) -> bool {
        if notif.severity < self.severity_floor {
            return false;
        }
        if !self.event_filter.is_empty()
            && !self
                .event_filter
                .iter()
                .any(|kind| kind == &notif.event_kind)
        {
            return false;
        }
        true
    }
}

/// Registry of operator channels — built by the daemon at startup and
/// passed to the forwarder + the MCP server's approval gate.
pub struct ChannelRegistry {
    inner: Arc<RegistryInner>,
}

struct RegistryInner {
    channels: Vec<RegisteredChannel>,
    /// Per-non-approval batching window. `None` = no batching (Phase
    /// 1; Phase 6 wires this on). Held in a `Mutex` because the
    /// window state is shared across spawned dispatch tasks.
    batching: Mutex<Option<BatchingWindow>>,
}

impl ChannelRegistry {
    /// Construct with an explicit channel list. The daemon's
    /// construction helper (see `daemon.rs`) wires the dashboard +
    /// dedicated session + any upstream channels through this.
    pub fn new(channels: Vec<RegisteredChannel>) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                channels,
                batching: Mutex::new(None),
            }),
        }
    }

    /// Construct with batching enabled. `window` controls the per-event
    /// coalesce window; `ApprovalRequest`-severity notifications
    /// bypass batching per plan §I-8.
    pub fn new_with_batching(
        channels: Vec<RegisteredChannel>,
        window: Duration,
    ) -> Self {
        Self {
            inner: Arc::new(RegistryInner {
                channels,
                batching: Mutex::new(Some(BatchingWindow::new(window))),
            }),
        }
    }

    /// Configured channel count.
    pub fn channel_count(&self) -> usize {
        self.inner.channels.len()
    }

    /// Channel names, in registration order. Used by the bootstrap
    /// note copy to render the multi-surface list.
    pub fn channel_names(&self) -> Vec<String> {
        self.inner
            .channels
            .iter()
            .map(|c| c.impl_.name().to_string())
            .collect()
    }

    /// Fan a notification out across every channel whose gates accept
    /// it. Returns the list of `NotificationId`s for the channels that
    /// actually posted; channels that filtered the notification out
    /// don't appear.
    ///
    /// Each channel's `notify` is invoked sequentially today — the
    /// dispatch volume is bounded by severity floors + batching, so
    /// parallel posting per notification would add complexity for
    /// negligible benefit. Phase 5 callers (approval gate) only block
    /// on ApprovalRequest fan-out, which is rare.
    pub async fn notify(&self, mut notif: Notification) -> Vec<NotificationId> {
        // Promote `Severity::Operator` to the event kind's default
        // floor when the caller left severity unset by convention
        // (default-Operator). This keeps wake-forwarder callers from
        // having to spell out severity on every wake — they get
        // sensible defaults per plan §I-7.
        if notif.severity == Severity::Operator {
            notif.severity = default_severity_for_event(&notif.event_kind);
        }

        // Approval prompts bypass batching — operator must see them
        // immediately.
        let bypasses_batching = notif.severity >= Severity::ApprovalRequest;

        if !bypasses_batching {
            let mut guard = self.inner.batching.lock().await;
            if let Some(window) = guard.as_mut() {
                if let Some(_coalesced) =
                    window.try_coalesce(&notif)
                {
                    // Batched; the windowed notification will be sent
                    // on the next flush. For Phase 1/6 we keep this
                    // synchronous: return the correlation id so the
                    // caller has something to reference.
                    let cid = notif
                        .correlation_id
                        .clone()
                        .unwrap_or_else(|| "batched".to_string());
                    return vec![NotificationId(cid)];
                }
                window.note_first(&notif);
            }
        }

        let mut out = Vec::with_capacity(self.inner.channels.len());
        for ch in self.inner.channels.iter() {
            if !ch.accepts(&notif) {
                continue;
            }
            match ch.impl_.notify(&ch.recipient, &notif).await {
                Ok(id) => out.push(id),
                Err(err) => {
                    tracing::warn!(
                        channel = %ch.impl_.name(),
                        event_kind = %notif.event_kind,
                        severity = %notif.severity.as_str(),
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_channel_notify_failed"
                    );
                }
            }
        }
        out
    }

    /// Merged inbound stream across every channel. Phase 1 returns the
    /// merge as-is — the dashboard channel's `replies()` is empty in
    /// Phase 1 and gets a polling impl in Phase 2.
    pub fn replies(
        &self,
    ) -> Pin<Box<dyn Stream<Item = (String, OperatorReply)> + Send + 'static>> {
        let streams = self
            .inner
            .channels
            .iter()
            .map(|c| {
                let name = c.impl_.name().to_string();
                c.impl_
                    .replies()
                    .map(move |reply| (name.clone(), reply))
            })
            .collect::<Vec<_>>();
        Box::pin(futures_util::stream::select_all(streams))
    }
}

impl Clone for ChannelRegistry {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::{Severity, Recipient};
    use anyhow::Result;
    use async_trait::async_trait;
    use std::sync::Arc;
    use tokio::sync::Mutex as TokioMutex;

    #[derive(Default)]
    struct CapturingChannel {
        name: String,
        calls: Arc<TokioMutex<Vec<Notification>>>,
        outcome: Outcome,
    }

    #[derive(Default, Clone)]
    enum Outcome {
        #[default]
        Ok,
        Fail,
    }

    #[async_trait]
    impl OperatorChannel for CapturingChannel {
        fn name(&self) -> &str {
            &self.name
        }
        async fn notify(
            &self,
            _recipient: &Recipient,
            payload: &Notification,
        ) -> Result<NotificationId> {
            self.calls.lock().await.push(payload.clone());
            match self.outcome {
                Outcome::Ok => Ok(NotificationId(
                    payload
                        .correlation_id
                        .clone()
                        .unwrap_or_else(|| "auto".into()),
                )),
                Outcome::Fail => anyhow::bail!("channel down"),
            }
        }
    }

    fn make_channel(
        name: &str,
        floor: Severity,
        filter: Vec<String>,
    ) -> (RegisteredChannel, Arc<TokioMutex<Vec<Notification>>>) {
        let calls = Arc::new(TokioMutex::new(Vec::new()));
        let ch = CapturingChannel {
            name: name.into(),
            calls: calls.clone(),
            outcome: Outcome::Ok,
        };
        (
            RegisteredChannel {
                impl_: Arc::new(ch),
                recipient: Recipient::AutoActiveSession,
                severity_floor: floor,
                event_filter: filter,
            },
            calls,
        )
    }

    #[tokio::test]
    async fn registry_drops_notifications_below_severity_floor() {
        let (ch, calls) = make_channel("dashboard", Severity::OperatorImportant, vec![]);
        let registry = ChannelRegistry::new(vec![ch]);
        let n = Notification {
            event_kind: "channel.message".into(),
            summary: "noise".into(),
            details: None,
            severity: Severity::Diagnostic,
            structured: None,
            correlation_id: None,
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        assert!(ids.is_empty());
        assert!(calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn registry_dispatches_when_severity_clears_floor() {
        let (ch, calls) = make_channel("dashboard", Severity::OperatorImportant, vec![]);
        let registry = ChannelRegistry::new(vec![ch]);
        let n = Notification {
            event_kind: "offer.accepted".into(),
            summary: "deal".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("tok".into()),
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0].as_str(), "tok");
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn registry_event_filter_drops_unmatched_kind() {
        let (ch, calls) = make_channel(
            "dashboard",
            Severity::Diagnostic,
            vec!["transaction.completed".into()],
        );
        let registry = ChannelRegistry::new(vec![ch]);
        let n = Notification {
            event_kind: "offer.accepted".into(),
            summary: "skipped".into(),
            details: None,
            severity: Severity::ApprovalRequest,
            structured: None,
            correlation_id: None,
            reply_hint: None,
        };
        assert!(registry.notify(n).await.is_empty());
        assert!(calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn registry_fans_out_across_multiple_channels() {
        let (dash, dash_calls) =
            make_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            make_channel("dedicated", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![dash, dedicated]);
        let n = Notification {
            event_kind: "transaction.completed".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("tok".into()),
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        assert_eq!(ids.len(), 2);
        assert_eq!(dash_calls.lock().await.len(), 1);
        assert_eq!(dedicated_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn registry_keeps_running_when_one_channel_fails() {
        let (good, good_calls) =
            make_channel("dedicated", Severity::Diagnostic, vec![]);
        let bad_calls = Arc::new(TokioMutex::new(Vec::new()));
        let bad = RegisteredChannel {
            impl_: Arc::new(CapturingChannel {
                name: "broken".into(),
                calls: bad_calls.clone(),
                outcome: Outcome::Fail,
            }),
            recipient: Recipient::AutoActiveSession,
            severity_floor: Severity::Diagnostic,
            event_filter: vec![],
        };
        let registry = ChannelRegistry::new(vec![bad, good]);
        let n = Notification {
            event_kind: "offer.accepted".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("tok".into()),
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        // Bad channel raised; good channel still posted.
        assert_eq!(ids.len(), 1);
        assert_eq!(good_calls.lock().await.len(), 1);
        assert_eq!(bad_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn registry_promotes_default_operator_severity_per_event() {
        // Severity::Operator + event_kind=offer.accepted → promoted to
        // OperatorImportant by the registry. Channel with floor =
        // OperatorImportant still sees it.
        let (ch, calls) =
            make_channel("dashboard", Severity::OperatorImportant, vec![]);
        let registry = ChannelRegistry::new(vec![ch]);
        let n = Notification {
            event_kind: "offer.accepted".into(),
            summary: "deal".into(),
            details: None,
            severity: Severity::Operator,
            structured: None,
            correlation_id: Some("tok".into()),
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        assert_eq!(ids.len(), 1);
    }

    #[tokio::test]
    async fn channel_names_lists_registered_channels_in_order() {
        let (a, _) = make_channel("first", Severity::Diagnostic, vec![]);
        let (b, _) = make_channel("second", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![a, b]);
        assert_eq!(registry.channel_names(), vec!["first", "second"]);
        assert_eq!(registry.channel_count(), 2);
    }

    #[tokio::test]
    async fn registry_bypasses_batching_for_approval_request() {
        // Even with batching configured, ApprovalRequest must dispatch
        // immediately.
        let (ch, calls) = make_channel("dashboard", Severity::Diagnostic, vec![]);
        let registry =
            ChannelRegistry::new_with_batching(vec![ch], Duration::from_secs(60));
        let n = Notification {
            event_kind: "klodi_tx_confirm.approval".into(),
            summary: "approve?".into(),
            details: None,
            severity: Severity::ApprovalRequest,
            structured: None,
            correlation_id: Some("tok".into()),
            reply_hint: None,
        };
        let ids = registry.notify(n).await;
        assert_eq!(ids.len(), 1);
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn registry_batches_subsequent_events_of_same_kind_in_window() {
        // Two non-ApprovalRequest events of the same kind within the
        // batching window — only the first dispatches; the second
        // returns a "batched" placeholder id.
        let (ch, calls) =
            make_channel("dashboard", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new_with_batching(
            vec![ch],
            Duration::from_secs(60),
        );
        let mk = |id: &str| Notification {
            event_kind: "listing.updated".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some(id.into()),
            reply_hint: None,
        };
        let first = registry.notify(mk("first")).await;
        assert_eq!(first.len(), 1);
        let second = registry.notify(mk("second")).await;
        // The second call returns the correlation id (placeholder)
        // but the channel itself only saw one notification.
        assert_eq!(second.len(), 1);
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn registry_does_not_batch_across_event_kinds() {
        let (ch, calls) =
            make_channel("dashboard", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new_with_batching(
            vec![ch],
            Duration::from_secs(60),
        );
        let mk = |kind: &str, id: &str| Notification {
            event_kind: kind.into(),
            summary: "x".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some(id.into()),
            reply_hint: None,
        };
        registry.notify(mk("listing.updated", "1")).await;
        registry.notify(mk("offer.proposed", "2")).await;
        registry.notify(mk("offer.accepted", "3")).await;
        assert_eq!(calls.lock().await.len(), 3);
    }

    #[tokio::test]
    async fn registry_plan_severity_matrix_locks_defaults() {
        // Lock the §I-7 default-dispatch table against accidental drift.
        // The matrix the plan calls out:
        //
        // | Severity          | Dashboard | Dedicated  | Upstream |
        // | ApprovalRequest   | dispatch  | dispatch   | dispatch |
        // | OperatorImportant | dispatch  | dispatch   | dispatch |
        // | Operator          | drop      | dispatch   | drop     |
        // | Diagnostic        | drop      | dispatch   | drop     |

        let (dashboard, dashboard_calls) =
            make_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            make_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let (upstream, upstream_calls) = make_channel(
            "upstream:telegram",
            Severity::OperatorImportant,
            vec![],
        );
        let registry = ChannelRegistry::new(vec![dashboard, dedicated, upstream]);

        // Diagnostic — only dedicated.
        let n = Notification {
            event_kind: "channel.message".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::Diagnostic,
            structured: None,
            correlation_id: Some("a".into()),
            reply_hint: None,
        };
        registry.notify(n).await;
        // Operator — only dedicated; promoted via
        // default_severity_for_event for known kinds, but the test
        // uses a kind that defaults to Operator.
        let n = Notification {
            event_kind: "offer.proposed".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::Operator,
            structured: None,
            correlation_id: Some("b".into()),
            reply_hint: None,
        };
        registry.notify(n).await;
        // OperatorImportant — all three.
        let n = Notification {
            event_kind: "offer.accepted".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("c".into()),
            reply_hint: None,
        };
        registry.notify(n).await;
        // ApprovalRequest — all three.
        let n = Notification {
            event_kind: "klodi_tx_confirm.approval".into(),
            summary: "approve?".into(),
            details: None,
            severity: Severity::ApprovalRequest,
            structured: None,
            correlation_id: Some("d".into()),
            reply_hint: None,
        };
        registry.notify(n).await;

        assert_eq!(dedicated_calls.lock().await.len(), 4); // everything
        assert_eq!(dashboard_calls.lock().await.len(), 2); // OperatorImportant + ApprovalRequest
        assert_eq!(upstream_calls.lock().await.len(), 2); // same
    }
}
