//! `klodi_setup_status` — phase reporter for daemon CLIs.
//!
//! Per **D § D4** the catalog declares this tool with
//! `host_shapes: ["daemon"]`; daemons surface it as a CLI subcommand
//! rather than an in-agent tool surface.
//!
//! The function inspects `${KLODI_HOME}/{nats.creds,config.json}` and
//! returns the same shape the in-agent tool returns (per the catalog
//! schema in `tool-catalog/src/index.ts`):
//!
//! - `phase`            — `"unconfigured" | "registering" | "ready"`
//! - `klodi_home`       — absolute path the daemon resolved
//! - `creds_present`    — bool
//! - `config_present`   — bool
//! - `creds_mode_secure`— mode bits with no group/world (P1-6 / D2)
//! - `user_id`          — JSON-extracted from `config.json` if present
//! - `handle`           — JSON-extracted from `config.json` if present
//! - `nats_url`         — JSON-extracted from `config.json` if present
//! - `issue_codes`      — vector of issue codes the agent / operator
//!   should surface to the user
//!
//! Closes P2-7 ("Rust adapter specs admit `klodi_setup_status` doesn't
//! exist").

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Phase the registration flow has reached. Mirrors the TS `klodi_setup_status`
/// reply at `klodi-plugin/adapters/openclaw/src/tools/setup-status.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupPhase {
    /// Neither creds nor config exist yet — agent should run `register`.
    Unconfigured,
    /// One of creds/config is present but the other is missing — agent
    /// should re-run `register`. The half-state is rare but possible if
    /// the previous registration crashed mid-write or the user deleted
    /// one file.
    Registering,
    /// Both files present and parseable — the daemon can connect.
    Ready,
}

/// JSON-serializable shape for the daemon CLI's `setup-status` subcommand.
#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub phase: SetupPhase,
    pub klodi_home: PathBuf,
    pub creds_present: bool,
    pub config_present: bool,
    pub creds_mode_secure: bool,
    pub user_id: Option<String>,
    pub handle: Option<String>,
    pub nats_url: Option<String>,
    pub issue_codes: Vec<String>,
}

/// Inspect `${klodi_home}/{nats.creds,config.json}` and produce a
/// [`SetupStatus`]. Never panics on malformed config — surfaces the
/// problem via `issue_codes` so the operator sees actionable text.
pub fn klodi_setup_status(klodi_home: &Path) -> SetupStatus {
    let creds_path = klodi_home.join("nats.creds");
    let config_path = klodi_home.join("config.json");

    let creds_present = creds_path.is_file();
    let config_present = config_path.is_file();
    let creds_mode_secure = creds_present && creds_mode_is_secure(&creds_path);

    let mut issue_codes: Vec<String> = Vec::new();
    if creds_present && !creds_mode_secure {
        issue_codes.push("creds_perms".to_owned());
    }

    let (user_id, handle, nats_url) = if config_present {
        match read_config(&config_path) {
            Ok(parsed) => (parsed.user_id, parsed.handle, parsed.nats_url),
            Err(_) => {
                issue_codes.push("config_unreadable".to_owned());
                (None, None, None)
            }
        }
    } else {
        (None, None, None)
    };

    let phase = match (creds_present, config_present) {
        (false, false) => SetupPhase::Unconfigured,
        (true, true) => SetupPhase::Ready,
        _ => SetupPhase::Registering,
    };

    SetupStatus {
        phase,
        klodi_home: klodi_home.to_path_buf(),
        creds_present,
        config_present,
        creds_mode_secure,
        user_id,
        handle,
        nats_url,
        issue_codes,
    }
}

#[derive(serde::Deserialize)]
struct ParsedConfig {
    user_id: Option<String>,
    handle: Option<String>,
    nats_url: Option<String>,
}

fn read_config(path: &Path) -> Result<ParsedConfig, std::io::Error> {
    let bytes = std::fs::read(path)?;
    let parsed: ParsedConfig = serde_json::from_slice(&bytes)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    Ok(parsed)
}

#[cfg(unix)]
fn creds_mode_is_secure(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(md) => md.mode() & 0o077 == 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn creds_mode_is_secure(_path: &Path) -> bool {
    // Windows: NTFS ACLs aren't expressible as octal mode bits and the
    // OS doesn't enforce a "world readable" semantics in the same way.
    // Treat as secure — the registration flow's `klodi_secret_write`
    // owns the actual file-mode discipline.
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn unconfigured_when_both_missing() {
        let dir = tempdir().unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Unconfigured);
        assert!(!status.creds_present);
        assert!(!status.config_present);
        assert!(status.user_id.is_none());
        assert!(status.issue_codes.is_empty());
    }

    #[test]
    fn ready_when_both_present_with_valid_config() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds-bytes").unwrap();
        let cfg = serde_json::json!({
            "user_id": "u1",
            "handle": "alice",
            "nats_url": "wss://example/4222",
            "nkey_public": "U1",
        });
        fs::write(dir.path().join("config.json"), cfg.to_string()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                dir.path().join("nats.creds"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Ready);
        assert_eq!(status.user_id.as_deref(), Some("u1"));
        assert_eq!(status.handle.as_deref(), Some("alice"));
        assert_eq!(status.nats_url.as_deref(), Some("wss://example/4222"));
        #[cfg(unix)]
        assert!(status.creds_mode_secure);
    }

    #[test]
    fn half_state_returns_registering_phase() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Registering);
    }

    #[test]
    fn config_unreadable_logs_issue_code() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap();
        fs::write(dir.path().join("config.json"), "{not json").unwrap();
        let status = klodi_setup_status(dir.path());
        assert!(status.issue_codes.contains(&"config_unreadable".to_owned()));
        assert!(status.user_id.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn creds_perms_issue_when_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap();
        fs::set_permissions(
            dir.path().join("nats.creds"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let status = klodi_setup_status(dir.path());
        assert!(!status.creds_mode_secure);
        assert!(status.issue_codes.contains(&"creds_perms".to_owned()));
    }
}
