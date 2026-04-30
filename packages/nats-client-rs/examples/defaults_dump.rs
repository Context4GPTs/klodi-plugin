//! Cross-language defaults equivalence example (Rust half).
//!
//! Per design Section 6 / P-DEFAULTS axis (P1-16 regression guard):
//! KLODI_DEFAULT_API_URL and KLODI_DEFAULT_NATS_URL must resolve to
//! byte-identical strings across TS / Py / Rust. The catalog at
//! `klodi-plugin/packages/tool-catalog/src/index.ts` is the source of
//! truth; Rust consumes codegen output via
//! `klodi_nats_client::catalog::*`.
//!
//! Imports the constants and prints the canonical payload to stdout.
//! The orchestrator at
//! `tests/integration/nats-infra/cross-language-wire/orchestrator-defaults.py`
//! compares the three payloads for byte equality.

use klodi_nats_client::{KLODI_DEFAULT_API_URL, KLODI_DEFAULT_NATS_URL};

fn main() {
    // Hand-rolled JSON keeps deps minimal (no serde_json::Value detour)
    // and emits sorted keys + compact separators directly — matching
    // the canonical form the orchestrator computes for comparison.
    println!(
        r#"{{"api_url":"{api}","nats_url":"{nats}"}}"#,
        api = KLODI_DEFAULT_API_URL,
        nats = KLODI_DEFAULT_NATS_URL,
    );
}
