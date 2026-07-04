//! RED/ratchet — the nats_ca path adds a CA SOURCE, never a verify toggle (rs).
//!
//! Card: auto-trust-nats-ca-from-register — cross-cutting invariant.
//!
//! Extends the verify-off ratchet to the NEW nats_ca surface: `tls.rs` (persist
//! + level-2 resolve) and the single rust-host persist site `register.rs` (which
//! covers moltis + ironclaw + zeroclaw). The register-CA path may introduce no
//! `danger_accept_invalid_certs` / `InsecureSkipVerify` and no env var **or wire
//! field** that toggles verification off.
//!
//! Two clauses:
//!   * verify-off scan (GREEN ratchet) — the new files carry no disabling token.
//!   * persist-site symmetry (RED driver) — the rust-host persist site wires the
//!     shared `persist_nats_ca` helper (Rust half of the six-adapter symmetry).
//!
//! COMMENTS ARE STRIPPED before scanning (code only) so docstrings that name a
//! token to document its absence don't false-positive; needles are assembled
//! from fragments so this file carries no literal forbidden token.
//!
//! QA-owned. NEVER weaken.

use std::path::PathBuf;

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn this_crate_src(file: &str) -> PathBuf {
    manifest_dir().join("src").join(file)
}

/// The rust-host persist site lives in the sibling `klodi-rust-host` crate —
/// one site for moltis + ironclaw + zeroclaw.
fn rust_host_register() -> PathBuf {
    manifest_dir()
        .join("..")
        .join("klodi-rust-host")
        .join("src")
        .join("register.rs")
}

/// Strip `//`-comments (full-line and trailing) so prose documenting a
/// forbidden token's absence doesn't trip the guard.
fn code_only(path: &PathBuf) -> String {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    text.lines()
        .map(|line| line.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn nats_ca_files() -> Vec<PathBuf> {
    vec![this_crate_src("tls.rs"), rust_host_register()]
}

#[test]
fn nats_ca_scan_targets_exist() {
    for f in nats_ca_files() {
        assert!(f.is_file(), "scan target missing: {} (update the guard)", f.display());
    }
}

#[test]
fn nats_ca_path_has_no_insecure_toggle() {
    let forbidden = [
        format!("danger_accept{}", "_invalid_certs"),
        format!("Insecure{}", "SkipVerify"),
        format!("set_certificate{}", "_verifier"),
    ];
    for f in nats_ca_files() {
        let code = code_only(&f);
        for needle in &forbidden {
            assert!(
                !code.contains(needle.as_str()),
                "{} weakens TLS verification (found {needle}) — the nats_ca \
                 path must add a CA source, never a toggle",
                f.display()
            );
        }
    }
}

#[test]
fn nats_ca_path_has_no_verify_off_env_or_field() {
    let toggle_fragments = [
        format!("INSEC{}", "URE"),
        format!("NO_{}", "VERIFY"),
        format!("SKIP_{}", "VERIFY"),
        format!("DISABLE_{}", "TLS"),
        format!("ALLOW_{}", "PLAINTEXT"),
        format!("NO_{}", "TLS"),
    ];
    for f in nats_ca_files() {
        let code = code_only(&f);
        for frag in &toggle_fragments {
            assert!(
                !code.contains(frag.as_str()),
                "{} references a verify-opt-out-shaped token ({frag}) — no env \
                 var or wire field may toggle cert verification off",
                f.display()
            );
        }
    }
}

#[test]
fn rust_host_persist_site_wires_the_shared_helper() {
    // [symmetry] The one rust-host persist site (moltis + ironclaw + zeroclaw)
    // must call the shared `persist_nats_ca` — an unwired site silently never
    // auto-trusts for all three Rust adapters.
    let code = code_only(&rust_host_register());
    assert!(
        code.contains("persist_nats_ca("),
        "register.rs does not wire persist_nats_ca — moltis/ironclaw/zeroclaw \
         would never persist the register CA (six-adapter symmetry breach)"
    );
}
