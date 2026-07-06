//! INVARIANT GUARD — cert/hostname verification is never disabled (rs).
//!
//! The CORE
//! security invariant. Fails the build if any insecure-TLS toggle appears
//! in the Rust TLS connect path, or if an env var / flag can turn
//! verification off. `KLODI_NATS_CA_FILE` selects *which* CA to trust,
//! never *whether* to verify, so it is allowed.
//!
//! GREEN today (the tls.rs trust path uses the standard verifying rustls
//! config). This is a RATCHET, not a RED driver — it must stay green as
//! the TLS code evolves; it goes RED the moment a
//! `danger_accept_invalid_certs` / `InsecureSkipVerify` path or a
//! verification-off env flag is introduced.
//!
//! COMMENTS ARE STRIPPED before scanning: `tls.rs`'s docstring legitimately
//! *names* the forbidden tokens to document their absence, so scanning raw
//! text would false-positive. We scan code only (everything before the
//! first `//` on each line). The forbidden needles are assembled from
//! fragments so this file carries no literal forbidden token.
//!
//! QA-owned. NEVER weaken.

use std::path::PathBuf;

fn src(file: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join(file)
}

/// Strip `//`-comments (full-line and trailing) so prose that documents a
/// forbidden token's *absence* doesn't trip the guard.
fn code_only(path: &PathBuf) -> String {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    text.lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

const SCANNED: [&str; 3] = ["client.rs", "config.rs", "tls.rs"];

#[test]
fn scanned_files_exist() {
    for f in SCANNED {
        assert!(src(f).is_file(), "scan target missing: {f} (update the guard)");
    }
}

#[test]
fn no_insecure_tls_toggle() {
    // Assembled from fragments — the literals never appear in this file.
    let forbidden = [
        format!("danger_accept{}", "_invalid_certs"),
        format!("Insecure{}", "SkipVerify"),
        format!("set_certificate{}", "_verifier"), // custom verifier = bypass seam
    ];
    for f in SCANNED {
        let code = code_only(&src(f));
        for needle in &forbidden {
            assert!(
                !code.contains(needle.as_str()),
                "{f} disables/weakens TLS verification (found {needle}) — \
                 forbidden by the verification invariant"
            );
        }
    }
}

#[test]
fn no_env_var_can_disable_verification() {
    let toggle_fragments = [
        format!("INSEC{}", "URE"),
        format!("NO_{}", "VERIFY"),
        format!("SKIP_{}", "VERIFY"),
        format!("DISABLE_{}", "TLS"),
        format!("ALLOW_{}", "PLAINTEXT"),
        format!("NO_{}", "TLS"),
    ];
    for f in SCANNED {
        let code = code_only(&src(f));
        for frag in &toggle_fragments {
            assert!(
                !code.contains(frag.as_str()),
                "{f} references a verification-opt-out-shaped env token \
                 ({frag}) — no flag may turn cert verification off"
            );
        }
    }
}
