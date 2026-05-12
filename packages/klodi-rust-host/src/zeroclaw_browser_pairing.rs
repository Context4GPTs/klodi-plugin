//! Browser-pairing helper for the ZeroClaw adapter.
//!
//! ZeroClaw's gateway prints a single one-time pairing code to its
//! stdout at boot, then consumes it the moment any client pairs.
//! `klodi-zeroclaw-register` shells out to `zeroclaw gateway
//! get-paircode --new` (this module) to mint a *second* pairing code
//! on demand, then `POST /pair`s it for the `zc_<hex>` bearer the
//! daemon will use on every subsequent spawn call.

use std::path::PathBuf;
use std::process::ExitStatus;
use std::time::Duration;

use thiserror::Error;

const PAIRCODE_MARKER: &str = "X-Pairing-Code:";

/// Configuration shared by all minter constructions. Defaults match the
/// canonical "daemon and gateway colocated, `zeroclaw` on PATH"
/// deployment that the published `klodi-zeroclaw` image ships with.
#[derive(Clone, Debug)]
pub struct BrowserPairConfig {
    /// Path to the `zeroclaw` CLI binary. Defaults to `"zeroclaw"`,
    /// resolved against `$PATH`. Operators running the daemon on a
    /// different host from the gateway override this; if the binary
    /// isn't reachable the minter detects that gracefully and the
    /// daemon falls back to the cached-token / sidecar-code flow.
    pub cli_path: PathBuf,
    /// Per-call timeout. The CLI typically responds in <100ms; 5s is a
    /// generous ceiling for a heavily-loaded gateway.
    pub timeout: Duration,
}

impl Default for BrowserPairConfig {
    fn default() -> Self {
        Self {
            cli_path: PathBuf::from("zeroclaw"),
            timeout: Duration::from_secs(5),
        }
    }
}

/// Failure modes for [`MinterImpl::mint`].
#[derive(Debug, Error)]
pub enum BrowserPairError {
    /// The configured CLI binary was not found on `$PATH` (or at the
    /// explicit override path). Daemon falls back to the cached token /
    /// sidecar pairing-code on this error.
    #[error("zeroclaw CLI not found at {0}")]
    CliMissing(PathBuf),
    /// The CLI ran but exited non-zero. Stderr is truncated to 200
    /// chars for diagnostic surfacing without leaking large outputs.
    #[error("zeroclaw CLI exited with status {status}: {stderr_snippet}")]
    CliFailed {
        status: ExitStatus,
        stderr_snippet: String,
    },
    /// The CLI ran successfully but its output did not contain a
    /// parseable `X-Pairing-Code: <digits>` line. Snippets are
    /// truncated to 200 chars.
    #[error(
        "zeroclaw CLI output did not contain an X-Pairing-Code line. \
         stdout: {stdout_snippet:?} stderr: {stderr_snippet:?}"
    )]
    UnparseableOutput {
        stdout_snippet: String,
        stderr_snippet: String,
    },
    /// The CLI did not return within the configured timeout. The child
    /// process is killed via `kill_on_drop`.
    #[error("zeroclaw CLI timed out after {timeout:?}")]
    Timeout { timeout: Duration },
    /// Other I/O error from the spawn — fork/exec resource exhaustion,
    /// permission denied, etc.
    #[error("zeroclaw CLI spawn error: {message}")]
    SpawnError { message: String },
}

/// Concrete minter that shells out to the gateway's CLI.
pub struct ZeroclawCliMinter {
    cfg: BrowserPairConfig,
}

impl ZeroclawCliMinter {
    pub fn new(cfg: BrowserPairConfig) -> Self {
        Self { cfg }
    }

    /// Probe whether the configured CLI is callable. Returns
    /// `Some(self)` when the binary can be spawned (regardless of
    /// `--version` exit code — older `zeroclaw` builds may not support
    /// `--version` and a non-zero exit is still proof of life), `None`
    /// when the binary cannot be spawned at all.
    ///
    /// Used by the daemon at startup to decide whether to enable
    /// auto-pair + the loopback shim. A `None` result is fully
    /// non-fatal: the daemon falls back to the cached token / sidecar
    /// flow exactly as it did before this module existed.
    pub async fn detect(cfg: BrowserPairConfig) -> Option<Self> {
        let probe = tokio::time::timeout(
            cfg.timeout,
            tokio::process::Command::new(&cfg.cli_path)
                .arg("--version")
                .kill_on_drop(true)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status(),
        )
        .await;
        match probe {
            // Spawn succeeded — binary exists and ran. Exit code is
            // ignored on purpose (see doc comment).
            Ok(Ok(_)) => Some(Self::new(cfg)),
            // Spawn failed (NotFound, permission denied) or the probe
            // timed out — treat as missing.
            _ => None,
        }
    }

    pub async fn mint(&self) -> Result<String, BrowserPairError> {
        let cli_path = self.cfg.cli_path.clone();
        let timeout = self.cfg.timeout;

        let spawn = tokio::process::Command::new(&cli_path)
            .arg("gateway")
            .arg("get-paircode")
            .arg("--new")
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null())
            .output();

        let output = match tokio::time::timeout(timeout, spawn).await {
            Ok(Ok(o)) => o,
            Ok(Err(err)) => {
                if err.kind() == std::io::ErrorKind::NotFound {
                    return Err(BrowserPairError::CliMissing(cli_path));
                }
                return Err(BrowserPairError::SpawnError {
                    message: err.to_string(),
                });
            }
            Err(_) => return Err(BrowserPairError::Timeout { timeout }),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() {
            return Err(BrowserPairError::CliFailed {
                status: output.status,
                stderr_snippet: truncate(&stderr, 200),
            });
        }

        parse_paircode(&stdout, &stderr)
    }
}

