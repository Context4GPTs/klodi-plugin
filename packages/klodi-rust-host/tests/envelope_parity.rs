//! Cross-language envelope parity — Rust consumer (RED).
//!
//! Loads `packages/tool-catalog/tests/fixtures/envelope-golden.json` and
//! asserts the Rust shared host's envelope helpers produce the same
//! shape the fixture pins (after substituting per-host placeholders).
//!
//! Coverage scope: every failure mode in the golden fixture that the
//! Rust trio (moltis, ironclaw, zeroclaw via `klodi-rust-host`) reaches
//! — creds-not-found → `not_registered`, config-not-found, not-connected,
//! setup-error notifications/channels, marketplace passthrough,
//! internal_error.
//!
//! R8 — every assertion that pins `error` is exact-string match; every
//! assertion that pins `recovery_hint` is exact-structure match modulo
//! placeholder substitution.
//!
//! This file is QA-owned during RED. The integration test compiles only
//! when the `mcp` feature is enabled (it depends on the `mcp::envelope`
//! module's public surface). Run with:
//!
//!   cargo test -p klodi-rust-host --features mcp --test envelope_parity
//!
//! NEVER weaken these asserts to compile.

#![cfg(feature = "mcp")]

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

// The implementer must `pub use` (or `pub mod`-and-`pub`) these items
// in `packages/klodi-rust-host/src/lib.rs` so the integration test can
// reach them. Until they're publicly visible, this integration test
// fails to compile — that is the RED state.
// The fixture pins the *dispatched* envelope — i.e. what the agent
// receives from the live MCP server. That path always carries the
// per-host register CLI. We therefore exercise
// `envelope_from_klodi_err_with_cli`, which is the dispatcher's call
// site. The lower-level `envelope_from_klodi_err` is the catalog-default
// helper used at construction sites that don't yet have the host CLI
// (e.g. setup-error mapping); the parity contract is irrelevant there
// because those envelopes get the CLI substituted before reaching the
// agent.
use klodi_rust_host::mcp::envelope::{
    ToolEnvelope, envelope_from_klodi_err, envelope_from_klodi_err_with_cli,
};
use klodi_nats_client::KlodiError;

/// The host name the parity-test harness substitutes for `<host>`.
/// Matches the founder's "same envelope across all six adapters" — we
/// pick zeroclaw as the reference and the other five conform.
const PARITY_HOST: &str = "zeroclaw";
const PARITY_REGISTER_CLI: &str = "klodi-zeroclaw-register";

fn fixture_path() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    // packages/klodi-rust-host → up two to repo root → then descend.
    let repo_root = PathBuf::from(manifest_dir).join("..").join("..");
    repo_root
        .join("packages")
        .join("tool-catalog")
        .join("tests")
        .join("fixtures")
        .join("envelope-golden.json")
}

fn load_fixture() -> Value {
    let raw = fs::read_to_string(fixture_path())
        .expect("envelope-golden.json must exist at the fixture path");
    serde_json::from_str(&raw).expect("envelope-golden.json must be valid JSON")
}

fn envelope_for(key: &str) -> Value {
    let fixture = load_fixture();
    let entry = fixture.get(key).unwrap_or_else(|| {
        panic!("fixture entry {key:?} not found in envelope-golden.json")
    });
    entry
        .get("envelope")
        .expect("each entry has an envelope object")
        .clone()
}

fn assert_envelope_keys(env: &ToolEnvelope) {
    // R1 — exactly four canonical keys. We serialise the envelope and
    // compare the JSON object key set.
    let v = serde_json::to_value(env).expect("envelope serialises");
    let obj = v.as_object().expect("envelope is a JSON object");
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["details", "error", "message", "recovery_hint"],
        "envelope must carry exactly the four R1 keys"
    );
}

fn assert_recovery_hint_matches(
    actual: &Value,
    expected: &Value,
    substitutions: &[(&str, &str)],
) {
    if expected.is_null() {
        assert!(
            actual.is_null(),
            "recovery_hint must be null when fixture says null; got {actual}"
        );
        return;
    }
    assert!(
        !actual.is_null(),
        "recovery_hint must NOT be null when fixture supplies a NextAction"
    );
    let exp_obj = expected.as_object().expect("expected hint is object");
    let act_obj = actual.as_object().expect("actual hint is object");
    assert_eq!(act_obj.get("kind"), exp_obj.get("kind"));
    for (k, exp_v) in exp_obj {
        if k == "kind" {
            continue;
        }
        if exp_v.is_null() {
            continue; // free-form field
        }
        let mut exp_str = exp_v.as_str().unwrap_or("").to_string();
        for (placeholder, real) in substitutions {
            exp_str = exp_str.replace(placeholder, real);
        }
        let actual_v = act_obj.get(k).expect("actual hint has the expected key");
        assert_eq!(
            actual_v.as_str(),
            Some(exp_str.as_str()),
            "recovery_hint.{k} mismatch after substitution"
        );
    }
}

