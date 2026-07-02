//! GATED integration — verified tls:// handshake + fail-closed (rs).
//!
//! Card: support-tls-nats-transport-with-private-ca-trust.
//! Criteria (Acceptance → "Verified TLS round-trip with private-CA trust"):
//!   * [integration] trusted private CA + tls:// nats_url → handshake
//!     completes (cert + hostname verification pass) + whoami round-trip.
//!   * [e2e] held JetStream subscription survives an idle period + delivers a
//!     subsequently published event.
//!   * [integration] wrong / absent CA → connect() errors: fails CLOSED, never
//!     a plaintext / unverified fallback.
//!
//! GATE (Do-NOW #3 dev-pair local TLS harness — NOT the epic Railway proxy):
//! each test EARLY-RETURNS (no-op) unless a local tls:// nats + self-signed
//! test CA is provided via env — KLODI_TLS_INTEGRATION=1, KLODI_TLS_NATS_URL,
//! KLODI_NATS_CA_FILE, KLODI_TLS_CREDS_PATH. Because the fail-closed case
//! mutates KLODI_NATS_CA_FILE, run the harness single-threaded:
//!   `cargo test --test tls_ca_integration -- --test-threads=1`
//! Does NOT touch prod / Railway.
//!
//! Authored to spec; UNVALIDATED in CI until the harness exists. QA-owned —
//! NEVER weaken; push back to the expert-developer instead.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use klodi_nats_client::client::KlodiClient;
use serde_json::Value;

struct Harness {
    ca_file: String,
    creds: PathBuf,
    dir: PathBuf,
    config: PathBuf,
}

/// Dependency-free unique temp dir (nats-client-rs has no `tempfile` dev-dep;
/// its own unit tests use `std::env::temp_dir` + a nonce — mirror that).
fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("klodi-tls-int-{}-{}-{tag}", std::process::id(), nanos));
    std::fs::create_dir_all(&p).expect("create temp dir");
    p
}

fn harness() -> Option<Harness> {
    if std::env::var("KLODI_TLS_INTEGRATION").as_deref() != Ok("1") {
        eprintln!("skipping tls_ca_integration: KLODI_TLS_INTEGRATION!=1");
        return None;
    }
    let nats_url = std::env::var("KLODI_TLS_NATS_URL").ok()?;
    let ca_file = std::env::var("KLODI_NATS_CA_FILE").ok()?;
    let creds = std::env::var("KLODI_TLS_CREDS_PATH").ok()?;
    let dir = unique_dir("home");
    let config = dir.join("config.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&serde_json::json!({
            "handle": "tlsuser",
            "user_id": "00000000-0000-4000-8000-000000000001",
            "nkey_public": "UTLSTEST",
            "nats_url": nats_url,
        }))
        .ok()?,
    )
    .ok()?;
    Some(Harness { ca_file, creds: PathBuf::from(creds), dir, config })
}

#[tokio::test]
async fn verified_tls_handshake_and_whoami_round_trip() {
    let Some(h) = harness() else { return };
    std::env::set_var("KLODI_NATS_CA_FILE", &h.ca_file); // trust the test CA
    let client = KlodiClient::new(&h.creds, &h.config)
        .await
        .expect("client new");
    client.connect().await.expect("verified tls:// connect must succeed");
    assert!(client.is_connected().await, "must be connected after handshake");
    let _resp: Value = client
        .request("p2p.v1.users.whoami", &serde_json::json!({}), None)
        .await
        .expect("whoami round-trip must succeed over tls://");
    client.close().await.ok();
    let _ = std::fs::remove_dir_all(&h.dir);
}

#[tokio::test]
async fn fails_closed_when_ca_is_wrong() {
    let Some(h) = harness() else { return };
    // A wrong CA (does not sign the test nats cert). Selecting the wrong CA
    // must fail closed — it must NOT disable verification.
    let wrong = h.dir.join("wrong-ca.pem");
    std::fs::write(
        &wrong,
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
    )
    .unwrap();
    std::env::set_var("KLODI_NATS_CA_FILE", &wrong);
    let client = KlodiClient::new(&h.creds, &h.config)
        .await
        .expect("client new");
    let result = client.connect().await;
    assert!(result.is_err(), "wrong CA must fail closed (no plaintext fallback)");
    assert!(!client.is_connected().await, "must not be connected with a wrong CA");
    let _ = std::fs::remove_dir_all(&h.dir);
}
