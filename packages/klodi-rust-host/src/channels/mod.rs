//! Operator-notification channels — single-destination routing for
//! klodi events, with passive fan-out to non-agent notification sinks.
//!
//! The shape is intentionally minimal: a single trait `OperatorChannel`
//! that every notification target (the dashboard, the dedicated klodi
//! session, any upstream-delegated channel) implements, plus a
//! `ChannelRegistry` that picks **one** agent surface per notification
//! (the one with the highest `severity_floor` that still accepts it;
//! falling through to lower-floor surfaces on Err), and exposes a
//! unified stream of inbound `OperatorReply`s back to the agent. See
//! `docs/plans/2026-05-11-klodi-zeroclaw-single-destination-routing.md`
//! for the rationale (every `/ws/chat` write fires a server-side agent
//! loop, so fanning to multiple agent surfaces creates duplicate turns
//! on the same content).
//!
//! Three implementations land in 0.2.9 — `DashboardChannel` (klodi-owned
//! WS transport against `/ws/chat`), `DedicatedSessionChannel`
//! (adapter over the persisted klodi session the daemon already owns),
//! and `UpstreamChannel` (delegating wrapper over `zeroclaw channel
//! send`). The first two are `agent_surface=true` (single-destination
//! among them); upstream channels are `agent_surface=false` (fan freely).
//!
//! Notification shape mirrors upstream's `(channel_id, recipient, message)`
//! `zeroclaw channel send` CLI: every notification carries a structured
//! event + severity + render hints; each implementation renders the
//! payload to whatever its medium expects (plain text for upstream
//! channels, dashboard-safe markdown with a `── klodi · req=` correlation
//! header for the dashboard, an icon-prefixed headline for the dedicated
//! klodi session).

use std::pin::Pin;

use anyhow::Result;
use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};

pub mod batching;
pub mod config;
pub mod cursor;
pub mod dashboard;
pub mod dedicated_session;
pub mod factory;
pub mod invoker;
pub mod ledger;
pub mod registry;
pub mod reply_capture;
pub mod session_health;
pub mod upstream;

pub use config::{
    DashboardChannelConfig, NotificationsConfig, RECIPIENT_AUTO_ACTIVE,
    UpstreamChannelConfig,
};
pub use cursor::DispatcherCursor;
pub use dashboard::DashboardChannel;
pub use dedicated_session::DedicatedSessionChannel;
pub use factory::{SessionBinding, build_channel_registry};
pub use invoker::ChannelInvoker;
pub use ledger::CreatedSessionsLedger;
pub use registry::{ChannelRegistry, RegisteredChannel, RouteOutcome};
pub use upstream::UpstreamChannel;

/// Severity of an outbound notification. Each registered channel has a
/// `severity_floor` and only sees notifications at or above that floor.
///
/// `Diagnostic < Operator < OperatorImportant < ApprovalRequest`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    /// Daemon-side health / echo / debug — only the dedicated klodi
    /// session sees these by default.
    Diagnostic,
    /// Routine activity (offer proposed, search match, listing update).
    Operator,
    /// Deal-closure state changes the operator should know about
    /// within minutes — offer accepted, transaction completed,
    /// transaction cancelled.
    OperatorImportant,
    /// Plugin-gated irreversible — fan out to every enabled channel
    /// (dashboard, upstream, dedicated). Bypasses batching.
    ApprovalRequest,
}

impl Severity {
    /// Stable string for log fields and the channels-config file.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Diagnostic => "diagnostic",
            Self::Operator => "operator",
            Self::OperatorImportant => "operator_important",
            Self::ApprovalRequest => "approval_request",
        }
    }

    /// Parse the same values that [`Self::as_str`] emits — `klodi.toml`
    /// uses them verbatim in `severity_floor = "operator_important"`.
    /// Returns `None` for unknown strings; the config loader logs and
    /// keeps the default.
    pub fn from_str_canonical(s: &str) -> Option<Self> {
        match s {
            "diagnostic" => Some(Self::Diagnostic),
            "operator" => Some(Self::Operator),
            "operator_important" => Some(Self::OperatorImportant),
            "approval_request" => Some(Self::ApprovalRequest),
            _ => None,
        }
    }
}

/// Destination identifier handed to [`OperatorChannel::notify`]. Two
/// shapes:
///
/// - `AutoActiveSession` (DashboardChannel only) — defer the choice to
///   the registered channel's runtime heuristic (T3 in the probe report
///   — the most-recent operator-typed session not on the
///   created-sessions ledger).
/// - `SessionId(id)` (DashboardChannel) — pin a specific dashboard
///   session. Used when the operator scoped the destination in
///   `klodi.toml`.
/// - `Address(s)` (UpstreamChannel, DedicatedSessionChannel) —
///   channel-specific destination (Telegram chat id, Slack channel,
///   email address, dedicated klodi session UUID).
#[derive(Debug, Clone)]
pub enum Recipient {
    /// DashboardChannel — resolve at notify time.
    AutoActiveSession,
    /// DashboardChannel pinned to a specific dashboard session.
    SessionId(String),
    /// UpstreamChannel / DedicatedSessionChannel — channel-specific
    /// destination string.
    Address(String),
}

