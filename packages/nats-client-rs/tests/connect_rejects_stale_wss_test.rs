//! RED [unit] — a stale persisted non-`tls://` nats_url is rejected at
//! `KlodiClient::connect()` BEFORE any transport dispatch (rs client).
//!
//! Two cases: the `wss://`-non-localhost case (verify-only) AND the
//! NEW `ws://localhost` / `wss://localhost` cases — RED today, since localhost
//! is still a bypass on current `main`.
//!
//! Scenario: `config.json` still carries a non-`tls://` nats_url — either a
//! `wss://<non-localhost>` (persisted before the cutover) or a stale
//! `ws://localhost` / `wss://localhost` (persisted while localhost was a
//! plaintext bypass, before it was removed). The host is upgraded to the
//! guard-collapsed client without re-registering. `connect()` runs the shared
//! guard (`client.rs:137`) BEFORE building `ConnectOptions` or entering
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

#[tokio::test]
async fn connect_rejects_stale_ws_localhost_before_transport_dispatch() {
    // The transport-guard flip: a stale
    // `ws://localhost` / `wss://localhost` was accepted at connect while
    // localhost was a bypass. After the collapse the guard rejects it with
    // `InvalidConfig` BEFORE any `ConnectOptions` / dial — no hang against a
    // localhost endpoint that no longer speaks ws://.
    for stale_url in ["ws://localhost:8080", "wss://localhost"] {
        let dir = unique_dir("home");
        let (creds_path, config_path) = write_session(&dir, stale_url);

        let client = KlodiClient::new(&creds_path, &config_path)
            .await
            .expect("new() only loads config+creds; it does not run the guard");

        // The timeout is the no-hang tripwire: a late guard would let the
        // client dial the localhost endpoint (or spin the reconnect loop).
        let outcome = tokio::time::timeout(Duration::from_secs(5), client.connect()).await;

        let result = outcome.unwrap_or_else(|_| {
            panic!("connect() must return promptly (guard before dispatch) for {stale_url}, not hang")
        });
        let err = result.expect_err(&format!(
            "stale {stale_url} must be rejected by the collapsed guard"
        ));
        assert!(
            matches!(err, KlodiError::InvalidConfig(_)),
            "rejection must be structured InvalidConfig for {stale_url}, got: {err:?}"
        );
        assert!(
            !client.is_connected().await,
            "no half-open connection may remain after a rejected connect() for {stale_url}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
