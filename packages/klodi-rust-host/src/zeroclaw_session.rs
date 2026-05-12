//! Persisted ZeroClaw operator-session id under
//! `${KLODI_HOME}/zeroclaw.session`.
//!
//! `register` mints the session via WS at registration time and writes
//! the id here; the daemon reads it on every wake so it can include
//! `{operator_session_id}` in the wake prompt the spawned agent uses to
//! decide who to write back to (`sessions_send`).

use anyhow::{Context, Result, bail};
use klodi_nats_client::klodi_secret_write;
use std::path::{Path, PathBuf};

/// `${KLODI_HOME}/zeroclaw.session` — the persisted operator-session UUID.
pub fn session_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("zeroclaw.session")
}

/// Read the persisted session id, trimming trailing whitespace. Returns
/// `Ok(None)` when the file is absent or holds only whitespace.
pub fn read_session_id(klodi_home: &Path) -> Result<Option<String>> {
    let path = session_path(klodi_home);
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

/// Write `session_id` atomically at mode 0600. Refuses to persist an
/// empty value.
pub fn persist_session_id(klodi_home: &Path, session_id: &str) -> Result<()> {
    if session_id.is_empty() {
        bail!(
            "refusing to persist empty session id at {}",
            session_path(klodi_home).display(),
        );
    }
    std::fs::create_dir_all(klodi_home)
        .with_context(|| format!("creating {}", klodi_home.display()))?;
    let path = session_path(klodi_home);
    klodi_secret_write(&path, session_id.as_bytes(), 0o600)
        .with_context(|| format!("klodi_secret_write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn session_path_lives_under_klodi_home() {
        let dir = tempdir().unwrap();
        assert_eq!(
            session_path(dir.path()),
            dir.path().join("zeroclaw.session"),
        );
    }

    #[test]
    fn read_session_id_returns_none_when_absent() {
        let dir = tempdir().unwrap();
        assert!(read_session_id(dir.path()).unwrap().is_none());
    }

    #[test]
    fn read_session_id_treats_whitespace_as_absent() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("zeroclaw.session"), "   \n\t  \n").unwrap();
        assert!(read_session_id(dir.path()).unwrap().is_none());
    }

    #[test]
    fn persist_and_read_round_trip() {
        let dir = tempdir().unwrap();
        persist_session_id(dir.path(), "session-uuid-1").unwrap();
        assert_eq!(
            read_session_id(dir.path()).unwrap().as_deref(),
            Some("session-uuid-1"),
        );
    }

    #[test]
    fn persist_rejects_empty() {
        let dir = tempdir().unwrap();
        assert!(persist_session_id(dir.path(), "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn persist_writes_mode_0600() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        persist_session_id(dir.path(), "abc").unwrap();
        let mode = std::fs::metadata(dir.path().join("zeroclaw.session"))
            .unwrap()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 mode, got {mode:o}");
    }

    #[test]
    fn persist_overwrites_existing() {
        let dir = tempdir().unwrap();
        persist_session_id(dir.path(), "first").unwrap();
        persist_session_id(dir.path(), "second").unwrap();
        assert_eq!(
            read_session_id(dir.path()).unwrap().as_deref(),
            Some("second"),
        );
    }
}
