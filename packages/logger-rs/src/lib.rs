//! `klodi-logger` — Rust implementation of the unified `KlodiLogger`
//! contract from `@klodi/tool-catalog/logging` (D15).
//!
//! One contract per language (TS / Py / Rust). Three implementations.
//! Operator log aggregation parses one NDJSON shape regardless of
//! source.
//!
//! Public surface:
//!
//!   - `KlodiLogger` — `error/warn/info/debug` + `child`.
//!   - `level_from_env` — reads `LOG_LEVEL` (catalog default fallback).
//!   - `redact_value` — exposed for tests + threshold-counter site.
//!
//! The redaction walk is recursive — nested JSON objects are walked and
//! any key in `REDACTED_FIELD_NAMES` has its value replaced with the
//! catalog placeholder (`[redacted]`) at INFO/WARN/ERROR. DEBUG bypasses
//! redaction so developers see full payloads locally.
//!
//! Per **D § D15** in
//! `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`.

use std::collections::HashMap;
use std::env;
use std::io::{self, Write};
use std::sync::Mutex;

use klodi_nats_client::catalog::logging as contract;
use serde::Serialize;
use serde_json::{Map, Value};

pub use contract::LogLevel;
pub use contract::{
    CALL_SITE_TYPES, DEFAULT_LOG_LEVEL, LOG_LEVELS, REDACTED_FIELD_NAMES, REDACTION_PLACEHOLDER,
    required_fields_by_site,
};

/// One NDJSON line emitted by the logger. Mirrors `KlodiLogLine` in TS.
#[derive(Debug, Serialize)]
pub struct KlodiLogLine<'a> {
    pub ts: String,
    pub level: &'a str,
    pub scope: &'a str,
    pub msg: &'a str,
    pub fields: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<KlodiErrorEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct KlodiErrorEnvelope {
    pub name: String,
    pub message: String,
    pub top_frame: String,
}

/// Sink trait — tests plug in an in-memory buffer; the default sink
/// writes to stdout/stderr.
pub trait LoggerSink: Send + Sync {
    fn write(&self, line: &str);
    fn write_error(&self, line: &str);
}

struct StdSink;

impl LoggerSink for StdSink {
    fn write(&self, line: &str) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{line}");
    }

    fn write_error(&self, line: &str) {
        let mut err = io::stderr().lock();
        let _ = writeln!(err, "{line}");
    }
}

/// Thread-safe in-memory sink — default for tests.
#[derive(Default)]
pub struct CaptureSink {
    pub stdout: Mutex<Vec<String>>,
    pub stderr: Mutex<Vec<String>>,
}

impl CaptureSink {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn stdout_lines(&self) -> Vec<String> {
        self.stdout.lock().unwrap().clone()
    }

    pub fn stderr_lines(&self) -> Vec<String> {
        self.stderr.lock().unwrap().clone()
    }
}

impl LoggerSink for CaptureSink {
    fn write(&self, line: &str) {
        self.stdout.lock().unwrap().push(line.to_string());
    }

    fn write_error(&self, line: &str) {
        self.stderr.lock().unwrap().push(line.to_string());
    }
}

/// Read `LOG_LEVEL` from environment; fall back to the catalog default
/// when unset or unrecognised.
pub fn level_from_env() -> LogLevel {
    match env::var("LOG_LEVEL") {
        Ok(raw) => contract::LogLevel::parse_str(raw.to_uppercase().as_str()).unwrap_or(DEFAULT_LOG_LEVEL),
        Err(_) => DEFAULT_LOG_LEVEL,
    }
}

/// Recursively replace redacted-field values with the placeholder.
/// Pure function — never mutates the input.
pub fn redact_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = Map::with_capacity(map.len());
            for (key, val) in map.iter() {
                if REDACTED_FIELD_NAMES.contains(&key.as_str()) {
                    out.insert(key.clone(), Value::String(REDACTION_PLACEHOLDER.to_string()));
                } else {
                    out.insert(key.clone(), redact_value(val));
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(redact_value).collect()),
        _ => value.clone(),
    }
}

/// Convenience: redact a `HashMap<String, Value>` directly. Used by the
/// adapters that build fields as a HashMap before emitting.
pub fn redact_fields(fields: &HashMap<String, Value>) -> Value {
    let mut map = Map::with_capacity(fields.len());
    for (key, val) in fields.iter() {
        if REDACTED_FIELD_NAMES.contains(&key.as_str()) {
            map.insert(key.clone(), Value::String(REDACTION_PLACEHOLDER.to_string()));
        } else {
            map.insert(key.clone(), redact_value(val));
        }
    }
    Value::Object(map)
}

/// `KlodiLogger` — emit NDJSON lines that match the `KlodiLogLine`
/// shape. Construct one per scope; use `child(extra_scope, base_fields)`
/// for sub-scopes.
pub struct KlodiLogger {
    scope: String,
    level: LogLevel,
    sink: std::sync::Arc<dyn LoggerSink>,
    base_fields: HashMap<String, Value>,
}

impl KlodiLogger {
    pub fn new(scope: impl Into<String>) -> Self {
        Self {
            scope: scope.into(),
            level: level_from_env(),
            sink: std::sync::Arc::new(StdSink),
            base_fields: HashMap::new(),
        }
    }

