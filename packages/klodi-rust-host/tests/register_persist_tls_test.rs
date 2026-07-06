//! The rust host persists a server-sent `tls://` nats_url and refuses non-tls.
//!
//! Two behaviours: tls:// persist + non-localhost refusal (verify-only), AND
//! the NEW `ws://localhost` refusal — RED today, since localhost is still a
//! bypass on current `main`.
//!
//! Criteria (Acceptance → D "each adapter persist path rejects a non-tls:// url"):
//!
//!   * marketplace returns `nats_url: tls://<svc>.proxy.rlwy.net:<port>` →
//!     the exact url is persisted to `${klodi_home}/config.json`.
//!   * marketplace returns ANY non-`tls://` url — nats:// / ws:// non-localhost,
//!     OR `ws://localhost` (the flip) — registration fails closed; nothing
//!     persisted.
//!
//! `register.rs` delegates to the shared guard (`assert_tls` after the
//! rename) — all four adapters delegate now, none carry an inline scheme copy.
//! This drives the full public `run_register` flow against a wiremock
//! marketplace — mirrors the existing `run_register_*` tests, no private-item
//! access.
//!
//! QA-owned (adversarial-testing). NEVER weaken. Do NOT re-add a localhost
//! carve-out so the `ws://localhost` case passes.

use klodi_rust_host::{run_register, RegisterArgs};
use tempfile::tempdir;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TLS_PROD_URL: &str = "tls://hayabusa.proxy.rlwy.net:32770";

fn completed_body(nats_url: &str) -> serde_json::Value {
    serde_json::json!({
        "status": "completed",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_url": nats_url,
    })
}

async fn mock_completed(server: &MockServer, nats_url: &str) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/sessions/.+$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completed_body(nats_url)))
        .mount(server)
        .await;
}

#[tokio::test]
async fn persists_tls_url_unchanged() {
    let dir = tempdir().unwrap();
    let server = MockServer::start().await;
    mock_completed(&server, TLS_PROD_URL).await;

    run_register(RegisterArgs {
        api_url: server.uri(),
        klodi_home: dir.path().to_path_buf(),
        user_agent: "klodi-test/0".into(),
        binary_name: "klodi-test".into(),
        force_register: false,
    })
    .await
    .expect("completed tls:// registration must persist and return Ok");

    let config = std::fs::read_to_string(dir.path().join("config.json"))
        .expect("config.json must be written");
    let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
    assert_eq!(
        parsed["nats_url"], TLS_PROD_URL,
        "tls:// nats_url must persist unchanged"
    );
}

#[tokio::test]
async fn refuses_plaintext_nats_non_localhost() {
    let dir = tempdir().unwrap();
    let server = MockServer::start().await;
    mock_completed(&server, "nats://hayabusa.proxy.rlwy.net:4222").await;

    let err = run_register(RegisterArgs {
        api_url: server.uri(),
        klodi_home: dir.path().to_path_buf(),
        user_agent: "klodi-test/0".into(),
        binary_name: "klodi-test".into(),
        force_register: false,
    })
    .await
    .expect_err("plaintext nats:// url must fail closed");
    assert!(
        err.to_string().to_lowercase().contains("plaintext"),
        "error should explain the plaintext refusal, got: {err}"
    );
    assert!(
        !dir.path().join("config.json").exists(),
        "nothing may persist when the url is refused"
    );
    assert!(!dir.path().join("nats.creds").exists());
}

/// [integration] tls-only cutover: the ONE rust-host persist
/// site (moltis + ironclaw + zeroclaw) refuses a wss://<non-localhost>
/// nats_url via the shared guard — the wss:// scheme was accepted before
/// the collapse. Fails closed; nothing persisted. Not coupled to the
/// "plaintext" wording (wss:// is encrypted, just the wrong transport).
#[tokio::test]
async fn refuses_wss_non_localhost() {
    let dir = tempdir().unwrap();
    let server = MockServer::start().await;
    mock_completed(&server, "wss://klodi-net.4gpts.com").await;

    let err = run_register(RegisterArgs {
        api_url: server.uri(),
        klodi_home: dir.path().to_path_buf(),
        user_agent: "klodi-test/0".into(),
        binary_name: "klodi-test".into(),
        force_register: false,
    })
    .await
    .expect_err("wss:// non-localhost must fail closed under the tls-only guard");
    let _ = err;
    assert!(
        !dir.path().join("config.json").exists(),
        "nothing may persist when the wss:// url is refused"
    );
    assert!(!dir.path().join("nats.creds").exists());
}

/// [integration] The transport-guard flip:
/// a `/register` response carrying `ws://localhost` was accepted while
/// localhost was a plaintext bypass. After the guard collapse the shared
/// guard rejects it — the rust-host persist site fails closed, nothing
/// persisted. RED today (ws://localhost is still accepted on `main`).
#[tokio::test]
async fn refuses_ws_localhost() {
    let dir = tempdir().unwrap();
    let server = MockServer::start().await;
    mock_completed(&server, "ws://localhost:8080").await;

    let err = run_register(RegisterArgs {
        api_url: server.uri(),
        klodi_home: dir.path().to_path_buf(),
        user_agent: "klodi-test/0".into(),
        binary_name: "klodi-test".into(),
        force_register: false,
    })
    .await
    .expect_err("ws://localhost must fail closed after the localhost bypass is removed");
    let _ = err;
    assert!(
        !dir.path().join("config.json").exists(),
        "nothing may persist when the ws://localhost url is refused"
    );
    assert!(!dir.path().join("nats.creds").exists());
}
