//! RED — persist + resolve the register-response CA (rs).
//!
//! Card: auto-trust-nats-ca-from-register.
//!
//! Three shared helpers land in `nats-client-rs/src/tls.rs`, byte-for-byte
//! with the py/ts halves:
//!   * `nats_ca_path(klodi_home)`      — the single filename source (nats-ca.pem).
//!   * `persist_nats_ca(klodi_home, pem)` — atomic write, mode 0644 (non-secret
//!     cert per ADR-0022, unlike the 0600 nkey creds). A non-PEM-shaped / empty
//!     value is SKIPPED (never written, never Err) so a garbage nats_ca can
//!     never fail registration. Last-write wins → the re-register rotation path.
//!   * `resolve_ca_file(klodi_home)`   — gains a NEW level-2 step:
//!       1. KLODI_NATS_CA_FILE env  — override; short-circuits (persisted path
//!          is not even returned).
//!       2. ${KLODI_HOME}/nats-ca.pem — persisted register CA. NEW.
//!       3. bundled KLODI_NATS_CA_PEM — static fallback (empty here).
//!       4. system trust store (None).
//!
//! This file references the NEW symbols, so **it will not compile until they
//! exist** — that IS the RED signal for statically-typed new API. The dev's
//! first GREEN step (add the three helpers + thread `klodi_home` into
//! `resolve_ca_file`) makes the `klodi-nats-client` test target compile again.
//!
//! Env-mutating tests are serialised through `ENV_LOCK` (set_var is process
//! global). QA-owned. NEVER weaken — push failures back to the expert-developer.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use klodi_nats_client::tls::{nats_ca_path, persist_nats_ca, resolve_ca_file};

const CA_FILE_ENV: &str = "KLODI_NATS_CA_FILE";

/// Serialise env-var mutation — `std::env::set_var` is process-global and
/// cargo runs a file's tests on multiple threads.
static ENV_LOCK: Mutex<()> = Mutex::new(());

const REG_PEM: &str =
    "-----BEGIN CERTIFICATE-----\nMIICregisterFixtureBody\n-----END CERTIFICATE-----\n";
const ROT_PEM: &str =
    "-----BEGIN CERTIFICATE-----\nMIICrotatedFixtureBody\n-----END CERTIFICATE-----\n";

/// Dependency-free unique temp home (no `tempfile` dev-dep — mirror the
/// existing `tls_ca_integration.rs` nonce pattern).
fn unique_home(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("klodi-nats-ca-{}-{}-{tag}", std::process::id(), nanos));
    std::fs::create_dir_all(&p).expect("create temp home");
    p
}

// ── Persist helpers ─────────────────────────────────────────────────────────

#[test]
fn nats_ca_path_is_nats_ca_pem_under_home() {
    let home = unique_home("path");
    assert_eq!(nats_ca_path(&home), home.join("nats-ca.pem"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persist_writes_pem_shaped_ca() {
    let home = unique_home("persist");
    persist_nats_ca(&home, REG_PEM).expect("persist a valid PEM");
    let got = std::fs::read_to_string(nats_ca_path(&home)).expect("nats-ca.pem written");
    assert_eq!(got, REG_PEM);
    let _ = std::fs::remove_dir_all(&home);
}

#[cfg(unix)]
#[test]
fn persisted_ca_is_mode_0644() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_home("mode");
    persist_nats_ca(&home, REG_PEM).expect("persist");
    let mode = std::fs::metadata(nats_ca_path(&home))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o644, "non-secret CA cert must be persisted 0644");
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persist_skips_non_pem_value_without_error() {
    let home = unique_home("skip");
    // A non-PEM-shaped value must be skipped, never Err — a garbage nats_ca
    // may not fail registration (Open questions #4, persist-side disposition).
    persist_nats_ca(&home, "definitely not a certificate").expect("skip must not fail");
    assert!(
        !nats_ca_path(&home).exists(),
        "non-PEM-shaped nats_ca must be skipped, not persisted"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persist_skips_empty_value() {
    let home = unique_home("empty");
    persist_nats_ca(&home, "").expect("skip empty must not fail");
    assert!(!nats_ca_path(&home).exists());
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persist_overwrites_on_rotation() {
    let home = unique_home("rotate");
    persist_nats_ca(&home, REG_PEM).expect("persist first");
    persist_nats_ca(&home, ROT_PEM).expect("persist rotated");
    assert_eq!(
        std::fs::read_to_string(nats_ca_path(&home)).unwrap(),
        ROT_PEM,
        "a fresh nats_ca must replace the persisted CA (last-write wins)"
    );
    let _ = std::fs::remove_dir_all(&home);
}

// ── Resolve precedence ──────────────────────────────────────────────────────

#[test]
fn env_override_wins_over_persisted_register_ca() {
    // Scenario 2 [guard]: explicit KLODI_NATS_CA_FILE beats the persisted CA.
    let _g = ENV_LOCK.lock().unwrap();
    let home = unique_home("envwin");
    std::fs::write(nats_ca_path(&home), REG_PEM).unwrap();
    let env_ca = home.join("env-ca.pem");
    std::fs::write(&env_ca, REG_PEM).unwrap();
    std::env::set_var(CA_FILE_ENV, &env_ca);

    let resolved = resolve_ca_file(&home).expect("resolve").expect("some path");
    assert_eq!(resolved, env_ca, "explicit override must win over persisted CA");

    std::env::remove_var(CA_FILE_ENV);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn env_override_short_circuits_persisted_not_returned() {
    // Scenario 2 [guard]: strict precedence — when the env override is set the
    // persisted path is never even considered (no CA union / divergence I/O).
    let _g = ENV_LOCK.lock().unwrap();
    let home = unique_home("shortcircuit");
    std::fs::write(nats_ca_path(&home), REG_PEM).unwrap();
    let env_ca = home.join("env-ca.pem");
    std::fs::write(&env_ca, REG_PEM).unwrap();
    std::env::set_var(CA_FILE_ENV, &env_ca);

    let resolved = resolve_ca_file(&home).expect("resolve").expect("some path");
    assert_ne!(
        resolved,
        nats_ca_path(&home),
        "the persisted CA path must not be returned when the env override is set"
    );

    std::env::remove_var(CA_FILE_ENV);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persisted_register_ca_used_when_no_env() {
    // Scenario 1 [RED driver]: no env override + a persisted register CA → the
    // resolver returns the persisted path so async-nats trusts it.
    let _g = ENV_LOCK.lock().unwrap();
    std::env::remove_var(CA_FILE_ENV);
    let home = unique_home("persistedresolve");
    std::fs::write(nats_ca_path(&home), REG_PEM).unwrap();

    let resolved = resolve_ca_file(&home)
        .expect("resolve")
        .expect("persisted register CA must resolve to a path");
    assert_eq!(resolved, nats_ca_path(&home));

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn no_env_no_persisted_falls_through_to_system_store() {
    // Scenario 3 [guard]: no env + no persisted + empty bundle → system store.
    let _g = ENV_LOCK.lock().unwrap();
    std::env::remove_var(CA_FILE_ENV);
    let home = unique_home("nonesystem");

    let resolved = resolve_ca_file(&home).expect("resolve");
    assert!(
        resolved.is_none(),
        "no CA source → fall through to the system trust store (None)"
    );

    let _ = std::fs::remove_dir_all(&home);
}