/// Type-erased minter the daemon and shim consume. Production code
/// constructs only [`Self::Cli`]; the [`Self::Stub`] variant exists so
/// in-process tests of the shim and the daemon wiring can yield a
/// deterministic code without forking a real subprocess.
pub enum MinterImpl {
    Cli(ZeroclawCliMinter),
    /// Test-only — yields a fixed code on every `mint()` call. Always
    /// compiled (avoids the `#[cfg(test)]` exhaustiveness asymmetry on
    /// match arms) but never constructed by production code paths.
    Stub { fixed_code: String },
}

impl MinterImpl {
    pub async fn mint(&self) -> Result<String, BrowserPairError> {
        match self {
            Self::Cli(m) => m.mint().await,
            Self::Stub { fixed_code } => Ok(fixed_code.clone()),
        }
    }
}

/// Last-line-wins parser for `X-Pairing-Code: <digits>`. Mirrors the
/// regex `(?m)X-Pairing-Code:\s+(\d+)` without pulling a regex
/// dependency. Checks stdout first, then stderr — the demo's interim
/// `up-zeroclaw.sh` discards stderr with `2>/dev/null` but the
/// production parser is permissive so a future ZeroClaw build that
/// switches the print stream doesn't silently break the daemon.
pub(crate) fn parse_paircode(
    stdout: &str,
    stderr: &str,
) -> Result<String, BrowserPairError> {
    fn scan(buf: &str) -> Option<String> {
        for line in buf.lines().rev() {
            let Some(idx) = line.find(PAIRCODE_MARKER) else {
                continue;
            };
            let rest = &line[idx + PAIRCODE_MARKER.len()..];
            let code: String = rest
                .trim_start()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !code.is_empty() {
                return Some(code);
            }
        }
        None
    }
    scan(stdout)
        .or_else(|| scan(stderr))
        .ok_or_else(|| BrowserPairError::UnparseableOutput {
            stdout_snippet: truncate(stdout, 200),
            stderr_snippet: truncate(stderr, 200),
        })
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_paircode_extracts_canonical_line() {
        assert_eq!(
            parse_paircode("X-Pairing-Code: 123456\n", "").unwrap(),
            "123456"
        );
    }

    #[test]
    fn parse_paircode_picks_last_match_in_stdout() {
        let stdout = "X-Pairing-Code: 111111\nintermezzo\nX-Pairing-Code: 222222\n";
        assert_eq!(parse_paircode(stdout, "").unwrap(), "222222");
    }

    #[test]
    fn parse_paircode_falls_back_to_stderr_when_stdout_silent() {
        assert_eq!(
            parse_paircode("hello\n", "X-Pairing-Code: 999999\n").unwrap(),
            "999999"
        );
    }

    #[test]
    fn parse_paircode_strips_inline_whitespace() {
        assert_eq!(
            parse_paircode("X-Pairing-Code:    654321  \n", "").unwrap(),
            "654321"
        );
    }

    #[test]
    fn parse_paircode_tolerates_log_prefix() {
        // A future zeroclaw build that prefixes the line with a log
        // marker (e.g. tracing's INFO) must not silently break us.
        let stdout = "[INFO] X-Pairing-Code: 314159\n";
        assert_eq!(parse_paircode(stdout, "").unwrap(), "314159");
    }

    #[test]
    fn parse_paircode_takes_digit_prefix_only() {
        // Trailing annotations after the digits are dropped.
        let stdout = "X-Pairing-Code: 271828 (expires-in 60s)\n";
        assert_eq!(parse_paircode(stdout, "").unwrap(), "271828");
    }

    #[test]
    fn parse_paircode_rejects_non_digit_payload() {
        let err = parse_paircode("X-Pairing-Code: abc123\n", "").unwrap_err();
        assert!(matches!(err, BrowserPairError::UnparseableOutput { .. }));
    }

    #[test]
    fn parse_paircode_returns_error_when_no_match() {
        let err = parse_paircode("hello world\n", "more lines\n").unwrap_err();
        assert!(matches!(err, BrowserPairError::UnparseableOutput { .. }));
    }

    #[test]
    fn parse_paircode_empty_inputs_error() {
        let err = parse_paircode("", "").unwrap_err();
        assert!(matches!(err, BrowserPairError::UnparseableOutput { .. }));
    }

    #[test]
    fn truncate_preserves_short_strings() {
        assert_eq!(truncate("hello", 200), "hello");
    }

    #[test]
    fn truncate_appends_ellipsis_for_long_strings() {
        let long = "a".repeat(250);
        let out = truncate(&long, 100);
        assert!(out.ends_with('…'));
        assert_eq!(out.chars().count(), 101);
    }

    #[tokio::test]
    async fn stub_minter_yields_fixed_code_on_every_call() {
        let m = MinterImpl::Stub {
            fixed_code: "424242".to_string(),
        };
        assert_eq!(m.mint().await.unwrap(), "424242");
        assert_eq!(m.mint().await.unwrap(), "424242");
    }

    #[tokio::test]
    async fn detect_returns_none_for_missing_binary() {
        let cfg = BrowserPairConfig {
            cli_path: PathBuf::from("/nonexistent/path/to/zeroclaw"),
            timeout: Duration::from_secs(2),
        };
        assert!(ZeroclawCliMinter::detect(cfg).await.is_none());
    }

    #[tokio::test]
    async fn cli_minter_mint_reports_missing_binary() {
        let cfg = BrowserPairConfig {
            cli_path: PathBuf::from("/nonexistent/path/to/zeroclaw"),
            timeout: Duration::from_secs(2),
        };
        let m = ZeroclawCliMinter::new(cfg);
        let err = m.mint().await.unwrap_err();
        assert!(matches!(err, BrowserPairError::CliMissing(_)));
    }
}
