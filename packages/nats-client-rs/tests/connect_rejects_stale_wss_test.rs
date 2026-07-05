//! RED [unit] — a stale persisted `wss://` nats_url is rejected at
//! `KlodiClient::connect()` BEFORE any transport dispatch (rs client).
//!
//! Card: collapse-nats-transport-guard-to-tls-only.
//!
//! Scenario: `config.json` still carries a `wss://<non-localhost>` nats_url
//! (persisted before the cutover), the host is upgraded to the tls-only
//! client without re-registering. `connect()` runs the shared guard
//! (`client.rs:137`) BEFORE building `ConnectOptions` or entering
//! `initial_connect`, so the stale url must fail closed synchronously with a
//! structured `KlodiError::InvalidConfig` — no dial attempt.
//!
//! async-nats gives no transport-injection seam, so the no-dispatch proof is
//! terminality-under-timeout: `initial_connect` retries Io/Dns/TimedOut
//! FOREVER (`max_reconnects(None)`), so were the guard to run late, a dial
//! against the dead `wss://` endpoint would hang past the timeout. A prompt
//! `InvalidConfig` proves the guard fired ahead of dispatch. (Same
//! bounded-terminal recipe the TLS-trust suite uses.)
//!
//! Compiles against existing public symbols (`KlodiClient` / `KlodiError`),
//! so this binary is behavioural-RED (wss:// currently accepted → hang →
//! timeout), not compile-RED.
//!
//! QA-owned (adversarial-testing). NEVER weaken.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use klodi_nats_client::{KlodiClient, KlodiError};

/// Dependency-free unique temp dir (nats-client-rs has no `tempfile`
/// dev-dep — mirror the existing tests' `std::env::temp_dir` + nonce).
fn unique_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut p = std::env::temp_dir();
    p.push(format!("klodi-stale-wss-{}-{}-{tag}", std::process::id(), nanos));
    std::fs::create_dir_all(&p).expect("create temp dir");
    p
}

fn write_session(dir: &Path, nats_url: &str) -> (PathBuf, PathBuf) {
    let config_path = dir.join("config.json");
    let creds_path = dir.join("nats.creds");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "handle": "alice",
            "user_id": "u-1",
            "nkey_public": "UAAAAAAAAAAAA",
            "nats_url": nats_url,
        })
        .to_string(),
    )
    .expect("write config.json");
    std::fs::write(&creds_path, "-----BEGIN NATS USER JWT-----\nfake\n")
        .expect("write nats.creds");
    (creds_path, config_path)
}

#[tokio::test]
async fn connect_rejects_stale_wss_before_transport_dispatch() {
    let dir = unique_dir("home");
    let (creds_path, config_path) = write_session(&dir, "wss://klodi-net.4gpts.com");

    let client = KlodiClient::new(&creds_path, &config_path)
        .await
        .expect("new() only loads config+creds; it does not run the guard");

    // The timeout is the no-hang tripwire: a late guard would let
    // initial_connect retry the dead wss:// endpoint forever.
    let outcome = tokio::time::timeout(Duration::from_secs(5), client.connect()).await;

    let result = outcome.expect(
        "connect() must return promptly (guard before dispatch), not hang on a \
         wss:// transport dial",
    );
    let err = result.expect_err("stale wss:// nats_url must be rejected by the guard");
    assert!(
        matches!(err, KlodiError::InvalidConfig(_)),
        "rejection must be a structured InvalidConfig error, got: {err:?}"
    );
    assert!(
        !client.is_connected().await,
        "no half-open connection may remain after a rejected connect()"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
