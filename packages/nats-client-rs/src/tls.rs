//! TLS trust for the raw `tls://` NATS transport (private-CA proxy).
//! See ADR-0022 (`docs/decisions/0022-tls-nats-transport-private-ca-trust.md`).
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
//!      self-signed test CA; emergency rotation without a release). When set
//!      it **short-circuits** — the persisted register CA is not even returned.
//!   2. `${KLODI_HOME}/nats-ca.pem` — the register-response CA persisted at
//!      registration (see [`persist_nats_ca`]). Server-authoritative,
//!      endpoint-matched to the served `nats_url`, rotatable without a client
//!      release (card `auto-trust-nats-ca-from-register`). Returned as a path
//!      that async-nats reads at connect; a present-but-unreadable/invalid
//!      file fails closed there. Absent falls through.
//!   3. The bundled [`KLODI_NATS_CA_PEM`] catalog constant — the shipped
//!      private CA, materialised to a per-process temp file so the
//!      path-based async-nats API can consume it. Empty until the epic
//!      mints the real CA; empty means "fall through".
//!   4. None present → `None`: the system trust store applies and a
//!      private-CA cert fails closed (correct).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::catalog::KLODI_NATS_CA_PEM;
use crate::error::KlodiError;
use crate::secret_write::klodi_secret_write;

/// Env var naming a PEM bundle path. Selects *which* CA to trust; it can
/// never disable verification.
const CA_FILE_ENV: &str = "KLODI_NATS_CA_FILE";

/// Cheap PEM-shape sniff at the persist boundary — a full X.509 parse would
/// make the adapter persist sites expensive and asymmetric; a
/// PEM-shaped-but-deep-invalid cert instead fails closed at connect.
const PEM_MARKER: &str = "-----BEGIN CERTIFICATE-----";

/// Non-secret cert (ADR-0022 §Security) — world-readable, unlike the 0600
/// nkey creds of ADR-0002.
const CA_FILE_MODE: u32 = 0o644;

/// The persisted register-CA location `${klodi_home}/nats-ca.pem`. Single
/// filename source shared by [`persist_nats_ca`] (register-time write) and
/// [`resolve_ca_file`] (connect-time level-2 read) so the two can never
/// disagree on location.
pub fn nats_ca_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("nats-ca.pem")
}

/// Persist the register-response CA to `${klodi_home}/nats-ca.pem`. Atomic
/// write (temp + fsync + rename, via [`klodi_secret_write`]) at mode 0644 —
/// a non-secret CA certificate (ADR-0022 §Security), unlike the 0600 nkey
/// creds. **Skips** — writing nothing, returning `Ok(())` — when `pem` is
/// empty or not PEM-shaped, so an absent / garbage `nats_ca` can never fail
/// registration. Last-write-wins: a fresh value overwrites, making
/// re-register the CA-rotation path (an *omission* does not delete — "no
/// update" ≠ "revoke", handled at the call site).
pub fn persist_nats_ca(klodi_home: &Path, pem: &str) -> Result<(), KlodiError> {
    if pem.is_empty() || !pem.contains(PEM_MARKER) {
        tracing::info!(
            reason = if pem.is_empty() { "empty" } else { "not_pem_shaped" },
            "nats_ca_persist_skipped",
        );
        return Ok(());
    }
    let target = nats_ca_path(klodi_home);
    klodi_secret_write(&target, pem.as_bytes(), CA_FILE_MODE).map_err(|err| {
        KlodiError::InvalidConfig(format!(
            "could not persist register CA to {}: {err}",
            target.display()
        ))
    })
}

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
///
/// `klodi_home` locates the persisted register CA (level 2); the caller
/// derives it from the creds-path parent so this lower-layer package never
/// re-resolves `KLODI_HOME` upward.
pub fn resolve_ca_file(klodi_home: &Path) -> Result<Option<PathBuf>, KlodiError> {
    if let Ok(path) = std::env::var(CA_FILE_ENV) {
        if !path.is_empty() {
            return Ok(Some(PathBuf::from(path)));
        }
    }
    // Level 2 — the register-response CA persisted at registration. Only
    // reached when the env override is unset (strict precedence, no CA
    // union, no divergence read). Returned as a path; async-nats reads it at
    // connect and a present-but-unreadable/invalid file fails closed there.
    let persisted = nats_ca_path(klodi_home);
    if persisted.exists() {
        return Ok(Some(persisted));
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
