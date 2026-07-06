//! RED — the rust host persists the register-response nats_ca.
//!
//! The ONE rust-host persist site (`register.rs::persist_session`) covers
//! moltis + ironclaw + zeroclaw — the Rust third of the six-adapter symmetry
//! audit (Scenario 1 persist + Scenario 3 no-regression + rotation):
//!
//!   * completed session carries a PEM nats_ca → ${klodi_home}/nats-ca.pem is
//!     written alongside config.json.
//!   * completed session omits nats_ca → nothing new persisted; creds + config
//!     still land; an existing persisted CA is NOT deleted on a later omission.
//!   * force-re-register with a rotated nats_ca → the persisted CA is replaced.
//!
//! nats_ca is OPTIONAL — it must NOT be added to the required-field context()?
//! chain (register.rs:208), so an absent value never fails registration.
//! Drives the full public `run_register` flow against a wiremock marketplace —
//! no private-item access. RED today: persist_session ignores nats_ca.
//!
//! QA-owned. NEVER weaken.

use klodi_rust_host::{run_register, RegisterArgs};
use tempfile::tempdir;
use wiremock::matchers::{method, path_regex};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TLS_URL: &str = "tls://hayabusa.proxy.rlwy.net:32770";
const CA_ONE: &str =
    "-----BEGIN CERTIFICATE-----\nMIICregisterCaOneFixture\n-----END CERTIFICATE-----\n";
const CA_TWO: &str =
    "-----BEGIN CERTIFICATE-----\nMIICrotatedCaTwoFixture\n-----END CERTIFICATE-----\n";

fn completed_body(nats_ca: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "status": "completed",
        "nats_creds": "-----BEGIN NATS USER JWT-----\nfake\n",
        "handle": "alice",
        "user_id": "u-1",
        "nkey_public": "UAAAAAAAAAAAA",
        "nats_url": TLS_URL,
    });
    if let Some(ca) = nats_ca {
        body["nats_ca"] = serde_json::Value::String(ca.to_string());
    }
    body
}

async fn server_returning(nats_ca: Option<&str>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/api/sessions/.+$"))
        .respond_with(ResponseTemplate::new(200).set_body_json(completed_body(nats_ca)))
        .mount(&server)
        .await;
    server
}

fn args(api_url: String, home: &std::path::Path, force: bool) -> RegisterArgs {
    RegisterArgs {
        api_url,
        klodi_home: home.to_path_buf(),
        user_agent: "klodi-test/0".into(),
        binary_name: "klodi-test".into(),
        force_register: force,
    }
}

#[tokio::test]
async fn persists_nats_ca_alongside_config() {
    let dir = tempdir().unwrap();
    let server = server_returning(Some(CA_ONE)).await;

    run_register(args(server.uri(), dir.path(), false))
        .await
        .expect("completed registration with nats_ca must persist and return Ok");

    let ca_file = dir.path().join("nats-ca.pem");
    assert!(
        ca_file.exists(),
        "register nats_ca must be persisted to ${{KLODI_HOME}}/nats-ca.pem"
    );
    assert_eq!(std::fs::read_to_string(&ca_file).unwrap(), CA_ONE);
    assert!(dir.path().join("config.json").exists());
}

#[tokio::test]
async fn omitted_nats_ca_persists_nothing_but_creds_config_land() {
    let dir = tempdir().unwrap();
    let server = server_returning(None).await; // older @klodi/web — no nats_ca

    run_register(args(server.uri(), dir.path(), false))
        .await
        .expect("registration without nats_ca must still succeed (no regression)");

    assert!(
        !dir.path().join("nats-ca.pem").exists(),
        "no nats_ca in the response ⇒ nothing new persisted"
    );
    assert!(dir.path().join("config.json").exists());
    assert!(dir.path().join("nats.creds").exists());
}

#[tokio::test]
async fn omission_on_reregister_does_not_delete_existing_ca() {
    let dir = tempdir().unwrap();
    let s1 = server_returning(Some(CA_ONE)).await;
    run_register(args(s1.uri(), dir.path(), false))
        .await
        .expect("initial register with nats_ca");

    // Force a re-register whose response omits nats_ca — must not revoke.
    let s2 = server_returning(None).await;
    run_register(args(s2.uri(), dir.path(), true))
        .await
        .expect("forced re-register without nats_ca");

    let ca_file = dir.path().join("nats-ca.pem");
    assert!(
        ca_file.exists(),
        "'no update' must not revoke a previously persisted CA"
    );
    assert_eq!(std::fs::read_to_string(&ca_file).unwrap(), CA_ONE);
}

#[tokio::test]
async fn reregister_rotates_persisted_ca() {
    let dir = tempdir().unwrap();
    let s1 = server_returning(Some(CA_ONE)).await;
    run_register(args(s1.uri(), dir.path(), false))
        .await
        .expect("initial register");

    let s2 = server_returning(Some(CA_TWO)).await;
    run_register(args(s2.uri(), dir.path(), true))
        .await
        .expect("forced re-register with rotated nats_ca");

    assert_eq!(
        std::fs::read_to_string(dir.path().join("nats-ca.pem")).unwrap(),
        CA_TWO,
        "a fresh nats_ca on re-register must replace the persisted CA"
    );
}
