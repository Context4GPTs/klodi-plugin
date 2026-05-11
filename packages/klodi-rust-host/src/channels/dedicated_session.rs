//! `DedicatedSessionChannel` — adapter exposing the existing klodi
//! dedicated-session write path as an `OperatorChannel`. Lets the
//! registry fan a single `Notification` out to the dedicated session +
//! the dashboard + any upstream channels using one trait call.
//!
//! The dedicated session is the chronicle of record (per
//! `zeroclaw_bootstrap_note`) — it always sees everything. Severity
//! filtering happens *upstream* of this channel in `ChannelRegistry`;
//! the impl here just renders + writes.

use anyhow::{Context, Result};
use async_trait::async_trait;
use reqwest::Client as HttpClient;
use std::time::Duration;
use uuid::Uuid;

use crate::zeroclaw_ws::{ZeroClawWsConfig, send_session_message};

use super::session_health::{
    SessionHealth, check_session_alive, resurrection_breadcrumb,
};
use super::{Notification, NotificationId, OperatorChannel, Recipient, Severity};

/// Per-call HTTP timeout for the stale-session health probe. Bounded short
/// because the probe runs in the hot path of every notification — a
/// slow gateway shouldn't stall the operator's chat.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Adapter around the existing dedicated-session WS write path.
pub struct DedicatedSessionChannel {
    name: String,
    ws_config: ZeroClawWsConfig,
    session_id: String,
    http: HttpClient,
}

impl DedicatedSessionChannel {
    /// Construct from the resolved WS config + persisted session id
    /// (`${KLODI_HOME}/zeroclaw.session`).
    pub fn new(ws_config: ZeroClawWsConfig, session_id: String) -> Self {
        let http = HttpClient::builder()
            .timeout(HEALTH_PROBE_TIMEOUT)
            .build()
            .expect("building dedicated-session HTTP client");
        Self {
            name: "dedicated_session".into(),
            ws_config,
            session_id,
            http,
        }
    }

    /// Underlying session id — used by daemon code that needs to know
    /// "which session is klodi's own" for the created-sessions ledger.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Underlying WS config — used by the daemon when wiring legacy
    /// paths that still consume the `(ws_config, session_id)` tuple
    /// directly (the forwarder's `BodyShape::ZeroClawSession`).
    pub fn ws_config(&self) -> &ZeroClawWsConfig {
        &self.ws_config
    }
}

#[async_trait]
impl OperatorChannel for DedicatedSessionChannel {
    fn name(&self) -> &str {
        &self.name
    }

    async fn notify(
        &self,
        recipient: &Recipient,
        payload: &Notification,
    ) -> Result<NotificationId> {
        // `Recipient::Address` carrying our own session id is the canonical
        // form when the registry routes here, but `AutoActiveSession` is
        // tolerated too — there's only one dedicated session, no choice
        // to make.
        if let Recipient::SessionId(id) = recipient {
            if id != &self.session_id {
                tracing::warn!(
                    expected = %self.session_id,
                    requested = %id,
                    "klodi_zeroclaw_dedicated_session_recipient_mismatch_routing_to_owned"
                );
            }
        }
        let correlation_id = payload
            .correlation_id
            .clone()
            .unwrap_or_else(|| short_token());
        let rendered = render_payload(payload, &correlation_id);

        // Stale-session pre-write check. If the dedicated session is missing
        // or has zero `message_count`, the gateway has silently
        // recreated it since we bootstrapped (T5). Log loudly, write a
        // breadcrumb so the operator sees the resurrected session
        // isn't the one they've been talking to, then write the
        // notification anyway — the operator still wants to see the
        // event.
        let health = check_session_alive(
            &self.http,
            &self.ws_config,
            &self.session_id,
        )
        .await;
        match &health {
            SessionHealth::Alive { .. } => {}
            SessionHealth::Resurrected { message_count } => {
                tracing::warn!(
                    session_id = %self.session_id,
                    message_count = message_count,
                    "klodi_zeroclaw_session_resurrection_detected"
                );
                let _ = send_session_message(
                    &self.ws_config,
                    &self.session_id,
                    &resurrection_breadcrumb(),
                )
                .await;
            }
            SessionHealth::Missing => {
                tracing::warn!(
                    session_id = %self.session_id,
                    "klodi_zeroclaw_session_resurrection_detected_missing"
                );
                // Missing → the write itself will silently re-create
                // the session id. Post the breadcrumb after the write
                // (the gateway will pair them in order).
            }
            SessionHealth::Unknown { error } => {
                tracing::warn!(
                    session_id = %self.session_id,
                    error = %error,
                    "klodi_zeroclaw_dedicated_session_health_unknown_writing_anyway"
                );
            }
        }

        send_session_message(&self.ws_config, &self.session_id, &rendered)
            .await
            .with_context(|| {
                format!(
                    "posting notification {correlation_id} to dedicated klodi session {}",
                    self.session_id,
                )
            })?;

        if matches!(health, SessionHealth::Missing) {
            // Post the breadcrumb after the silent-recreate write so
            // the gateway's new session id carries the explanation.
            let _ = send_session_message(
                &self.ws_config,
                &self.session_id,
                &resurrection_breadcrumb(),
            )
            .await;
        }

        Ok(NotificationId(correlation_id))
    }
}

