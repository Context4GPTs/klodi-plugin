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
//! Cross-language parity: the Python adapter pair
//! (`klodi_nats_client.envelope`) and the openclaw TS adapter
//! (`adapters/openclaw/src/lib/envelope.ts`) emit the same four-key
//! shape under matching conditions. The shared fixture at
//! `packages/tool-catalog/tests/fixtures/envelope-golden.json` is the
//! cross-language oracle. See ADR-0011.
//!
//! Production items consumed by `super::tools::dispatch`:
//!
//! - [`ToolEnvelope`] — the wire-format struct.
//! - [`envelope_from_klodi_err`] — maps every [`klodi_nats_client::KlodiError`]
//!   variant to a stable envelope code per [R2 in the card body].
//! - [`envelope_to_call_tool_result`] — wraps the envelope into the
//!   `CallToolResult` shape rmcp serves (structured payload PLUS
//!   JSON-stringified `content[0].text`).

use crate::setup_status::NextAction;
use klodi_nats_client::KlodiError;
use rmcp::model::{CallToolResult, Content};
use serde::Serialize;
use serde_json::{Value, json};

/// Cross-language tool-result envelope. Serialises to four named keys;
/// `details` and `recovery_hint` are emitted as JSON `null` (never
/// elided) so byte-for-byte parity with the Python and TS adapters
/// holds.
#[derive(Debug, Clone, Serialize)]
pub struct ToolEnvelope {
    pub error: String,
    pub message: String,
    /// Machine-readable cause. Absent → JSON `null`.
    pub details: Option<Value>,
    /// Agent-actionable next step. Absent → JSON `null`. Drawn from the
    /// existing `NextAction` vocabulary (no new variants without an ADR
    /// amendment — R3).
    pub recovery_hint: Option<NextAction>,
}

/// Map a [`KlodiError`] into a [`ToolEnvelope`] using the R2 vocabulary
/// (see card body — closed code set). Server-side codes pass through
/// verbatim with no synthesised recovery hint (open Q2 default).
pub fn envelope_from_klodi_err(err: KlodiError) -> ToolEnvelope {
    match err {
        KlodiError::Marketplace { code, message, details } => ToolEnvelope {
            error: code,
            message,
            details,
            recovery_hint: None,
        },
        KlodiError::CredsNotFound(path) | KlodiError::ConfigNotFound(path) => ToolEnvelope {
            error: "not_registered".to_string(),
            message: format!(
                "klodi is not registered on this host (missing {path}). \
                 Run klodi-zeroclaw-register from a shell to mint credentials.",
            ),
            details: None,
            // The default CLI is zeroclaw (the canonical Rust adapter
            // for which this shared host was first wired up). Adapters
            // whose binary differs (moltis, ironclaw) override the hint
            // via `envelope_from_klodi_err_with_cli` in the dispatch
            // wrap-up. See ADR-0011.
            recovery_hint: Some(NextAction::Cli {
                command: "klodi-zeroclaw-register".to_string(),
                message:
                    "Run klodi-zeroclaw-register — opens a browser link, polls for completion, \
                     writes nats.creds + config.json."
                        .to_string(),
            }),
        },
        KlodiError::NotConnected => ToolEnvelope {
            error: "connection_not_ready".to_string(),
            message: "klodi NATS connection is not ready. \
                      Call klodi_setup_status to diagnose, then retry."
                .to_string(),
            details: None,
            recovery_hint: Some(NextAction::Tool {
                tool: "klodi_setup_status".to_string(),
                message: "Inspect setup state — connection is not ready.".to_string(),
            }),
        },
        KlodiError::Setup { code, message } => {
            let consumer = code.strip_suffix("_consumer_missing").unwrap_or("");
            ToolEnvelope {
                error: "consumer_missing".to_string(),
                message,
                // Cross-language parity: the golden fixture pins
                // `details` to `{"consumer": <name>}` only. Adding extra
                // keys here breaks the byte-for-byte JSON match adapters
                // run against the fixture.
                details: Some(json!({ "consumer": consumer })),
                recovery_hint: Some(NextAction::Tool {
                    tool: "klodi_setup_status".to_string(),
                    message: "Inspect setup state — a server-managed consumer is missing.".to_string(),
                }),
            }
        }
        other => ToolEnvelope {
            error: "internal_error".to_string(),
            message: format!("{other}"),
            details: None,
            recovery_hint: None,
        },
    }
}

/// Same as [`envelope_from_klodi_err`] but substitutes a host-specific
/// register CLI name into the `not_registered` recovery hint. Adapters
/// that pass their per-bin register-CLI name (e.g. `klodi-zeroclaw-register`)
/// surface the literal command the operator runs.
pub fn envelope_from_klodi_err_with_cli(
    err: KlodiError,
    register_cli: &str,
) -> ToolEnvelope {
    let mut env = envelope_from_klodi_err(err);
    if env.error == "not_registered" {
        env.recovery_hint = Some(NextAction::Cli {
            command: register_cli.to_string(),
            message: format!(
                "Run {register_cli} — mints nats.creds + config.json under ${{KLODI_HOME}}.",
            ),
        });
    }
    env
}

/// Wrap a [`ToolEnvelope`] into the `CallToolResult` shape rmcp serves:
/// `structured` carries the four-key JSON object for parsing; `content[0].text`
/// carries the same JSON stringified so non-structured-aware MCP clients
/// still see the envelope in the plain-text channel. Mirrors the existing
/// `structured_with_text` convention.
pub fn envelope_to_call_tool_result(env: ToolEnvelope) -> CallToolResult {
    let value = serde_json::to_value(&env)
        .unwrap_or_else(|_| json!({"error": "internal_error", "message": "envelope serialisation failed", "details": null, "recovery_hint": null}));
    let text = serde_json::to_string(&value).unwrap_or_else(|_| value.to_string());
    let mut result = CallToolResult::structured_error(value);
    result.content = vec![Content::text(text)];
    result
}

/// Build a `not_registered` envelope for a per-host bin's startup check
/// (creds or config missing on disk). The caller writes the result to
/// stderr and aborts; see the per-adapter `bin/mcp.rs` `bail!` paths.
///
/// Returns the envelope as a JSON string so the bin can `eprintln!` it
/// without bringing in this crate's serde dependency directly.
pub fn not_registered_envelope_json(register_cli: &str) -> String {
    let env = ToolEnvelope {
        error: "not_registered".to_string(),
        message: format!(
            "klodi is not registered on this host. \
             Run {register_cli} from a shell to mint nats.creds and config.json.",
        ),
        details: None,
        recovery_hint: Some(NextAction::Cli {
            command: register_cli.to_string(),
            message: format!(
                "Run {register_cli} — opens a browser link, polls for completion, \
                 writes nats.creds + config.json.",
            ),
        }),
    };
    serde_json::to_string(&env)
        .unwrap_or_else(|_| format!("{{\"error\":\"not_registered\",\"message\":\"missing creds; run {register_cli}\",\"details\":null,\"recovery_hint\":null}}"))
}

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
