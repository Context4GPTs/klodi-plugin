//! Pre-call guard contract for the klodi-rust-host MCP layer.
//!
//! Three guards run in fixed order before any NATS request issues:
//!
//!   1. `creds_present` — `${klodi_home}/{nats.creds, config.json}` both
//!      exist. Failure → `not_registered` + `NextAction::Cli`.
//!   2. `connection_ready` — the lazy NATS client is connected. Failure
//!      → `connection_not_ready` + `NextAction::Tool {
//!      klodi_setup_status }`.
//!   3. `args_well_formed` — adapter-side schema check. Failure →
//!      `invalid_request` + `details: {field, problem}` + no
//!      recovery_hint (agent re-calls with corrected args).
//!
//! Guards fail FAST — no NATS connection opened, no filesystem mutated,
//! no marketplace request issued. First failure short-circuits; later
//! guards do not execute (R4).
//!
//! `host_authorization` (R-arch) is reserved as an optional pre-flight
//! hook for adapters whose host can deny a tool independently (e.g. the
//! ZeroClaw gateway bearer). Not in scope for the shared parity contract.
//!
//! See ADR-0011.

use super::envelope::{ToolEnvelope, invalid_request_envelope};
use crate::setup_status::NextAction;
use serde_json::{Map, Value};
use std::path::Path;

/// Argument-shape vocabulary for `guard_args`. Mirrors the small set the
/// rmcp catalog schemas actually use today; widen only when a new
/// catalog tool needs a new type.
#[derive(Debug, Clone, Copy)]
pub enum ArgKind {
    /// UUID v4 string (matches catalog's `^[0-9a-f]{8}-…` pattern).
    Uuid,
    /// Any non-null string. Empty string is allowed.
    #[allow(dead_code)]
    String,
    /// Integer (JSON number with no fractional component).
    #[allow(dead_code)]
    Integer,
    /// Boolean.
    #[allow(dead_code)]
    Bool,
    /// Non-empty string. Empty string rejected with `problem: "empty"`.
    NonEmptyString,
}

const UUID_V4_PATTERN: &str =
    "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/// `creds_present` guard. Returns `None` when both
/// `${klodi_home}/nats.creds` and `${klodi_home}/config.json` exist as
/// regular files; otherwise returns a `not_registered` envelope.
///
/// `register_cli` is the per-host CLI name (`klodi-zeroclaw-register`,
/// `klodi-moltis-register`, …) substituted into the `NextAction::Cli`
/// recovery hint so the agent surfaces the literal command the operator
/// runs (R8).
pub fn guard_creds(klodi_home: &Path, register_cli: &str) -> Option<ToolEnvelope> {
    let creds_path = klodi_home.join("nats.creds");
    let config_path = klodi_home.join("config.json");
    let creds_present = creds_path.is_file();
    let config_present = config_path.is_file();
    if creds_present && config_present {
        return None;
    }
    Some(ToolEnvelope {
        error: "not_registered".to_string(),
        message: format!(
            "klodi is not registered on this host. \
             Run {register_cli} from a shell to mint nats.creds and config.json under \
             ${{KLODI_HOME}}.",
        ),
        details: None,
        recovery_hint: Some(NextAction::Cli {
            command: register_cli.to_string(),
            message: format!(
                "Run {register_cli} — opens a browser link, polls for completion, \
                 writes nats.creds + config.json.",
            ),
        }),
    })
}

/// `args_well_formed` guard. Walks the `required` list in order and
/// returns the FIRST envelope describing a missing / wrong-type / empty
/// field. R4 short-circuit: the agent sees one problem at a time and
/// fixes them in catalog-declared order.
pub fn guard_args(
    args: &Map<String, Value>,
    required: &[(&str, ArgKind)],
) -> Option<ToolEnvelope> {
    for (field, kind) in required {
        match args.get(*field) {
            None => {
                return Some(invalid_request_envelope(field, "missing"));
            }
            Some(Value::Null) => {
                return Some(invalid_request_envelope(field, "missing"));
            }
            Some(value) => {
                if let Some(problem) = check_value(value, *kind) {
                    return Some(invalid_request_envelope(field, problem));
                }
            }
        }
    }
    None
}

