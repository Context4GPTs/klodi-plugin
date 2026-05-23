//! Tool-result envelope contract for the klodi-rust-host MCP layer.
//!
//! The architect's ADR-0011 plan locks the wire format at
//!
//! ```json
//! {"error": "<code>", "message": "<human>", "details": {...|null}, "recovery_hint": {...|null}}
//! ```
//!
//! All four keys are ALWAYS present. `details` and `recovery_hint`
//! serialise as explicit JSON `null` when absent — never elided.
//! `recovery_hint` is a value of the existing
//! [`crate::setup_status::NextAction`] discriminated union (`cli | tool
//! | shell | dialog`) or `null`.
//!
//! Production helpers live alongside `super::tools` (the dispatcher).
//! See the architect's Affected-files entry for the placement of
//! `ToolEnvelope`, `envelope_from_klodi_err`, and the `CallToolResult`
//! constructor that emits both `structured` and a JSON-stringified
//! `content[0].text` (mirrors the existing `structured_with_text`).
//!
//! This file is QA-owned during RED. The unit tests below pin the
//! contract; the expert-developer adds the production items
//! (`ToolEnvelope`, conversion impls, serialisation helpers) until the
//! tests compile and pass.

#[cfg(test)]
mod tests {
    // Production items the implementer must add to this same module:
    //
    //   pub struct ToolEnvelope {
    //       pub error: String,
    //       pub message: String,
    //       pub details: Option<serde_json::Value>,
    //       pub recovery_hint: Option<crate::setup_status::NextAction>,
    //   }
    //
    //   impl ToolEnvelope { /* `new`, `with_*` builders */ }
    //   pub fn envelope_from_klodi_err(err: klodi_nats_client::KlodiError) -> ToolEnvelope;
    //   pub fn envelope_to_call_tool_result(env: ToolEnvelope) -> rmcp::model::CallToolResult;
    //
    // Until they exist, the asserts below fail to compile — that is the
    // RED state. NEVER weaken these asserts to compile; add the
    // production items so the asserts hold.

    use super::{ToolEnvelope, envelope_from_klodi_err};
    use crate::setup_status::NextAction;
    use klodi_nats_client::KlodiError;
    use serde_json::{Value, json};

    /// R1: every envelope serialises to exactly the four named keys.
    /// `details` and `recovery_hint` are present even when null.
    #[test]
    fn envelope_serialises_all_four_keys_even_when_optional_are_null() {
        let env = ToolEnvelope {
            error: "internal_error".to_string(),
            message: "boom".to_string(),
            details: None,
            recovery_hint: None,
        };
        let v: Value = serde_json::to_value(&env).expect("envelope serialises");
        let obj = v.as_object().expect("envelope is a JSON object");
        let keys: std::collections::BTreeSet<&str> =
            obj.keys().map(String::as_str).collect();
        let expected: std::collections::BTreeSet<&str> =
            ["error", "message", "details", "recovery_hint"]
                .iter()
                .copied()
                .collect();
        assert_eq!(keys, expected, "envelope must carry exactly four keys");
        assert!(obj.get("details").map(Value::is_null).unwrap_or(false));
        assert!(obj.get("recovery_hint").map(Value::is_null).unwrap_or(false));
    }

