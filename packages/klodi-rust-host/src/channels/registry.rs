//! `ChannelRegistry` — routes an outbound notification to **one** agent
//! surface (with automatic fall-through to lower-floor surfaces on
//! Err), fans alongside to any non-agent notification sinks, and
//! exposes a unified inbound `OperatorReply` stream.
//!
//! Routing model (per `docs/plans/2026-05-11-klodi-zeroclaw-single-destination-routing.md`):
//! a wake or notification lands in **exactly one** agent surface. The
//! registry picks the agent-surface channel with the highest
//! `severity_floor` that still accepts the notification's severity (the
//! channel "closest to the operator"), calls `notify`, and — on Err —
//! falls through to the next-highest agent surface that accepts. The
//! dedicated klodi session, with `severity_floor=Diagnostic`, is the
//! natural backstop: it accepts everything and is always live (the
//! daemon owns the session id), so the chronicle never disappears.
//!
//! Why single-destination among agent surfaces: every `/ws/chat` write
//! fires a server-side agent loop in the target session. Fanning the
//! same payload to multiple agent surfaces would fire multiple agents
//! on the same content, with contradictory action paths and duplicate
//! token spend. Non-agent channels (Telegram, Slack, email — anything
//! where `OperatorChannel::agent_surface()` returns `false`) don't
//! trigger agent loops; they're notification sinks the operator sees
//! passively, so the registry fans them alongside the picked agent
//! route.
//!
//! Channel registration carries a `severity_floor` and an optional
//! `event_filter`. The registry filters channels that don't clear a
//! notification's gates before considering them in the route pick.
//!
//! A batching window (default 5s, configurable via `klodi.toml`) exists
//! for `notify()` — used by `klodi_escalate_to_user` and the approval
//! gate where the operator-visible note is what's being coalesced. The
//! wake-routing path uses `route_wake()` which bypasses batching
//! unconditionally; wakes are the dedicated session's chronicle and
//! batching would silently drop the second of two same-kind events
//! within the window.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio::sync::Mutex;

use super::batching::BatchingWindow;
use super::{
    Notification, NotificationId, OperatorChannel, OperatorReply, Recipient, Severity,
};

/// Outcome of [`ChannelRegistry::route_wake`] / [`ChannelRegistry::notify`].
/// Carries the channel name + posted-ness + the severity the registry
/// routed on (after any caller-side promotion). Callers that need to
/// react to `posted=false` (e.g. surfacing an error to the MCP client,
/// NAK'ing a NATS delivery) can read it here; the registry's own
/// fallback chain already tried every accepting agent surface before
/// returning, so `posted=false` means **everything** failed.
#[derive(Debug, Clone)]
pub struct RouteOutcome {
    /// Name of the channel the registry last attempted, if any. `None`
    /// only when no channel in the registry accepted the notification's
    /// severity + event_filter; otherwise the last-tried channel's name
    /// even when its `notify` returned `Err`.
    pub destination_channel: Option<String>,
    /// `true` iff one of the agent-surface channels accepted AND its
    /// `notify()` returned successfully. The registry tries every
    /// accepting agent surface in descending-floor order before giving
    /// up, so `posted: false` means all of them failed (or none
    /// accepted at all).
    pub posted: bool,
    /// Correlation id of the notification when posted, threaded back
    /// for callers (the approval gate, escalate-to-user) that need to
    /// reference it in subsequent retries.
    pub correlation_id: Option<NotificationId>,
}

