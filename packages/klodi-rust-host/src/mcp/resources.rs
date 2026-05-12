//! `resources/list` + `resources/read` for the klodi MCP server.
//!
//! The 2026-05-12 wake-agent-spawn redesign deletes the embedded skill
//! bundle — the canonical "what to do on each event" guidance now lives
//! in the wake prompt the daemon composes (see
//! `crate::wake_prompt`). Adapters that surface an MCP server still
//! advertise `resources` capability for protocol completeness; the
//! list is empty and `resources/read` always returns `not found`.

use rmcp::ErrorData as McpError;
use rmcp::model::{ListResourcesResult, ReadResourceResult};
use serde_json::json;

pub(super) fn list_skill_resources() -> ListResourcesResult {
    ListResourcesResult {
        resources: Vec::new(),
        next_cursor: None,
        meta: None,
    }
}

pub(super) fn read_skill_resource(uri: &str) -> Result<ReadResourceResult, McpError> {
    Err(McpError::resource_not_found(
        "no_skill_bundle",
        Some(json!({
            "uri": uri,
            "note": "klodi 0.2+ does not ship an embedded skill bundle; the wake prompt is the catalog.",
        })),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_empty() {
        let result = list_skill_resources();
        assert!(result.resources.is_empty());
    }

    #[test]
    fn read_returns_not_found() {
        let err = read_skill_resource("klodi://skill/SKILL.md").unwrap_err();
        assert!(format!("{err:?}").contains("no_skill_bundle"));
    }
}
