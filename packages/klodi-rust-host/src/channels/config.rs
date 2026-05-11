//! `${KLODI_HOME}/klodi.toml` `[notifications]` block — operator-side
//! channel wiring. Implements plan §I-11.
//!
//! Missing file = defaults. Missing `[notifications]` table = defaults.
//! Per-channel field omissions = field defaults. The point is that an
//! operator who never touches `klodi.toml` gets the same out-of-the-box
//! behaviour as v0.2.7 plus the new dashboard channel.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::Severity;

/// Special recipient string meaning "T3 auto-active-session" for the
/// dashboard channel. Exposed as a constant so the daemon and the
/// channel impl agree on the literal value.
pub const RECIPIENT_AUTO_ACTIVE: &str = "auto";

/// Top-level on-disk schema. Only `[notifications]` lands in 0.3.0;
/// future tables can land here without touching the channel surface.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(default)]
pub struct KlodiToml {
    pub notifications: NotificationsConfig,
}

/// `[notifications]` table. Holds the dashboard config + the list of
/// upstream channels.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct NotificationsConfig {
    pub dashboard: DashboardChannelConfig,
    /// Upstream channels — `[[notifications.upstream]]` array of tables.
    pub upstream: Vec<UpstreamChannelConfig>,
    /// Dedicated klodi session config — separate from the dashboard
    /// because its severity floor + filter are independent. Default
    /// = "fan everything out", which preserves the v0.2.7 behaviour.
    pub dedicated_session: DedicatedSessionConfig,
    /// I-8 batching window — when more than one notification of the
    /// same `event_kind` lands within this window, subsequent ones
    /// are dropped on the dashboard + upstream surfaces. The
    /// dedicated klodi session still sees every event (its floor is
    /// `diagnostic`). `ApprovalRequest`-severity events bypass
    /// batching unconditionally. Default 5s. Set to `0` to disable
    /// batching entirely.
    pub batch_window_seconds: u64,
}

impl Default for NotificationsConfig {
    fn default() -> Self {
        Self {
            dashboard: DashboardChannelConfig::default(),
            upstream: vec![],
            dedicated_session: DedicatedSessionConfig::default(),
            batch_window_seconds: 5,
        }
    }
}

/// Dashboard channel config — defaults shown.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct DashboardChannelConfig {
    /// Toggle the dashboard channel entirely. `false` = v0.2.7
    /// single-surface behaviour (dedicated session only).
    pub enabled: bool,
    /// `"auto"` = T3 active-session resolution. Any other value is
    /// treated as a pinned session UUID.
    pub recipient: String,
    /// Severity floor for the dashboard channel. Defaults to
    /// `operator_important` per plan §I-7 — routine activity stays in
    /// the dedicated session.
    pub severity_floor: String,
    /// Optional event-kind allowlist. Empty = "all events at the
    /// severity floor or higher."
    #[serde(default)]
    pub events: Vec<String>,
}

impl Default for DashboardChannelConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            recipient: RECIPIENT_AUTO_ACTIVE.into(),
            severity_floor: Severity::OperatorImportant.as_str().to_string(),
            events: vec![],
        }
    }
}

/// Single `[[notifications.upstream]]` entry. `channel_id` matches a
/// configured channel in `zeroclaw channel list`; `recipient` is the
/// channel-specific destination.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct UpstreamChannelConfig {
    pub channel_id: String,
    pub recipient: String,
    #[serde(default = "default_upstream_severity_floor")]
    pub severity_floor: String,
    #[serde(default)]
    pub events: Vec<String>,
}

fn default_upstream_severity_floor() -> String {
    Severity::OperatorImportant.as_str().to_string()
}

/// Dedicated klodi session — same shape as dashboard but with
/// "everything goes here" defaults.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct DedicatedSessionConfig {
    pub enabled: bool,
    pub severity_floor: String,
    #[serde(default)]
    pub events: Vec<String>,
}

impl Default for DedicatedSessionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            severity_floor: Severity::Diagnostic.as_str().to_string(),
            events: vec![],
        }
    }
}

impl NotificationsConfig {
    /// Load `${KLODI_HOME}/klodi.toml`. Missing file = defaults; parse
    /// errors propagate (we don't want to silently misread an operator
    /// edit and ship notifications to the wrong place).
    pub fn load(klodi_home: &Path) -> Result<Self> {
        let path = config_path(klodi_home);
        Self::load_from(&path)
    }

    pub fn load_from(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading {}", path.display()))?;
        let parsed: KlodiToml = toml::from_str(&raw)
            .with_context(|| format!("parsing {} as klodi.toml", path.display()))?;
        Ok(parsed.notifications)
    }