/// Single registered channel — impl + the operator-supplied dispatch
/// constraints (recipient, severity floor, optional event allowlist).
/// `agent_surface` is a property of the channel impl
/// ([`OperatorChannel::agent_surface`]) so wiring this registration
/// can't accidentally re-introduce duplicate-agent fan-out.
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
    /// bypass batching.
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

    /// Route a notification through the registry's pick-one-agent
    /// chain. Among agent-surface channels that accept the
    /// notification (severity ≥ floor, event_filter clears), tries them
    /// in **descending `severity_floor` order** — the channel closest
    /// to the operator first, falling through to lower-floor channels
    /// on Err. The dedicated klodi session, with the lowest floor
    /// (`Diagnostic`), is therefore the natural backstop: it accepts
    /// everything and is always live, so the chronicle never
    /// disappears. Non-agent channels (upstream Telegram/Slack/email)
    /// fan alongside the picked agent route since they don't fire
    /// agent loops.
    ///
    /// Wakes use [`Self::route_wake`] (same semantics but unconditionally
    /// bypasses batching). MCP callers — `klodi_escalate_to_user` and
    /// the approval gate — use this `notify` so the batching window
    /// can coalesce same-event-kind noise on the operator-visible
    /// surfaces.
    pub async fn notify(&self, notif: Notification) -> RouteOutcome {
        self.route(notif, /* bypass_batching */ false).await
    }

    /// Wake-path entry point. Same single-destination semantics as
    /// [`Self::notify`] but unconditionally bypasses the registry's
    /// batching window — wakes are the chronicle and a coalesced wake
    /// silently drops a marketplace event.
    pub async fn route_wake(&self, notif: Notification) -> RouteOutcome {
        self.route(notif, /* bypass_batching */ true).await
    }

    async fn route(
        &self,
        notif: Notification,
        bypass_batching: bool,
    ) -> RouteOutcome {
        let bypasses_batching =
            bypass_batching || notif.severity >= Severity::ApprovalRequest;

        if !bypasses_batching {
            let mut guard = self.inner.batching.lock().await;
            if let Some(window) = guard.as_mut() {
                if let Some(_coalesced) = window.try_coalesce(&notif) {
                    // Coalesced into a prior window entry. Return the
                    // correlation id so the caller has something to
                    // reference; `posted: true` signals "do not retry"
                    // — the prior dispatch already covered this.
                    let cid = notif
                        .correlation_id
                        .clone()
                        .unwrap_or_else(|| "batched".to_string());
                    return RouteOutcome {
                        destination_channel: Some("(batched)".to_string()),
                        posted: true,
                        correlation_id: Some(NotificationId(cid)),
                    };
                }
                window.note_first(&notif);
            }
        }

        // Build the descending-floor chain of accepting agent surfaces.
        // The first one to succeed wins (single destination invariant);
        // on Err we fall through to the next-highest floor. The
        // dedicated session's `Diagnostic` floor makes it the last
        // resort for every notification that has a destination at all.
        let mut agent_chain: Vec<&RegisteredChannel> = self
            .inner
            .channels
            .iter()
            .filter(|ch| ch.impl_.agent_surface() && ch.accepts(&notif))
            .collect();
        agent_chain.sort_by(|a, b| b.severity_floor.cmp(&a.severity_floor));

        let mut outcome = RouteOutcome {
            destination_channel: None,
            posted: false,
            correlation_id: None,
        };

        for ch in agent_chain.iter() {
            let channel_name = ch.impl_.name().to_string();
            outcome.destination_channel = Some(channel_name.clone());
            match ch.impl_.notify(&ch.recipient, &notif).await {
                Ok(id) => {
                    outcome.posted = true;
                    outcome.correlation_id = Some(id);
                    break;
                }
                Err(err) => {
                    tracing::warn!(
                        channel = %channel_name,
                        event_kind = %notif.event_kind,
                        severity = %notif.severity.as_str(),
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_channel_notify_failed_falling_through"
                    );
                }
            }
        }

        if agent_chain.is_empty() {
            tracing::warn!(
                event_kind = %notif.event_kind,
                severity = %notif.severity.as_str(),
                "klodi_zeroclaw_no_accepting_agent_channel"
            );
        } else if !outcome.posted {
            tracing::warn!(
                event_kind = %notif.event_kind,
                severity = %notif.severity.as_str(),
                attempts = agent_chain.len(),
                "klodi_zeroclaw_every_agent_channel_failed"
            );
        }

        // Fan upstream notification sinks — these don't fire agent
        // loops, so safe to send in addition to the picked agent route.
        for ch in self.inner.channels.iter() {
            if ch.impl_.agent_surface() || !ch.accepts(&notif) {
                continue;
            }
            if let Err(err) = ch.impl_.notify(&ch.recipient, &notif).await {
                tracing::warn!(
                    channel = %ch.impl_.name(),
                    event_kind = %notif.event_kind,
                    severity = %notif.severity.as_str(),
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_upstream_channel_notify_failed"
                );
            }
        }

        outcome
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
        is_agent_surface: bool,
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
        fn agent_surface(&self) -> bool {
            self.is_agent_surface
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

    /// Test helper: build an agent-surface channel (dedicated /
    /// dashboard style — single-destination among other agent surfaces,
    /// with fall-through to lower floors on Err).
    fn agent_channel(
        name: &str,
        floor: Severity,
        filter: Vec<String>,
    ) -> (RegisteredChannel, Arc<TokioMutex<Vec<Notification>>>) {
        let calls = Arc::new(TokioMutex::new(Vec::new()));
        let ch = CapturingChannel {
            name: name.into(),
            calls: calls.clone(),
            outcome: Outcome::Ok,
            is_agent_surface: true,
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

    /// Test helper: build a failing agent-surface channel — used to
    /// exercise the fall-through-on-Err path between agent surfaces.
    fn failing_agent_channel(
        name: &str,
        floor: Severity,
    ) -> (RegisteredChannel, Arc<TokioMutex<Vec<Notification>>>) {
        let calls = Arc::new(TokioMutex::new(Vec::new()));
        let ch = CapturingChannel {
            name: name.into(),
            calls: calls.clone(),
            outcome: Outcome::Fail,
            is_agent_surface: true,
        };
        (
            RegisteredChannel {
                impl_: Arc::new(ch),
                recipient: Recipient::AutoActiveSession,
                severity_floor: floor,
                event_filter: vec![],
            },
            calls,
        )
    }

    /// Test helper: build a non-agent channel (Telegram/Slack-style —
    /// fans alongside the agent route).
    fn upstream_channel(
        name: &str,
        floor: Severity,
        filter: Vec<String>,
    ) -> (RegisteredChannel, Arc<TokioMutex<Vec<Notification>>>) {
        let calls = Arc::new(TokioMutex::new(Vec::new()));
        let ch = CapturingChannel {
            name: name.into(),
            calls: calls.clone(),
            outcome: Outcome::Ok,
            is_agent_surface: false,
        };
        (
            RegisteredChannel {
                impl_: Arc::new(ch),
                recipient: Recipient::Address("telegram:123".into()),
                severity_floor: floor,
                event_filter: filter,
            },
            calls,
        )
    }

    #[tokio::test]
    async fn route_picks_dedicated_for_diagnostic_severity() {
        // channel.message → Diagnostic. Dashboard (floor=OperatorImportant)
        // rejects; dedicated (floor=Diagnostic) accepts. Dedicated wins.
        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![dashboard, dedicated]);
        let outcome = registry
            .notify(Notification {
                event_kind: "channel.message".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::Diagnostic,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(outcome.posted);
        assert_eq!(outcome.destination_channel.as_deref(), Some("dedicated_session"));
        assert_eq!(dedicated_calls.lock().await.len(), 1);
        assert!(dashboard_calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn route_prefers_dashboard_over_dedicated_for_operator_important() {
        // offer.accepted → OperatorImportant. Both channels accept;
        // dashboard wins because its severity_floor is higher (it's
        // the channel "closer to the operator"). Dedicated stays silent
        // — no fan-out.
        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![dashboard, dedicated]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::OperatorImportant,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(outcome.posted);
        assert_eq!(outcome.destination_channel.as_deref(), Some("dashboard"));
        assert_eq!(dashboard_calls.lock().await.len(), 1);
        assert!(dedicated_calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn route_no_fanout_between_agent_surfaces() {
        // Pins the no-fanout invariant explicitly. Three agent
        // surfaces, all accept the notification. Exactly one fires.
        let (a, a_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (b, b_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let (c, c_calls) =
            agent_channel("dashboard_alt", Severity::Operator, vec![]);
        let registry = ChannelRegistry::new(vec![a, b, c]);
        registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::ApprovalRequest,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        let total = a_calls.lock().await.len()
            + b_calls.lock().await.len()
            + c_calls.lock().await.len();
        assert_eq!(total, 1, "exactly one agent channel must fire — no fan-out");
        // Highest floor wins: dashboard (OperatorImportant).
        assert_eq!(a_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn route_fans_upstream_alongside_agent_destination() {
        // Upstream channels (agent_surface=false) don't fire agent
        // loops, so they fan freely alongside the picked agent
        // destination. Dashboard (agent) fires + Telegram (upstream)
        // fires for one ApprovalRequest.
        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (telegram, telegram_calls) = upstream_channel(
            "upstream:telegram",
            Severity::OperatorImportant,
            vec![],
        );
        let registry = ChannelRegistry::new(vec![dashboard, telegram]);
        registry
            .notify(Notification {
                event_kind: "klodi_tx_confirm.approval".into(),
                summary: "approve?".into(),
                details: None,
                severity: Severity::ApprovalRequest,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert_eq!(dashboard_calls.lock().await.len(), 1);
        assert_eq!(telegram_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn route_event_filter_drops_unmatched_kind() {
        let (ch, calls) = agent_channel(
            "dashboard",
            Severity::Diagnostic,
            vec!["transaction.completed".into()],
        );
        let registry = ChannelRegistry::new(vec![ch]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "skipped".into(),
                details: None,
                severity: Severity::ApprovalRequest,
                structured: None,
                correlation_id: None,
                reply_hint: None,
            })
            .await;
        assert!(!outcome.posted);
        assert!(outcome.destination_channel.is_none());
        assert!(calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn route_returns_posted_false_when_only_channel_errors() {
        // When the only accepting agent surface fails and there's no
        // lower-floor backstop, `posted=false` with the failed channel
        // name surfaces back. Callers (the forwarder) NAK to NATS so
        // JetStream redelivers.
        let (failing, calls) =
            failing_agent_channel("dashboard", Severity::OperatorImportant);
        let registry = ChannelRegistry::new(vec![failing]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::OperatorImportant,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(!outcome.posted);
        assert_eq!(outcome.destination_channel.as_deref(), Some("dashboard"));
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn route_falls_through_to_lower_floor_on_err() {
        // Dashboard floor=OperatorImportant fails (T3 returned nothing,
        // gateway hiccup, …); the registry falls through to the
        // dedicated session (Diagnostic floor) which is the chronicle
        // of record. Replaces the previous "every caller implements its
        // own fallback" pattern — fallback is the registry's job.
        let (failing, dashboard_calls) =
            failing_agent_channel("dashboard", Severity::OperatorImportant);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![failing, dedicated]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::OperatorImportant,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(outcome.posted, "fell through to dedicated session");
        assert_eq!(
            outcome.destination_channel.as_deref(),
            Some("dedicated_session"),
            "registry should record the channel that succeeded, not the one that failed"
        );
        assert_eq!(dashboard_calls.lock().await.len(), 1);
        assert_eq!(dedicated_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn route_does_not_fall_through_on_success() {
        // Pin the no-fan-out invariant once more: dashboard succeeds,
        // dedicated must NOT also get the payload — that would fire two
        // agent loops on the same content.
        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![dashboard, dedicated]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::OperatorImportant,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(outcome.posted);
        assert_eq!(outcome.destination_channel.as_deref(), Some("dashboard"));
        assert_eq!(dashboard_calls.lock().await.len(), 1);
        assert_eq!(
            dedicated_calls.lock().await.len(),
            0,
            "dedicated must not see the payload — would fire a second agent",
        );
    }

    #[tokio::test]
    async fn route_no_accepting_channel_returns_none() {
        // Notification severity is below every channel's floor → no
        // agent channel accepts → outcome.destination_channel = None.
        let (ch, calls) =
            agent_channel("dashboard", Severity::ApprovalRequest, vec![]);
        let registry = ChannelRegistry::new(vec![ch]);
        let outcome = registry
            .notify(Notification {
                event_kind: "channel.message".into(),
                summary: "x".into(),
                details: None,
                severity: Severity::Diagnostic,
                structured: None,
                correlation_id: None,
                reply_hint: None,
            })
            .await;
        assert!(!outcome.posted);
        assert!(outcome.destination_channel.is_none());
        assert!(calls.lock().await.is_empty());
    }

    #[tokio::test]
    async fn route_respects_caller_supplied_severity_verbatim() {
        // The registry no longer silently promotes
        // `Severity::Operator + offer.accepted` to OperatorImportant —
        // callers supply the canonical severity themselves
        // (`default_severity_for_event` is now their responsibility, not
        // a hidden registry behaviour). A caller passing
        // severity=Operator for offer.accepted routes to dedicated (the
        // only channel accepting Operator), not the dashboard.
        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![dashboard, dedicated]);
        let outcome = registry
            .notify(Notification {
                event_kind: "offer.accepted".into(),
                summary: "deal".into(),
                details: None,
                severity: Severity::Operator,
                structured: None,
                correlation_id: Some("tok".into()),
                reply_hint: None,
            })
            .await;
        assert!(outcome.posted);
        assert_eq!(
            outcome.destination_channel.as_deref(),
            Some("dedicated_session"),
        );
        assert_eq!(dashboard_calls.lock().await.len(), 0);
        assert_eq!(dedicated_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn route_wake_bypasses_batching_window() {
        // Wakes must always land — registry-wide batching would
        // silently coalesce two same-kind marketplace events into one.
        // `route_wake` is the forwarder's entry point and skips coalesce.
        let (ch, calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new_with_batching(
            vec![ch],
            Duration::from_secs(60),
        );
        let mk = |id: &str| Notification {
            event_kind: "channel.message".into(),
            summary: "x".into(),
            details: None,
            severity: Severity::Diagnostic,
            structured: None,
            correlation_id: Some(id.into()),
            reply_hint: None,
        };
        let first = registry.route_wake(mk("first")).await;
        assert!(first.posted);
        let second = registry.route_wake(mk("second")).await;
        assert!(second.posted);
        assert_eq!(calls.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn notify_bypasses_batching_for_approval_request() {
        // ApprovalRequest severity bypasses batching even on the
        // `notify` path. Pin that the second call still dispatches.
        let (ch, calls) =
            agent_channel("dashboard", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new_with_batching(
            vec![ch],
            Duration::from_secs(60),
        );
        let mk = |id: &str| Notification {
            event_kind: "klodi_tx_confirm.approval".into(),
            summary: "approve?".into(),
            details: None,
            severity: Severity::ApprovalRequest,
            structured: None,
            correlation_id: Some(id.into()),
            reply_hint: None,
        };
        registry.notify(mk("first")).await;
        registry.notify(mk("second")).await;
        assert_eq!(calls.lock().await.len(), 2);
    }

    #[tokio::test]
    async fn notify_batches_same_event_kind_in_window() {
        let (ch, calls) =
            agent_channel("dashboard", Severity::Diagnostic, vec![]);
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
        assert!(first.posted);
        let second = registry.notify(mk("second")).await;
        // Second one coalesces — `posted: true` but the channel only
        // saw the first.
        assert!(second.posted);
        assert_eq!(calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn channel_names_lists_registered_channels_in_order() {
        let (a, _) = agent_channel("first", Severity::Diagnostic, vec![]);
        let (b, _) = agent_channel("second", Severity::Diagnostic, vec![]);
        let registry = ChannelRegistry::new(vec![a, b]);
        assert_eq!(registry.channel_names(), vec!["first", "second"]);
        assert_eq!(registry.channel_count(), 2);
    }

    #[tokio::test]
    async fn route_severity_matrix() {
        // Lock the single-destination routing table:
        //
        // | Severity          | Picked agent surface | Upstream fan |
        // | Diagnostic        | dedicated            | drop         |
        // | Operator          | dedicated            | drop         |
        // | OperatorImportant | dashboard            | dispatch     |
        // | ApprovalRequest   | dashboard            | dispatch     |

        let (dashboard, dashboard_calls) =
            agent_channel("dashboard", Severity::OperatorImportant, vec![]);
        let (dedicated, dedicated_calls) =
            agent_channel("dedicated_session", Severity::Diagnostic, vec![]);
        let (upstream, upstream_calls) = upstream_channel(
            "upstream:telegram",
            Severity::OperatorImportant,
            vec![],
        );
        let registry = ChannelRegistry::new(vec![dashboard, dedicated, upstream]);

        let mk = |kind: &str, sev: Severity, id: &str| Notification {
            event_kind: kind.into(),
            summary: "x".into(),
            details: None,
            severity: sev,
            structured: None,
            correlation_id: Some(id.into()),
            reply_hint: None,
        };

        registry.notify(mk("channel.message", Severity::Diagnostic, "a")).await;
        registry.notify(mk("offer.proposed", Severity::Operator, "b")).await;
        registry.notify(mk("offer.accepted", Severity::OperatorImportant, "c")).await;
        registry.notify(mk("klodi_tx_confirm.approval", Severity::ApprovalRequest, "d")).await;

        // Dedicated picks up Diagnostic + Operator (dashboard rejects those).
        assert_eq!(dedicated_calls.lock().await.len(), 2);
        // Dashboard picks up OperatorImportant + ApprovalRequest.
        assert_eq!(dashboard_calls.lock().await.len(), 2);
        // Upstream (non-agent, fans freely): also OperatorImportant + ApprovalRequest.
        assert_eq!(upstream_calls.lock().await.len(), 2);
    }
}
