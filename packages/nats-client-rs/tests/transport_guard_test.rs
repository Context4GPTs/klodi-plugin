//! RED/spec — transport guard widened to accept `tls://` (rs client).
//!
//! Card: support-tls-nats-transport-with-private-ca-trust.
//! Criteria (Acceptance → "Transport guard — widen to tls://…"), mirror of
//! the py/ts guard matrix:
//!
//!   * `tls://<non-localhost>`  → Ok  (the new prod transport)
//!   * `wss://<non-localhost>`  → Ok  (widening must not drop wss)
//!   * `nats://<non-localhost>` → Err; message names both secure schemes
//!   * `ws://<non-localhost>`   → Err (D §D10 control intact)
//!   * any scheme @ localhost   → Ok  (localhost bypass unchanged)
//!
//! The guard is the shared connect-time + persist-time control. This file
//! pins the shared guard in `klodi_nats_client::config`.
//!
//! QA-owned (adversarial-testing). NEVER weaken.

use klodi_nats_client::config::assert_encrypted_or_localhost;

const TLS_PROD: &str = "tls://kodama.proxy.rlwy.net:37360";
const WSS_PROD: &str = "wss://klodi-net.4gpts.com";
const NATS_PLAINTEXT: &str = "nats://kodama.proxy.rlwy.net:4222";
const WS_PLAINTEXT: &str = "ws://attacker.example.com:8080";

#[test]
fn accepts_tls_non_localhost() {
    assert!(
        assert_encrypted_or_localhost(TLS_PROD).is_ok(),
        "tls:// (raw TLS through the Railway TCP proxy) must be accepted"
    );
}

#[test]
fn accepts_tls_arbitrary_non_localhost_host() {
    assert!(assert_encrypted_or_localhost("tls://nats.example.com:4222").is_ok());
}

#[test]
fn still_accepts_wss_non_localhost() {
    assert!(
        assert_encrypted_or_localhost(WSS_PROD).is_ok(),
        "widening must not drop the wss:// L7-edge transport"
    );
}

#[test]
fn rejects_plaintext_nats_non_localhost() {
    assert!(
        assert_encrypted_or_localhost(NATS_PLAINTEXT).is_err(),
        "nats:// is plaintext TCP — must never stand in for tls://"
    );
}

#[test]
fn nats_rejection_names_both_secure_schemes() {
    let err = assert_encrypted_or_localhost(NATS_PLAINTEXT)
        .expect_err("nats:// non-localhost must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("wss://"), "error must cite wss:// (got: {msg})");
    assert!(
        msg.contains("tls://"),
        "error must cite tls:// as an acceptable secure scheme (got: {msg})"
    );
}

#[test]
fn rejects_bare_ws_non_localhost() {
    assert!(assert_encrypted_or_localhost(WS_PLAINTEXT).is_err());
}

#[test]
fn accepts_any_scheme_against_localhost() {
    for url in [
        "ws://localhost:8080",
        "nats://127.0.0.1:4222",
        "tls://localhost:4222",
        "wss://localhost",
        "ws://0.0.0.0:8080",
        "nats://dev.localhost:4222",
    ] {
        assert!(
            assert_encrypted_or_localhost(url).is_ok(),
            "localhost bypass must accept every scheme, incl. {url}"
        );
    }
}
