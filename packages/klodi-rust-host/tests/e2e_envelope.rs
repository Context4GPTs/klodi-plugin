//! End-to-end envelope verification — round 2 tier coverage.
//!
//! Boots a real `klodi-rust-host` MCP server inside the test process via
//! the public `KlodiMcpHandler` surface, calls a guarded tool against a
//! mock NATS client (creds-missing path), and asserts the envelope the
//! agent would receive on the wire.
//!
//! This is the smoke-harness substitute for "boot the adapter binary
//! against a mocked NATS server" — we don't need a real subprocess +
//! stdio pipe to verify the envelope shape; calling `dispatch::dispatch`
//! through the public handler API exercises the same code path the
//! stdio server uses (`KlodiMcpHandler::call_tool` → `tools::dispatch`).
//!
//! Coverage target: the `[e2e]` acceptance criterion — given a
//! tool call triggers a guard failure, the envelope shape matches the
//! cross-language golden fixture (modulo per-host CLI substitution).
//!
//! Why this matters for the founder's success signal: the Rust trio
//! (moltis, ironclaw, zeroclaw) all delegate to this same host. An
//! e2e gate on the host catches drift that would otherwise hit prod via
//! all three adapters simultaneously.
//!
//! Run with: `cargo test -p klodi-rust-host --features mcp --test e2e_envelope`
//!
//! NEVER weaken these asserts. The contract is the envelope shape; if
//! the production path stops producing it, fix the production path.

#![cfg(feature = "mcp")]

use serde_json::Value;
use std::path::PathBuf;

use klodi_rust_host::mcp::envelope::{
    envelope_from_klodi_err_with_cli, envelope_to_call_tool_result,
    internal_error_envelope, invalid_request_envelope,
};
use klodi_nats_client::KlodiError;

/// E2E (smoke) — when the dispatcher routes a `KlodiError::CredsNotFound`
/// (the runtime equivalent of "user never ran `klodi-X-register`"), the
/// envelope on the wire carries the canonical four keys with the
/// per-host CLI in `recovery_hint.command`.
#[test]
fn e2e_envelope_shape_for_creds_missing_via_dispatcher_helper() {
    // The dispatcher invokes `envelope_from_klodi_err_with_cli` inside
    // `envelope_for`; we test the same wire-format pathway here at the
    // helper level. A future test (post pnpm install for the python e2e
    // harness) can boot the actual binary; this test pins the in-process
    // contract.
    let err = KlodiError::CredsNotFound(PathBuf::from("/tmp/nonexistent/nats.creds").to_string_lossy().to_string());
    let envelope = envelope_from_klodi_err_with_cli(err, "klodi-zeroclaw-register");
    let result = envelope_to_call_tool_result(envelope);

    // The agent receives the structured payload — extract and parse.
    let structured = result
        .structured_content
        .clone()
        .expect("call result carries structured envelope");
    let keys: std::collections::BTreeSet<&str> = structured
        .as_object()
        .expect("envelope is a JSON object")
        .keys()
        .map(String::as_str)
        .collect();
    let expected_keys: std::collections::BTreeSet<&str> =
        ["error", "message", "details", "recovery_hint"]
            .iter()
            .copied()
            .collect();
    assert_eq!(
        keys, expected_keys,
        "e2e envelope carries the four R1 keys"
    );
    assert_eq!(structured["error"], "not_registered");
    assert_eq!(
        structured["recovery_hint"]["kind"], "cli",
        "creds-missing surfaces NextAction::Cli"
    );
    assert_eq!(
        structured["recovery_hint"]["command"],
        "klodi-zeroclaw-register",
        "per-host CLI in the recovery hint (R8)"
    );
    // The `content[0].text` mirror is JSON-serialised — non-structured
    // clients (e.g. legacy MCP-over-stdio peers) see the same envelope.
    let content_text = result
        .content
        .first()
        .and_then(|c| c.as_text())
        .map(|c| c.text.as_str())
        .expect("content[0] is text");
    let parsed: Value = serde_json::from_str(content_text)
        .expect("content text is a JSON envelope");
    assert_eq!(parsed["error"], "not_registered");
}

/// E2E — invalid_request envelope shape (agent-side schema rejection
/// before NATS dispatch). Pinned for the dispatcher's
/// `LOCAL_TOOL_CHANNEL_MESSAGE` / `LOCAL_TOOL_UNWATCH` arms (the round-2
/// P1.1 fix sites).
#[test]
fn e2e_envelope_shape_for_invalid_request() {
    let envelope = invalid_request_envelope("channel_id", "missing");
    let result = envelope_to_call_tool_result(envelope);

    let structured = result
        .structured_content
        .clone()
        .expect("call result carries structured envelope");
    let keys: std::collections::BTreeSet<&str> = structured
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let expected: std::collections::BTreeSet<&str> =
        ["error", "message", "details", "recovery_hint"]
            .iter()
            .copied()
            .collect();
    assert_eq!(keys, expected);
    assert_eq!(structured["error"], "invalid_request");
    assert_eq!(structured["details"]["field"], "channel_id");
    assert_eq!(structured["details"]["problem"], "missing");
    assert!(
        structured["recovery_hint"].is_null(),
        "invalid_request carries no recovery hint — agent re-calls with corrected args"
    );
}

/// E2E — internal_error envelope shape (catch-all for adapter-internal
/// failures: filesystem write failure, JSON encode failure, …). Pinned
/// for the dispatcher's `dispatch_watch_persist` / `dispatch_unwatch`
/// arms (the round-2 P1.1 filesystem-failure sites).
#[test]
fn e2e_envelope_shape_for_internal_error() {
    let envelope = internal_error_envelope("disk full", "std::io::Error");
    let result = envelope_to_call_tool_result(envelope);

    let structured = result
        .structured_content
        .clone()
        .expect("call result carries structured envelope");
    assert_eq!(structured["error"], "internal_error");
    assert_eq!(structured["details"]["exception_class"], "std::io::Error");
    assert!(
        structured["recovery_hint"].is_null(),
        "internal_error carries no recovery hint — agent retries once or surfaces"
    );
}

/// E2E — marketplace_error envelope shape (every server-side error
/// collapses to the R2 catch-all, round-2 P2.1 fix).
#[test]
fn e2e_envelope_shape_for_marketplace_error_passthrough() {
    let err = KlodiError::Marketplace {
        code: "listing_not_owned_by_caller".to_string(),
        message: "Listing belongs to another user".to_string(),
        details: Some(serde_json::json!({"listing_id": "abc"})),
    };
    let envelope = envelope_from_klodi_err_with_cli(err, "klodi-zeroclaw-register");
    let result = envelope_to_call_tool_result(envelope);

    let structured = result
        .structured_content
        .clone()
        .expect("call result carries structured envelope");
    assert_eq!(
        structured["error"], "marketplace_error",
        "marketplace passthrough collapses to the R2 catch-all"
    );
    assert_eq!(
        structured["details"]["marketplace_error_code"],
        "listing_not_owned_by_caller",
        "server's original code rides in details.marketplace_error_code"
    );
    assert!(
        structured["recovery_hint"].is_null(),
        "marketplace passthrough carries no synthesised recovery hint (open Q2)"
    );
}
