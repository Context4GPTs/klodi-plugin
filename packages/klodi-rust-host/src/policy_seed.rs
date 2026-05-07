//! Non-destructive seeding of `${KLODI_HOME}/policies/`.
//!
//! Two policy files live under the user's klodi home: `negotiation_style.md`
//! (pricing, posture, counter-offer ladder — user-edited) and `security.md`
//! (static hard rules — copy-as-is). Both are seeded **once** from the
//! embedded skill bundle on first registration; subsequent re-runs of
//! [`seed_policies_if_absent`] never overwrite a present file, preserving
//! every operator edit.
//!
//! Mirrors `klodi-plugin/adapters/openclaw/src/lib/policy-seeding.ts` so
//! the TS / Rust hosts behave identically: agents on either host see the
//! same policy contract, fed by the same template bytes from
//! `klodi-plugin/skill/`.
//!
//! The "filled" predicate exists so `klodi_setup_status` can surface a
//! `negotiation_style_unfilled` issue when the user hasn't replaced the
//! template placeholders. Same heuristic as openclaw: any remaining
//! `<e.g., ...>` angle-bracket sentinel marks the file as unfilled.

use crate::skill_bundle;
use anyhow::{Context, Result};
use serde::Serialize;
use std::path::Path;

const NEGOTIATION_STYLE_TEMPLATE: &str = "templates/negotiation_style.template.md";
const SECURITY_POLICY_TEMPLATE: &str = "policies/security.md";

/// Result of a [`seed_policies_if_absent`] call. `true` means the file
/// was newly written from the template; `false` means a present file was
/// preserved.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SeedReport {
    pub negotiation_style_seeded: bool,
    pub security_policy_seeded: bool,
}

/// Seed `${klodi_home}/policies/{negotiation_style,security}.md` from
/// the embedded skill bundle. Non-destructive — present files are
/// preserved verbatim. Creates `${klodi_home}/policies/` if missing.
///
/// Returns the per-file seed flags so the caller can log a precise
/// "1 of 2 seeded" message instead of a fuzzy "policies seeded".
pub fn seed_policies_if_absent(klodi_home: &Path) -> Result<SeedReport> {
    let policies_dir = klodi_home.join("policies");
    std::fs::create_dir_all(&policies_dir)
        .with_context(|| format!("creating {}", policies_dir.display()))?;

    let negotiation_style_seeded = seed_one_if_absent(
        NEGOTIATION_STYLE_TEMPLATE,
        &policies_dir.join("negotiation_style.md"),
    )?;
    let security_policy_seeded = seed_one_if_absent(
        SECURITY_POLICY_TEMPLATE,
        &policies_dir.join("security.md"),
    )?;

    Ok(SeedReport {
        negotiation_style_seeded,
        security_policy_seeded,
    })
}

fn seed_one_if_absent(bundle_rel_path: &str, target: &Path) -> Result<bool> {
    if target.is_file() {
        return Ok(false);
    }
    let bytes = skill_bundle::get_file(bundle_rel_path).with_context(|| {
        format!(
            "policy template {bundle_rel_path} missing from embedded bundle — \
             plugin packaging is broken"
        )
    })?;
    std::fs::write(target, bytes)
        .with_context(|| format!("writing {}", target.display()))?;
    Ok(true)
}

/// True when the user has filled in `negotiation_style.md` — i.e. there
/// are no remaining template placeholders. Mirrors openclaw's
/// `isNegotiationStyleFilled`: any `<e.g., ...>` sentinel or the bare
/// `firm | flexible | aggressive` line marks the file as unfilled.
///
/// Returns `false` when the file is missing — the seed step hasn't run
/// yet, so there's nothing for the user to have filled.
pub fn is_negotiation_style_filled(path: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    if text.contains("<e.g.,") || text.contains("<E.g.,") {
        return false;
    }
    for line in text.lines() {
        if line.trim() == "firm | flexible | aggressive" {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn seeds_both_files_on_first_run() {
        let dir = tempdir().unwrap();
        let report = seed_policies_if_absent(dir.path()).unwrap();
        assert!(report.negotiation_style_seeded);
        assert!(report.security_policy_seeded);
        assert!(dir.path().join("policies/negotiation_style.md").is_file());
        assert!(dir.path().join("policies/security.md").is_file());
    }

    #[test]
    fn second_run_is_idempotent_and_preserves_edits() {
        let dir = tempdir().unwrap();
        seed_policies_if_absent(dir.path()).unwrap();
        let target = dir.path().join("policies/negotiation_style.md");
        std::fs::write(&target, "user-edited body").unwrap();

        let report = seed_policies_if_absent(dir.path()).unwrap();
        assert!(!report.negotiation_style_seeded);
        assert!(!report.security_policy_seeded);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "user-edited body");
    }

    #[test]
    fn partial_present_state_only_seeds_missing() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("policies")).unwrap();
        std::fs::write(
            dir.path().join("policies/security.md"),
            "user-tweaked security",
        )
        .unwrap();

        let report = seed_policies_if_absent(dir.path()).unwrap();
        assert!(report.negotiation_style_seeded);
        assert!(!report.security_policy_seeded);
        assert_eq!(
            std::fs::read_to_string(dir.path().join("policies/security.md")).unwrap(),
            "user-tweaked security",
        );
    }

    #[test]
    fn is_negotiation_style_filled_detects_template_sentinels() {
        let dir = tempdir().unwrap();
        seed_policies_if_absent(dir.path()).unwrap();
        let path = dir.path().join("policies/negotiation_style.md");
        assert!(
            !is_negotiation_style_filled(&path),
            "freshly seeded template should be unfilled",
        );

        std::fs::write(&path, "Posture: firm\nFloor: $40\n").unwrap();
        assert!(
            is_negotiation_style_filled(&path),
            "user-filled file with no sentinels should be filled",
        );

        std::fs::write(
            &path,
            "## Posture\n\nfirm | flexible | aggressive\n\nFloor: $40\n",
        )
        .unwrap();
        assert!(
            !is_negotiation_style_filled(&path),
            "bare posture sentinel on its own line marks file unfilled",
        );

        std::fs::write(&path, "Floor: <e.g., 40>\n").unwrap();
        assert!(
            !is_negotiation_style_filled(&path),
            "remaining angle-bracket placeholder marks file unfilled",
        );
    }

    #[test]
    fn is_negotiation_style_filled_returns_false_when_missing() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("policies/negotiation_style.md");
        assert!(!is_negotiation_style_filled(&path));
    }
}
