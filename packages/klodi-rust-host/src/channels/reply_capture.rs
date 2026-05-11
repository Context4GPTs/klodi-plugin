//! Persist inbound operator replies so the approval gate can read
//! them across MCP-server invocations. Implements the cross-process
//! reply attribution half of the approval gate.
//!
//! The daemon subscribes to the channel registry's reply stream and
//! writes one `.reply.json` file per matched `correlation_id`. The
//! MCP server's approval gate, on agent retry, checks for the file
//! when no explicit `_klodi_approval_operator_text` was supplied —
//! this lets a reply on the dashboard release a gate the agent is
//! polling from the dedicated klodi session.
//!
//! File path: `${KLODI_HOME}/approvals/<request_id>.reply.json`.
//! Atomic, mode 0600. First-write-wins per request_id (subsequent
//! replies are logged but don't overwrite — the approval gate's
//! "first matching reply wins" guarantee holds across surfaces).

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use klodi_nats_client::klodi_secret_write;
use serde::{Deserialize, Serialize};

/// Path of the per-approval reply file under `${KLODI_HOME}/approvals/`.
pub fn reply_path(klodi_home: &Path, request_id: &str) -> PathBuf {
    crate::zeroclaw_approval::approvals_dir(klodi_home)
        .join(format!("{request_id}.reply.json"))
}

/// On-disk reply record. Persisted by the daemon's reply-attribution
/// task; consumed by the MCP server's approval gate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedReply {
    pub text: String,
    pub channel_name: String,
    pub origin: String,
    pub received_at_unix_seconds: i64,
}

/// Persist a reply for `request_id`. First-write-wins — if a reply
/// file already exists for this id, returns `Ok(false)` and the
/// existing file is preserved. Otherwise writes atomically and
/// returns `Ok(true)`.
pub fn persist_reply(
    klodi_home: &Path,
    request_id: &str,
    reply: &PersistedReply,
) -> Result<bool> {
    let path = reply_path(klodi_home, request_id);
    if path.exists() {
        return Ok(false);
    }
    let dir = crate::zeroclaw_approval::approvals_dir(klodi_home);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    let body = serde_json::to_vec_pretty(reply).context("encoding reply")?;
    klodi_secret_write(&path, &body, 0o600)
        .with_context(|| format!("klodi_secret_write {}", path.display()))?;
    Ok(true)
}

/// Read a persisted reply for `request_id`. Returns `Ok(None)` when
/// no reply has been captured yet.
pub fn load_reply(
    klodi_home: &Path,
    request_id: &str,
) -> Result<Option<PersistedReply>> {
    let path = reply_path(klodi_home, request_id);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    if raw.is_empty() {
        return Ok(None);
    }
    let parsed: PersistedReply = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(parsed))
}

/// Remove a persisted reply file — called once the approval gate has
/// consumed the reply and resolved the gate.
pub fn clear_reply(klodi_home: &Path, request_id: &str) -> Result<()> {
    let path = reply_path(klodi_home, request_id);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path)
        .with_context(|| format!("removing {}", path.display()))
}

/// Current wall-clock epoch seconds — matches the format
/// `zeroclaw_approval::PendingApproval` uses.
pub fn now_unix_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn persist_and_load_round_trip() {
        let dir = tempdir().unwrap();
        let reply = PersistedReply {
            text: "yes please".into(),
            channel_name: "dashboard".into(),
            origin: "session-X".into(),
            received_at_unix_seconds: 42,
        };
        let wrote = persist_reply(dir.path(), "req-1", &reply).unwrap();
        assert!(wrote);
        let loaded = load_reply(dir.path(), "req-1").unwrap().unwrap();
        assert_eq!(loaded, reply);
    }

    #[test]
    fn persist_is_first_write_wins() {
        let dir = tempdir().unwrap();
        let first = PersistedReply {
            text: "yes".into(),
            channel_name: "dashboard".into(),
            origin: "session-X".into(),
            received_at_unix_seconds: 1,
        };
        let second = PersistedReply {
            text: "no".into(),
            channel_name: "upstream:telegram".into(),
            origin: "123".into(),
            received_at_unix_seconds: 2,
        };
        assert!(persist_reply(dir.path(), "req-1", &first).unwrap());
        assert!(!persist_reply(dir.path(), "req-1", &second).unwrap());
        let loaded = load_reply(dir.path(), "req-1").unwrap().unwrap();
        assert_eq!(loaded.text, "yes");
    }

    #[test]
    fn load_returns_none_for_unknown_id() {
        let dir = tempdir().unwrap();
        assert!(load_reply(dir.path(), "no-such-id").unwrap().is_none());
    }

    #[test]
    fn clear_removes_persisted_reply() {
        let dir = tempdir().unwrap();
        let reply = PersistedReply {
            text: "yes".into(),
            channel_name: "dashboard".into(),
            origin: "x".into(),
            received_at_unix_seconds: 1,
        };
        persist_reply(dir.path(), "req-1", &reply).unwrap();
        clear_reply(dir.path(), "req-1").unwrap();
        assert!(load_reply(dir.path(), "req-1").unwrap().is_none());
    }
}