/// Render a notification for the dedicated klodi session — preserves
/// the existing `klodi_report_to_operator` shape (icon + bold headline
/// + optional details + optional fenced JSON block). Different from the
/// dashboard renderer because the dedicated session is the agent's own
/// reasoning surface; a defensive `── klodi · req=…` delimiter is
/// unnecessary noise here.
pub fn render_payload(payload: &Notification, correlation_id: &str) -> String {
    let icon = match payload.severity {
        Severity::ApprovalRequest => "🔒",
        Severity::OperatorImportant => "ℹ️",
        Severity::Operator => "·",
        Severity::Diagnostic => "·",
    };
    let mut out = format!(
        "{icon} **{summary}** (req `{correlation_id}` · {event_kind})",
        icon = icon,
        summary = payload.summary,
        correlation_id = correlation_id,
        event_kind = payload.event_kind,
    );
    if let Some(details) = &payload.details {
        out.push_str("\n\n");
        out.push_str(details);
    }
    if let Some(structured) = &payload.structured {
        let pretty = serde_json::to_string_pretty(structured)
            .unwrap_or_else(|_| structured.to_string());
        out.push_str("\n\n```json\n");
        out.push_str(&pretty);
        out.push_str("\n```");
    }
    out
}

fn short_token() -> String {
    Uuid::new_v4().simple().to_string().chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Notification {
        Notification {
            event_kind: "offer.accepted".into(),
            summary: "Deal struck".into(),
            details: Some("at €140".into()),
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("abc12345".into()),
            reply_hint: None,
        }
    }

    #[test]
    fn render_payload_includes_icon_summary_and_correlation() {
        let rendered = render_payload(&fixture(), "abc12345");
        assert!(rendered.starts_with("ℹ️ **Deal struck**"));
        assert!(rendered.contains("req `abc12345`"));
        assert!(rendered.contains("offer.accepted"));
        assert!(rendered.contains("at €140"));
    }

    #[test]
    fn render_payload_swaps_icon_per_severity() {
        let mut n = fixture();
        n.severity = Severity::ApprovalRequest;
        assert!(render_payload(&n, "x").starts_with("🔒"));
        n.severity = Severity::Diagnostic;
        assert!(render_payload(&n, "x").starts_with("·"));
    }

    #[test]
    fn channel_exposes_session_id_and_ws_config() {
        let cfg = ZeroClawWsConfig {
            ws_url: "ws://x/ws/chat".into(),
            http_base: "http://x".into(),
            bearer: "zc_t".into(),
        };
        let ch = DedicatedSessionChannel::new(cfg.clone(), "session-1".into());
        assert_eq!(ch.session_id(), "session-1");
        assert_eq!(ch.ws_config(), &cfg);
        assert_eq!(ch.name(), "dedicated_session");
    }
}
