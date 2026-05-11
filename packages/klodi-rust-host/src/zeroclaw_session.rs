//! Persisted ZeroClaw operator-session id under `${KLODI_HOME}/zeroclaw.session`.
//!
//! The plugin owns one operator session per persona and writes every
//! wake / report / approval prompt into it.
//!
//! Lifecycle:
//!
//! 1. Daemon starts → calls [`resolve_session_id`].
//! 2. If `${KLODI_HOME}/zeroclaw.session` exists and probes successfully
//!    via [`zeroclaw_ws::probe_session`], reuse it.
//! 3. If the file is missing OR the probe fails with NOT_FOUND-like
//!    rejection, mint a fresh session via
//!    [`zeroclaw_ws::bootstrap_session`] and persist the new id.
//! 4. Other probe failures (network down, TLS error, invalid bearer)
//!    propagate as errors — those aren't "session is gone, try again",
//!    they're operational issues the operator needs to see.
//!
//! The persistence layer reuses [`klodi_secret_write`] so the session-id
//! file lands atomically with mode 0600 (it's not as sensitive as
//! `nats.creds`, but it identifies the operator's chat session and we
//! treat anything written under `${KLODI_HOME}` consistently).

use anyhow::{Context, Result};
use klodi_nats_client::klodi_secret_write;
use std::path::{Path, PathBuf};

use crate::zeroclaw_ws::{self, SessionOutcome, ZeroClawWsConfig};

/// `${KLODI_HOME}/zeroclaw.session` — the persisted operator-session UUID.
pub fn session_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("zeroclaw.session")
}

/// Outcome of a [`resolve_session_id`] call. Carries whether we minted a
/// fresh session this boot — the daemon uses this to decide whether to
/// post the bootstrap note or skip it on a steady-state restart.
#[derive(Debug, Clone)]
pub struct ResolvedSession {
    pub session_id: String,
    /// `true` iff this session was newly created during this call (no
    /// prior persisted id, OR the persisted id was rejected by the
    /// gateway and we re-bootstrapped). When `true`, the
    /// `bootstrap_message` passed into [`resolve_session_id`] has
    /// already been written into the session as its first user-role
    /// message — the daemon must NOT re-send the same heartbeat
    /// separately (it'd appear twice in the operator's chat).
    pub freshly_minted: bool,
    /// Whatever the gateway told us about message_count when we
    /// connected. Used in the bootstrap-note skip heuristic — a session
    /// with message_count > 0 has already received our intro.
    pub message_count: Option<u64>,
}

/// Read-or-bootstrap the ZeroClaw operator session for this persona.
///
/// Behaviour:
/// - If `${KLODI_HOME}/zeroclaw.session` exists and a probe of that id
///   against `cfg` succeeds, returns it (`freshly_minted: false`).
///   `bootstrap_message` is **ignored** in this path — the session
///   already has prior content.
/// - If the file is missing, mints a new session **and atomically
///   writes `bootstrap_message` as the session's first user-role
///   message** (`freshly_minted: true`). Closes the empty-session GC
///   window observed against the gateway — a session with at least
///   one durable write survives the gateway's cleanup pass.
/// - If the file exists but the probe fails in a way that suggests the
///   session is gone server-side (any error response from the WS
///   handshake/handshake-frame stream), mints a new session via the
///   atomic path and rewrites the file.
///
/// Network failures that aren't session-shaped (TLS, DNS, bearer
/// rejected) propagate as errors so the operator can see them.
pub async fn resolve_session_id(
    klodi_home: &Path,
    cfg: &ZeroClawWsConfig,
    bootstrap_message: &str,
) -> Result<ResolvedSession> {
    let path = session_path(klodi_home);
    let cached = read_session_file(&path)?;

    if let Some(session_id) = cached.as_deref() {
        match zeroclaw_ws::probe_session(cfg, session_id).await {
            Ok(SessionOutcome {
                session_id: server_id,
                message_count,
                ..
            }) => {
                if server_id != session_id {
                    // Gateway resumed but echoed back a different id —
                    // unexpected; treat as if the cached one is stale
                    // and persist the gateway's authoritative answer.
                    // We didn't write the bootstrap message in this
                    // branch (the gateway accepted the resume), so the
                    // daemon will treat this as freshly_minted only for
                    // the bootstrap-note decision; it must still post
                    // the heartbeat separately.
                    persist_session_file(&path, &server_id)?;
                    return Ok(ResolvedSession {
                        session_id: server_id,
                        freshly_minted: false,
                        message_count,
                    });
                }
                return Ok(ResolvedSession {
                    session_id: session_id.to_string(),
                    freshly_minted: false,
                    message_count,
                });
            }
            Err(probe_err) => {
                // Distinguish "session is gone" from "gateway is down".
                // The gateway emits an `error` frame for an unknown
                // session_id; the WS handshake itself succeeds. If the
                // error message hints at this, re-bootstrap. Otherwise
                // surface the error so the operator sees it.
                let msg = format!("{probe_err:#}");
                let looks_like_missing_session = msg.contains("error frame")
                    || msg.contains("not_found")
                    || msg.contains("NOT_FOUND")
                    || msg.contains("unknown_session")
                    || msg.contains("UNKNOWN_SESSION");
                if !looks_like_missing_session {
                    return Err(probe_err.context(format!(
                        "probing cached ZeroClaw session at {}",
                        path.display(),
                    )));
                }
                tracing::warn!(
                    cached_session = %session_id,
                    error = %msg,
                    "klodi_zeroclaw_session_rebootstrapping_after_probe_rejection"
                );
            }
        }
    }

    // Bootstrap path: open WS, mint a session, atomically write the
    // first message before closing. This is the only place
    // bootstrap_message is consumed.
    let outcome =
        zeroclaw_ws::bootstrap_session_with_first_message(cfg, bootstrap_message)
            .await
            .context(
                "bootstrapping a fresh ZeroClaw session via WS /ws/chat \
                 with atomic first message",
            )?;
    persist_session_file(&path, &outcome.session_id)?;
    Ok(ResolvedSession {
        session_id: outcome.session_id,
        freshly_minted: true,
        message_count: outcome.message_count,
    })
}

