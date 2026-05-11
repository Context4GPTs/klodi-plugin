//! Session-health probe for the silent-recreation case.
//!
//! `WS /ws/chat?session_id=<id>` against a deleted id silently
//! re-creates the session with the same id and fresh history — no HTTP
//! 404 surfaces. The mitigation is: before writing, check
//! `GET /api/sessions` for both membership AND non-zero
//! `message_count` (when we expected non-zero). If either condition
//! fails, treat as deletion-in-progress, log
//! `klodi_zeroclaw_session_resurrection_detected`, ledger the old id,
//! and post a one-line breadcrumb in the (resurrected) session so the
//! operator sees what happened.

use anyhow::{Context, Result, bail};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;

use crate::zeroclaw_ws::ZeroClawWsConfig;

/// Outcome of a session-health check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionHealth {
    /// Session present in `/api/sessions` with `message_count >= 1`.
    /// `Alive` is the normal-happy-path outcome.
    Alive { message_count: u64 },
    /// Session present but `message_count == 0`. When the caller
    /// expected the session to be non-empty (we wrote into it before),
    /// this signals silent recreation per T5.
    Resurrected { message_count: u64 },
    /// Session absent from `/api/sessions`.
    Missing,
    /// HTTP transport failure — caller chooses whether to proceed
    /// (write anyway) or back off. The probe text is included for
    /// log fields.
    Unknown { error: String },
}

/// Per-session entry as returned by `/api/sessions`. Mirror of
/// `dashboard::DashboardSession` but kept local so this module doesn't
/// depend on the dashboard surface. The gateway returns `session_id`
/// per the wake-routing redesign §6; `alias = "id"` is a defensive
/// fallback in case a legacy/test shape sends `id`.
#[derive(Debug, Deserialize)]
struct HealthSession {
    #[serde(rename = "session_id", alias = "id")]
    id: String,
    #[serde(default)]
    message_count: Option<u64>,
}

/// Check the health of a single session id by querying
/// `GET /api/sessions`. Caller decides what to do with each
/// [`SessionHealth`] outcome.
pub async fn check_session_alive(
    http: &HttpClient,
    ws_config: &ZeroClawWsConfig,
    session_id: &str,
) -> SessionHealth {
    match list_sessions(http, ws_config).await {
        Ok(sessions) => {
            for s in sessions {
                if s.id == session_id {
                    let count = s.message_count.unwrap_or(0);
                    if count == 0 {
                        return SessionHealth::Resurrected {
                            message_count: count,
                        };
                    }
                    return SessionHealth::Alive {
                        message_count: count,
                    };
                }
            }
            SessionHealth::Missing
        }
        Err(err) => SessionHealth::Unknown {
            error: format!("{err:#}"),
        },
    }
}

async fn list_sessions(
    http: &HttpClient,
    ws_config: &ZeroClawWsConfig,
) -> Result<Vec<HealthSession>> {
    let url = format!("{}/api/sessions", ws_config.http_base);
    let resp = http
        .get(&url)
        .bearer_auth(&ws_config.bearer)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        bail!("GET /api/sessions returned {status}");
    }
    let body: Value = resp
        .json()
        .await
        .context("decoding /api/sessions")?;
    let arr = match body {
        Value::Object(ref map) => match map.get("sessions") {
            Some(Value::Array(a)) => a.clone(),
            _ => bail!("/api/sessions: missing `sessions` array"),
        },
        Value::Array(a) => a,
        _ => bail!("/api/sessions: unexpected shape"),
    };
    let mut out = Vec::with_capacity(arr.len());
    for e in arr {
        if let Ok(s) = serde_json::from_value::<HealthSession>(e) {
            out.push(s);
        }
    }
    Ok(out)
}

/// One-line breadcrumb posted in a resurrected dashboard session so
/// the operator can correlate fresh chat with "klodi noticed this
/// session was recreated."
pub fn resurrection_breadcrumb() -> String {
    "🔁 **klodi notice.** This dashboard session was recreated since I last \
     wrote here — the prior history is gone from this session. Future klodi \
     notifications will pick whichever session is currently active. (T5)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resurrection_breadcrumb_carries_operator_context() {
        let s = resurrection_breadcrumb();
        assert!(s.contains("klodi"));
        assert!(s.contains("recreated"));
    }

    /// Regression: gateway emits `session_id` (not `id`). A silent
    /// decode failure here would have made `check_session_alive`
    /// return `Missing` for every live session — causing every
    /// `verify_or_reroute_destination` to mistake healthy sessions
    /// for resurrected ones and rebootstrap noise.
    #[test]
    fn health_session_decodes_gateway_session_id_field() {
        let entry = serde_json::json!({
            "session_id": "abc-123",
            "created_at": "2026-05-11T08:00:00Z",
            "last_activity": "2026-05-11T09:00:00Z",
            "message_count": 7,
        });
        let decoded: HealthSession = serde_json::from_value(entry).unwrap();
        assert_eq!(decoded.id, "abc-123");
        assert_eq!(decoded.message_count, Some(7));
    }

    #[test]
    fn health_session_accepts_legacy_id_alias() {
        let entry = serde_json::json!({
            "id": "legacy-uuid",
            "message_count": 2,
        });
        let decoded: HealthSession = serde_json::from_value(entry).unwrap();
        assert_eq!(decoded.id, "legacy-uuid");
    }
}
