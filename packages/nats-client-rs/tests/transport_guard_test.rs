//! RED/spec — transport guard collapsed to `tls://` ONLY, no localhost
//! bypass (rs client).
//!
//! Card: remove-dead-ws-localhost-nats-transport-bypass. Mirror of the
//! py/ts guard matrix — flips the prior *localhost-accepts-any-scheme*
//! premise to *localhost-is-no-longer-a-bypass*. The guard's sole rule is
//! now `scheme == tls://`; `tls://localhost` (dev CA) is Ok because it is
//! `tls://`, not via a host carve-out.
//!
//!   * `tls://<non-localhost>`  → Ok  (the sole prod transport)
//!   * `tls://localhost`        → Ok  (dev-CA loopback — it is tls://)
//!   * `ws://localhost`         → Err (was Ok; the bypass is dead)
//!   * `wss://localhost`        → Err (was Ok; the bypass is dead)
//!   * `nats://localhost`       → Err (was Ok; the bypass is dead)
//!   * `ws://<non-localhost>`   → Err (unchanged)
//!   * `wss://<non-localhost>`  → Err (unchanged)
//!   * `nats://<non-localhost>` → Err (unchanged)
//!
//! The guard is the shared connect-time + persist-time control. This file
//! pins the shared guard in `klodi_nats_client::config`.
//!
//! COORDINATION: the guard is renamed in-dev `assert_tls_or_localhost` →
//! `assert_tls` (once the localhost bypass is gone, `_or_localhost` is an
//! active lie). This file imports the NEW name, so this test *binary* will
//! not compile until the rename lands (expected compile-RED — the rename IS
//! part of the deliverable; no re-export for the old name per the
//! no-backwards-compat rule). `is_localhost` is deleted — never import it.
//!
//! QA-owned (adversarial-testing). NEVER weaken. In particular: do NOT
//! re-widen the guard to accept `ws://localhost` so an old assertion passes.

use klodi_nats_client::config::assert_tls;
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
        assert_tls(TLS_PROD).is_ok(),
        "tls:// (raw TLS through the Railway TCP proxy) must be accepted"
    );
}

#[test]
fn accepts_tls_arbitrary_non_localhost_host() {
    assert!(assert_tls("tls://nats.example.com:4222").is_ok());
}

#[test]
fn accepts_tls_localhost() {
    // The surviving dev loopback: accepted because it is `tls://`, NOT via
    // a localhost carve-out.
    assert!(
        assert_tls("tls://localhost:4222").is_ok(),
        "tls://localhost (dev CA) is accepted because it is tls://"
    );
}

#[test]
fn rejects_wss_non_localhost() {
    let err = assert_tls(WSS_PROD)
        .expect_err("wss:// non-localhost must be rejected");
    assert!(
        matches!(err, KlodiError::InvalidConfig(_)),
        "rejection must be a structured InvalidConfig error, got: {err:?}"
    );
}

#[test]
fn rejects_plaintext_nats_non_localhost() {
    assert!(
        assert_tls(NATS_PLAINTEXT).is_err(),
        "nats:// is plaintext TCP — must never stand in for tls://"
    );
}

#[test]
fn rejects_bare_ws_non_localhost() {
    assert!(assert_tls(WS_PLAINTEXT).is_err());
}

#[test]
fn rejects_non_tls_against_localhost() {
    // THE FLIP: localhost is no longer a plaintext escape hatch. Every
    // non-tls scheme against localhost was Ok under the old
    // `assert_tls_or_localhost` bypass; the collapse rejects them all.
    for url in [
        "ws://localhost:8080",
        "wss://localhost",
        "nats://localhost:4222",
        "nats://127.0.0.1:4222",
        "ws://0.0.0.0:8080",
        "nats://dev.localhost:4222",
    ] {
        let err = assert_tls(url).expect_err(&format!(
            "non-tls against localhost must reject after the collapse: {url}"
        ));
        assert!(
            matches!(err, KlodiError::InvalidConfig(_)),
            "rejection must be structured InvalidConfig for {url}, got: {err:?}"
        );
    }
}

#[test]
fn rejection_message_names_tls_only_no_localhost_bypass() {
    // Non-localhost offending url so echoing it can never re-introduce the
    // word "localhost" into the message.
    let err = assert_tls(WS_PLAINTEXT)
        .expect_err("ws:// non-localhost must be rejected");
    let msg = err.to_string();
    // Names tls:// as the required transport.
    assert!(msg.contains("tls://"), "must name tls:// as required (got: {msg})");
    // No longer presents localhost as an acceptable bypass — the old
    // "…only accepted when the host resolves to localhost" clause is gone.
    let lower = msg.to_lowercase();
    assert!(
        !lower.contains("localhost"),
        "message must not present localhost as an acceptable bypass — the \
         host carve-out is deleted (got: {msg})"
    );
    // Names re-register as the benign migration remedy, not compromise-only.
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