/// Adopt an explicit operator-supplied session id. Probes the gateway
/// to confirm the id exists + the bearer can resume it; persists
/// `${KLODI_HOME}/zeroclaw.session` on success. Bails loudly on any
/// failure — operator typos must not silently fall through to a fresh
/// bootstrap (that'd defeat the purpose of the explicit adopt).
///
/// Used by the `klodi-zeroclaw-daemon --adopt-session=<uuid>` /
/// `ZEROCLAW_ADOPT_SESSION=<uuid>` operator opt-in for the
/// pre-existing-session-collision case.
pub async fn adopt_session_id(
    klodi_home: &Path,
    cfg: &ZeroClawWsConfig,
    session_id: &str,
) -> Result<ResolvedSession> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        anyhow::bail!("--adopt-session value is empty");
    }
    let outcome = zeroclaw_ws::probe_session(cfg, trimmed).await
        .with_context(|| format!(
            "adopting ZeroClaw session {trimmed}: gateway rejected the resume \
             (typo? wrong bearer? session deleted?)"
        ))?;
    if outcome.session_id != trimmed {
        anyhow::bail!(
            "--adopt-session={trimmed}: gateway echoed back a different id ({}) — refusing to persist a mismatched session",
            outcome.session_id,
        );
    }
    let path = session_path(klodi_home);
    persist_session_file(&path, &outcome.session_id)?;
    Ok(ResolvedSession {
        session_id: outcome.session_id,
        // Adopted sessions count as not-freshly-minted: the daemon
        // should post a heartbeat into them but skip the bootstrap
        // note (the operator already has chat history they care about).
        freshly_minted: false,
        message_count: outcome.message_count,
    })
}

fn read_session_file(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // Empty file = treat as not-yet-persisted; safer than passing
        // the empty string into the WS resume URL (where it'd produce
        // a "missing session_id" error).
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

fn persist_session_file(path: &Path, session_id: &str) -> Result<()> {
    if session_id.is_empty() {
        anyhow::bail!("refusing to persist empty session id at {}", path.display());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    klodi_secret_write(path, session_id.as_bytes(), 0o600)
        .with_context(|| format!("klodi_secret_write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
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
    fn read_session_file_returns_none_when_absent() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        assert!(read_session_file(&path).unwrap().is_none());
    }

    #[test]
    fn read_session_file_treats_whitespace_as_absent() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        fs::write(&path, "   \n\t  \n").unwrap();
        assert!(read_session_file(&path).unwrap().is_none());
    }

    #[test]
    fn read_session_file_strips_trailing_whitespace() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        fs::write(&path, "abc-123\n").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("abc-123"),
        );
    }

    #[test]
    fn persist_session_file_writes_and_reads_back() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "session-uuid-1").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("session-uuid-1"),
        );
    }

    #[test]
    fn persist_session_file_rejects_empty() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        assert!(persist_session_file(&path, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn persist_session_file_writes_mode_0600() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "abc").unwrap();
        let mode = fs::metadata(&path).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 mode, got {mode:o}");
    }

    #[test]
    fn persist_session_file_overwrites_existing() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "first").unwrap();
        persist_session_file(&path, "second").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("second"),
        );
    }
}
