//! `${KLODI_HOME}/zeroclaw.created_sessions` — JSON list of session ids
//! the daemon has ever written to. Implements I-5 of the channels plan.
//!
//! The T3 active-session heuristic uses this to skip klodi-owned
//! sessions (the dedicated klodi session, plus any sessions the
//! dashboard channel posted into) when picking "where activity is right
//! now." Without it, a fresh notification would land in the very
//! session klodi just opened — which the T1-T5 probes confirm is silent
//! re-creation territory.
//!
//! Storage shape: a JSON array of strings persisted atomically with
//! `klodi_secret_write`. The file may not exist (first boot); a missing
//! file is treated as an empty ledger.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use klodi_nats_client::klodi_secret_write;
use tokio::sync::RwLock;

/// On-disk + in-memory created-sessions ledger.
pub struct CreatedSessionsLedger {
    path: PathBuf,
    inner: Arc<RwLock<HashSet<String>>>,
}

impl CreatedSessionsLedger {
    /// Open (or create) the ledger at `path`. Reads existing contents
    /// into memory; subsequent `record` calls write through.
    pub fn open(path: PathBuf) -> Result<Self> {
        let existing = load_from_disk(&path)?;
        Ok(Self {
            path,
            inner: Arc::new(RwLock::new(existing)),
        })
    }

    /// Async membership check — `true` if `session_id` has been
    /// recorded in this ledger.
    pub async fn contains(&self, session_id: &str) -> bool {
        let guard = self.inner.read().await;
        guard.contains(session_id)
    }

    /// Record a session id as klodi-owned, persisting through to disk.
    /// Idempotent — repeated records are no-ops.
    pub async fn record(&self, session_id: &str) {
        {
            let mut guard = self.inner.write().await;
            if !guard.insert(session_id.to_string()) {
                return;
            }
        }
        if let Err(err) = self.persist().await {
            tracing::warn!(
                error = %format!("{err:#}"),
                "klodi_zeroclaw_dashboard_ledger_persist_failed"
            );
        }
    }

    /// Snapshot of the recorded session ids — read-only view for tests
    /// and the resurrection detector.
    pub async fn snapshot(&self) -> HashSet<String> {
        self.inner.read().await.clone()
    }

    async fn persist(&self) -> Result<()> {
        let snapshot: Vec<String> = {
            let guard = self.inner.read().await;
            let mut v: Vec<String> = guard.iter().cloned().collect();
            // Sort for determinism — same input → same bytes → easier
            // to inspect by hand and easier to diff under version
            // control if an operator backs up `${KLODI_HOME}`.
            v.sort();
            v
        };
        let body = serde_json::to_vec_pretty(&snapshot)
            .context("encoding created-sessions ledger")?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        klodi_secret_write(&self.path, &body, 0o600)
            .with_context(|| format!("klodi_secret_write {}", self.path.display()))
    }

    /// Path of the on-disk ledger file.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn load_from_disk(path: &Path) -> Result<HashSet<String>> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let raw = std::fs::read(path)
        .with_context(|| format!("reading {}", path.display()))?;
    if raw.is_empty() {
        return Ok(HashSet::new());
    }
    let list: Vec<String> = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing {} as JSON list", path.display()))?;
    Ok(list.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn open_creates_empty_ledger_when_file_missing() {
        let dir = tempdir().unwrap();
        let ledger =
            CreatedSessionsLedger::open(dir.path().join("ledger.json")).unwrap();
        assert!(ledger.snapshot().await.is_empty());
    }

    #[tokio::test]
    async fn record_persists_through_to_disk_and_reload_preserves() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        {
            let ledger = CreatedSessionsLedger::open(path.clone()).unwrap();
            ledger.record("session-1").await;
            ledger.record("session-2").await;
        }
        let reopened = CreatedSessionsLedger::open(path).unwrap();
        let snap = reopened.snapshot().await;
        assert!(snap.contains("session-1"));
        assert!(snap.contains("session-2"));
    }

    #[tokio::test]
    async fn record_is_idempotent() {
        let dir = tempdir().unwrap();
        let ledger =
            CreatedSessionsLedger::open(dir.path().join("ledger.json")).unwrap();
        ledger.record("session-1").await;
        ledger.record("session-1").await;
        ledger.record("session-1").await;
        let snap = ledger.snapshot().await;
        assert_eq!(snap.len(), 1);
    }

    #[tokio::test]
    async fn contains_round_trips() {
        let dir = tempdir().unwrap();
        let ledger =
            CreatedSessionsLedger::open(dir.path().join("ledger.json")).unwrap();
        assert!(!ledger.contains("session-1").await);
        ledger.record("session-1").await;
        assert!(ledger.contains("session-1").await);
    }

    #[tokio::test]
    async fn load_treats_empty_file_as_empty_ledger() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("ledger.json");
        std::fs::write(&path, b"").unwrap();
        let ledger = CreatedSessionsLedger::open(path).unwrap();
        assert!(ledger.snapshot().await.is_empty());
    }
}