/// Outbound notification. The `payload` is rendered per-channel by the
/// implementation (see `dashboard::render_payload` and
/// `upstream::render_payload`).
#[derive(Debug, Clone)]
pub struct Notification {
    /// Free-form event identifier — `offer.accepted`,
    /// `transaction.completed`, `klodi_tx_confirm.approval`, …
    /// Used for per-channel event filtering and for the
    /// correlation header in the rendered payload.
    pub event_kind: String,
    /// One-line headline operator sees first. Plain text — channel-side
    /// rendering may bold, prefix with an icon, or wrap in markdown.
    pub summary: String,
    /// Optional multi-line body.
    pub details: Option<String>,
    /// Severity for the dispatch gates.
    pub severity: Severity,
    /// Optional structured payload (JSON tree) — rendered into a fenced
    /// JSON block by impls that support it (DashboardChannel,
    /// DedicatedSessionChannel). Plain-text channels ignore it.
    pub structured: Option<serde_json::Value>,
    /// Optional correlation token. When present, used verbatim as the
    /// `req=` slot in the dashboard and upstream rendering. When `None`,
    /// the channel generates one — but Phase 5's approval gate always
    /// supplies its own `request_id` here so the reply bridge can
    /// disambiguate.
    pub correlation_id: Option<String>,
    /// Optional reply hint for the dashboard rendering — overrides the
    /// default `/klodi yes:<req>` line. Approval prompts use this to
    /// surface the exact tokens the agent will accept; informational
    /// notifications leave it `None` so the standard hint applies.
    pub reply_hint: Option<String>,
}

/// Identifier returned by [`OperatorChannel::notify`]. For dashboard
/// notifications this is the `req=` token the operator sees in the
/// rendered headline. Upstream channels return the same value so the
/// caller can match approval replies (Phase 4 won't accept replies on
/// upstream channels in 0.2.9 — outbound only — but the token is
/// preserved end-to-end so the operator's eye can scan for it across
/// surfaces).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationId(pub String);

impl NotificationId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Inbound reply from an operator-visible surface. Phase 2 wires this
/// up for the dashboard channel; Phase 4 emits an empty stream for
/// upstream channels (no documented inbound surface in 0.7.4).
#[derive(Debug, Clone)]
pub struct OperatorReply {
    /// Which channel observed the reply — `"dashboard"`,
    /// `"upstream:telegram"`, `"dedicated_session"`. Mirrors
    /// [`OperatorChannel::name`].
    pub channel_name: String,
    /// Verbatim text the operator typed (or its channel-specific
    /// equivalent — for voice channels this would be the transcription).
    /// The reply bridge does the prefix / disambiguation work; the
    /// stream just emits "operator said something on channel X."
    pub text: String,
    /// If the reply matched a pending `req=` token, the matched id.
    /// `None` when the reply is bare chat the bridge couldn't tie to
    /// any open notification.
    pub correlation_id: Option<String>,
    /// Where the reply came from — for the dashboard, the originating
    /// session id; for upstream, the recipient address. Lets the
    /// approval-gate code attribute the reply to a specific operator
    /// surface in audit logs.
    pub origin: String,
}

/// Outbound-channel surface. Every concrete channel impl (dashboard,
/// upstream, dedicated session) implements this. The dispatch in
/// `ChannelRegistry` is fully polymorphic over the trait — adding a new
/// transport never touches the registry.
///
/// The trait uses `async-trait` because we hold channel impls behind a
/// `Box<dyn OperatorChannel>`. Native `async fn` in trait is stable but
/// not yet trivially `dyn`-compatible without boxed-future spelling.
#[async_trait]
pub trait OperatorChannel: Send + Sync {
    /// Stable per-channel name — `"dashboard"`, `"dedicated_session"`,
    /// `"upstream:telegram"`. Used in log fields, `OperatorReply.channel_name`,
    /// and the multi-surface bootstrap-note copy.
    fn name(&self) -> &str;

    /// Post `payload` to the channel addressed by `recipient`. Returns
    /// the correlation token (the `req=…` operator sees) so callers
    /// (the approval gate) can correlate inbound replies later.
    async fn notify(
        &self,
        recipient: &Recipient,
        payload: &Notification,
    ) -> Result<NotificationId>;

