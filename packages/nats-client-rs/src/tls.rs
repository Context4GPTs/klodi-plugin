//! TLS trust for the raw `tls://` NATS transport (private-CA proxy).
//!
//! The Railway L4 TCP proxy terminates TLS at the NATS server with a
//! **private** CA (epic `nats-ws-ingress-flap-2026-06`). For a `tls://`
//! URL the client trusts that CA via async-nats
//! [`ConnectOptions::add_root_certificates`], which takes a **path** to a
//! PEM bundle. This module resolves that path.
//!
//! Invariant (the card's core security control): verification is **never**
//! disabled. `add_root_certificates` builds a standard verifying rustls
//! `ClientConfig` (certificate + SNI-hostname checks ON); there is no
//! `danger_accept_invalid_certs` / `InsecureSkipVerify` path anywhere.
//! `KLODI_NATS_CA_FILE` selects *which* CA to trust, never *whether* to
//! verify — a missing / wrong CA fails **closed** (the handshake errors).
//!
//! Note: async-nats trusts **only** the provided CA when
//! `add_root_certificates` is used (it skips the native root store in
//! that case), matching the private-CA-only posture of the Python and TS
//! clients.
//!
//! CA resolution order (highest priority first):
//!   1. `KLODI_NATS_CA_FILE` env var — a path to a PEM bundle (local /
//!      self-signed test CA; emergency rotation without a release).
//!   2. The bundled [`KLODI_NATS_CA_PEM`] catalog constant — the shipped
//!      private CA, materialised to a per-process temp file so the
//!      path-based async-nats API can consume it. Empty until the epic
//!      mints the real CA; empty means "fall through".
//!   3. Neither present → `None`: the system trust store applies and a
//!      private-CA cert fails closed (correct).

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::catalog::KLODI_NATS_CA_PEM;
use crate::error::KlodiError;

/// Env var naming a PEM bundle path. Selects *which* CA to trust; it can
/// never disable verification.
const CA_FILE_ENV: &str = "KLODI_NATS_CA_FILE";

/// Cache for the temp file materialised from the bundled PEM constant, so
/// repeated connects reuse one file rather than leaking one per attempt.
static BUNDLED_CA_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Resolve the CA-bundle path to trust for a `tls://` connection.
///
/// Returns `Ok(None)` when no private CA is configured (system trust
/// store applies). Returns `Err` only when a configured source cannot be
/// realised (e.g. the bundled PEM can't be written to a temp file) — a
/// fail-closed signal, never a silent downgrade.
///
/// The `KLODI_NATS_CA_FILE` path is *not* stat-checked here: async-nats
/// opens it at connect and surfaces a clear error if it is missing, so a
/// broken override still fails closed at the handshake.
pub fn resolve_ca_file() -> Result<Option<PathBuf>, KlodiError> {
    if let Ok(path) = std::env::var(CA_FILE_ENV) {
        if !path.is_empty() {
            return Ok(Some(PathBuf::from(path)));
        }
    }
    if !KLODI_NATS_CA_PEM.is_empty() {
        return Ok(Some(bundled_ca_path()?.clone()));
    }
    Ok(None)
}

/// Materialise the embedded [`KLODI_NATS_CA_PEM`] to a temp file once and
/// cache the path. async-nats' `add_root_certificates` only accepts a
/// path, so the in-binary PEM must live on disk to be consumed.
fn bundled_ca_path() -> Result<&'static PathBuf, KlodiError> {
    if let Some(path) = BUNDLED_CA_PATH.get() {
        return Ok(path);
    }
    let mut path = std::env::temp_dir();
    path.push(format!("klodi-nats-bundled-ca-{}.pem", std::process::id()));
    let mut file = std::fs::File::create(&path).map_err(|err| {
        KlodiError::InvalidConfig(format!(
            "could not materialise bundled NATS CA to {}: {err}",
            path.display()
        ))
    })?;
    file.write_all(KLODI_NATS_CA_PEM.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|err| {
            KlodiError::InvalidConfig(format!(
                "could not write bundled NATS CA to {}: {err}",
                path.display()
            ))
        })?;
    // Another thread may have won the race; fall back to the stored value.
    let _ = BUNDLED_CA_PATH.set(path);
    Ok(BUNDLED_CA_PATH.get().expect("BUNDLED_CA_PATH set above"))
}
