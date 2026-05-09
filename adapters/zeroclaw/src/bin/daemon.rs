//! `klodi-zeroclaw-daemon` — long-running NATS-native wake forwarder
//! for ZeroClaw.
//!
//! Per **D § D8** the daemon body lives in `klodi_rust_host::forwarder`;
//! this binary binds CLI / env and resolves the bearer token before
//! handing the [`ForwarderConfig`] to the shared runner.
//!
//! ZeroClaw 0.7.4 retired the `/hooks/wake` route in favor of `/webhook`
//! (auth-required, returns 401 without an `Authorization: Bearer …`
//! header). The token is minted by `POST /pair` against the same
//! gateway, with a one-time pairing code in the `X-Pairing-Code`
//! header. Tokens persist server-side in `gateway.paired_tokens`, but
//! deployments that rewrite `config.toml` on every boot wipe them — so
//! this daemon supports a sidecar pairing-code file
//! (`${KLODI_HOME}/zeroclaw.pairing-code`) that the operator's init
//! script refreshes per boot. The daemon consumes the code, caches the
//! resulting `zc_<hex>` bearer at `${KLODI_HOME}/zeroclaw.token`, and
//! deletes the code file so it cannot be replayed.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{BodyShape, ForwarderConfig, paths, run_forwarder};
use std::path::PathBuf;
use std::time::Duration;

/// Per-attempt timeout for the wake POST. ZeroClaw 0.7.4 `/webhook` runs
/// the agent loop synchronously and only returns the response body once
/// the agent has finished — empirically a trivial `{"message":"ping"}`
/// already takes ~6s, and real `channel.message` wakes (agent reasons +
/// calls `klodi_channel_message` to reply) routinely take 15–60s but a
/// long-tool-using turn can run far longer. 240s buys generous headroom
/// for that long tail while still bounding pathological hangs. Each
/// in-flight POST holds only its own task — the forwarder serves
/// notifications and channel messages on independent subscriber tasks,
/// so a slow wake here does not block other deliveries. Anything shorter
/// than the agent's typical turn pins the daemon in a NAK / redeliver
/// loop, and the redeliveries stack parallel agent loops on the gateway
/// since each retry kicks off a fresh agent init.
const WAKE_POST_TIMEOUT: Duration = Duration::from_secs(240);

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-daemon",
    about = "Long-running NATS-WS wake daemon for klodi on ZeroClaw.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    /// Local ZeroClaw `/webhook` URL.
    #[arg(
        long,
        env = "ZEROCLAW_WEBHOOK_URL",
        default_value = "http://127.0.0.1:7070/webhook"
    )]
    zeroclaw_webhook_url: String,
    /// Override the derived `/pair` URL. Daemon derives this by
    /// replacing the trailing `/webhook` in `--zeroclaw-webhook-url`
    /// with `/pair`; set this explicitly when the gateway lives at a
    /// non-canonical path.
    #[arg(long, env = "ZEROCLAW_PAIR_URL")]
    zeroclaw_pair_url: Option<String>,
    /// Bearer token for ZeroClaw's `/webhook`. When unset the daemon
    /// resolves the bearer at startup: a sidecar pairing-code file at
    /// `${KLODI_HOME}/zeroclaw.pairing-code` triggers a pair-dance and
    /// caches the resulting `zc_<hex>` token at
    /// `${KLODI_HOME}/zeroclaw.token`; otherwise the daemon reads the
    /// cached token.
    #[arg(long, env = "ZEROCLAW_AGENT_TOKEN")]
    zeroclaw_token: Option<String>,
    /// Optional `/healthz` HTTP probe port (P2-25).
    #[arg(long, env = "ZEROCLAW_HEALTH_PORT")]
    health_port: Option<u16>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();
    let creds_path = cli.creds.unwrap_or_else(paths::creds_path);
    let config_path = cli.config.unwrap_or_else(paths::config_path);

    if cli.zeroclaw_webhook_url.is_empty() {
        bail!("--zeroclaw-webhook-url (or ZEROCLAW_WEBHOOK_URL) must be set");
    }
    if !creds_path.exists() {
        bail!(
            "klodi creds not found at {} — run klodi-zeroclaw-register first",
            creds_path.display(),
        );
    }
    if !config_path.exists() {
        bail!(
            "klodi config not found at {} — run klodi-zeroclaw-register first",
            config_path.display(),
        );
    }

    let bearer = pair::resolve_bearer(
        cli.zeroclaw_token.as_deref(),
        cli.zeroclaw_pair_url.as_deref(),
        &cli.zeroclaw_webhook_url,
        &paths::klodi_home(),
    )
    .await?;

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        wake_url: cli.zeroclaw_webhook_url,
        bearer_token: Some(bearer),
        user_agent: format!(
            "klodi-zeroclaw-daemon/{}",
            env!("CARGO_PKG_VERSION")
        ),
        log_event_prefix: "klodi_zeroclaw".into(),
        health_port: cli.health_port,
        body_shape: BodyShape::MessageWrapped,
        wake_post_timeout: WAKE_POST_TIMEOUT,
    })
    .await
    .context("running klodi-zeroclaw-daemon")
}

