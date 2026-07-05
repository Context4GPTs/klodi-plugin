//! RED/spec — transport guard collapsed to `tls://` only (rs client).
//!
//! Card: collapse-nats-transport-guard-to-tls-only. Mirror of the py/ts
//! guard matrix — flips the prior wss://-acceptance suite to rejection:
//!
//!   * `tls://<non-localhost>`  → Ok  (the sole prod transport)
//!   * `wss://<non-localhost>`  → Err (was Ok; the collapse)
//!   * `ws://<non-localhost>`   → Err (unchanged)
//!   * `nats://<non-localhost>` → Err (unchanged)
//!   * any scheme @ localhost   → Ok  (localhost bypass unchanged)
//!
//! The guard is the shared connect-time + persist-time control. This file
//! pins the shared guard in `klodi_nats_client::config`.
//!
//! COORDINATION: the guard is renamed in-dev `assert_encrypted_or_localhost`
//! → `assert_tls_or_localhost`. This file imports the NEW name, so this test
//! *binary* will not compile until the rename lands (expected compile-RED —
//! the rename IS the deliverable; no re-export for the old name per the
//! no-backwards-compat rule).
//!
//! QA-owned (adversarial-testing). NEVER weaken.

use klodi_nats_client::config::assert_tls_or_localhost;
use klodi_nats_client::error::KlodiError;

// The pinned prod endpoint: Railway's L4 TCP proxy in front of NATS
// (devops §1 — NOT `kodama`, which is pgvector's Postgres proxy).
const TLS_PROD: &str = "tls://hayabusa.proxy.rlwy.net:32770";
const WSS_PROD: &str = "wss://klodi-net.4gpts.com";
const NATS_PLAINTEXT: &str = "nats://hayabusa.proxy.rlwy.net:4222";
const WS_PLAINTEXT: &str = "ws://attacker.example.com:8080";

#[test]
fn accepts_tls_non_localhost() {
    assert!(
        assert_tls_or_localhost(TLS_PROD).is_ok(),
        "tls:// (raw TLS through the Railway TCP proxy) must be accepted"
    );
}

#[test]
fn accepts_tls_arbitrary_non_localhost_host() {
    assert!(assert_tls_or_localhost("tls://nats.example.com:4222").is_ok());
}

#[test]
fn rejects_wss_non_localhost() {
    // The load-bearing flip: wss:// was accepted under the two-scheme
    // allow-list; the tls-only cutover rejects it off-localhost.
    let err = assert_tls_or_localhost(WSS_PROD)
        .expect_err("wss:// non-localhost must be rejected after the collapse");
    assert!(
        matches!(err, KlodiError::InvalidConfig(_)),
        "rejection must be a structured InvalidConfig error, got: {err:?}"
    );
}

#[test]
fn rejects_plaintext_nats_non_localhost() {
    assert!(
        assert_tls_or_localhost(NATS_PLAINTEXT).is_err(),
        "nats:// is plaintext TCP — must never stand in for tls://"
    );
}

#[test]
fn rejects_bare_ws_non_localhost() {
    assert!(assert_tls_or_localhost(WS_PLAINTEXT).is_err());
}

#[test]
fn wss_rejection_names_tls_only_and_reregister() {
    let err = assert_tls_or_localhost(WSS_PROD)
        .expect_err("wss:// non-localhost must be rejected");
    let msg = err.to_string();
    // Names tls:// as the sole required non-localhost scheme.
    assert!(msg.contains("tls://"), "must name tls:// as required (got: {msg})");
    // Lists wss:// among the rejected schemes.
    assert!(
        msg.contains("wss://"),
        "must list wss:// among the rejected schemes (got: {msg})"
    );
    // No longer frames wss:// as acceptable alongside tls://.
    assert!(
        !msg.contains("wss:// or tls://"),
        "must not present wss:// as acceptable alongside tls:// (got: {msg})"
    );
    assert!(
        !msg.contains("must use wss://"),
        "must not require wss:// (got: {msg})"
    );
    // Names re-register as the benign migration remedy, not a
    // compromise-only one.
    let lower = msg.to_lowercase();
    assert!(
        lower.contains("register"),
        "must name re-register as the remedy (got: {msg})"
    );
    assert!(
        !lower.contains("compromis"),
        "re-register must read as the normal migration remedy, not a \
         compromise-only one (got: {msg})"
    );
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
            assert_tls_or_localhost(url).is_ok(),
            "localhost bypass must accept every scheme, incl. {url}"
        );
    }
}
