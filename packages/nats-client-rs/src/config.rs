//! Disk-backed config and credentials.
//!
//! Mirrors the TS client at `klodi-plugin/packages/nats-client-ts/src/config.ts`.
//! Two files written by `klodi_register` (HTTP-only, unchanged in 0012):
//!
//!   ${klodi_home}/config.json — handle, user_id, public NKey, NATS URL
//!   ${klodi_home}/nats.creds  — Ed25519 NKey credentials at mode 0600
//!
//! The KlodiClient takes both paths in `new()`; adapters resolve them
//! from their host's config tree.

use crate::error::KlodiError;
use serde::Deserialize;
use std::fs;
use std::path::Path;

/// On-disk klodi session metadata. Authoritative once `klodi_register`
/// has completed.
#[derive(Clone, Debug, Deserialize)]
pub struct KlodiConfig {
    /// Marketplace handle, e.g. "alice".
    pub handle: String,
    /// Authoritative user UUID, set by the marketplace at registration.
    pub user_id: String,
    /// Public NKey, sent in the `X-Nkey-Public` header.
    pub nkey_public: String,
    /// `tls://…` — the sole accepted transport (prod, or `tls://localhost`
    /// with the dev CA for loopback).
    pub nats_url: String,
}

/// Load and validate the on-disk config. Returns
/// [`KlodiError::ConfigNotFound`] when the file is absent and
/// [`KlodiError::ConfigInvalid`] when required fields are empty.
pub fn load_config(path: &Path) -> Result<KlodiConfig, KlodiError> {
    if !path.exists() {
        return Err(KlodiError::ConfigNotFound(path.display().to_string()));
    }
    let raw = fs::read_to_string(path)?;
    let cfg: KlodiConfig = serde_json::from_str(&raw)?;
    let mut missing: Vec<&str> = Vec::new();
    if cfg.handle.is_empty() {
        missing.push("handle");
    }
    if cfg.user_id.is_empty() {
        missing.push("user_id");
    }
    if cfg.nkey_public.is_empty() {
        missing.push("nkey_public");
    }
    if cfg.nats_url.is_empty() {
        missing.push("nats_url");
    }
    if !missing.is_empty() {
        return Err(KlodiError::ConfigInvalid {
            path: path.display().to_string(),
            missing: missing.join(", "),
        });
    }
    Ok(cfg)
}

