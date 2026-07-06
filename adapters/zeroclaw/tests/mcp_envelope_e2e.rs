//! End-to-end test for the `klodi-zeroclaw-mcp` binary's setup-time
//! envelope emission.
//!
//! Round 2 tier coverage across `[unit, integration, e2e]`
//! — no e2e shipped in round 1. This test spawns the actual built
//! binary as a subprocess with `KLODI_HOME` pointed at an empty
//! directory and asserts that stderr carries the four-key
//! `not_registered` envelope JSON — same shape the dispatcher emits to
//! the agent-visible channel. R8 — the recovery_hint references
//! `klodi-zeroclaw-register`, the per-host CLI.
//!
//! This validates the cross-bin parity contract end-to-end:
//!   * The bin's setup-time check emits the canonical envelope JSON.
//!   * The envelope is parseable as the four-key shape.
//!   * `error == "not_registered"` and `recovery_hint.command ==
//!     "klodi-zeroclaw-register"`.
//!
//! Why e2e (vs the existing dispatcher integration tests): this test
//! exercises the COMPILED bin's setup path, including:
//!   * Cargo wiring of `klodi_rust_host::not_registered_envelope_json`
//!   * `env!()` macro resolution of the bin's CARGO_PKG_VERSION
//!   * The bin's exit-code contract (1 on setup failure)
//!   * stderr / stdout separation (the agent sees stderr; stdout is
//!     reserved for JSON-RPC)
//!
//! Cargo provides `env!("CARGO_BIN_EXE_<name>")` to integration tests;
//! the build system guarantees the bin is built before this test runs.

use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::Duration;
use tempfile::TempDir;

/// Spawn `klodi-zeroclaw-mcp` with `KLODI_HOME` pointed at an empty
/// directory. The bin's setup-time check at
/// `adapters/zeroclaw/src/bin/mcp.rs:~56` detects the missing creds and
/// emits the envelope JSON to stderr, then exits 1.
///
/// Returns (stderr_text, exit_code).
fn spawn_with_empty_klodi_home() -> (String, Option<i32>) {
    let dir = TempDir::new().expect("tempdir");
    let bin = env!("CARGO_BIN_EXE_klodi-zeroclaw-mcp");

    let mut child = Command::new(bin)
        .env("KLODI_HOME", dir.path())
        // Don't inherit caller's env (avoids the test runner's
        // KLODI_HOME bleeding in).
        .env_clear()
        .env("KLODI_HOME", dir.path())
        // tracing_subscriber needs a `TERM` or similar; provide a
        // minimal env.
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawning klodi-zeroclaw-mcp");

    // The bin should exit quickly (setup check fails immediately).
    // Add a generous timeout so the test fails fast if the bin hangs.
    let start = std::time::Instant::now();
    let exit = loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => break status,
            None => {
                if start.elapsed() > Duration::from_secs(10) {
                    let _ = child.kill();
                    panic!("klodi-zeroclaw-mcp did not exit within 10s; setup-time check is supposed to be synchronous and immediate");
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    };

    let output = child.wait_with_output().expect("wait_with_output");
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    (stderr, exit.code())
}

/// Extract the FIRST JSON object that matches the envelope shape from
/// the bin's stderr. The bin emits a single envelope JSON line
/// (via `eprintln!`); tracing-subscriber may emit other tracing
/// records, so we scan line-by-line for a parseable object that has
/// the four envelope keys.
fn parse_envelope_from_stderr(stderr: &str) -> Value {
    for line in stderr.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let parsed: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(obj) = parsed.as_object() {
            let has_all_four = obj.contains_key("error")
                && obj.contains_key("message")
                && obj.contains_key("details")
                && obj.contains_key("recovery_hint");
            if has_all_four {
                return parsed;
            }
        }
    }
    panic!(
        "no four-key envelope JSON found in stderr:\n----\n{stderr}\n----"
    );
}

#[test]
fn missing_klodi_home_emits_not_registered_envelope_to_stderr() {
    let (stderr, exit_code) = spawn_with_empty_klodi_home();

    // Bin contract: exit code 1 on setup-time failure (per bin/mcp.rs:58).
    assert_eq!(
        exit_code,
        Some(1),
        "bin must exit 1 on creds-missing; stderr was:\n{stderr}",
    );

    let env = parse_envelope_from_stderr(&stderr);
    let obj = env.as_object().expect("envelope is a JSON object");

    // R1 — four canonical keys.
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["details", "error", "message", "recovery_hint"],
        "envelope must carry exactly the four R1 keys",
    );

    // R2 — `not_registered` is the bin's setup-time code.
    assert_eq!(env["error"], "not_registered");

    // R8 — recovery_hint references the per-host CLI.
    let hint = &env["recovery_hint"];
    assert!(hint.is_object(), "recovery_hint MUST be an object");
    assert_eq!(hint["kind"], "cli");
    assert_eq!(hint["command"], "klodi-zeroclaw-register");
    assert!(
        hint["message"].is_string(),
        "recovery_hint.message MUST be a string",
    );

    // `details` is null for this failure mode (no machine-readable
    // cause beyond the human-readable message).
    assert!(env["details"].is_null());
}

#[test]
fn missing_klodi_home_keeps_stdout_pristine() {
    // MCP servers MUST keep stdout pristine — the host parses every line
    // as JSON-RPC. The bin's setup-time guard emits to stderr; stdout
    // stays empty so a host that prematurely starts reading doesn't
    // see junk.
    let dir = TempDir::new().expect("tempdir");
    let bin = env!("CARGO_BIN_EXE_klodi-zeroclaw-mcp");

    let output = Command::new(bin)
        .env_clear()
        .env("KLODI_HOME", dir.path())
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("running klodi-zeroclaw-mcp");

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.trim().is_empty(),
        "stdout MUST be empty on setup-time failure; got:\n{stdout}",
    );
}
