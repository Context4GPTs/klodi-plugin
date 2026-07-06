//! Cross-language search-payload parity — Rust shared-host consumer (RED).
//!
//! Loads `packages/tool-catalog/tests/fixtures/search-payload-golden.json`
//! and asserts that, for every input case, the Rust shared host's
//! passthrough dispatcher (`dispatch_passthrough` for `ToolName::KlodiSearch`
//! / `ToolName::KlodiSearchesCreate`) builds an on-wire NATS request
//! payload byte-equal to the fixture's `expected_wire_payload`.
//!
//! This is the SC-parity.{1,2} acceptance gate at the per-stack level
//! for the Rust trio (moltis / ironclaw / zeroclaw via
//! `klodi-rust-host`).
//!
//! Coverage scope: the request-payload-construction site at
//! `packages/klodi-rust-host/src/mcp/tools.rs:271` (`let payload =
//! Value::Object(args);`) is the ONE deterministic transform from
//! `JsonObject` input to the `Value` sent to `client.request`. There
//! is no compaction, no normalisation, no default-filling — by design
//! the tool layer is a thin pass-through. This test pins that contract.
//!
//! The architect's discovery handoff (PO open Q5 → architect call):
//! "dev introduces a thin per-stack capture helper inside each adapter's
//! existing test-helpers directory". For Rust, the dispatcher's
//! payload-construction is a one-liner — exposing it as a pure helper
//! makes the contract testable without dialing NATS or mocking the
//! `KlodiClient`. The test below imports
//! `klodi_rust_host::mcp::tools::payload_for_passthrough` (the helper
//! the dev introduces during GREEN). Until that import resolves, this
//! test fails to compile — that is the RED state.
//!
//! Run with:
//!
//!     cargo test -p klodi-rust-host --features mcp --test search_payload_parity
//!
//! Per the `adversarial-testing` skill: NEVER weaken these asserts to
//! compile / pass. The fixture IS the contract; the implementation must
//! match the spec.

#![cfg(feature = "mcp")]

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use serde_json::{Map, Value};

// The implementer must `pub use` (or `pub`-mod + `pub fn`) the
// `payload_for_passthrough` helper at `mcp::tools` so the integration
// test below can reach it. Until that re-export lands, this integration
// test FAILS TO COMPILE — and that is the RED state. The helper is the
// pure (Value::Object(args)) one-liner from `dispatch_passthrough` at
// `packages/klodi-rust-host/src/mcp/tools.rs:271`, lifted into a public
// function so the parity test can exercise it without a live NATS dial.
//
// Helper signature the implementer must add:
//
//     pub fn payload_for_passthrough(args: rmcp::model::JsonObject) -> serde_json::Value;
//
// Lift the line as-is; do NOT introduce any transform.
use klodi_rust_host::mcp::tools::payload_for_passthrough;

const SEARCH_SUBJECT: &str = "p2p.v1.listings.search";
const SEARCHES_CREATE_SUBJECT: &str = "p2p.v1.searches.create";

// ── Fixture loading ──────────────────────────────────────────────────

fn fixture_path() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    // packages/klodi-rust-host → up two to repo root → then descend.
    let repo_root = PathBuf::from(manifest_dir).join("..").join("..");
    repo_root
        .join("packages")
        .join("tool-catalog")
        .join("tests")
        .join("fixtures")
        .join("search-payload-golden.json")
}

fn load_fixture() -> Value {
    let raw = fs::read_to_string(fixture_path())
        .expect("search-payload-golden.json must exist at the shared fixture path");
    serde_json::from_str(&raw)
        .expect("search-payload-golden.json must be valid JSON")
}

/// Convert a fixture entry's `input` (an arbitrary JSON object) into
/// the same `JsonObject` shape `dispatch_passthrough` receives at
/// runtime. The MCP runtime delivers `arguments` as a parsed
/// `JsonObject` (the rmcp model alias for `Map<String, Value>`); the
/// test rebuilds that shape from the JSON fixture's object literal.
fn json_object_for_input(input: &Value) -> Map<String, Value> {
    input
        .as_object()
        .expect("fixture `input` is a JSON object per the contract")
        .clone()
}

