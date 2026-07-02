//! RED/spec — the rust host persists a server-sent `tls://` nats_url.
//!
//! Card: support-tls-nats-transport-with-private-ca-trust.
//! Criteria (Acceptance → "Registration persists a server-sent tls:// endpoint"):
//!
//!   * marketplace returns `nats_url: tls://<svc>.proxy.rlwy.net:<port>` →
//!     the exact url is persisted to `${klodi_home}/config.json`.
//!   * marketplace returns a plaintext non-localhost url (nats:// / ws://) →
//!     registration fails closed; nothing persisted.
//!
//! `register.rs:236` delegates to the shared `assert_encrypted_or_localhost`
//! guard (auto-fixed by the guard widening), unlike hermes/nanobot/openclaw
//! which carry inline copies. This drives the full public `run_register`
//! flow against a wiremock marketplace — mirrors the existing
//! `run_register_*` tests, no private-item access.
//!
//! QA-owned (adversarial-testing). NEVER weaken.

use klodi_rust_host::{run_register, RegisterArgs};
use tempfile::tempdir;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TLS_PROD_URL: &str = "tls://kodama.proxy.rlwy.net:37360";

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
    mock_completed(&server, "nats://kodama.proxy.rlwy.net:4222").await;

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