    /// Resolve the dashboard channel's severity floor, defaulting if
    /// the operator wrote an unknown string.
    pub fn dashboard_severity_floor(&self) -> Severity {
        Severity::from_str_canonical(&self.dashboard.severity_floor)
            .unwrap_or_else(|| {
                tracing::warn!(
                    value = %self.dashboard.severity_floor,
                    "klodi_zeroclaw_dashboard_unknown_severity_floor_falling_back"
                );
                Severity::OperatorImportant
            })
    }

    /// Resolve the dedicated session's severity floor.
    pub fn dedicated_session_severity_floor(&self) -> Severity {
        Severity::from_str_canonical(&self.dedicated_session.severity_floor)
            .unwrap_or_else(|| {
                tracing::warn!(
                    value = %self.dedicated_session.severity_floor,
                    "klodi_zeroclaw_dedicated_session_unknown_severity_floor_falling_back"
                );
                Severity::Diagnostic
            })
    }
}

impl UpstreamChannelConfig {
    /// Resolve this upstream entry's severity floor.
    pub fn resolve_severity_floor(&self) -> Severity {
        Severity::from_str_canonical(&self.severity_floor).unwrap_or_else(|| {
            tracing::warn!(
                channel_id = %self.channel_id,
                value = %self.severity_floor,
                "klodi_zeroclaw_upstream_unknown_severity_floor_falling_back"
            );
            Severity::OperatorImportant
        })
    }
}

/// `${KLODI_HOME}/klodi.toml`
pub fn config_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("klodi.toml")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn defaults_match_v0_2_7_dashboard_enabled() {
        let cfg = NotificationsConfig::default();
        assert!(cfg.dashboard.enabled);
        assert_eq!(cfg.dashboard.recipient, RECIPIENT_AUTO_ACTIVE);
        assert_eq!(cfg.dashboard_severity_floor(), Severity::OperatorImportant);
        assert!(cfg.upstream.is_empty());
        assert!(cfg.dedicated_session.enabled);
        assert_eq!(
            cfg.dedicated_session_severity_floor(),
            Severity::Diagnostic,
        );
    }

    #[test]
    fn missing_file_yields_defaults() {
        let dir = tempdir().unwrap();
        let cfg = NotificationsConfig::load(dir.path()).unwrap();
        assert!(cfg.dashboard.enabled);
    }

    #[test]
    fn empty_notifications_table_yields_defaults() {
        let dir = tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(&path, "[notifications]\n").unwrap();
        let cfg = NotificationsConfig::load_from(&path).unwrap();
        assert!(cfg.dashboard.enabled);
    }

    #[test]
    fn partial_dashboard_table_keeps_other_defaults() {
        let dir = tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(
            &path,
            r#"
[notifications]

[notifications.dashboard]
recipient = "abc-uuid"
"#,
        )
        .unwrap();
        let cfg = NotificationsConfig::load_from(&path).unwrap();
        assert_eq!(cfg.dashboard.recipient, "abc-uuid");
        assert!(cfg.dashboard.enabled);
        assert_eq!(cfg.dashboard_severity_floor(), Severity::OperatorImportant);
    }

    #[test]
    fn upstream_block_round_trips() {
        let dir = tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(
            &path,
            r##"
[notifications]

[[notifications.upstream]]
channel_id = "telegram"
recipient = "123456789"
severity_floor = "approval_request"

[[notifications.upstream]]
channel_id = "slack"
recipient = "#klodi-alerts"
events = ["transaction.completed"]
"##,
        )
        .unwrap();
        let cfg = NotificationsConfig::load_from(&path).unwrap();
        assert_eq!(cfg.upstream.len(), 2);
        assert_eq!(cfg.upstream[0].channel_id, "telegram");
        assert_eq!(cfg.upstream[0].recipient, "123456789");
        assert_eq!(
            cfg.upstream[0].resolve_severity_floor(),
            Severity::ApprovalRequest,
        );
        assert_eq!(cfg.upstream[1].channel_id, "slack");
        assert_eq!(cfg.upstream[1].recipient, "#klodi-alerts");
        assert_eq!(
            cfg.upstream[1].resolve_severity_floor(),
            Severity::OperatorImportant,
        );
        assert_eq!(cfg.upstream[1].events, vec!["transaction.completed"]);
    }

    #[test]
    fn unknown_severity_falls_back_to_default() {
        let dir = tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(
            &path,
            r#"
[notifications]

[notifications.dashboard]
severity_floor = "loud"
"#,
        )
        .unwrap();
        let cfg = NotificationsConfig::load_from(&path).unwrap();
        assert_eq!(cfg.dashboard_severity_floor(), Severity::OperatorImportant);
    }

    #[test]
    fn parse_failure_surfaces_as_error_not_silent_default() {
        let dir = tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(&path, "not[valid]toml{").unwrap();
        let err = NotificationsConfig::load_from(&path).unwrap_err().to_string();
        assert!(
            err.contains("parsing") || err.contains("klodi.toml"),
            "got: {err}"
        );
    }
}