/// Synchronous pre-call guard composition: creds → args. The
/// `connection_ready` guard requires the async handler, so it composes
/// in the dispatcher (`tools::dispatch`) rather than here; this helper
/// covers the test path and any future synchronous caller.
pub fn run_pre_call_guards(
    klodi_home: &Path,
    register_cli: &str,
    args: &Map<String, Value>,
    required: &[(&str, ArgKind)],
) -> Option<ToolEnvelope> {
    if let Some(env) = guard_creds(klodi_home, register_cli) {
        return Some(env);
    }
    guard_args(args, required)
}

fn check_value(value: &Value, kind: ArgKind) -> Option<&'static str> {
    match kind {
        ArgKind::Uuid => match value.as_str() {
            None => Some("wrong_type"),
            Some("") => Some("empty"),
            Some(s) if !is_uuid_v4(s) => Some("wrong_type"),
            Some(_) => None,
        },
        ArgKind::String => {
            if value.as_str().is_none() {
                Some("wrong_type")
            } else {
                None
            }
        }
        ArgKind::NonEmptyString => match value.as_str() {
            None => Some("wrong_type"),
            Some("") => Some("empty"),
            Some(_) => None,
        },
        ArgKind::Integer => {
            if value.as_i64().is_none() {
                Some("wrong_type")
            } else {
                None
            }
        }
        ArgKind::Bool => {
            if value.as_bool().is_none() {
                Some("wrong_type")
            } else {
                None
            }
        }
    }
}

fn is_uuid_v4(s: &str) -> bool {
    // Hand-rolled instead of pulling in a regex crate — the catalog's
    // UUID-v4 pattern is small and fixed. See ADR-0011.
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if *b != b'-' {
                    return false;
                }
            }
            14 => {
                if *b != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(*b, b'8' | b'9' | b'a' | b'b') {
                    return false;
                }
            }
            _ => {
                if !matches!(*b, b'0'..=b'9' | b'a'..=b'f') {
                    return false;
                }
            }
        }
    }
    let _ = UUID_V4_PATTERN; // doc reference; lint can't see the pattern
    true
}

#[cfg(test)]
mod tests {
    // Production items the implementer must add to this same module:
    //
    //   pub fn guard_creds(klodi_home: &std::path::Path,
    //                      register_cli: &str) -> Option<ToolEnvelope>;
    //   pub async fn guard_connection(handler: &super::handler::KlodiMcpHandler)
    //       -> Option<ToolEnvelope>;
    //   pub fn guard_args(args: &serde_json::Map<String, serde_json::Value>,
    //                     required: &[(&str, ArgKind)]) -> Option<ToolEnvelope>;
    //   pub enum ArgKind { Uuid, String, Integer, Bool, NonEmptyString }
    //
    //   /// Synchronous part of the chain: creds_present → args_well_formed.
    //   /// Used in this test module; the live dispatch path composes
    //   /// `run_pre_call_guards` + `guard_connection` in `tools::dispatch`.
    //   pub fn run_pre_call_guards(klodi_home: &std::path::Path,
    //                              register_cli: &str,
    //                              args: &serde_json::Map<String, serde_json::Value>,
    //                              required: &[(&str, ArgKind)])
    //       -> Option<ToolEnvelope>;
    //
    // The architect's plan also calls for `register_cli: &str` to feed
    // into the `not_registered` NextAction::Cli. The signature below
    // takes that as a parameter so each adapter binary supplies its
    // own host name.

    use super::{ArgKind, guard_args, guard_creds, run_pre_call_guards};
    use super::super::envelope::ToolEnvelope;
    use crate::setup_status::NextAction;
    use serde_json::{Map, json};
    use tempfile::tempdir;

