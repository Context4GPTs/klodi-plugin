//! `UpstreamChannel` — delegate-to-upstream wrapper that routes every
//! notification through `zeroclaw channel send`.
//!
//! Klodi does NOT re-implement Telegram/Slack/Discord/etc. clients.
//! `zeroclaw channel list` enumerates 24 channel ids that
//! `zeroclaw channel send` accepts; upstream's `[reliability]` config
//! owns retry/backoff for each medium. The wrapper here is a thin
//! formatting + invocation layer.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::zeroclaw_ws::ZeroClawWsConfig;

use super::invoker::ChannelInvoker;
use super::{Notification, NotificationId, OperatorChannel, Recipient};

/// Per-call timeout for `GET /api/channels`. Small because the list is
/// short and we only call it once at daemon startup.
const CHANNELS_REST_TIMEOUT: Duration = Duration::from_secs(10);

/// `GET /api/channels` response entry — only the channel id matters
/// for validation; other fields drain into the catch-all.
#[derive(Debug, Deserialize)]
struct ChannelListEntry {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, alias = "channel_id")]
    channel: Option<String>,
}

impl ChannelListEntry {
    fn identifier(&self) -> Option<&str> {
        self.id
            .as_deref()
            .or(self.channel.as_deref())
            .or(self.name.as_deref())
    }
}

/// Query `GET /api/channels` on the gateway and return the set of
/// channel ids the operator has registered upstream. The daemon uses
/// this to validate `klodi.toml` `[[notifications.upstream]]` channel
/// ids — referencing one that isn't on the upstream listing is a typo
/// or config drift and we surface it as a warn so notifications don't
/// silently drop for that channel.
pub async fn fetch_configured_channel_ids(
    ws_config: &ZeroClawWsConfig,
) -> Result<Vec<String>> {
    let http = HttpClient::builder()
        .timeout(CHANNELS_REST_TIMEOUT)
        .build()
        .context("building upstream-channels REST client")?;
    let url = format!("{}/api/channels", ws_config.http_base);
    let resp = http
        .get(&url)
        .bearer_auth(&ws_config.bearer)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("GET /api/channels returned {status}: {body}");
    }
    let body: Value = resp
        .json()
        .await
        .context("decoding /api/channels response")?;
    let arr = match body {
        Value::Object(ref map) => match map.get("channels") {
            Some(Value::Array(a)) => a.clone(),
            _ => bail!("/api/channels: missing `channels` array"),
        },
        Value::Array(a) => a,
        _ => bail!("/api/channels: unexpected response shape"),
    };
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        if let Ok(parsed) = serde_json::from_value::<ChannelListEntry>(entry) {
            if let Some(id) = parsed.identifier() {
                out.push(id.to_string());
            }
        }
    }
    Ok(out)
}

/// Delegating wrapper over one upstream channel id.
pub struct UpstreamChannel {
    name: String,
    channel_id: String,
    invoker: Arc<ChannelInvoker>,
}

impl UpstreamChannel {
    /// Build an upstream channel for `channel_id`. The `name` is
    /// `"upstream:<channel_id>"` so registry log fields stay readable.
    pub fn new(channel_id: String, invoker: Arc<ChannelInvoker>) -> Self {
        let name = format!("upstream:{channel_id}");
        Self {
            name,
            channel_id,
            invoker,
        }
    }

    pub fn channel_id(&self) -> &str {
        &self.channel_id
    }
}

#[async_trait]
impl OperatorChannel for UpstreamChannel {
    fn name(&self) -> &str {
        &self.name
    }

    async fn notify(
        &self,
        recipient: &Recipient,
        payload: &Notification,
    ) -> Result<NotificationId> {
        let recipient_str = match recipient {
            Recipient::Address(s) => s.clone(),
            Recipient::SessionId(s) => {
                // SessionId is the dashboard's recipient shape. If a caller
                // accidentally hands it here, fall through to using the
                // string verbatim — upstream's CLI will reject it with a
                // medium-specific error and the operator will see why.
                tracing::warn!(
                    channel_id = %self.channel_id,
                    "klodi_zeroclaw_upstream_unexpected_session_id_recipient"
                );
                s.clone()
            }
            Recipient::AutoActiveSession => bail!(
                "UpstreamChannel can only deliver to a fixed Address recipient; got AutoActiveSession"
            ),
        };

        let correlation_id = payload
            .correlation_id
            .clone()
            .unwrap_or_else(short_token);
        let rendered = render_payload(payload, &correlation_id);

        self.invoker
            .send(&self.channel_id, &recipient_str, &rendered)
            .await?;
        tracing::info!(
            channel_id = %self.channel_id,
            recipient = %recipient_str,
            correlation_id = %correlation_id,
            event_kind = %payload.event_kind,
            "klodi_zeroclaw_upstream_notified"
        );
        Ok(NotificationId(correlation_id))
    }
}

