//! `klodi-zeroclaw-daemon` — long-running NATS-native wake forwarder
//! for ZeroClaw.
//!
//! Per **D § D8** the daemon body lives in `klodi_rust_host::forwarder`;
//! this binary binds CLI / env, resolves the bearer + operator session,
//! posts the plugin-authored heartbeat + bootstrap note (I-7 / I-8 of
//! `docs/plans/2026-05-10-klodi-zeroclaw-wake-routing-redesign.md`), and
//! then hands a [`ForwarderConfig`] with `BodyShape::ZeroClawSession`
//! (I-1) to the shared runner so wakes write into the operator's
//! ZeroClaw session via `/ws/chat` instead of POSTing to `/webhook`.
//!
//! Bearer pairing flow is unchanged from 0.2.x: a sidecar pairing-code
//! file (`${KLODI_HOME}/zeroclaw.pairing-code`) triggers `POST /pair`,
//! the resulting `zc_<hex>` bearer is cached at
//! `${KLODI_HOME}/zeroclaw.token`, and the code file is consumed.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{
    BodyShape, ForwarderConfig, ResolvedSession, ZeroClawWsConfig,
    adopt_session_id, paths, resolve_session_id, run_forwarder,
    send_session_message, zeroclaw_bootstrap_note,
};
use std::path::PathBuf;
use std::time::Duration;

