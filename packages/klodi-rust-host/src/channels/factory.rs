//! Shared builder for the channel registry.
//!
//! Both `klodi-zeroclaw-daemon` and `klodi-zeroclaw-mcp` need to
//! construct the same registry shape (dedicated klodi session + the
//! configured dashboard channel + zero or more upstream channels).
//! Sharing the builder here keeps the two binaries in lockstep —
//! changes to channel wiring only need to land in one place.
//!
//! The daemon additionally subscribes to `registry.replies()` and
//! captures inbound replies via `reply_capture` (Phase 5) so the
//! approval gate can pick them up across MCP-server invocations. The
//! MCP server only calls `notify()` on its registry — its dashboard
//! channel's poll task therefore never spawns, avoiding a duplicate
//! poll loop against the gateway.

use std::sync::Arc;

use anyhow::{Context, Result};

use crate::zeroclaw_ws::ZeroClawWsConfig;

use super::config::{NotificationsConfig, RECIPIENT_AUTO_ACTIVE};
use super::cursor::DispatcherCursor;
use super::dashboard::DashboardChannel;
use super::dedicated_session::DedicatedSessionChannel;
use super::invoker::ChannelInvoker;
use super::ledger::CreatedSessionsLedger;
use super::registry::{ChannelRegistry, RegisteredChannel};
use super::upstream::{UpstreamChannel, fetch_configured_channel_ids};
use super::Recipient;

/// Dedicated klodi-session binding. Built by callers from the
/// persisted `${KLODI_HOME}/zeroclaw.{token,session}` files.
#[derive(Clone)]
pub struct SessionBinding {
    pub ws_config: ZeroClawWsConfig,
    pub session_id: String,
}

/// Construct a `ChannelRegistry` from `${KLODI_HOME}/klodi.toml` plus
/// a dedicated klodi-session binding. Validates upstream channel ids
/// against `GET /api/channels` — channels that aren't
/// registered upstream are dropped with a warn-level log, the daemon
/// still boots.
///
/// Returns the registry plus the resolved [`NotificationsConfig`] so
/// callers (especially the daemon) can surface the same defaults to
/// their bootstrap-note copy.
pub async fn build_channel_registry(
    klodi_home: &std::path::Path,
    binding: &SessionBinding,
    zeroclaw_cli: &std::path::Path,
) -> Result<(ChannelRegistry, NotificationsConfig)> {
    let cfg = NotificationsConfig::load(klodi_home).with_context(|| {
        format!(
            "loading {}",
            super::config::config_path(klodi_home).display()
        )
    })?;

    let mut registered: Vec<RegisteredChannel> = Vec::with_capacity(4);

    if cfg.dedicated_session.enabled {
        let dedicated = DedicatedSessionChannel::new(
            binding.ws_config.clone(),
            binding.session_id.clone(),
        );
        let floor = cfg.dedicated_session_severity_floor();
        registered.push(RegisteredChannel {
            impl_: Arc::new(dedicated),
            recipient: Recipient::Address(binding.session_id.clone()),
            severity_floor: floor,
            event_filter: cfg.dedicated_session.events.clone(),
        });
    }

    if cfg.dashboard.enabled {
        match build_dashboard_channel(klodi_home, binding, &cfg).await {
            Ok(channel) => registered.push(channel),
            Err(err) => {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_dashboard_channel_build_failed_skipping"
                );
            }
        }
    }

    let configured_upstream: Option<std::collections::HashSet<String>> =
        if cfg.upstream.is_empty() {
            None
        } else {
            match fetch_configured_channel_ids(&binding.ws_config).await {
                Ok(ids) => Some(ids.into_iter().collect()),
                Err(err) => {
                    tracing::warn!(
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_upstream_channels_listing_unavailable_skipping_validation"
                    );
                    None
                }
            }
        };

    for upstream_cfg in &cfg.upstream {
        if let Some(set) = configured_upstream.as_ref() {
            if !set.contains(&upstream_cfg.channel_id) {
                tracing::warn!(
                    channel_id = %upstream_cfg.channel_id,
                    recipient = %upstream_cfg.recipient,
                    "klodi_zeroclaw_upstream_channel_unknown"
                );
                continue;
            }
        }
        let invoker = Arc::new(ChannelInvoker::shell(
            zeroclaw_cli.to_path_buf(),
            super::invoker::DEFAULT_SHELL_TIMEOUT,
        ));
        let upstream =
            UpstreamChannel::new(upstream_cfg.channel_id.clone(), invoker);
        let floor = upstream_cfg.resolve_severity_floor();
        registered.push(RegisteredChannel {
            impl_: Arc::new(upstream),
            recipient: Recipient::Address(upstream_cfg.recipient.clone()),
            severity_floor: floor,
            event_filter: upstream_cfg.events.clone(),
        });
    }

    let registry = if cfg.batch_window_seconds == 0 {
        ChannelRegistry::new(registered)
    } else {
        ChannelRegistry::new_with_batching(
            registered,
            std::time::Duration::from_secs(cfg.batch_window_seconds),
        )
    };
    Ok((registry, cfg))
}

async fn build_dashboard_channel(
    klodi_home: &std::path::Path,
    binding: &SessionBinding,
    cfg: &NotificationsConfig,
) -> Result<RegisteredChannel> {
    let ledger_path = klodi_home.join("zeroclaw.created_sessions");
    let ledger = Arc::new(
        CreatedSessionsLedger::open(ledger_path)
            .context("opening created-sessions ledger")?,
    );
    ledger.record(&binding.session_id).await;

    let cursor_path = klodi_home.join("zeroclaw.dispatcher_cursor.json");
    // Touch the cursor at construction time — the dashboard channel
    // opens it again internally; opening twice is fine (each owns its
    // own in-memory copy, both flush to the same path).
    let _ = DispatcherCursor::open(cursor_path.clone())
        .context("opening dispatcher cursor")?;
    let channel = DashboardChannel::new(
        binding.ws_config.clone(),
        ledger,
        cursor_path,
    )
    .context("constructing DashboardChannel")?;

    let recipient = match cfg.dashboard.recipient.as_str() {
        RECIPIENT_AUTO_ACTIVE => Recipient::AutoActiveSession,
        other => Recipient::SessionId(other.to_string()),
    };
    let floor = cfg.dashboard_severity_floor();
    Ok(RegisteredChannel {
        impl_: Arc::new(channel),
        recipient,
        severity_floor: floor,
        event_filter: cfg.dashboard.events.clone(),
    })
}
