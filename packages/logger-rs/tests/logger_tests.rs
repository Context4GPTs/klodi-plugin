//! Adversarial unit tests for the unified `KlodiLogger` (D15, Phase 4A).
//!
//! Mirrors the TS + Python halves: same redact list, same level filter,
//! same NDJSON shape. Tests are written against the public surface only
//! — never against private fields — so the contract holds even if the
//! internal struct layout shifts.
//!
//! Per `docs/plans/2026-04-26-multi-lens-review-implementation-plan.md`
//! § Phase 4A and `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`
//! § D15.

use std::collections::HashMap;
use std::sync::Arc;

use klodi_logger::{CaptureSink, KlodiLogger, LogLevel, redact_value};
use serde_json::{Value, json};

/// Build a logger wired to an in-memory sink at the requested level.
/// Returning the `Arc<CaptureSink>` lets the test inspect both buffers
/// after the logger has emitted.
fn make_logger(level: LogLevel) -> (KlodiLogger, Arc<CaptureSink>) {
    let sink = Arc::new(CaptureSink::new());
    let logger = KlodiLogger::new("test")
        .with_level(level)
        .with_sink(sink.clone());
    (logger, sink)
}

/// Parse every captured line as JSON. Panics with a clear message on
/// malformed lines — that is itself a contract failure.
fn parse_lines(buf: &[String]) -> Vec<Value> {
    buf.iter()
        .map(|s| serde_json::from_str::<Value>(s).expect("logger emitted invalid JSON"))
        .collect()
}

#[test]
fn redact_value_top_level() {
    let input = json!({
        "tool_name": "k",
        "bio": "x",
        "email": "y",
        "bearer_token": "z",
    });
    let out = redact_value(&input);
    assert_eq!(out["tool_name"], json!("k"));
    assert_eq!(out["bio"], json!("[redacted]"));
    assert_eq!(out["email"], json!("[redacted]"));
    assert_eq!(out["bearer_token"], json!("[redacted]"));
}

#[test]
fn redact_value_nested() {
    // Redacted key sits two levels deep — the walk must recurse into
    // both objects and replace the inner value.
    let input = json!({
        "outer": {
            "inner": {
                "email": "hidden@example.com",
                "tool_name": "kept",
            }
        }
    });
    let out = redact_value(&input);
    assert_eq!(out["outer"]["inner"]["email"], json!("[redacted]"));
    assert_eq!(out["outer"]["inner"]["tool_name"], json!("kept"));
}

#[test]
fn redact_value_arrays() {
    let input = json!([
        { "email": "a@x.com", "id": 1 },
        { "email": "b@x.com", "id": 2 },
    ]);
    let out = redact_value(&input);
    let arr = out.as_array().expect("expected array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["email"], json!("[redacted]"));
    assert_eq!(arr[0]["id"], json!(1));
    assert_eq!(arr[1]["email"], json!("[redacted]"));
    assert_eq!(arr[1]["id"], json!(2));
}

#[test]
fn redact_value_primitives() {
    assert_eq!(redact_value(&json!("hello")), json!("hello"));
    assert_eq!(redact_value(&json!(42)), json!(42));
    assert_eq!(redact_value(&json!(42.0)), json!(42.0));
    assert_eq!(redact_value(&json!(true)), json!(true));
    assert_eq!(redact_value(&json!(null)), json!(null));
}

#[test]
fn info_emits_ndjson_shape() {
    let (logger, sink) = make_logger(LogLevel::Info);
    let mut fields = HashMap::new();
    fields.insert("user_id".to_string(), json!("u-1"));

    logger.info("event_invoked", Some(fields));

    let stdout = sink.stdout_lines();
    assert_eq!(stdout.len(), 1, "expected exactly one stdout line");
    let lines = parse_lines(&stdout);
    let line = &lines[0];

    assert_eq!(line["level"], json!("INFO"));
    assert_eq!(line["scope"], json!("test"));
    assert_eq!(line["msg"], json!("event_invoked"));
    assert_eq!(line["fields"], json!({ "user_id": "u-1" }));
    assert!(
        line.get("error").is_none(),
        "error field must be absent when no error was passed"
    );
    // ts must be present and non-empty so log aggregation has something
    // to sort by.
    assert!(line["ts"].is_string());
    assert!(!line["ts"].as_str().unwrap().is_empty());
}

#[test]
fn info_redacts_payload() {
    let (logger, sink) = make_logger(LogLevel::Info);
    let mut fields = HashMap::new();
    fields.insert(
        "payload".to_string(),
        json!({ "secret": "should-not-leak" }),
    );

    logger.info("wake", Some(fields));

    let lines = parse_lines(&sink.stdout_lines());
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0]["fields"]["payload"],
        json!("[redacted]"),
        "payload must be replaced with the catalog placeholder at INFO"
    );
}

