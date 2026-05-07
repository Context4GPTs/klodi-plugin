//! Embedded klodi skill bundle.
//!
//! Two consumers:
//!
//! - The MCP server (under feature `mcp`) exposes each file under
//!   `klodi://skill/<rel-path>` via `resources/list` + `resources/read`.
//!   The agent reads them on demand — single source of truth, no on-disk
//!   seeding, no version skew.
//! - The registration flow seeds `templates/negotiation_style.template.md`
//!   + `policies/security.md` into `${KLODI_HOME}/policies/` on first
//!   registration. The bundle is the only source for those templates;
//!   the agent edits the seeded copies, not the embedded bytes.
//!
//! Path resolution:
//!
//! | Layout       | `$CARGO_MANIFEST_DIR/skill` resolves to              |
//! |--------------|------------------------------------------------------|
//! | workspace    | `packages/klodi-rust-host/skill/` (symlink to `klodi-plugin/skill/`) |
//! | adapter `.crate` | `<staged>/skill/` (vendored copy)               |
//!
//! See `adapters/zeroclaw/scripts/vendor.py` for the staged-tree copy.

use include_dir::{Dir, include_dir};

pub static SKILL: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/skill");

/// Iterate every embedded skill file as `(rel_path, contents)`.
pub fn iter_files() -> impl Iterator<Item = (&'static str, &'static [u8])> {
    walk(&SKILL)
}

fn walk(dir: &'static Dir<'static>) -> Box<dyn Iterator<Item = (&'static str, &'static [u8])>> {
    let files = dir.files().map(|f| (f.path().to_str().unwrap_or(""), f.contents()));
    let nested = dir.dirs().flat_map(walk);
    Box::new(files.chain(nested))
}

/// Look up an embedded file by its relative path inside the bundle (e.g.
/// `templates/negotiation_style.template.md`). Returns `None` when the
/// file is not part of the bundle — useful for `policy_seed` so a missing
/// template surfaces a clear "plugin packaging is broken" error rather
/// than panicking deep in `include_dir`.
pub fn get_file(rel_path: &str) -> Option<&'static [u8]> {
    SKILL.get_file(rel_path).map(|f| f.contents())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_root_contains_skill_md() {
        let f = SKILL.get_file("SKILL.md").expect("SKILL.md present");
        let body = f.contents_utf8().expect("SKILL.md is UTF-8");
        assert!(
            body.contains("# klodi"),
            "SKILL.md missing expected header"
        );
    }

    #[test]
    fn skill_bundle_includes_references() {
        let mut found = 0usize;
        for (rel, _) in iter_files() {
            if rel.starts_with("references/") {
                found += 1;
            }
        }
        assert!(
            found >= 3,
            "expected reference docs under references/ in the skill bundle, got {found}"
        );
    }

    #[test]
    fn skill_bundle_includes_policy_templates() {
        assert!(
            get_file("templates/negotiation_style.template.md").is_some(),
            "negotiation_style.template.md missing from embedded bundle",
        );
        assert!(
            get_file("policies/security.md").is_some(),
            "policies/security.md missing from embedded bundle",
        );
    }
}