    pub fn with_level(mut self, level: LogLevel) -> Self {
        self.level = level;
        self
    }

    pub fn with_sink(mut self, sink: std::sync::Arc<dyn LoggerSink>) -> Self {
        self.sink = sink;
        self
    }

    pub fn with_base_fields(mut self, base_fields: HashMap<String, Value>) -> Self {
        self.base_fields = base_fields;
        self
    }

    /// Emit an ERROR-level line. Generic over the error type so the
    /// concrete type name lands in `error.name` (mirrors TS `err.name`
    /// and Py `err.__class__.__name__`). Trait objects collapse the
    /// type info, so `&dyn Error` callers should use `error_dyn()`
    /// (which falls back to a `"Error"` placeholder).
    pub fn error<E: std::error::Error>(
        &self,
        msg: &str,
        fields: Option<HashMap<String, Value>>,
        err: Option<&E>,
    ) {
        self.emit(LogLevel::Error, msg, fields, err.map(describe_error));
    }

    /// Trait-object fallback for callers that already hold a
    /// `&dyn std::error::Error`. The concrete type name is unavailable
    /// behind the dyn boundary, so `error.name` is set to `"Error"`.
    pub fn error_dyn(
        &self,
        msg: &str,
        fields: Option<HashMap<String, Value>>,
        err: Option<&dyn std::error::Error>,
    ) {
        self.emit(LogLevel::Error, msg, fields, err.map(describe_error_dyn));
    }

    pub fn warn(&self, msg: &str, fields: Option<HashMap<String, Value>>) {
        self.emit(LogLevel::Warn, msg, fields, None);
    }

    pub fn info(&self, msg: &str, fields: Option<HashMap<String, Value>>) {
        self.emit(LogLevel::Info, msg, fields, None);
    }

    pub fn debug(&self, msg: &str, fields: Option<HashMap<String, Value>>) {
        self.emit(LogLevel::Debug, msg, fields, None);
    }

    /// Emit an ERROR-level line without an error envelope.
    pub fn error_msg(&self, msg: &str, fields: Option<HashMap<String, Value>>) {
        self.emit(LogLevel::Error, msg, fields, None);
    }

    pub fn child(
        &self,
        extra_scope: &str,
        base_fields: Option<HashMap<String, Value>>,
    ) -> KlodiLogger {
        let mut merged = self.base_fields.clone();
        if let Some(extra) = base_fields {
            for (k, v) in extra {
                merged.insert(k, v);
            }
        }
        KlodiLogger {
            scope: format!("{}.{}", self.scope, extra_scope),
            level: self.level,
            sink: self.sink.clone(),
            base_fields: merged,
        }
    }

    fn emit(
        &self,
        level: LogLevel,
        msg: &str,
        fields: Option<HashMap<String, Value>>,
        error: Option<KlodiErrorEnvelope>,
    ) {
        if level.rank() < self.level.rank() {
            return;
        }
        let mut merged = self.base_fields.clone();
        if let Some(extra) = fields {
            for (k, v) in extra {
                merged.insert(k, v);
            }
        }
        let emitted_fields = if matches!(level, LogLevel::Debug) {
            // Build a JSON object directly without redaction.
            let mut obj = Map::with_capacity(merged.len());
            for (key, val) in merged {
                obj.insert(key, val);
            }
            Value::Object(obj)
        } else {
            redact_fields(&merged)
        };
        let line = KlodiLogLine {
            ts: now_iso(),
            level: level.as_str(),
            scope: &self.scope,
            msg,
            fields: emitted_fields,
            error,
        };
        let serialised = serde_json::to_string(&line).unwrap_or_else(|_| String::from("{}"));
        match level {
            LogLevel::Error | LogLevel::Warn => self.sink.write_error(&serialised),
            _ => self.sink.write(&serialised),
        }
    }
}

fn now_iso() -> String {
    use chrono::Utc;
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Build the error envelope for a concretely-typed error. Generic
/// dispatch yields the concrete type name in `error.name` (mirrors TS
/// `err.name` and Py `err.__class__.__name__`).
fn describe_error<E: std::error::Error>(err: &E) -> KlodiErrorEnvelope {
    let name = std::any::type_name::<E>()
        .rsplit("::")
        .next()
        .unwrap_or("Error")
        .to_string();
    KlodiErrorEnvelope {
        name,
        message: err.to_string(),
        // Rust std errors don't carry source-line info without `Backtrace`;
        // capture the immediate `source()` chain head as the closest
        // analogue to a "top frame". Empty when there's no source.
        top_frame: err
            .source()
            .map(|inner| inner.to_string())
            .unwrap_or_default(),
    }
}

/// Trait-object fallback. The concrete type is erased behind `&dyn`,
/// so `name` collapses to a placeholder. Callers that have access to
/// the concrete type should use the generic `describe_error` instead.
fn describe_error_dyn(err: &dyn std::error::Error) -> KlodiErrorEnvelope {
    KlodiErrorEnvelope {
        name: "Error".to_string(),
        message: err.to_string(),
        top_frame: err
            .source()
            .map(|inner| inner.to_string())
            .unwrap_or_default(),
    }
}