#[test]
fn debug_does_not_redact() {
    let (logger, sink) = make_logger(LogLevel::Debug);
    let mut fields = HashMap::new();
    fields.insert(
        "payload".to_string(),
        json!({ "secret": "visible-in-dev" }),
    );

    logger.debug("wake", Some(fields));

    let lines = parse_lines(&sink.stdout_lines());
    assert_eq!(lines.len(), 1);
    assert_eq!(
        lines[0]["fields"]["payload"],
        json!({ "secret": "visible-in-dev" }),
        "DEBUG must bypass redaction so developers see real payloads"
    );
}

#[test]
fn level_filtering_warn() {
    let (logger, sink) = make_logger(LogLevel::Warn);

    logger.debug("d", None);
    logger.info("i", None);
    logger.warn("w", None);
    logger.error_msg("e", None);

    let stdout = sink.stdout_lines();
    let stderr = sink.stderr_lines();
    assert_eq!(
        stdout.len(),
        0,
        "DEBUG and INFO must be filtered when level=WARN"
    );
    assert_eq!(stderr.len(), 2, "WARN and ERROR must both reach stderr");
}

#[test]
fn error_top_frame_only() {
    let (logger, sink) = make_logger(LogLevel::Info);

    // `std::io::Error` has no `source()` chain — perfect for asserting
    // we never leak more than the top frame.
    let io_err = std::io::Error::other("boom");
    logger.error("oops", None, Some(&io_err));

    let stderr = sink.stderr_lines();
    assert_eq!(stderr.len(), 1);
    let raw = &stderr[0];

    // Hard guard: the emitted line must be a single NDJSON record. A
    // newline inside the line means a multi-line backtrace leaked.
    assert!(
        !raw.contains('\n'),
        "log line must not embed newlines (no backtrace leak)"
    );

    let line: Value = serde_json::from_str(raw).expect("valid JSON");
    let err_obj = &line["error"];
    assert!(err_obj.is_object(), "error envelope must be present");
    // Generic `error<E>` preserves the concrete type — for `std::io::Error`
    // the last `::`-separated segment of `type_name::<E>()` is "Error".
    assert_eq!(err_obj["name"].as_str().unwrap(), "Error");
    assert_eq!(err_obj["message"], json!("boom"));
}

#[test]
fn error_dyn_falls_back_to_placeholder() {
    let (logger, sink) = make_logger(LogLevel::Error);
    let io_err = std::io::Error::other("boom");
    let dyn_err: &dyn std::error::Error = &io_err;
    logger.error_dyn("oops", None, Some(dyn_err));
    let stderr = sink.stderr_lines();
    assert_eq!(stderr.len(), 1);
    let parsed: serde_json::Value = serde_json::from_str(&stderr[0]).expect("valid json");
    let error_obj = parsed.get("error").expect("error envelope present");
    assert_eq!(error_obj["name"].as_str().unwrap(), "Error");
    assert_eq!(error_obj["message"].as_str().unwrap(), "boom");
}

#[test]
fn child_inherits_scope_level_fields() {
    let sink = Arc::new(CaptureSink::new());
    let mut parent_base = HashMap::new();
    parent_base.insert("user_id".to_string(), json!("u-1"));
    let parent = KlodiLogger::new("klodi-moltis")
        .with_level(LogLevel::Info)
        .with_sink(sink.clone())
        .with_base_fields(parent_base);

    let mut child_base = HashMap::new();
    child_base.insert("kind".to_string(), json!("wake_forwarded"));
    let child = parent.child("forwarder", Some(child_base));

    let mut call_fields = HashMap::new();
    call_fields.insert("latency_ms".to_string(), json!(12));
    child.info("invoked", Some(call_fields));

    let lines = parse_lines(&sink.stdout_lines());
    assert_eq!(lines.len(), 1);
    let line = &lines[0];
    assert_eq!(line["scope"], json!("klodi-moltis.forwarder"));
    assert_eq!(
        line["fields"],
        json!({
            "user_id": "u-1",
            "kind": "wake_forwarded",
            "latency_ms": 12,
        }),
        "child must merge parent base fields, child base fields, and call-site fields"
    );
}

#[test]
fn output_routing() {
    let (logger, sink) = make_logger(LogLevel::Debug);

    logger.debug("d", None);
    logger.info("i", None);
    logger.warn("w", None);
    logger.error_msg("e", None);

    let stdout = sink.stdout_lines();
    let stderr = sink.stderr_lines();

    assert_eq!(stdout.len(), 2, "DEBUG and INFO must land on stdout");
    assert_eq!(stderr.len(), 2, "WARN and ERROR must land on stderr");

    let stdout_lines = parse_lines(&stdout);
    let stderr_lines = parse_lines(&stderr);

    let stdout_levels: Vec<&str> = stdout_lines
        .iter()
        .map(|l| l["level"].as_str().unwrap())
        .collect();
    let stderr_levels: Vec<&str> = stderr_lines
        .iter()
        .map(|l| l["level"].as_str().unwrap())
        .collect();

    assert_eq!(stdout_levels, vec!["DEBUG", "INFO"]);
    assert_eq!(stderr_levels, vec!["WARN", "ERROR"]);
}