/// Pair-bootstrap helpers — derive the `/pair` URL, consume a sidecar
/// pairing-code, cache the minted bearer, fall back to the cache.
mod pair {
    use anyhow::{Context, Result, bail};
    use klodi_nats_client::klodi_secret_write;
    use serde::Deserialize;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    /// `${KLODI_HOME}/zeroclaw.pairing-code` — sidecar one-time code the
    /// operator's init script writes; the daemon reads + deletes it.
    pub fn pairing_code_path(home: &Path) -> PathBuf {
        home.join("zeroclaw.pairing-code")
    }

    /// `${KLODI_HOME}/zeroclaw.token` — cached `zc_<hex>` bearer minted
    /// from a successful `/pair`. Mode 0600 on Unix.
    pub fn token_path(home: &Path) -> PathBuf {
        home.join("zeroclaw.token")
    }

    /// Resolve `/pair` by stripping a trailing `/webhook` from the
    /// webhook URL and appending `/pair`. Honors the explicit override
    /// when present so non-canonical layouts keep working.
    pub fn derive_pair_url(
        webhook_url: &str,
        override_pair: Option<&str>,
    ) -> Result<String> {
        if let Some(p) = override_pair {
            return Ok(p.to_string());
        }
        let trimmed = webhook_url.trim_end_matches('/');
        if let Some(base) = trimmed.strip_suffix("/webhook") {
            Ok(format!("{base}/pair"))
        } else {
            bail!(
                "cannot derive /pair URL from webhook URL {webhook_url:?}: expected trailing '/webhook'. \
                 Set ZEROCLAW_PAIR_URL explicitly, or pair manually and pass ZEROCLAW_AGENT_TOKEN."
            )
        }
    }

    #[derive(Deserialize)]
    struct PairResponse {
        token: String,
        #[serde(default)]
        paired: bool,
    }

    pub async fn resolve_bearer(
        env_token: Option<&str>,
        pair_url_override: Option<&str>,
        webhook_url: &str,
        klodi_home: &Path,
    ) -> Result<String> {
        // 1. Explicit env override — operator manages manually.
        if let Some(token) = env_token {
            let token = token.trim();
            if token.is_empty() {
                bail!("ZEROCLAW_AGENT_TOKEN is set but empty");
            }
            tracing::info!("klodi_zeroclaw_bearer_from_env");
            return Ok(token.to_string());
        }

        let code_path = pairing_code_path(klodi_home);
        let cache_path = token_path(klodi_home);

        // 2. Fresh pairing-code file → re-pair and cache. Init scripts
        // that wipe ZeroClaw's `gateway.paired_tokens` on every boot
        // must write a fresh code here so the daemon can recover.
        if code_path.exists() {
            let code = std::fs::read_to_string(&code_path)
                .with_context(|| {
                    format!("read pairing code at {}", code_path.display())
                })?
                .trim()
                .to_string();
            if code.is_empty() {
                bail!(
                    "pairing code at {} is empty",
                    code_path.display()
                );
            }
            let pair_url = derive_pair_url(webhook_url, pair_url_override)?;
            let token = pair_with_zeroclaw(&pair_url, &code).await?;
            persist_token(&cache_path, &token)?;
            if let Err(err) = std::fs::remove_file(&code_path) {
                tracing::warn!(
                    error = %err,
                    path = %code_path.display(),
                    "klodi_zeroclaw_pairing_code_cleanup_failed"
                );
            }
            tracing::info!(
                pair_url = %pair_url,
                "klodi_zeroclaw_paired"
            );
            return Ok(token);
        }

        // 3. Cached token from a prior successful pair.
        if cache_path.exists() {
            let token = std::fs::read_to_string(&cache_path)
                .with_context(|| {
                    format!("read cached token at {}", cache_path.display())
                })?
                .trim()
                .to_string();
            if token.is_empty() {
                bail!(
                    "cached token at {} is empty",
                    cache_path.display()
                );
            }
            tracing::info!("klodi_zeroclaw_bearer_from_cache");
            return Ok(token);
        }

        bail!(
            "ZeroClaw bearer unavailable: set ZEROCLAW_AGENT_TOKEN, or write a one-time pairing code to {} \
             (the daemon will POST /pair, cache the bearer at {}, and consume the code file).",
            code_path.display(),
            cache_path.display(),
        )
    }