/// Render a notification for upstream delivery — plain text with the
/// correlation header. Per-channel rendering happens at the upstream
/// layer (Slack mrkdwn, Telegram MarkdownV2, plain SMS, voice-call
/// TTS, …); we keep the payload boring so it survives any medium.
pub fn render_payload(payload: &Notification, correlation_id: &str) -> String {
    let mut out = format!(
        "[klodi req={correlation_id}] {event}: {summary}",
        correlation_id = correlation_id,
        event = payload.event_kind,
        summary = payload.summary,
    );
    if let Some(details) = &payload.details {
        out.push('\n');
        out.push_str(details);
    }
    if let Some(structured) = &payload.structured {
        // Plain text — no fenced JSON. Some upstream channels (SMS,
        // voice) would render the markdown literally. Inline the
        // structured payload as a one-line summary.
        out.push_str("\nDetails: ");
        out.push_str(&structured.to_string());
    }
    out.push_str("\nConfirmation must be released from your klodi dashboard or dedicated klodi session.");
    out
}

fn short_token() -> String {
    Uuid::new_v4().simple().to_string().chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::invoker::FakeOutcome;
    use super::super::Severity;

    fn fake_invoker(outcome: FakeOutcome) -> (Arc<ChannelInvoker>, Arc<tokio::sync::Mutex<Vec<(String, String, String)>>>) {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let invoker = Arc::new(ChannelInvoker::Fake {
            captured: captured.clone(),
            outcome,
        });
        (invoker, captured)
    }

    fn fixture() -> Notification {
        Notification {
            event_kind: "transaction.completed".into(),
            summary: "Escrow released for tx_abc".into(),
            details: Some("Amount: €600".into()),
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("req-1".into()),
            reply_hint: None,
        }
    }

    #[tokio::test]
    async fn notify_invokes_shell_with_channel_recipient_and_rendered_payload() {
        let (invoker, captured) = fake_invoker(FakeOutcome::Ok);
        let ch = UpstreamChannel::new("telegram".into(), invoker);
        let id = ch
            .notify(&Recipient::Address("12345".into()), &fixture())
            .await
            .unwrap();
        assert_eq!(id.as_str(), "req-1");
        let g = captured.lock().await;
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].0, "telegram");
        assert_eq!(g[0].1, "12345");
        assert!(g[0].2.contains("[klodi req=req-1]"));
        assert!(g[0].2.contains("transaction.completed"));
        assert!(g[0].2.contains("Escrow released for tx_abc"));
        assert!(g[0].2.contains("Amount: €600"));
        assert!(g[0].2.contains("klodi dashboard"));
    }

    #[tokio::test]
    async fn notify_rejects_auto_active_session_recipient() {
        let (invoker, _captured) = fake_invoker(FakeOutcome::Ok);
        let ch = UpstreamChannel::new("telegram".into(), invoker);
        let err = ch
            .notify(&Recipient::AutoActiveSession, &fixture())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("AutoActiveSession"), "got: {err}");
    }

    #[tokio::test]
    async fn notify_returns_minted_token_when_correlation_id_missing() {
        let (invoker, captured) = fake_invoker(FakeOutcome::Ok);
        let ch = UpstreamChannel::new("slack".into(), invoker);
        let mut n = fixture();
        n.correlation_id = None;
        let id = ch
            .notify(&Recipient::Address("#alerts".into()), &n)
            .await
            .unwrap();
        assert_eq!(id.as_str().len(), 8);
        let g = captured.lock().await;
        assert!(g[0].2.contains(&format!("[klodi req={}]", id.as_str())));
    }

    #[tokio::test]
    async fn notify_surfaces_invoker_error() {
        let (invoker, _captured) =
            fake_invoker(FakeOutcome::Err("upstream rate-limited".into()));
        let ch = UpstreamChannel::new("telegram".into(), invoker);
        let err = ch
            .notify(&Recipient::Address("1".into()), &fixture())
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("upstream rate-limited"), "got: {err}");
    }

    #[test]
    fn render_payload_omits_dashboard_specific_reply_hint() {
        // Upstream payload must NOT prompt the operator with a
        // dashboard-specific `/klodi …` reply syntax — explicit
        // sentence about confirmation channel only.
        let rendered = render_payload(&fixture(), "tok-1");
        assert!(!rendered.contains("/klodi yes"));
        assert!(rendered.contains("klodi dashboard or dedicated klodi session"));
    }

    #[test]
    fn render_payload_summarises_structured_inline() {
        let mut n = fixture();
        n.structured = Some(serde_json::json!({ "tx": "abc", "amount_cents": 60000 }));
        let rendered = render_payload(&n, "tok-1");
        assert!(rendered.contains("Details:"));
        assert!(rendered.contains("\"tx\""));
        assert!(rendered.contains("60000"));
        // Plain text — no fenced code blocks (would render literally
        // on SMS / voice channels).
        assert!(!rendered.contains("```"));
    }
}
