//! Embedded klodi skill bundle.
//!
//! The MCP server exposes each file under `klodi://skill/<rel-path>` via
//! `resources/list` + `resources/read`. ZeroClaw's agent reads them on
//! demand — single source of truth, no on-disk seeding, no version skew.
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

pub(super) static SKILL: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/skill");

/// Iterate every embedded skill file as `(rel_path, contents)`.
pub(super) fn iter_files() -> impl Iterator<Item = (&'static str, &'static [u8])> {
    walk(&SKILL)
}

fn walk(dir: &'static Dir<'static>) -> Box<dyn Iterator<Item = (&'static str, &'static [u8])>> {
    let files = dir.files().map(|f| (f.path().to_str().unwrap_or(""), f.contents()));
    let nested = dir.dirs().flat_map(walk);
    Box::new(files.chain(nested))
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
}