    async fn pair_with_zeroclaw(
        pair_url: &str,
        code: &str,
    ) -> Result<String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .context("build pair HTTP client")?;
        let resp = http
            .post(pair_url)
            .header("X-Pairing-Code", code)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .with_context(|| format!("POST {pair_url} (pair)"))?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            bail!(
                "pair POST to {} returned {}: {}",
                pair_url,
                status,
                truncate(&body, 200),
            );
        }
        let parsed: PairResponse = serde_json::from_str(&body)
            .with_context(|| {
                format!(
                    "decode pair response (status {status}): {}",
                    truncate(&body, 200)
                )
            })?;
        if !parsed.token.starts_with("zc_") {
            bail!(
                "unexpected token shape from /pair (expected 'zc_' prefix): {:?}",
                truncate(&parsed.token, 16)
            );
        }
        if !parsed.paired {
            tracing::warn!(
                "klodi_zeroclaw_pair_response_paired_false"
            );
        }
        Ok(parsed.token)
    }

    fn persist_token(target: &Path, token: &str) -> Result<()> {
        klodi_secret_write(target, token.as_bytes(), 0o600)
            .with_context(|| {
                format!("klodi_secret_write {}", target.display())
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
        use tempfile::tempdir;

        #[test]
        fn derive_pair_url_canonical() {
            assert_eq!(
                derive_pair_url("http://127.0.0.1:7070/webhook", None).unwrap(),
                "http://127.0.0.1:7070/pair"
            );
        }

        #[test]
        fn derive_pair_url_strips_trailing_slash() {
            assert_eq!(
                derive_pair_url("http://127.0.0.1:7070/webhook/", None).unwrap(),
                "http://127.0.0.1:7070/pair"
            );
        }

        #[test]
        fn derive_pair_url_handles_subpath() {
            assert_eq!(
                derive_pair_url("https://gw.example/zc/webhook", None).unwrap(),
                "https://gw.example/zc/pair"
            );
        }

        #[test]
        fn derive_pair_url_explicit_override_wins() {
            assert_eq!(
                derive_pair_url(
                    "http://127.0.0.1:7070/whatever",
                    Some("http://other:9000/pair")
                )
                .unwrap(),
                "http://other:9000/pair"
            );
        }

        #[test]
        fn derive_pair_url_rejects_non_webhook_path() {
            let err = derive_pair_url("http://127.0.0.1:7070/wakes", None)
                .unwrap_err()
                .to_string();
            assert!(
                err.contains("expected trailing '/webhook'"),
                "unexpected error: {err}"
            );
        }

        #[tokio::test]
        async fn resolve_bearer_prefers_env() {
            let dir = tempdir().unwrap();
            let token = resolve_bearer(
                Some("zc_explicit_env"),
                None,
                "http://127.0.0.1:7070/webhook",
                dir.path(),
            )
            .await
            .unwrap();
            assert_eq!(token, "zc_explicit_env");
        }

        #[tokio::test]
        async fn resolve_bearer_reads_cached_token_when_no_code_file() {
            let dir = tempdir().unwrap();
            std::fs::write(
                dir.path().join("zeroclaw.token"),
                "zc_cached_value\n",
            )
            .unwrap();
            let token = resolve_bearer(
                None,
                None,
                "http://127.0.0.1:7070/webhook",
                dir.path(),
            )
            .await
            .unwrap();
            assert_eq!(token, "zc_cached_value");
        }

        #[tokio::test]
        async fn resolve_bearer_bails_when_no_source_available() {
            let dir = tempdir().unwrap();
            let err = resolve_bearer(
                None,
                None,
                "http://127.0.0.1:7070/webhook",
                dir.path(),
            )
            .await
            .unwrap_err()
            .to_string();
            assert!(err.contains("ZEROCLAW_AGENT_TOKEN"));
            assert!(err.contains("zeroclaw.pairing-code"));
        }

        #[tokio::test]
        async fn resolve_bearer_rejects_empty_cached_token() {
            let dir = tempdir().unwrap();
            std::fs::write(dir.path().join("zeroclaw.token"), "   \n").unwrap();
            assert!(
                resolve_bearer(
                    None,
                    None,
                    "http://127.0.0.1:7070/webhook",
                    dir.path()
                )
                .await
                .is_err()
            );
        }
    }
}