/// Iterate the named cases of a fixture section (skipping
/// `_doc` / `_when` metadata keys).
fn case_entries<'a>(section: &'a Value) -> Vec<(String, &'a Value)> {
    let obj = section
        .as_object()
        .expect("fixture section is a JSON object");
    let mut out: Vec<(String, &Value)> = obj
        .iter()
        .filter(|(k, _)| !k.starts_with('_'))
        .map(|(k, v)| (k.clone(), v))
        .collect();
    // Stable iteration for diagnostics — failures name the case by key.
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

// ── klodi_search — per-case payload-equality (SC-parity.1) ───────────

#[test]
fn klodi_search_payload_parity_across_every_fixture_case() {
    let fixture = load_fixture();
    let section = fixture
        .get("search")
        .expect("fixture exposes a `search` section");
    let cases = case_entries(section);
    assert!(
        !cases.is_empty(),
        "search section must carry at least one named case",
    );

    let mut seen: BTreeSet<String> = BTreeSet::new();
    for (case_name, entry) in cases {
        let input = entry
            .get("input")
            .expect("every case carries an `input` field");
        let expected = entry
            .get("expected_wire_payload")
            .expect("every case carries an `expected_wire_payload` field");
        let args = json_object_for_input(input);

        let actual = payload_for_passthrough(args);

        assert_eq!(
            &actual,
            expected,
            "{case_name}: Rust shared host forwarded a payload that diverges from the spec. \
             Expected (raw catalog-shaped): {expected}. Got: {actual}. \
             The fixture IS the contract — fix the implementation, never this \
             assertion. The pass-through site is `dispatch_passthrough` at \
             packages/klodi-rust-host/src/mcp/tools.rs:271. See ADR-0011 \
             (SC-parity.1).",
        );
        seen.insert(case_name);
    }
    // Sanity — the central openclaw-divergence cases the architect named
    // are present. If a future edit drops them silently, the suite is
    // still GREEN but the central architectural risk re-opens. Pin them.
    for required in [
        "search_empty_query_string",
        "search_null_category",
        "search_empty_string_and_null_mix",
    ] {
        assert!(
            seen.contains(required),
            "fixture coverage gap: missing the central divergence case {required:?} \
             — that case is the architect's smoking-gun input. Re-add to the fixture \
             OR fail the run.",
        );
    }
}

// ── klodi_searches_create — per-case payload-equality (SC-parity.2) ──

#[test]
fn klodi_searches_create_payload_parity_across_every_fixture_case() {
    let fixture = load_fixture();
    let section = fixture
        .get("searches_create")
        .expect("fixture exposes a `searches_create` section");
    let cases = case_entries(section);
    assert!(
        !cases.is_empty(),
        "searches_create section must carry at least one named case",
    );

    for (case_name, entry) in cases {
        let input = entry
            .get("input")
            .expect("every case carries an `input` field");
        let expected = entry
            .get("expected_wire_payload")
            .expect("every case carries an `expected_wire_payload` field");
        let args = json_object_for_input(input);

        let actual = payload_for_passthrough(args);

        assert_eq!(
            &actual,
            expected,
            "{case_name}: Rust shared host forwarded a payload that diverges from the spec. \
             Expected: {expected}. Got: {actual}. See ADR-0011 and SC-parity.2.",
        );
    }
}

// ── Subject pinning — the catalog single-entry-point invariant ───────

#[test]
fn klodi_search_subject_unchanged_in_catalog() {
    // ToolName is generated from the canonical TS catalog. If the
    // codegen flips the subject under our feet, agents send to the
    // wrong handler and parity is meaningless. Pin the subject.
    use klodi_nats_client::catalog::ToolName;
    assert_eq!(ToolName::KlodiSearch.subject(), SEARCH_SUBJECT);
}

#[test]
fn klodi_searches_create_subject_unchanged_in_catalog() {
    use klodi_nats_client::catalog::ToolName;
    assert_eq!(
        ToolName::KlodiSearchesCreate.subject(),
        SEARCHES_CREATE_SUBJECT,
    );
}

// ── SC-contract.3 — Rust per-adapter schema equivalence ──────────────

#[test]
fn klodi_search_params_schema_present_in_catalog_consumed_by_rust() {
    // The Rust adapter consumes `dist/schemas.json` via the catalog
    // re-export. The schema must carry the agent-facing param surface.
    // A drift here means agents written against the canonical catalog
    // would submit calls the Rust dispatcher rejects (or misroutes).
    use klodi_rust_host::mcp::tools::tool_input_schema_for;
    let schema = tool_input_schema_for("klodi_search")
        .expect("Rust catalog exposes a schema for klodi_search");
    let obj = schema
        .as_object()
        .expect("klodi_search input schema is a JSON object");
    assert_eq!(obj.get("type").and_then(Value::as_str), Some("object"));
    let props = obj
        .get("properties")
        .and_then(Value::as_object)
        .expect("klodi_search.params has a `properties` map");
    for required in [
        "query", "category", "min_price", "max_price",
        "delivery", "condition", "limit", "cursor",
    ] {
        assert!(
            props.contains_key(required),
            "Rust klodi_search.params dropped {required:?} — breaking change",
        );
    }
}

#[test]
fn klodi_searches_create_params_schema_present_in_catalog_consumed_by_rust() {
    use klodi_rust_host::mcp::tools::tool_input_schema_for;
    let schema = tool_input_schema_for("klodi_searches_create")
        .expect("Rust catalog exposes a schema for klodi_searches_create");
    let obj = schema
        .as_object()
        .expect("klodi_searches_create input schema is a JSON object");
    assert_eq!(obj.get("type").and_then(Value::as_str), Some("object"));
    let props = obj
        .get("properties")
        .and_then(Value::as_object)
        .expect("klodi_searches_create.params has a `properties` map");
    for required in [
        "slug", "query", "category", "min_price", "max_price", "delivery",
    ] {
        assert!(
            props.contains_key(required),
            "Rust klodi_searches_create.params dropped {required:?} — breaking change",
        );
    }
    let required_arr = obj
        .get("required")
        .and_then(Value::as_array)
        .expect("klodi_searches_create.params has a `required` array");
    let required_set: BTreeSet<&str> = required_arr
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        required_set.contains("slug"),
        "Rust klodi_searches_create.params.slug demoted from required — \
         every standing-search needs a client-chosen slug (last-write-wins)",
    );
}