    /// Stream of inbound operator replies. The default returns an empty
    /// stream — outbound-only channels (`UpstreamChannel` in 0.2.9)
    /// don't need to override. The dashboard channel overrides with its
    /// polling bridge in Phase 2.
    fn replies(&self) -> Pin<Box<dyn Stream<Item = OperatorReply> + Send + 'static>> {
        Box::pin(futures_util::stream::empty())
    }

    /// `true` for channels that write into a ZeroClaw `/ws/chat` session
    /// (every write fires a server-side agent loop). The registry's
    /// `route()` picks **one** agent surface per notification — fanning
    /// to multiple would fire duplicate agent turns on the same content
    /// (the bug 0.2.11 rewinds). `false` channels (upstream notification
    /// sinks: Telegram, Slack, email, …) fan freely alongside the picked
    /// agent route.
    ///
    /// Default `false` so a new transport author can't silently break
    /// the no-fan-out invariant; impls that ARE agent surfaces opt in
    /// by overriding.
    fn agent_surface(&self) -> bool {
        false
    }
}

/// Map a "wake kind" string (`listing.created`, `offer.accepted`, …)
/// to its default [`Severity`]. Daemon uses this on
/// the forwarder path so wake events get a sensible default that
/// `klodi.toml` can override.
pub fn default_severity_for_event(event_kind: &str) -> Severity {
    match event_kind {
        // Plugin-gated approval prompts are the highest priority and
        // bypass batching.
        k if k.ends_with(".approval")
            || k.starts_with("klodi_tx_confirm")
            || k.starts_with("klodi_tx_cancel")
            || k.starts_with("klodi_list_withdraw") =>
        {
            Severity::ApprovalRequest
        }
        // State changes the operator should know about within minutes.
        // Limited to deal-closure events — these are the moments where
        // the operator's dashboard agent has the right context to
        // surface to the user (confirm tx, rate counterparty, cancel
        // / dispute).
        "offer.accepted"
        | "transaction.completed"
        | "transaction.cancelled" => Severity::OperatorImportant,
        // Routine marketplace activity. Stays in the dedicated klodi
        // session; the autonomous agent handles per SKILL.md §3.
        "search.match"
        | "offer.proposed"
        | "offer.created"
        | "offer.rejected"
        | "offer.responded"
        | "listing.created"
        | "listing.matched"
        | "listing.updated" => Severity::Operator,
        // Channel lifecycle + per-message traffic — autonomous-agent
        // territory. `channel.opened` is the start of a negotiation
        // thread the agent runs itself (seller: send the structured
        // logistics opener; buyer: read against the buy file). No
        // operator involvement until the agent escalates explicitly
        // via `klodi_escalate_to_user`. Operator's dashboard agent
        // would have no useful context to act on these.
        "channel.message" | "channel.opened" | "channel.closed" => Severity::Diagnostic,
        _ => Severity::Operator,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_string_roundtrip() {
        for s in [
            Severity::Diagnostic,
            Severity::Operator,
            Severity::OperatorImportant,
            Severity::ApprovalRequest,
        ] {
            assert_eq!(Severity::from_str_canonical(s.as_str()), Some(s));
        }
    }

    #[test]
    fn severity_unknown_string_is_none() {
        assert!(Severity::from_str_canonical("loud").is_none());
        assert!(Severity::from_str_canonical("").is_none());
    }

    #[test]
    fn severity_ordering_matches_plan() {
        assert!(Severity::Diagnostic < Severity::Operator);
        assert!(Severity::Operator < Severity::OperatorImportant);
        assert!(Severity::OperatorImportant < Severity::ApprovalRequest);
    }

    #[test]
    fn default_severity_recognises_irreversibles() {
        assert_eq!(
            default_severity_for_event("klodi_tx_confirm.approval"),
            Severity::ApprovalRequest,
        );
        assert_eq!(
            default_severity_for_event("klodi_list_withdraw"),
            Severity::ApprovalRequest,
        );
    }

    #[test]
    fn default_severity_promotes_important_state_changes() {
        assert_eq!(
            default_severity_for_event("offer.accepted"),
            Severity::OperatorImportant,
        );
        assert_eq!(
            default_severity_for_event("transaction.completed"),
            Severity::OperatorImportant,
        );
    }

    #[test]
    fn default_severity_drops_diagnostic_noise() {
        assert_eq!(
            default_severity_for_event("channel.message"),
            Severity::Diagnostic,
        );
    }

    #[test]
    fn default_severity_falls_back_to_operator_for_unknown() {
        assert_eq!(
            default_severity_for_event("listing.created"),
            Severity::Operator,
        );
        assert_eq!(
            default_severity_for_event("offer.proposed"),
            Severity::Operator,
        );
        // Genuinely unknown — also lands on Operator so operators don't
        // miss novel events. Phase 7's format work can refine this.
        assert_eq!(
            default_severity_for_event("brand.new.event"),
            Severity::Operator,
        );
    }
}
