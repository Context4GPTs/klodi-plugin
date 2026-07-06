//! Loud-fail — malformed/untrusted served CA fails LOUD, TERMINAL, PROMPT,
//! STRUCTURED (rs).
//!
//! Byte-for-byte port of the Python `test_tls_loud_fail.py` / TS
//! `tls-loud-fail.test.ts` contract, for the async-nats/rustls family.
//!
//! ⚠️ COMPILE-RED (intentional, contained). This file references the NEW
//! `KlodiError::CaTrust { ca_source, message }` variant that is the Rust
//! deliverable. Until the expert-developer adds it, THIS file
//! fails to compile — the compiler error naming the missing variant IS the RED
//! signal for a statically-typed new API. Per repo convention the new-symbol
//! references are contained to THIS single `tests/*.rs` file; every OTHER test
//! target still compiles and runs, e.g.:
//!   cargo test --manifest-path packages/nats-client-rs/Cargo.toml \
//!     --test nats_ca_resolve_persist
//!   cargo test --manifest-path packages/nats-client-rs/Cargo.toml \
//!     --test verification_never_disabled
//! (There is no cargo workspace at the repo root — run standalone crates by
//! `--manifest-path`, not `-p`.)
//!
//! GATE (dev-pair local TLS harness — NOT the prod Railway proxy). async-nats
//! has no in-process TLS-server dev-dep, so the negative handshake is exercised
//! against the klodi-stage bed's real `tls://` NATS: each test EARLY-RETURNS
//! unless KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL, KLODI_TLS_CREDS_PATH are
//! set. The bed presents its real chain; the client trusts a WRONG-signer
//! fixture CA (`ca-wrong.pem`), so the handshake is rejected. The wrong-signer
//! case is the universally-rejected cross-family anchor (Open question #7); the
//! keyUsage-missing strict-stack instance is proven self-contained on Python
//! (see the handoff note recommending a `tokio-rustls`/`rcgen` dev-dep to make
//! this file self-contained + add a keyUsage-missing rs case).
//!
//! Run single-threaded — it mutates KLODI_NATS_CA_FILE:
//!   cargo test --manifest-path packages/nats-client-rs/Cargo.toml \
//!     --test tls_loud_fail -- --test-threads=1
//!
//! QA-owned. NEVER weaken — push failures back to the expert-developer.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use klodi_nats_client::KlodiError;
use klodi_nats_client::client::KlodiClient;

/// A bad-CA connect must reach a terminal error within this bound; a hang
/// (`retry_on_initial_connect` retries the deterministic verify failure
/// forever) trips the timeout → the assert fails.
const TERMINAL_BOUND: Duration = Duration::from_secs(15);

/// A transient (refused-port) failure must still be retrying inside this short
/// window — never a terminal `CaTrust`.
const TRANSIENT_WINDOW: Duration = Duration::from_secs(4);

/// A shared local TLS-CA fixture (`CARGO_MANIFEST_DIR` = packages/nats-client-rs).
fn fixture(name: &str) -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("test-fixtures")
        .join("tls-ca")
        .join(name);
    assert!(
        p.is_file(),
        "missing fixture {} (run test-fixtures/tls-ca/gen.sh)",
        p.display()
    );
    p
}

struct Harness {
    creds: PathBuf,
    dir: PathBuf,
    nats_url: String,
}

/// Dependency-free unique temp dir (no `tempfile` dev-dep — mirror the existing
/// `tls_ca_integration.rs` nonce pattern).
fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("klodi-tls-loud-{}-{}-{tag}", std::process::id(), nanos));
    std::fs::create_dir_all(&p).expect("create temp dir");
    p
}

