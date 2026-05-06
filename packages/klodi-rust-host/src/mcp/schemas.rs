//! Embedded klodi tool catalog (subjects + JSON Schemas).
//!
//! `schemas.json` is the codegen output of `@klodi/tool-catalog`. Embedding it
//! at compile time keeps the MCP server's tool surface in lock-step with the
//! TS / Py adapters — a catalog edit reaches Rust on the next `pnpm codegen`
//! + `cargo build`, with no runtime fetch.
//!
//! Path resolution:
//!
//! | Layout       | `../../schemas.json` resolves to                   |
//! |--------------|----------------------------------------------------|
//! | workspace    | `packages/klodi-rust-host/schemas.json` (symlink)  |
//! | adapter `.crate` | `<staged>/src/_rust_host/schemas.json` (vendored) |
//!
//! The workspace symlink points at `packages/tool-catalog/dist/schemas.json`.
//! The vendor step copies the same file into the staged tree and rewrites
//! this `include_str!` argument so the macro succeeds inside the published
//! crate (see `adapters/zeroclaw/scripts/vendor.py`).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::OnceLock;

const SCHEMAS_JSON: &str = include_str!("../../schemas.json");

#[derive(Deserialize, Debug)]
pub(super) struct CatalogTool {
    // `subject` is in the JSON but the Rust dispatcher reaches it via
    // `ToolName::subject()` (single source of truth — the codegen'd
    // enum); decoding it here would only invite drift.
    pub description: String,
    pub params: serde_json::Value,
}

#[derive(Deserialize, Debug)]
pub(super) struct CatalogRoot {
    #[allow(dead_code)]
    pub version: String,
    pub tools: BTreeMap<String, CatalogTool>,
}

/// Parsed catalog. Lazily decoded once per process; subsequent calls are
/// cheap pointer reads.
pub(super) fn catalog() -> &'static CatalogRoot {
    static CELL: OnceLock<CatalogRoot> = OnceLock::new();
    CELL.get_or_init(|| {
        serde_json::from_str(SCHEMAS_JSON).expect(
            "klodi tool-catalog schemas.json must parse — codegen drift",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_catalog_parses_and_has_tools() {
        let cat = catalog();
        assert!(
            cat.tools.contains_key("klodi_list_create"),
            "expected klodi_list_create in embedded catalog"
        );
        let tool = &cat.tools["klodi_list_create"];
        assert!(
            tool.params.is_object(),
            "params must be a JSON Schema object"
        );
        assert!(
            !tool.description.is_empty(),
            "description must be non-empty"
        );
    }
}