// ── not_registered (creds + config) ───────────────────────────────────

#[test]
fn parity_not_registered_creds_path() {
    let expected = envelope_for("not_registered");
    let err = KlodiError::CredsNotFound("/tmp/nats.creds".to_string());
    // Exercise the dispatcher's per-host call site — that's the envelope
    // the agent receives. See PARITY_HOST / PARITY_REGISTER_CLI above.
    let actual = envelope_from_klodi_err_with_cli(err, PARITY_REGISTER_CLI);
    assert_envelope_keys(&actual);

    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert_recovery_hint_matches(
        &actual_v["recovery_hint"],
        &expected["recovery_hint"],
        &[("<host>", PARITY_HOST)],
    );
}

#[test]
fn parity_not_registered_config_path() {
    let expected = envelope_for("not_registered");
    let err = KlodiError::ConfigNotFound("/tmp/config.json".to_string());
    let actual = envelope_from_klodi_err_with_cli(err, PARITY_REGISTER_CLI);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert_recovery_hint_matches(
        &actual_v["recovery_hint"],
        &expected["recovery_hint"],
        &[("<host>", PARITY_HOST)],
    );
}

// ── connection_not_ready ──────────────────────────────────────────────

#[test]
fn parity_connection_not_ready() {
    let expected = envelope_for("connection_not_ready");
    let err = KlodiError::NotConnected;
    let actual = envelope_from_klodi_err(err);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert_recovery_hint_matches(
        &actual_v["recovery_hint"],
        &expected["recovery_hint"],
        &[],
    );
}

// ── consumer_missing (notifications + channels) ──────────────────────

#[test]
fn parity_consumer_missing_notifications() {
    let expected = envelope_for("consumer_missing_notifications");
    let err = KlodiError::Setup {
        code: "notifications_consumer_missing",
        message: "missing".to_string(),
    };
    let actual = envelope_from_klodi_err(err);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert_eq!(actual_v["details"]["consumer"], "notifications");
    assert_recovery_hint_matches(
        &actual_v["recovery_hint"],
        &expected["recovery_hint"],
        &[],
    );
}

#[test]
fn parity_consumer_missing_channels() {
    let expected = envelope_for("consumer_missing_channels");
    let err = KlodiError::Setup {
        code: "channels_consumer_missing",
        message: "missing".to_string(),
    };
    let actual = envelope_from_klodi_err(err);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert_eq!(actual_v["details"]["consumer"], "channels");
}

// ── marketplace passthrough ──────────────────────────────────────────

#[test]
fn parity_marketplace_passthrough_preserves_server_code() {
    let expected = envelope_for("marketplace_passthrough_listing_not_owned");
    let err = KlodiError::Marketplace {
        code: "listing_not_owned_by_caller".to_string(),
        message: "Listing belongs to another user".to_string(),
        details: Some(serde_json::json!({
            "listing_id": "550e8400-e29b-41d4-a716-446655440000"
        })),
    };
    let actual = envelope_from_klodi_err(err);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert!(
        actual_v["recovery_hint"].is_null(),
        "marketplace passthrough must NOT synthesise a recovery_hint"
    );
}

// ── internal_error ───────────────────────────────────────────────────

#[test]
fn parity_internal_error_no_recovery_hint() {
    let expected = envelope_for("internal_error_generic");
    // Use a Json decode error — any "uncategorised" KlodiError variant
    // collapses to internal_error.
    let json_err = serde_json::from_str::<Value>("not-json")
        .expect_err("intentional decode failure");
    let err = KlodiError::Json(json_err);
    let actual = envelope_from_klodi_err(err);
    let actual_v = serde_json::to_value(&actual).unwrap();
    assert_eq!(actual_v["error"], expected["error"]);
    assert!(actual_v["recovery_hint"].is_null());
}

// ── Wire-format sanity ───────────────────────────────────────────────

#[test]
fn parity_serialised_envelope_has_four_keys() {
    // Whatever envelope the helper produces for any failure mode, it
    // carries the four R1 keys.
    let err = KlodiError::NotConnected;
    let env = envelope_from_klodi_err(err);
    let v = serde_json::to_value(&env).unwrap();
    let obj = v.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(keys, vec!["details", "error", "message", "recovery_hint"]);
}