/// Per-attempt timeout for the wake POST. Only relevant when the daemon
/// runs in the legacy `BodyShape::MessageWrapped` path against
/// `/webhook` — the WS path doesn't use reqwest at all. Kept as a
/// generous fallback so an operator who explicitly opts into the legacy
/// path (`--legacy-webhook`) still gets the long-tail headroom that
/// klodi-zeroclaw 0.2.5 had.
const LEGACY_WAKE_POST_TIMEOUT: Duration = Duration::from_secs(240);

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
    /// Local ZeroClaw `/webhook` URL. The daemon derives the WS endpoint
    /// (`/ws/chat`) and the REST base from this — see
    /// `klodi_rust_host::ZeroClawWsConfig::from_webhook_url`. Override
    /// with `--ws-url` / `--http-base` when the gateway lives at a
    /// non-canonical path.
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
    /// Override the derived `/ws/chat` URL.
    #[arg(long, env = "ZEROCLAW_WS_URL")]
    zeroclaw_ws_url: Option<String>,
    /// Override the derived REST base used for session diagnostics.
    #[arg(long, env = "ZEROCLAW_HTTP_BASE")]
    zeroclaw_http_base: Option<String>,
    /// Bearer token for ZeroClaw's `/webhook` and `/ws/chat`. When unset
    /// the daemon resolves the bearer at startup: a sidecar pairing-code
    /// file at `${KLODI_HOME}/zeroclaw.pairing-code` triggers a
    /// pair-dance and caches the resulting `zc_<hex>` token at
    /// `${KLODI_HOME}/zeroclaw.token`; otherwise the daemon reads the
    /// cached token.
    #[arg(long, env = "ZEROCLAW_AGENT_TOKEN")]
    zeroclaw_token: Option<String>,
    /// Optional `/healthz` HTTP probe port (P2-25).
    #[arg(long, env = "ZEROCLAW_HEALTH_PORT")]
    health_port: Option<u16>,
    /// Force the legacy `POST /webhook` body shape instead of the new
    /// WS / operator-session delivery path. Only useful for operators
    /// running a ZeroClaw build that hasn't deployed `/ws/chat` (none
    /// shipped post-0.7.x). Default is `false` — the WS path is the
    /// canonical one as of klodi-zeroclaw 0.2.6.
    #[arg(long, env = "ZEROCLAW_LEGACY_WEBHOOK", default_value_t = false)]
    legacy_webhook: bool,
    /// Adopt an existing ZeroClaw session id for klodi instead of
    /// minting a new one. Per plan §5 I-2, the default is to always
    /// create a new dedicated session (operators with a pre-existing
    /// chat keep both unmixed); this flag is the explicit opt-in when
    /// the operator wants their klodi activity to land in an existing
    /// session.
    ///
    /// The daemon probes the gateway to confirm the id resumes
    /// successfully, then persists it to `${KLODI_HOME}/zeroclaw.session`
    /// (overwriting any prior value). On any probe failure (typo,
    /// wrong bearer, deleted session) the daemon bails — typos must
    /// not silently re-bootstrap.
    #[arg(long, env = "ZEROCLAW_ADOPT_SESSION")]
    adopt_session: Option<String>,
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

    let ws_config = build_ws_config(
        &cli.zeroclaw_webhook_url,
        cli.zeroclaw_ws_url.as_deref(),
        cli.zeroclaw_http_base.as_deref(),
        bearer.clone(),
    )?;

    if cli.legacy_webhook {
        // Operator explicitly opted into the pre-0.2.6 path. Skip the
        // session bootstrap + heartbeat (no session to write into) and
        // hand the forwarder the old `MessageWrapped` shape against
        // `/webhook`. The 240s timeout band-aid stays in this branch.
        tracing::warn!(
            "klodi_zeroclaw_legacy_webhook_enabled — bypassing /ws/chat session delivery; \
             wake processing will block on the agent's full turn duration"
        );
        return run_forwarder(ForwarderConfig {
            creds_path,
            config_path,
            wake_url: cli.zeroclaw_webhook_url.clone(),
            bearer_token: Some(bearer),
            user_agent: format!(
                "klodi-zeroclaw-daemon/{}",
                env!("CARGO_PKG_VERSION")
            ),
            log_event_prefix: "klodi_zeroclaw".into(),
            health_port: cli.health_port,
            body_shape: BodyShape::MessageWrapped,
            wake_post_timeout: LEGACY_WAKE_POST_TIMEOUT,
        })
        .await
        .context("running klodi-zeroclaw-daemon (legacy /webhook path)");
    }

    // Heartbeat + (optional) bootstrap note. Read handle/user_id/nats_url
    // from config.json directly — KlodiClient::new will load it again
    // inside run_forwarder, but we need the values before then so the
    // operator sees the heartbeat at the moment the daemon starts, not
    // after the first NATS subscribe round-trips. We compose the
    // heartbeat string here so it can be fed into the atomic bootstrap
    // path (plan-update fix C — closes the empty-session GC window
    // described in the updated §4).
    let klodi_home = paths::klodi_home();
    let cfg_summary = read_config_summary(&config_path)
        .with_context(|| format!("reading {} for heartbeat", config_path.display()))?;
    let bootstrap_inputs = zeroclaw_bootstrap_note::BootstrapInputs {
        handle: &cfg_summary.handle,
        user_id: &cfg_summary.user_id,
        nats_url: &cfg_summary.nats_url,
        daemon_version: env!("CARGO_PKG_VERSION"),
    };
    let heartbeat = zeroclaw_bootstrap_note::heartbeat(&bootstrap_inputs);

    // Resolve operator session. Adopt path takes precedence (operator
    // explicit), then read-or-bootstrap with atomic first-write.
    let resolved = if let Some(adopt_id) = &cli.adopt_session {
        adopt_session_id(&klodi_home, &ws_config, adopt_id)
            .await
            .context("adopting operator-supplied ZeroClaw session id")?
    } else {
        resolve_session_id(&klodi_home, &ws_config, &heartbeat)
            .await
            .context("resolving ZeroClaw operator session")?
    };
    tracing::info!(
        session_id = %resolved.session_id,
        freshly_minted = resolved.freshly_minted,
        message_count = ?resolved.message_count,
        adopted = cli.adopt_session.is_some(),
        "klodi_zeroclaw_session_resolved"
    );

    // The atomic resolve path already wrote the heartbeat as the
    // session's first message — skip the standalone post in that case
    // so the operator's chat doesn't show the same line twice.
    let heartbeat_already_written = resolved.freshly_minted;
    post_startup_notes(
        &ws_config,
        &resolved,
        &bootstrap_inputs,
        &heartbeat,
        heartbeat_already_written,
    )
    .await?;

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        wake_url: cli.zeroclaw_webhook_url.clone(),
        bearer_token: Some(bearer),
        user_agent: format!(
            "klodi-zeroclaw-daemon/{}",
            env!("CARGO_PKG_VERSION")
        ),
        log_event_prefix: "klodi_zeroclaw".into(),
        health_port: cli.health_port,
        body_shape: BodyShape::ZeroClawSession {
            ws_config,
            session_id: resolved.session_id,
        },
        // The WS path doesn't use this — it's only consulted by
        // forward_http when body_shape is Structured/MessageWrapped.
        // Keep the generous default in case a future operator flips
        // back to the legacy path mid-config without restarting.
        wake_post_timeout: LEGACY_WAKE_POST_TIMEOUT,
    })
    .await
    .context("running klodi-zeroclaw-daemon")
}

/// Build the WS config from CLI inputs. Honours explicit `--ws-url` /
/// `--http-base` overrides; otherwise derives from the webhook URL.
fn build_ws_config(
    webhook_url: &str,
    ws_override: Option<&str>,
    http_base_override: Option<&str>,
    bearer: String,
) -> Result<ZeroClawWsConfig> {
    let derived = ZeroClawWsConfig::from_webhook_url(webhook_url, bearer.clone())?;
    let ws_url = ws_override
        .map(str::to_string)
        .unwrap_or(derived.ws_url);
    let http_base = http_base_override
        .map(str::to_string)
        .unwrap_or(derived.http_base);
    Ok(ZeroClawWsConfig {
        ws_url,
        http_base,
        bearer,
    })
}

