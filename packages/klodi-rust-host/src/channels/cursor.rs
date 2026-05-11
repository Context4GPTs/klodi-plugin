//! `${KLODI_HOME}/zeroclaw.dispatcher_cursor.json` — last-processed
//! message index per dashboard session. Implements the persistence
//! half of the dashboard reply bridge.
//!
//! The Phase 2 reply bridge polls `/api/sessions/<id>/messages` past
//! the per-session cursor at a 1.5s cadence, advancing the cursor for
//! every message it observes. On daemon restart we read the cursor
//! back so the bridge doesn't re-process already-handled messages — at
//! worst it re-processes the most recent message if the dispatcher
//! crashed mid-write, which is acceptable: the approval gate's
//! persisted state is idempotent and the agent already handles
//! duplicate user-replies gracefully.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use klodi_nats_client::klodi_secret_write;
use tokio::sync::RwLock;

/// On-disk + in-memory cursor.
pub struct DispatcherCursor {
    path: PathBuf,
    inner: Arc<RwLock<HashMap<String, u64>>>,
}

impl DispatcherCursor {
    /// Open (or create) the cursor at `path`.
    pub fn open(path: PathBuf) -> Result<Self> {
        let existing = load_from_disk(&path)?;
        Ok(Self {
            path,
            inner: Arc::new(RwLock::new(existing)),
        })
    }

    /// Read the cursor for `session_id`. Returns `0` when the session
    /// has never been processed.
    pub async fn get(&self, session_id: &str) -> u64 {
        self.inner
            .read()
            .await
            .get(session_id)
            .copied()
            .unwrap_or(0)
    }

    /// Advance the cursor for `session_id` to at least `index`. Lower
    /// values are ignored (cursor only moves forward). Persists
    /// through to disk on every advance.
    pub async fn advance(&self, session_id: &str, index: u64) {
        let changed = {
            let mut guard = self.inner.write().await;
            let entry = guard.entry(session_id.to_string()).or_insert(0);
            if index > *entry {
                *entry = index;
                true
            } else {
                false
            }
        };
        if changed {
            if let Err(err) = self.persist().await {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_dispatcher_cursor_persist_failed"
                );
            }
        }
    }

    /// Snapshot — read-only view for tests.
    pub async fn snapshot(&self) -> HashMap<String, u64> {
        self.inner.read().await.clone()
    }

    async fn persist(&self) -> Result<()> {
        let snapshot = self.inner.read().await.clone();
        let body = serde_json::to_vec_pretty(&snapshot)
            .context("encoding dispatcher cursor")?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        klodi_secret_write(&self.path, &body, 0o600)
            .with_context(|| format!("klodi_secret_write {}", self.path.display()))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn load_from_disk(path: &Path) -> Result<HashMap<String, u64>> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = std::fs::read(path)
        .with_context(|| format!("reading {}", path.display()))?;
    if raw.is_empty() {
        return Ok(HashMap::new());
    }
    let map: HashMap<String, u64> = serde_json::from_slice(&raw)
        .with_context(|| format!("parsing {} as JSON map", path.display()))?;
    Ok(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn get_returns_zero_for_unknown_session() {
        let dir = tempdir().unwrap();
        let cur = DispatcherCursor::open(dir.path().join("cur.json")).unwrap();
        assert_eq!(cur.get("session-1").await, 0);
    }

    #[tokio::test]
    async fn advance_moves_forward_only() {
        let dir = tempdir().unwrap();
        let cur = DispatcherCursor::open(dir.path().join("cur.json")).unwrap();
        cur.advance("s", 5).await;
        cur.advance("s", 3).await;
        assert_eq!(cur.get("s").await, 5);
        cur.advance("s", 10).await;
        assert_eq!(cur.get("s").await, 10);
    }

    #[tokio::test]
    async fn cursor_persists_across_reopen() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cur.json");
        {
            let cur = DispatcherCursor::open(path.clone()).unwrap();
            cur.advance("s-1", 42).await;
            cur.advance("s-2", 7).await;
        }
        let reopened = DispatcherCursor::open(path).unwrap();
        let snap = reopened.snapshot().await;
        assert_eq!(snap.get("s-1").copied(), Some(42));
        assert_eq!(snap.get("s-2").copied(), Some(7));
    }
}