    /// guard_creds returns `None` when both creds and config files exist.
    #[test]
    fn guard_creds_returns_none_when_both_files_present() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nats.creds"), "fake-creds").unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let env = guard_creds(dir.path(), "klodi-zeroclaw-register");
        assert!(env.is_none(), "guard passes when both files exist");
    }

    /// guard_creds returns `not_registered` when nats.creds is missing.
    #[test]
    fn guard_creds_rejects_when_creds_file_missing() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let env: ToolEnvelope = guard_creds(dir.path(), "klodi-zeroclaw-register")
            .expect("guard fails when nats.creds is absent");
        assert_eq!(env.error, "not_registered");
        // R8: recovery_hint references the host's register CLI verbatim
        // — the agent surfaces the literal command the operator runs.
        match env.recovery_hint {
            Some(NextAction::Cli { ref command, .. }) => {
                assert_eq!(command, "klodi-zeroclaw-register");
            }
            _ => panic!("not_registered must carry NextAction::Cli"),
        }
        // R4: guard rejection must NOT open a NATS connection or any
        // other side-channel. The test sets up no client; if the guard
        // tried to dial, this test would hang or panic.
        assert!(env.details.is_none() || env.details.as_ref().unwrap().is_object());
    }

    /// guard_creds returns `not_registered` when config.json is missing.
    #[test]
    fn guard_creds_rejects_when_config_file_missing() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nats.creds"), "fake-creds").unwrap();
        let env = guard_creds(dir.path(), "klodi-moltis-register")
            .expect("guard fails when config.json is absent");
        assert_eq!(env.error, "not_registered");
        match env.recovery_hint {
            Some(NextAction::Cli { ref command, .. }) => {
                assert_eq!(command, "klodi-moltis-register");
            }
            _ => panic!("not_registered must carry NextAction::Cli with per-host CLI"),
        }
    }

    /// guard_creds returns `not_registered` when both files are missing.
    /// R4 — first guard fires, later guards do not run.
    #[test]
    fn guard_creds_rejects_when_both_files_missing() {
        let dir = tempdir().unwrap();
        let env = guard_creds(dir.path(), "klodi-zeroclaw-register")
            .expect("guard fails when both files absent");
        assert_eq!(env.error, "not_registered");
    }

    /// guard_args returns `None` when every required field is present
    /// and well-typed.
    #[test]
    fn guard_args_passes_well_formed_payload() {
        let mut args = Map::new();
        args.insert("transaction_id".to_string(),
            json!("550e8400-e29b-41d4-a716-446655440000"));
        let env = guard_args(&args, &[("transaction_id", ArgKind::Uuid)]);
        assert!(env.is_none(), "well-formed args pass the guard");
    }

    /// guard_args returns `invalid_request` when a required field is missing.
    /// R2: error code is `invalid_request`. details.field names the
    /// offending field; details.problem is `"missing"`. No recovery_hint.
    #[test]
    fn guard_args_rejects_missing_required_field() {
        let args = Map::new();
        let env: ToolEnvelope =
            guard_args(&args, &[("transaction_id", ArgKind::Uuid)])
                .expect("missing field is rejected");
        assert_eq!(env.error, "invalid_request");
        let details = env.details.as_ref().expect("invalid_request carries details");
        assert_eq!(details["field"], "transaction_id");
        assert_eq!(details["problem"], "missing");
        assert!(env.recovery_hint.is_none(),
            "invalid_request must NOT carry a recovery_hint (agent re-calls)");
    }

    /// guard_args returns `invalid_request` with problem=wrong_type
    /// when a string field receives an integer.
    #[test]
    fn guard_args_rejects_wrong_type_field() {
        let mut args = Map::new();
        args.insert("transaction_id".to_string(), json!(42));
        let env = guard_args(&args, &[("transaction_id", ArgKind::Uuid)])
            .expect("wrong-type field is rejected");
        assert_eq!(env.error, "invalid_request");
        let details = env.details.as_ref().unwrap();
        assert_eq!(details["field"], "transaction_id");
        assert_eq!(details["problem"], "wrong_type");
    }

    /// guard_args returns `invalid_request` with problem=empty when a
    /// non-empty string field receives "".
    #[test]
    fn guard_args_rejects_empty_string_field() {
        let mut args = Map::new();
        args.insert("content".to_string(), json!(""));
        let env = guard_args(&args, &[("content", ArgKind::NonEmptyString)])
            .expect("empty string is rejected");
        assert_eq!(env.error, "invalid_request");
        let details = env.details.as_ref().unwrap();
        assert_eq!(details["field"], "content");
        assert_eq!(details["problem"], "empty");
    }

    /// guard_args validates Uuid v4 format (used by tx/listing/offer ids).
    #[test]
    fn guard_args_rejects_malformed_uuid() {
        let mut args = Map::new();
        args.insert("transaction_id".to_string(), json!("not-a-uuid"));
        let env = guard_args(&args, &[("transaction_id", ArgKind::Uuid)])
            .expect("malformed uuid is rejected");
        assert_eq!(env.error, "invalid_request");
        let details = env.details.as_ref().unwrap();
        assert_eq!(details["field"], "transaction_id");
        assert_eq!(details["problem"], "wrong_type");
    }

    /// guard_args reports the FIRST failing field — not a list, not
    /// every problem. R4 first-failure-short-circuits applies to args
    /// validation too.
    #[test]
    fn guard_args_short_circuits_at_first_failure() {
        let mut args = Map::new();
        // channel_id missing, content empty — guard reports channel_id
        // because it's first in the required list.
        args.insert("content".to_string(), json!(""));
        let env = guard_args(
            &args,
            &[
                ("channel_id", ArgKind::Uuid),
                ("content", ArgKind::NonEmptyString),
            ],
        )
        .expect("missing channel_id is rejected first");
        let details = env.details.as_ref().unwrap();
        assert_eq!(details["field"], "channel_id");
        assert_eq!(details["problem"], "missing");
    }

    /// R4 guard ordering: creds-first. If creds are missing AND args
    /// are malformed, the envelope reports `not_registered`, not
    /// `invalid_request`. Tests `run_guards` which composes the chain.
    #[test]
    fn run_guards_reports_creds_failure_before_args_failure() {
        let dir = tempdir().unwrap();
        // No creds files written. Args also empty — but creds guard
        // fires first.
        let args = Map::new();
        let env = run_pre_call_guards(
            dir.path(),
            "klodi-zeroclaw-register",
            &args,
            &[("transaction_id", ArgKind::Uuid)],
        )
        .expect("run_guards rejects when creds missing");
        assert_eq!(env.error, "not_registered",
            "creds guard must fire before args guard");
    }

    /// R4 guard ordering — when creds pass but args fail, the envelope
    /// reports `invalid_request`. Confirms args guard is reached after
    /// creds pass (no unconditional skip).
    #[test]
    fn run_guards_reaches_args_after_creds_pass() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nats.creds"), "fake-creds").unwrap();
        std::fs::write(dir.path().join("config.json"), "{}").unwrap();
        let args = Map::new();
        let env = run_pre_call_guards(
            dir.path(),
            "klodi-zeroclaw-register",
            &args,
            &[("transaction_id", ArgKind::Uuid)],
        )
        .expect("run_guards rejects args when creds pass");
        assert_eq!(env.error, "invalid_request");
    }

    /// Side-effect freedom — guards never write to the filesystem or
    /// open network connections. Tested indirectly: the tempdir is
    /// observed before and after; no new entries beyond what the test
    /// itself created.
    #[test]
    fn guards_never_mutate_klodi_home() {
        let dir = tempdir().unwrap();
        let before: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        let args = Map::new();
        let _ = run_pre_call_guards(
            dir.path(),
            "klodi-zeroclaw-register",
            &args,
            &[("transaction_id", ArgKind::Uuid)],
        );
        let after: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .collect();
        assert_eq!(before, after,
            "guards must not create files under ${{KLODI_HOME}}");
    }
}