    /// R1: `details: null` is emitted as JSON null, NEVER omitted via
    /// serde's `skip_serializing_if = "Option::is_none"`. Cross-language
    /// parity depends on every adapter producing the literal `null`.
    #[test]
    fn envelope_with_details_serialises_details_object() {
        let env = ToolEnvelope {
            error: "invalid_request".to_string(),
            message: "transaction_id is required".to_string(),
            details: Some(json!({"field": "transaction_id", "problem": "missing"})),
            recovery_hint: None,
        };
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["error"], "invalid_request");
        assert_eq!(v["details"]["field"], "transaction_id");
        assert_eq!(v["details"]["problem"], "missing");
        assert!(v["recovery_hint"].is_null(), "recovery_hint must be null, not absent");
    }

    /// R3: `recovery_hint` accepts a `NextAction::Tool` variant and
    /// round-trips to the documented JSON layout.
    #[test]
    fn envelope_recovery_hint_carries_nextaction_tool() {
        let env = ToolEnvelope {
            error: "connection_not_ready".to_string(),
            message: "klodi NATS connection is not ready".to_string(),
            details: None,
            recovery_hint: Some(NextAction::Tool {
                tool: "klodi_setup_status".to_string(),
                message: "Run klodi_setup_status to diagnose.".to_string(),
            }),
        };
        let v = serde_json::to_value(&env).unwrap();
        let hint = &v["recovery_hint"];
        assert_eq!(hint["kind"], "tool", "NextAction serialises with kind discriminant");
        assert_eq!(hint["tool"], "klodi_setup_status");
        assert!(hint["message"].is_string());
    }

    /// R3: `NextAction::Cli` variant.
    #[test]
    fn envelope_recovery_hint_carries_nextaction_cli() {
        let env = ToolEnvelope {
            error: "not_registered".to_string(),
            message: "Run klodi-register first".to_string(),
            details: None,
            recovery_hint: Some(NextAction::Cli {
                command: "klodi-zeroclaw-register".to_string(),
                message: "Run klodi-zeroclaw-register from the shell.".to_string(),
            }),
        };
        let v = serde_json::to_value(&env).unwrap();
        assert_eq!(v["recovery_hint"]["kind"], "cli");
        assert_eq!(v["recovery_hint"]["command"], "klodi-zeroclaw-register");
    }

    /// envelope_from_klodi_err: Marketplace error preserves code,
    /// message, details verbatim. recovery_hint stays None (server-side
    /// codes get no hint by default — see architect open Q2).
    #[test]
    fn envelope_from_marketplace_error_passes_through() {
        let err = KlodiError::Marketplace {
            code: "listing_not_owned_by_caller".to_string(),
            message: "Listing belongs to another user".to_string(),
            details: Some(json!({"listing_id": "abc"})),
        };
        let env = envelope_from_klodi_err(err);
        // Marketplace passthrough — code is preserved verbatim under
        // the open-Q2 default (no recovery_hint synthesised).
        assert_eq!(env.error, "listing_not_owned_by_caller");
        assert_eq!(env.message, "Listing belongs to another user");
        assert_eq!(env.details.as_ref().unwrap()["listing_id"], "abc");
        assert!(env.recovery_hint.is_none(),
            "marketplace passthrough must NOT synthesise a recovery_hint (open Q2)");
    }

    /// envelope_from_klodi_err: CredsNotFound → not_registered with the
    /// CLI recovery_hint. The host name is parameterised; the helper
    /// should not hard-code "klodi-register" — defer to the caller.
    /// (Tests confirm the code+kind, not the exact CLI string, which is
    /// set by the per-bin `register_cli` config.)
    #[test]
    fn envelope_from_creds_not_found_signals_not_registered() {
        let err = KlodiError::CredsNotFound("/tmp/nats.creds".to_string());
        let env = envelope_from_klodi_err(err);
        assert_eq!(env.error, "not_registered");
        assert!(!env.message.is_empty());
        match env.recovery_hint {
            Some(NextAction::Cli { .. }) => {}
            _ => panic!("not_registered must surface NextAction::Cli recovery_hint"),
        }
    }

    /// envelope_from_klodi_err: ConfigNotFound also resolves to
    /// not_registered (matches R4 — creds_present guard covers both
    /// halves of registration state).
    #[test]
    fn envelope_from_config_not_found_signals_not_registered() {
        let err = KlodiError::ConfigNotFound("/tmp/config.json".to_string());
        let env = envelope_from_klodi_err(err);
        assert_eq!(env.error, "not_registered");
    }

    /// envelope_from_klodi_err: NotConnected → connection_not_ready with
    /// the `klodi_setup_status` tool recovery_hint.
    #[test]
    fn envelope_from_not_connected_signals_connection_not_ready() {
        let err = KlodiError::NotConnected;
        let env = envelope_from_klodi_err(err);
        assert_eq!(env.error, "connection_not_ready");
        match env.recovery_hint {
            Some(NextAction::Tool { ref tool, .. }) if tool == "klodi_setup_status" => {}
            _ => panic!("connection_not_ready must surface tool=klodi_setup_status"),
        }
    }

    /// envelope_from_klodi_err: Setup variant carries the stable code
    /// (`notifications_consumer_missing` / `channels_consumer_missing`)
    /// and maps to `consumer_missing` with the setup_status hint.
    #[test]
    fn envelope_from_setup_error_signals_consumer_missing() {
        let err = KlodiError::Setup {
            code: "notifications_consumer_missing",
            message: "notifications consumer not provisioned".to_string(),
        };
        let env = envelope_from_klodi_err(err);
        assert_eq!(env.error, "consumer_missing");
        let details = env.details.as_ref().expect("consumer_missing has details");
        assert_eq!(details["consumer"], "notifications");
        match env.recovery_hint {
            Some(NextAction::Tool { ref tool, .. }) if tool == "klodi_setup_status" => {}
            _ => panic!("consumer_missing must surface tool=klodi_setup_status"),
        }
    }

    /// envelope_from_klodi_err: any other variant degrades to
    /// `internal_error` with no recovery_hint. The agent retries once or
    /// surfaces to the operator.
    #[test]
    fn envelope_from_unknown_error_signals_internal_error() {
        let err = KlodiError::Json(serde_json::from_str::<Value>("not-json")
            .expect_err("intentional decode failure"));
        let env = envelope_from_klodi_err(err);
        assert_eq!(env.error, "internal_error");
        assert!(env.recovery_hint.is_none(),
            "internal_error must NOT synthesise a recovery_hint");
    }

    /// Stable JSON key order is not asserted (JSON objects are unordered),
    /// but the *set of keys* is. Snapshot the canonical-key layout once
    /// and pin every adapter to it.
    #[test]
    fn envelope_keys_are_exactly_the_four_canonical_names() {
        let env = ToolEnvelope {
            error: "invalid_request".to_string(),
            message: "x".to_string(),
            details: None,
            recovery_hint: None,
        };
        let v = serde_json::to_value(&env).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, vec!["details", "error", "message", "recovery_hint"]);
    }
}
