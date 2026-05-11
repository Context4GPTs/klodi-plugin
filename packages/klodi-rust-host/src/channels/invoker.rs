//! `ChannelInvoker` — abstraction over the transport that talks to
//! upstream channels.
//!
//! In 0.2.9 the only variant is `Shell`, which spawns
//! `zeroclaw channel send <message> --channel-id <id> --recipient <r>`.
//! Long-term, when upstream exposes a library or REST surface, new
//! variants land here without touching `UpstreamChannel`.
//!
//! The shell variant mirrors the existing `MinterImpl::Cli` pattern in
//! `zeroclaw_browser_pairing` — same `tokio::process::Command`, same
//! `--zeroclaw-cli` resolvable path, same timeout shape.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use tokio::process::Command;
use tokio::time::timeout;

/// Default timeout for a single `zeroclaw channel send` invocation.
/// 30s gives the upstream transport time to do per-medium work
/// (Telegram bot API call, email send, …) without burning a slot
/// indefinitely if the upstream process is stuck.
pub const DEFAULT_SHELL_TIMEOUT: Duration = Duration::from_secs(30);

/// Default path of the `zeroclaw` CLI. Resolved through `PATH` when
/// the operator hasn't pinned `--zeroclaw-cli` to a specific binary.
pub const DEFAULT_CLI: &str = "zeroclaw";

/// Transport for `UpstreamChannel`.
///
/// Enum (not trait) because the variant set is closed and small. A
/// future `Library` variant lands here without touching call sites.
pub enum ChannelInvoker {
    /// Shell out to `zeroclaw channel send`. The 0.2.9 default.
    Shell {
        /// Path of the `zeroclaw` CLI. Defaults to `"zeroclaw"`
        /// resolved through `PATH`.
        cli_path: PathBuf,
        /// Per-invocation timeout.
        timeout: Duration,
    },
    /// Used in tests — captures invocations into a shared buffer
    /// instead of spawning a real process. Never constructed by
    /// production code paths.
    #[cfg(test)]
    Fake {
        captured: std::sync::Arc<
            tokio::sync::Mutex<Vec<(String, String, String)>>,
        >,
        outcome: FakeOutcome,
    },
}

#[cfg(test)]
#[derive(Clone)]
pub enum FakeOutcome {
    Ok,
    Err(String),
}

impl ChannelInvoker {
    /// Default-shaped `Shell` variant — picks `DEFAULT_CLI` + `DEFAULT_SHELL_TIMEOUT`.
    pub fn shell_default() -> Self {
        Self::Shell {
            cli_path: PathBuf::from(DEFAULT_CLI),
            timeout: DEFAULT_SHELL_TIMEOUT,
        }
    }

    /// `Shell` variant with explicit `cli_path` (`--zeroclaw-cli`).
    pub fn shell(cli_path: PathBuf, timeout: Duration) -> Self {
        Self::Shell { cli_path, timeout }
    }

    /// Send `message` to `recipient` on the upstream channel
    /// `channel_id`. Returns `Ok(())` on success; non-zero exit or
    /// transport error becomes `Err`.
    pub async fn send(
        &self,
        channel_id: &str,
        recipient: &str,
        message: &str,
    ) -> Result<()> {
        match self {
            Self::Shell {
                cli_path,
                timeout: t,
            } => shell_send(cli_path, *t, channel_id, recipient, message).await,
            #[cfg(test)]
            Self::Fake { captured, outcome } => {
                let mut g = captured.lock().await;
                g.push((
                    channel_id.to_string(),
                    recipient.to_string(),
                    message.to_string(),
                ));
                match outcome {
                    FakeOutcome::Ok => Ok(()),
                    FakeOutcome::Err(s) => bail!(s.clone()),
                }
            }
        }
    }
}

async fn shell_send(
    cli_path: &PathBuf,
    cli_timeout: Duration,
    channel_id: &str,
    recipient: &str,
    message: &str,
) -> Result<()> {
    let mut cmd = Command::new(cli_path);
    cmd.arg("channel")
        .arg("send")
        .arg(message)
        .arg("--channel-id")
        .arg(channel_id)
        .arg("--recipient")
        .arg(recipient)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let exec = async {
        let output = cmd.output().await.with_context(|| {
            format!(
                "spawning {} channel send (channel_id={channel_id} recipient={recipient})",
                cli_path.display(),
            )
        })?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            bail!(
                "{} channel send returned {} for channel_id={channel_id} recipient={recipient}: stderr={} stdout={}",
                cli_path.display(),
                output.status,
                truncate(&stderr, 400),
                truncate(&stdout, 200),
            );
        }
        Ok(())
    };

    match timeout(cli_timeout, exec).await {
        Ok(res) => res,
        Err(_) => bail!(
            "{} channel send timed out after {:?} (channel_id={channel_id} recipient={recipient})",
            cli_path.display(),
            cli_timeout
        ),
    }
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
    fn shell_default_uses_path_resolvable_default() {
        match ChannelInvoker::shell_default() {
            ChannelInvoker::Shell { cli_path, timeout } => {
                assert_eq!(cli_path, PathBuf::from(DEFAULT_CLI));
                assert_eq!(timeout, DEFAULT_SHELL_TIMEOUT);
            }
            _ => panic!("expected Shell variant"),
        }
    }

    #[tokio::test]
    async fn fake_variant_captures_invocations() {
        let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let invoker = ChannelInvoker::Fake {
            captured: captured.clone(),
            outcome: FakeOutcome::Ok,
        };
        invoker
            .send("telegram", "123", "hello world")
            .await
            .unwrap();
        invoker
            .send("slack", "#klodi-alerts", "another")
            .await
            .unwrap();
        let g = captured.lock().await;
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].0, "telegram");
        assert_eq!(g[0].1, "123");
        assert_eq!(g[0].2, "hello world");
        assert_eq!(g[1].0, "slack");
    }

    #[tokio::test]
    async fn fake_variant_propagates_error_outcome() {
        let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let invoker = ChannelInvoker::Fake {
            captured: captured.clone(),
            outcome: FakeOutcome::Err("simulated CLI failure".into()),
        };
        let err = invoker.send("x", "y", "z").await.unwrap_err().to_string();
        assert!(err.contains("simulated"), "got: {err}");
        assert_eq!(captured.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn shell_send_fails_when_cli_path_missing() {
        let invoker = ChannelInvoker::Shell {
            cli_path: PathBuf::from("/nope/this/does/not/exist/zeroclaw"),
            timeout: Duration::from_secs(1),
        };
        let err = invoker
            .send("telegram", "123", "x")
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("spawning") || err.contains("No such file"),
            "got: {err}",
        );
    }
}
