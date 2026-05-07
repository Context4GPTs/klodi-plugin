//! `resources/list` + `resources/read` for the embedded skill bundle.
//!
//! URIs are `klodi://skill/<rel-path>` where `<rel-path>` is the file's
//! position inside the bundle (e.g. `klodi://skill/SKILL.md`,
//! `klodi://skill/references/wake_payload_reference.md`). The agent reads
//! them on demand via MCP `resources/read`; no seeding step copies the
//! bundle to disk.

use crate::skill_bundle;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    AnnotateAble, ListResourcesResult, ReadResourceResult, RawResource, ResourceContents,
};
use serde_json::json;

const URI_PREFIX: &str = "klodi://skill/";

/// Build the `resources/list` reply from the embedded skill bundle.
pub(super) fn list_skill_resources() -> ListResourcesResult {
    let resources = skill_bundle::iter_files()
        .map(|(rel_path, _)| {
            let uri = format!("{URI_PREFIX}{rel_path}");
            let mime = mime_type_for(rel_path);
            let mut raw = RawResource::new(uri, rel_path.to_string());
            if let Some(m) = mime {
                raw = raw.with_mime_type(m.to_string());
            }
            raw.no_annotation()
        })
        .collect();
    ListResourcesResult {
        resources,
        next_cursor: None,
        meta: None,
    }
}

/// Resolve a `resources/read` request against the embedded bundle.
pub(super) fn read_skill_resource(uri: &str) -> Result<ReadResourceResult, McpError> {
    let rel_path = uri.strip_prefix(URI_PREFIX).ok_or_else(|| {
        McpError::resource_not_found(
            "unknown_uri_scheme",
            Some(json!({ "uri": uri, "expected_prefix": URI_PREFIX })),
        )
    })?;

    let file = skill_bundle::SKILL.get_file(rel_path).ok_or_else(|| {
        McpError::resource_not_found(
            "skill_file_not_found",
            Some(json!({ "uri": uri, "rel_path": rel_path })),
        )
    })?;

    let mut contents = ResourceContents::text(
        file.contents_utf8().unwrap_or_default(),
        uri.to_string(),
    );
    if let Some(mime) = mime_type_for(rel_path) {
        contents = contents.with_mime_type(mime.to_string());
    }
    Ok(ReadResourceResult::new(vec![contents]))
}

fn mime_type_for(rel_path: &str) -> Option<&'static str> {
    let dot = rel_path.rfind('.')?;
    match &rel_path[dot..] {
        ".md" => Some("text/markdown"),
        ".txt" => Some("text/plain"),
        ".json" => Some("application/json"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_includes_skill_md() {
        let result = list_skill_resources();
        let uris: Vec<&str> =
            result.resources.iter().map(|r| r.raw.uri.as_str()).collect();
        assert!(
            uris.iter().any(|u| *u == "klodi://skill/SKILL.md"),
            "SKILL.md must appear in resources/list — got {uris:?}",
        );
    }

    #[test]
    fn read_skill_md_returns_body() {
        let result = read_skill_resource("klodi://skill/SKILL.md").expect("read SKILL.md");
        assert_eq!(result.contents.len(), 1);
        match &result.contents[0] {
            ResourceContents::TextResourceContents { text, mime_type, .. } => {
                assert!(text.contains("# klodi"));
                assert_eq!(mime_type.as_deref(), Some("text/markdown"));
            }
            ResourceContents::BlobResourceContents { .. } => {
                panic!("expected text variant for SKILL.md")
            }
        }
    }

    #[test]
    fn read_unknown_uri_returns_error() {
        let err = read_skill_resource("file:///etc/passwd").expect_err("must reject unknown scheme");
        assert!(format!("{err:?}").contains("unknown_uri_scheme"));
    }

    #[test]
    fn read_missing_skill_path_returns_error() {
        let err = read_skill_resource("klodi://skill/does-not-exist.md")
            .expect_err("must reject missing path");
        assert!(format!("{err:?}").contains("skill_file_not_found"));
    }
}