/// Subset of `${KLODI_HOME}/config.json` fields needed for heartbeat
/// composition. Loaded directly via serde so we don't have to spin a
/// full `KlodiClient` ahead of `run_forwarder`.
#[derive(Debug)]
struct ConfigSummary {
    handle: String,
    user_id: String,
    nats_url: String,
}

fn read_config_summary(path: &std::path::Path) -> Result<ConfigSummary> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("read {}", path.display()))?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse {} as JSON", path.display()))?;
    let handle = parsed
        .get("handle")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("config.json missing 'handle'"))?
        .to_string();
    let user_id = parsed
        .get("user_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("config.json missing 'user_id'"))?
        .to_string();
    let nats_url = parsed
        .get("nats_url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("config.json missing 'nats_url'"))?
        .to_string();
    Ok(ConfigSummary {
        handle,
        user_id,
        nats_url,
    })
}

/// Post the heartbeat (when not already written atomically by the
/// bootstrap path) and the plugin-authored bootstrap note (only when
/// the session is freshly minted OR has zero pre-existing messages).
/// Failures here are non-fatal — the daemon still boots because the
/// operator is better off with a missing intro line than with a daemon
/// that refuses to start.
async fn post_startup_notes(
    ws: &ZeroClawWsConfig,
    resolved: &ResolvedSession,
    inputs: &zeroclaw_bootstrap_note::BootstrapInputs<'_>,
    heartbeat: &str,
    heartbeat_already_written: bool,
) -> Result<()> {
    if !heartbeat_already_written {
        if let Err(err) =
            send_session_message(ws, &resolved.session_id, heartbeat).await
        {
            tracing::warn!(
                error = %format!("{err:#}"),
                session_id = %resolved.session_id,
                "klodi_zeroclaw_heartbeat_post_failed_continuing"
            );
            // Continue — the operator will still see wakes when they arrive.
            return Ok(());
        }
    }

    // Bootstrap note — sent on freshly-minted sessions OR sessions with
    // no prior messages. Steady-state daemon restarts skip it so the
    // operator's chat doesn't accumulate identical intros.
    let needs_intro = resolved.freshly_minted
        || resolved.message_count.unwrap_or(1) == 0;
    if needs_intro {
        let body = zeroclaw_bootstrap_note::bootstrap_note(inputs);
        if let Err(err) =
            send_session_message(ws, &resolved.session_id, &body).await
        {
            tracing::warn!(
                error = %format!("{err:#}"),
                session_id = %resolved.session_id,
                "klodi_zeroclaw_bootstrap_note_post_failed_continuing"
            );
        }
    }
    Ok(())
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

#[cfg(test)]
mod daemon_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn build_ws_config_uses_derived_when_no_overrides() {
        let cfg = build_ws_config(
            "http://127.0.0.1:7070/webhook",
            None,
            None,
            "zc_token".into(),
        )
        .unwrap();
        assert_eq!(cfg.ws_url, "ws://127.0.0.1:7070/ws/chat");
        assert_eq!(cfg.http_base, "http://127.0.0.1:7070");
        assert_eq!(cfg.bearer, "zc_token");
    }

    #[test]
    fn build_ws_config_honours_explicit_overrides() {
        let cfg = build_ws_config(
            "http://127.0.0.1:7070/webhook",
            Some("wss://other:8443/ws/chat"),
            Some("https://other:8443"),
            "zc_token".into(),
        )
        .unwrap();
        assert_eq!(cfg.ws_url, "wss://other:8443/ws/chat");
        assert_eq!(cfg.http_base, "https://other:8443");
    }

    #[test]
    fn read_config_summary_extracts_required_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(
            &path,
            r#"{"handle":"alice","user_id":"u1","nats_url":"wss://nats.example/4222","nkey_public":"X"}"#,
        )
        .unwrap();
        let cfg = read_config_summary(&path).unwrap();
        assert_eq!(cfg.handle, "alice");
        assert_eq!(cfg.user_id, "u1");
        assert_eq!(cfg.nats_url, "wss://nats.example/4222");
    }

    #[test]
    fn read_config_summary_errors_on_missing_handle() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, r#"{"user_id":"u1","nats_url":"x"}"#).unwrap();
        let err = read_config_summary(&path).unwrap_err().to_string();
        assert!(err.contains("handle"), "got: {err}");
    }

    #[test]
    fn read_config_summary_errors_on_invalid_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, "{not json").unwrap();
        assert!(read_config_summary(&path).is_err());
    }
}