fn harness(tag: &str) -> Option<Harness> {
    if std::env::var("KLODI_TLS_INTEGRATION").as_deref() != Ok("1") {
        eprintln!("skipping tls_loud_fail: KLODI_TLS_INTEGRATION!=1");
        return None;
    }
    let nats_url = std::env::var("KLODI_TLS_NATS_URL").ok()?;
    let creds = std::env::var("KLODI_TLS_CREDS_PATH").ok()?;
    Some(Harness {
        creds: PathBuf::from(creds),
        dir: unique_dir(tag),
        nats_url,
    })
}

/// Write a `config.json` pointing at `nats_url`; return its path.
fn write_config(dir: &Path, nats_url: &str) -> PathBuf {
    let config = dir.join("config.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "handle": "tlsuser",
            "user_id": "00000000-0000-4000-8000-000000000001",
            "nkey_public": "UTLSTEST",
            "nats_url": nats_url,
        }))
        .expect("serialize config"),
    )
    .expect("write config");
    config
}

/// Bind then drop a listener so nothing is listening on the port → refused.
fn dead_local_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    listener.local_addr().expect("local_addr").port()
}

// ── Pillar B [integration] RED — wrong-signer served CA is structured + prompt.

#[tokio::test]
async fn wrong_signer_ca_is_terminal_prompt_and_structured() {
    let Some(h) = harness("wrongsigner") else { return };
    // Trust a WELL-FORMED wrong-signer CA while the bed presents its real chain
    // → the handshake is rejected. It must surface a STRUCTURED, attributable,
    // BOUNDED-time terminal `KlodiError::CaTrust`, never the infinite
    // retry_on_initial_connect hang and never a bare async-nats ConnectError.
    std::env::set_var("KLODI_NATS_CA_FILE", fixture("ca-wrong.pem"));
    let config = write_config(&h.dir, &h.nats_url);
    let client = KlodiClient::new(&h.creds, &config).await.expect("client new");

    let outcome = tokio::time::timeout(TERMINAL_BOUND, client.connect()).await;
    let inner = outcome.unwrap_or_else(|_| {
        panic!(
            "wrong-signer connect HUNG past {TERMINAL_BOUND:?} (retried forever) — the \
             deterministic CA/TLS-verify failure on the initial connect must be terminal"
        )
    });
    let err = inner.expect_err("wrong-signer CA must fail closed");
    assert!(
        matches!(err, KlodiError::CaTrust { .. }),
        "a wrong-signer served CA must surface the structured KlodiError::CaTrust \
         variant, not a bare async-nats ConnectError (got {err:?})"
    );
    let text = err.to_string().to_lowercase();
    assert!(
        ["ca", "cert", "tls", "trust", "verif"].iter().any(|t| text.contains(t)),
        "the CaTrust error must be legible as a CA-trust / TLS-verification failure: {err}"
    );
    assert!(!client.is_connected().await, "must not be connected with a wrong CA");
    let _ = std::fs::remove_dir_all(&h.dir);
}

// ── Pillar B [integration] GUARD (classifier pair) — a transient refused port
// must NOT be classified as a terminal CA failure.

#[tokio::test]
async fn transient_refused_port_is_not_terminal_ca() {
    let Some(h) = harness("transient") else { return };
    // Valid bed creds (so `with_credentials` parsing succeeds) but a dead local
    // port → connection refused (transient). The classifier must NOT label this
    // a terminal CaTrust; it keeps retrying (resilience must not regress).
    std::env::set_var("KLODI_NATS_CA_FILE", fixture("ca-good.pem"));
    let url = format!("tls://127.0.0.1:{}", dead_local_port());
    let config = write_config(&h.dir, &url);
    let client = KlodiClient::new(&h.creds, &config).await.expect("client new");

    let outcome = tokio::time::timeout(TRANSIENT_WINDOW, client.connect()).await;
    if let Ok(Err(KlodiError::CaTrust { .. })) = outcome {
        panic!(
            "a refused-port (transient) failure must NOT be classified as a terminal \
             CaTrust — only the deterministic CA/TLS-verify class fails fast"
        );
    }
    let _ = std::fs::remove_dir_all(&h.dir);
}