/// Read the on-disk creds file. Mirrors the TS `loadCreds`: warns to
/// the `tracing` log when group or world bits are set on the file but
/// does not refuse to load — surfacing a permissions decision is the
/// host plugin's call.
///
/// Mode check (D2): "no group or world bits" — `mode & 0o077 == 0`.
/// Both `0o600` (documented baseline) and `0o400` (read-only owner;
/// stricter) pass. Any group or world bit set logs the warning.
pub fn load_creds(path: &Path) -> Result<String, KlodiError> {
    if !path.exists() {
        return Err(KlodiError::CredsNotFound(path.display().to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(path) {
            Ok(meta) => {
                let mode = meta.permissions().mode() & 0o777;
                if mode & 0o077 != 0 {
                    tracing::warn!(
                        path = %path.display(),
                        mode = format!("{:o}", mode),
                        "klodi_creds_permissions_loose"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    path = %path.display(),
                    error = %err,
                    "klodi_creds_metadata_unreadable"
                );
            }
        }
    }
    fs::read_to_string(path).map_err(|err| KlodiError::CredsRead {
        path: path.display().to_string(),
        source: err,
    })
}

/// Refuse `nats_url` unless it uses the `tls://` transport.
///
/// Per epic `nats-tls-only-2026-07`: `tls://` (raw NATS-over-TLS, the L4
/// TCP-proxy path) is the **sole** accepted transport. It terminates TLS
/// at the NATS server with certificate + hostname verification ON (see
/// [`crate::tls`]). Every other scheme (`wss://` / `ws://` / `nats://`) is
/// rejected on every host — there is no localhost bypass and no plaintext
/// transport anywhere. The dev loopback is `tls://localhost` (dev CA),
/// accepted by this same prefix check because it *is* `tls://`. This closes
/// the compound attack where a compromised registration endpoint injects a
/// non-TLS `nats_url` and the next connect goes to attacker-controlled
/// infrastructure.
pub fn assert_tls(nats_url: &str) -> Result<(), KlodiError> {
    if nats_url.starts_with("tls://") {
        return Ok(());
    }
    Err(KlodiError::InvalidConfig(format!(
        "KlodiClient: nats_url must use tls:// (got {nats_url}). \
         tls:// (raw NATS-over-TLS with certificate + hostname verification) \
         is the sole accepted transport. Re-register to obtain the current \
         tls:// endpoint.",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let nonce = uuid::Uuid::new_v4();
        p.push(format!("klodi-nats-client-{nonce}-{name}"));
        p
    }

    #[test]
    fn config_round_trips_required_fields() {
        let path = temp_path("config.json");
        let body = r#"{
            "handle": "alice",
            "user_id": "11111111-1111-1111-1111-111111111111",
            "nkey_public": "U_TEST",
            "nats_url": "wss://nats.example/ws"
        }"#;
        fs::write(&path, body).expect("write");
        let cfg = load_config(&path).expect("parse");
        assert_eq!(cfg.handle, "alice");
        assert_eq!(cfg.nkey_public, "U_TEST");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn config_missing_path_errors() {
        let path = temp_path("missing.json");
        let err = load_config(&path).expect_err("missing file errors");
        assert!(matches!(err, KlodiError::ConfigNotFound(_)));
    }

    #[test]
    fn config_invalid_when_field_empty() {
        let path = temp_path("invalid.json");
        let body = r#"{"handle":"","user_id":"","nkey_public":"","nats_url":""}"#;
        fs::write(&path, body).expect("write");
        let err = load_config(&path).expect_err("empty fields error");
        match err {
            KlodiError::ConfigInvalid { missing, .. } => {
                assert!(missing.contains("handle"));
                assert!(missing.contains("user_id"));
                assert!(missing.contains("nkey_public"));
                assert!(missing.contains("nats_url"));
            }
            other => panic!("expected ConfigInvalid, got {other:?}"),
        }
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn creds_round_trips_payload() {
        let path = temp_path("nats.creds");
        let mut f = fs::File::create(&path).expect("create");
        f.write_all(b"-----BEGIN NATS USER JWT-----\nfoo\n").expect("write");
        let raw = load_creds(&path).expect("load");
        assert!(raw.starts_with("-----BEGIN NATS USER JWT"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn creds_missing_path_errors() {
        let path = temp_path("missing.creds");
        let err = load_creds(&path).expect_err("missing creds errors");
        assert!(matches!(err, KlodiError::CredsNotFound(_)));
    }

    /// D2: lenient creds-mode rule — `mode & 0o077 == 0` accepts the
    /// documented `0o600` baseline AND any stricter mode (e.g. `0o400`,
    /// read-only owner). Group/world bits trigger the warning.
    #[cfg(unix)]
    #[test]
    fn creds_loads_at_strict_mode_0400() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("strict.creds");
        let mut f = fs::File::create(&path).expect("create");
        f.write_all(b"jwt").expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400))
            .expect("chmod 0400");
        let raw = load_creds(&path).expect("load 0400");
        assert_eq!(raw, "jwt");
        let _ = fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn creds_loads_at_baseline_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_path("baseline.creds");
        let mut f = fs::File::create(&path).expect("create");
        f.write_all(b"jwt").expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");
        let raw = load_creds(&path).expect("load 0600");
        assert_eq!(raw, "jwt");
        let _ = fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn creds_loads_at_loose_mode_but_logs_warning() {
        use std::os::unix::fs::PermissionsExt;
        // 0o644 has group + world read bits; load_creds still returns
        // the bytes (host plugin decides) but logs the loose-mode
        // warning — exercising the lenient check path.
        let path = temp_path("loose.creds");
        let mut f = fs::File::create(&path).expect("create");
        f.write_all(b"jwt").expect("write");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))
            .expect("chmod 0644");
        let raw = load_creds(&path).expect("load 0644");
        assert_eq!(raw, "jwt");
        let _ = fs::remove_file(&path);
    }
}
