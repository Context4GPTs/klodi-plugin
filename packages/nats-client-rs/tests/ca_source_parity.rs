//! CA-source precedence has ONE encoding — the resolver (rs).
//!
//! Card: consolidate-ca-source-precedence-into-the-resolver.
//!
//! `resolve_ca_file` returns the CA path AND the label naming *which* source it
//! selected (env → persisted → bundled), packed in `ResolvedCa { path, source }`.
//! The connect-failure attribution threads `resolved.source` into
//! `initial_connect` and interpolates it into `KlodiError::CaTrust` instead of
//! re-deriving the order; the parallel `describe_ca_source` helper is deleted,
//! so there is no second encoding to drift.
//!
//! This pin asserts, per precedence level (env / persisted / bundled):
//!   (a) `resolve_ca_file(home).source` reports the exact expected label, and
//!   (b) the loud-fail `KlodiError::CaTrust` Display — the exact string the
//!       client surfaces, built from `resolved.source` — names *exactly* that
//!       same label.
//! Plus an exhaustiveness guard: every level yields a distinct, populated label.
//!
//! Unlike the py/ts parity pins, (b) here asserts at the `KlodiError::CaTrust`
//! Display boundary rather than driving a live `connect()`: async-nats has no
//! in-process TLS-server dev-dep, so the live threading of `resolved.source`
//! through `initial_connect` is exercised by the GATED `tls_loud_fail.rs`
//! (klodi-stage bed). The `describe_ca_source` deletion + the `initial_connect`
//! signature guarantee the client cannot re-derive — it can only carry the
//! resolver's `source`.
//!
//! ⚠️ COMPILE-RED (intentional, contained). References the NEW `ResolvedCa`
//! struct + the `resolve_ca_file -> Result<ResolvedCa, _>` shape that are the
//! Rust deliverable of this card. Until the expert-developer lands them THIS
//! file (and `nats_ca_resolve_persist.rs`) fails to compile — the compiler
//! error naming the missing symbol IS the RED signal. Every OTHER test target
//! still compiles + runs, e.g.:
//!   cargo test --manifest-path packages/nats-client-rs/Cargo.toml \
//!     --test verification_never_disabled
//!
//! Run single-threaded — it mutates KLODI_NATS_CA_FILE:
//!   cargo test --manifest-path packages/nats-client-rs/Cargo.toml \
//!     --test ca_source_parity -- --test-threads=1
//!
//! QA-owned. NEVER weaken — push failures back to the expert-developer.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use klodi_nats_client::KlodiError;
use klodi_nats_client::tls::{ResolvedCa, nats_ca_path, resolve_ca_file};

const CA_FILE_ENV: &str = "KLODI_NATS_CA_FILE";

/// Serialise env-var mutation — `std::env::set_var` is process-global and
/// cargo runs a file's tests on multiple threads.
static ENV_LOCK: Mutex<()> = Mutex::new(());

const REG_PEM: &str =
    "-----BEGIN CERTIFICATE-----\nMIICparityFixtureBody\n-----END CERTIFICATE-----\n";

fn unique_home(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("klodi-ca-parity-{}-{}-{tag}", std::process::id(), nanos));
    std::fs::create_dir_all(&p).expect("create temp home");
    p
}

/// The `<source>` the client surfaces in the loud-fail — `KlodiError::CaTrust`'s
/// `ca_source` is fed straight from `ResolvedCa.source`, so its Display is the
/// (b) attribution assertion (no live connect needed).
fn attributed_display(resolved: &ResolvedCa) -> String {
    KlodiError::CaTrust {
        ca_source: resolved.source.clone(),
        message: "certificate verify failed".to_string(),
    }
    .to_string()
}

#[test]
fn env_source_reported_and_attributed() {
    let _g = ENV_LOCK.lock().unwrap();
    let home = unique_home("env");
    let env_ca = home.join("env-ca.pem");
    let env_str = env_ca.to_str().expect("utf-8 path").to_string();
    std::env::set_var(CA_FILE_ENV, &env_ca);

    let resolved = resolve_ca_file(&home).expect("resolve");
    let expected = format!("{CA_FILE_ENV}={env_str}");
    // (a) resolver reports the exact env label + selects the env path.
    assert_eq!(resolved.source, expected);
    assert_eq!(resolved.path, Some(PathBuf::from(&env_str)));
    // (b) the loud-fail names exactly that label.
    assert!(
        attributed_display(&resolved).contains(&format!("served NATS CA {expected}")),
        "the CaTrust loud-fail must name exactly the resolver-selected env label"
    );

    std::env::remove_var(CA_FILE_ENV);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn persisted_source_reported_and_attributed() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::remove_var(CA_FILE_ENV);
    let home = unique_home("persisted");
    std::fs::write(nats_ca_path(&home), REG_PEM).unwrap();

    let resolved = resolve_ca_file(&home).expect("resolve");
    let expected = format!("persisted register CA at {}", nats_ca_path(&home).display());
    // (a) resolver reports the exact persisted label + selects the persisted path.
    assert_eq!(resolved.source, expected);
    assert_eq!(resolved.path, Some(nats_ca_path(&home)));
    // (b) the loud-fail names exactly that label.
    assert!(
        attributed_display(&resolved).contains(&format!("served NATS CA {expected}")),
        "the CaTrust loud-fail must name exactly the resolver-selected persisted label"
    );

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn bundled_source_reported_and_attributed() {
    let _g = ENV_LOCK.lock().unwrap();
    std::env::remove_var(CA_FILE_ENV);
    let home = unique_home("bundled");

    let resolved = resolve_ca_file(&home).expect("resolve");
    // (a) no env + no persisted → bundled fall-through. The source stays
    // populated even for the empty-bundle system-store path (`path` is `None`),
    // or a Tls failure against the system store would lose its attribution.
    assert_eq!(resolved.source, "bundled KLODI_NATS_CA_PEM");
    // (b) the loud-fail names exactly that label.
    assert!(
        attributed_display(&resolved).contains("served NATS CA bundled KLODI_NATS_CA_PEM"),
        "the CaTrust loud-fail must name exactly the bundled label"
    );

    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn source_label_set_is_exhaustive_over_levels() {
    let _g = ENV_LOCK.lock().unwrap();
    let home = unique_home("exhaustive");

    // bundled / system store
    std::env::remove_var(CA_FILE_ENV);
    let bundled = resolve_ca_file(&home).expect("resolve").source;
    // persisted
    std::fs::write(nats_ca_path(&home), REG_PEM).unwrap();
    let persisted = resolve_ca_file(&home).expect("resolve").source;
    // env override
    let env_ca = home.join("env-ca.pem");
    std::env::set_var(CA_FILE_ENV, &env_ca);
    let env = resolve_ca_file(&home).expect("resolve").source;
    std::env::remove_var(CA_FILE_ENV);

    let labels = [&env, &persisted, &bundled];
    assert!(labels.iter().all(|l| !l.is_empty()), "each level must yield a populated label");
    assert_ne!(env, persisted);
    assert_ne!(persisted, bundled);
    assert_ne!(env, bundled);

    let _ = std::fs::remove_dir_all(&home);
}
