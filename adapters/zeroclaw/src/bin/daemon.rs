//! `klodi-zeroclaw-daemon` — long-running NATS-native wake forwarder
//! for ZeroClaw.
//!
//! The daemon body lives in `klodi_rust_host::forwarder`; this binary
//! binds CLI / env, resolves the bearer + operator session, posts the
//! plugin-authored heartbeat + bootstrap note, and then hands a
//! [`ForwarderConfig`] with `BodyShape::ZeroClawSession` to the shared
//! runner so wakes write into the operator's ZeroClaw session via
//! `/ws/chat`. The pre-0.2.6 `POST /webhook` delivery path was
//! removed in 0.2.8 — every supported ZeroClaw build (≥ 0.7.4)
//! exposes `/ws/chat`, and the legacy synchronous-prompt path was
//! unusable on real klodi turns (30s gateway timeout vs. 60s+ agent
//! turns).
//!
//! Bearer pairing flow (as of 0.2.8): when no explicit env token, no
//! cached `${KLODI_HOME}/zeroclaw.token`, and no sidecar
//! `${KLODI_HOME}/zeroclaw.pairing-code` exist, the daemon auto-mints
//! its own pairing code via the gateway's
//! `zeroclaw gateway get-paircode --new` CLI and pairs itself —
//! eliminating the operator step of finding the gateway's startup code
//! and writing it to disk on first boot. Sidecar codes still take
//! precedence (operator-controlled re-pair).
//!
//! 0.2.8 also exposes a loopback browser-pairing helper at a tty-time
//! auto-opened URL ([`klodi_rust_host::zeroclaw_pairing_shim`]). The
//! shim hands the operator a fresh pairing code on every page hit,
//! pre-copies it to clipboard, and redirects to the dashboard — so
//! the dashboard's "PAIRING REQUIRED" prompt is a single ⌘V + Enter.
//!
//! 0.2.9 adds the channel registry (built before bootstrap-note post)
//! and the reply-attribution task that captures dashboard replies for
//! the MCP server's approval gate.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{
    BodyShape, BrowserPairConfig, ForwarderConfig, MinterImpl, ResolvedSession,
    SessionBinding, ShimConfig, ShimHandle, ZeroClawWsConfig, ZeroclawCliMinter,
    adopt_session_id, channels::factory::build_channel_registry, paths,
    resolve_session_id, run_forwarder, send_session_message,
    zeroclaw_bootstrap_note,
};
use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use futures_util::StreamExt;

/// Nominal value for `ForwarderConfig::wake_post_timeout`. The
/// `BodyShape::ZeroClawSession` path doesn't use reqwest for wake
/// delivery — the field is required by the shared `ForwarderConfig`
/// struct but never consulted on this code path.
const WAKE_POST_TIMEOUT_PLACEHOLDER: Duration = Duration::from_secs(60);

/// Timeout for spawning + waiting on the gateway CLI when the daemon
/// auto-mints a pairing code. The CLI typically responds in <100ms;
/// 5s is a generous ceiling for a heavily-loaded gateway.
const BROWSER_PAIR_CLI_TIMEOUT: Duration = Duration::from_secs(5);

/// Whether to auto-open the operator's browser at the loopback
/// pairing-helper URL on startup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
enum OpenBrowserDefault {
    /// Auto-open if stdout is a tty, skip otherwise. Default.
    Auto,
    /// Auto-open unconditionally.
    Always,
    /// Never auto-open.
    Never,
}

impl std::fmt::Display for OpenBrowserDefault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Auto => f.write_str("auto"),
            Self::Always => f.write_str("always"),
            Self::Never => f.write_str("never"),
        }
    }
}

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
    /// ZeroClaw gateway base-URL hint. The daemon derives the canonical
    /// `/ws/chat` (wake delivery) and `/pair` (bearer mint) endpoints
    /// from this — see `klodi_rust_host::ZeroClawWsConfig::from_webhook_url`.
    /// The env-var name is a holdover from the pre-0.2.6 era when wakes
    /// went to `POST /webhook` directly; today the literal `/webhook`
    /// route is unused. Override with `--zeroclaw-ws-url` /
    /// `--zeroclaw-http-base` when the gateway lives at a non-canonical
    /// path.
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
    /// Bearer token used as `Authorization: Bearer` on the `/ws/chat`
    /// upgrade. When unset the daemon resolves the bearer at startup:
    /// a sidecar pairing-code file at `${KLODI_HOME}/zeroclaw.pairing-code`
    /// triggers a `POST /pair` and caches the resulting `zc_<hex>`
    /// token at `${KLODI_HOME}/zeroclaw.token`; otherwise the daemon
    /// reads the cached token, or (0.2.8+) auto-mints a fresh code via
    /// the gateway CLI.
    #[arg(long, env = "ZEROCLAW_AGENT_TOKEN")]
    zeroclaw_token: Option<String>,
    /// Optional `/healthz` HTTP probe port (P2-25).
    #[arg(long, env = "ZEROCLAW_HEALTH_PORT")]
    health_port: Option<u16>,
    /// Adopt an existing ZeroClaw session id for klodi instead of
    /// minting a new one. The default is to always create a new
    /// dedicated session (operators with a pre-existing chat keep both
    /// unmixed); this flag is the explicit opt-in when the operator
    /// wants their klodi activity to land in an existing session.
    ///
    /// The daemon probes the gateway to confirm the id resumes
    /// successfully, then persists it to `${KLODI_HOME}/zeroclaw.session`
    /// (overwriting any prior value). On any probe failure (typo,
    /// wrong bearer, deleted session) the daemon bails — typos must
    /// not silently re-bootstrap.
    #[arg(long, env = "ZEROCLAW_ADOPT_SESSION")]
    adopt_session: Option<String>,
    /// Path to the `zeroclaw` CLI used to mint a fresh pairing code on
    /// demand. Default `"zeroclaw"`, resolved on PATH.
    /// Override when the gateway lives at a non-canonical path or when
    /// the daemon runs on a different host. If the binary is not
    /// reachable, the daemon falls back to the env / cached token /
    /// sidecar code bearer-resolve flow and the loopback browser-pairing
    /// helper auto-disables itself.
    #[arg(long, env = "ZEROCLAW_CLI", default_value = "zeroclaw")]
    zeroclaw_cli: PathBuf,
    /// Disable the loopback browser-pairing helper. When set, the
    /// daemon does not detect the gateway CLI, does not auto-mint its
    /// own bearer, does not bind the helper port, and does not
    /// auto-open the operator's browser. Use for non-canonical
    /// deployments where `zeroclaw` isn't on PATH, or when you want
    /// the operator to manage pairing manually via
    /// `${KLODI_HOME}/zeroclaw.pairing-code` or `ZEROCLAW_AGENT_TOKEN`.
    #[arg(
        long,
        env = "ZEROCLAW_BROWSER_PAIR_DISABLE",
        default_value_t = false
    )]
    no_browser_pair_shim: bool,
    /// TCP port the loopback browser-pairing helper binds on (always
    /// `127.0.0.1`). Default `0` = let the OS pick an ephemeral port;
    /// the chosen port is included in the heartbeat the operator sees
    /// in chat. Pin a port when you want a stable bookmarkable URL
    /// across restarts.
    #[arg(
        long,
        env = "ZEROCLAW_BROWSER_PAIR_PORT",
        default_value_t = 0_u16
    )]
    browser_pair_shim_port: u16,
    /// Override the dashboard URL surfaced to the operator (in stdout,
    /// the heartbeat, and the helper's HTML). Default: derive from
    /// `--zeroclaw-webhook-url` by stripping `/webhook`. Override when
    /// the daemon runs in a container with port-mapped access from the
    /// host (e.g., `http://localhost:18793`).
    #[arg(long, env = "ZEROCLAW_DASHBOARD_URL")]
    zeroclaw_dashboard_url: Option<String>,
    /// Whether to auto-open the operator's browser at the helper URL.
    /// `auto` (default) opens only when stdout is a tty (interactive
    /// runs). `always` opens regardless. `never` suppresses entirely.
    /// Containers that can't open a host browser should set `never`.
    #[arg(
        long,
        env = "ZEROCLAW_OPEN_BROWSER",
        value_enum,
        default_value_t = OpenBrowserDefault::Auto
    )]
    open_browser: OpenBrowserDefault,
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

    // Detect the gateway CLI minter once. Both the bearer auto-pair
    // fallback and the loopback browser-pairing helper consume it. A
    // `None` here is fully non-fatal — operators on non-canonical
    // deployments where `zeroclaw` is not on PATH (e.g., the daemon
    // running on a different host from the gateway) get the same
    // behaviour as the 0.2.7 release.
    let minter: Option<Arc<MinterImpl>> = if cli.no_browser_pair_shim {
        tracing::info!(
            "klodi_zeroclaw_browser_pair_disabled — auto-pair and shim suppressed by flag"
        );
        None
    } else {
        let cfg = BrowserPairConfig {
            cli_path: cli.zeroclaw_cli.clone(),
            timeout: BROWSER_PAIR_CLI_TIMEOUT,
        };
        match ZeroclawCliMinter::detect(cfg).await {
            Some(m) => Some(Arc::new(MinterImpl::Cli(m))),
            None => {
                tracing::info!(
                    cli_path = %cli.zeroclaw_cli.display(),
                    "klodi_zeroclaw_browser_pair_cli_missing — auto-pair and shim disabled"
                );
                None
            }
        }
    };

    let bearer = pair::resolve_bearer(
        cli.zeroclaw_token.as_deref(),
        cli.zeroclaw_pair_url.as_deref(),
        &cli.zeroclaw_webhook_url,
        &paths::klodi_home(),
        minter.as_deref(),
    )
    .await?;

    let ws_config = build_ws_config(
        &cli.zeroclaw_webhook_url,
        cli.zeroclaw_ws_url.as_deref(),
        cli.zeroclaw_http_base.as_deref(),
        bearer.clone(),
    )?;

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

    // Bind the loopback pairing-helper port BEFORE composing the
    // heartbeat so the URL is known and embedded as a clickable
    // affordance in the chat. Bind failures (port busy, FD exhaustion)
    // are non-fatal — the daemon still boots; the operator just
    // doesn't get the helper.
    let shim_handle: Option<ShimHandle> = if minter.is_some() {
        let dashboard_url = cli
            .zeroclaw_dashboard_url
            .clone()
            .unwrap_or_else(|| derive_dashboard_url(&cli.zeroclaw_webhook_url));
        let shim_cfg = ShimConfig::loopback(
            cli.browser_pair_shim_port,
            dashboard_url,
            env!("CARGO_PKG_VERSION").to_string(),
        );
        match ShimHandle::bind(shim_cfg).await {
            Ok(h) => {
                tracing::info!(
                    url = %h.url,
                    "klodi_zeroclaw_shim_bound"
                );
                Some(h)
            }
            Err(err) => {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_shim_bind_failed"
                );
                None
            }
        }
    } else {
        None
    };

    // Heartbeat doesn't use `channel_names` (it's one-line) — compose
    // with an empty list, send into the session at resolve time.
    let empty_names: Vec<String> = Vec::new();
    let heartbeat_inputs = zeroclaw_bootstrap_note::BootstrapInputs {
        handle: &cfg_summary.handle,
        user_id: &cfg_summary.user_id,
        nats_url: &cfg_summary.nats_url,
        daemon_version: env!("CARGO_PKG_VERSION"),
        browser_pair_url: shim_handle.as_ref().map(|h| h.url.as_str()),
        channel_names: &empty_names,
    };
    let heartbeat = zeroclaw_bootstrap_note::heartbeat(&heartbeat_inputs);

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

    // Channel-registry build comes BEFORE the bootstrap-note post so
    // the multi-surface copy can list every surface klodi will
    // page the operator on.
    let registry_outcome = match build_channel_registry(
        &klodi_home,
        &SessionBinding {
            ws_config: ws_config.clone(),
            session_id: resolved.session_id.clone(),
        },
    )
    .await
    {
        Ok((registry, cfg)) => Some((registry, cfg)),
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "klodi_zeroclaw_daemon_channel_registry_build_failed_continuing_single_surface"
            );
            None
        }
    };
    let channel_names_owned: Vec<String> = registry_outcome
        .as_ref()
        .map(|(r, _)| r.channel_names())
        .unwrap_or_default();

    let bootstrap_inputs = zeroclaw_bootstrap_note::BootstrapInputs {
        handle: &cfg_summary.handle,
        user_id: &cfg_summary.user_id,
        nats_url: &cfg_summary.nats_url,
        daemon_version: env!("CARGO_PKG_VERSION"),
        browser_pair_url: shim_handle.as_ref().map(|h| h.url.as_str()),
        channel_names: &channel_names_owned,
    };

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

    // Boxed stdout block + (optional) browser auto-open + spawn the
    // helper accept loop. Non-fatal at every step — the daemon's
    // primary job (NATS forwarding) proceeds regardless.
    if let Some(handle) = &shim_handle {
        print_pair_block(&handle.url, minter.as_deref()).await;
        if should_open_browser(cli.open_browser) {
            match open_browser_url(&handle.url) {
                Ok(()) => tracing::info!(
                    url = %handle.url,
                    "klodi_zeroclaw_open_browser_dispatched"
                ),
                Err(err) => tracing::warn!(
                    error = %err,
                    url = %handle.url,
                    "klodi_zeroclaw_open_browser_failed"
                ),
            }
        }
    }
    if let (Some(handle), Some(m)) = (shim_handle, minter) {
        tokio::spawn(async move {
            if let Err(err) = handle.serve(m).await {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_shim_loop_exited"
                );
            }
        });
    }

    // Hand the same registry to the reply-attribution task so
    // dashboard replies land in `${KLODI_HOME}/approvals/<rid>.reply.json`
    // for the MCP server's approval gate. Failures are non-fatal —
    // the dedicated klodi session path keeps working without the
    // dashboard surface.
    if let Some((registry, cfg)) = registry_outcome {
        if cfg.dashboard.enabled {
            tokio::spawn(run_reply_attribution(klodi_home.clone(), registry));
        } else {
            tracing::info!(
                "klodi_zeroclaw_reply_attribution_skipped_dashboard_disabled"
            );
        }
    }

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
        // Unused on the WS path — see WAKE_POST_TIMEOUT_PLACEHOLDER.
        wake_post_timeout: WAKE_POST_TIMEOUT_PLACEHOLDER,
    })
    .await
    .context("running klodi-zeroclaw-daemon")
}

/// Reply attribution loop. Subscribes to `registry.replies()` —
/// emitted by `DashboardChannel`'s polling bridge — and persists each
/// matched reply to `${KLODI_HOME}/approvals/<rid>.reply.json` so a
/// freshly-spawned MCP server's approval gate can pick it up on the
/// agent's next retry. Failures inside the task log + skip; the task
/// itself stays alive until the daemon shuts down.
async fn run_reply_attribution(
    klodi_home: PathBuf,
    registry: klodi_rust_host::ChannelRegistry,
) {
    let mut stream = registry.replies();
    tracing::info!(
        channel_count = registry.channel_count(),
        "klodi_zeroclaw_reply_attribution_started"
    );
    while let Some((channel_name, reply)) = stream.next().await {
        let Some(rid) = reply.correlation_id.as_deref() else {
            // Bare chat — not tied to an open approval. Drop.
            continue;
        };
        let record = klodi_rust_host::channels::reply_capture::PersistedReply {
            text: reply.text.clone(),
            channel_name: reply.channel_name.clone(),
            origin: reply.origin.clone(),
            received_at_unix_seconds:
                klodi_rust_host::channels::reply_capture::now_unix_seconds(),
        };
        match klodi_rust_host::channels::reply_capture::persist_reply(
            &klodi_home,
            rid,
            &record,
        ) {
            Ok(true) => {
                tracing::info!(
                    request_id = %rid,
                    channel = %channel_name,
                    origin = %reply.origin,
                    "klodi_zeroclaw_reply_attribution_captured"
                );
            }
            Ok(false) => {
                tracing::debug!(
                    request_id = %rid,
                    channel = %channel_name,
                    "klodi_zeroclaw_reply_attribution_duplicate_ignored"
                );
            }
            Err(err) => {
                tracing::warn!(
                    request_id = %rid,
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_reply_attribution_persist_failed"
                );
            }
        }
    }
    tracing::info!("klodi_zeroclaw_reply_attribution_stream_closed");
    let _ = klodi_home; // keep ownership; referenced via captures above
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
/// pairing-code, cache the minted bearer, fall back to the cache, and
/// (since 0.2.8) auto-mint via the gateway CLI as a final fallback so
/// first-boot is zero-touch.
mod pair {
    use anyhow::{Context, Result, bail};
    use klodi_nats_client::klodi_secret_write;
    use klodi_rust_host::MinterImpl;
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
        minter: Option<&MinterImpl>,
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

        // 2. Fresh pairing-code file → re-pair and cache. Operators
        // controlling the re-pair flow (rotation, paired-tokens wipe
        // recovery) drop a code here; this branch always wins over
        // both the cache and auto-mint so a refreshed file is honoured.
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
                "klodi_zeroclaw_paired_from_sidecar"
            );
            return Ok(token);
        }

        // 3. Cached token from a prior successful pair. Happy path on
        // every restart after the first.
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

        // 4. Auto-mint via the gateway CLI when nothing else is set.
        // First-boot convenience — operators on the canonical
        // deployment no longer need to find the gateway's startup
        // pairing code and write it to disk. A failure here falls
        // through to the bail message so the operator still gets
        // the actionable hint about ZEROCLAW_AGENT_TOKEN / the sidecar
        // file.
        if let Some(m) = minter {
            match m.mint().await {
                Ok(code) => {
                    let pair_url =
                        derive_pair_url(webhook_url, pair_url_override)?;
                    let token = pair_with_zeroclaw(&pair_url, &code).await?;
                    persist_token(&cache_path, &token)?;
                    tracing::info!(
                        pair_url = %pair_url,
                        "klodi_zeroclaw_paired_via_auto_mint"
                    );
                    return Ok(token);
                }
                Err(err) => {
                    tracing::warn!(
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_auto_mint_failed_falling_through"
                    );
                }
            }
        }

        bail!(
            "ZeroClaw bearer unavailable: set ZEROCLAW_AGENT_TOKEN, or write a one-time pairing code to {} \
             (the daemon will POST /pair, cache the bearer at {}, and consume the code file). \
             If `zeroclaw` is on PATH the daemon also auto-mints when none of the above are present; \
             override the path with --zeroclaw-cli when the gateway lives elsewhere.",
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
                None,
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
                None,
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
                None,
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
                    dir.path(),
                    None,
                )
                .await
                .is_err()
            );
        }

        #[tokio::test]
        async fn resolve_bearer_skips_minter_when_cache_present() {
            // Cached token wins over auto-mint — once paired, restarts
            // should reuse the cached bearer rather than re-mint on
            // every boot (would accumulate tokens in
            // `gateway.paired_tokens`).
            let dir = tempdir().unwrap();
            std::fs::write(
                dir.path().join("zeroclaw.token"),
                "zc_cached_value\n",
            )
            .unwrap();
            let m = MinterImpl::Stub {
                fixed_code: "987654".into(),
            };
            let token = resolve_bearer(
                None,
                None,
                "http://127.0.0.1:7070/webhook",
                dir.path(),
                Some(&m),
            )
            .await
            .unwrap();
            assert_eq!(token, "zc_cached_value");
        }

        #[tokio::test]
        async fn resolve_bearer_consults_minter_when_no_other_source() {
            // No env, no sidecar, no cache → minter is the last
            // fallback. The minter mints fine, but pair_with_zeroclaw
            // fails because there's no real gateway at the unreachable
            // URL. The point of the test is that the failure happens
            // *after* the minter was called — i.e., the auto-mint
            // branch is exercised, not the bail path.
            let dir = tempdir().unwrap();
            let m = MinterImpl::Stub {
                fixed_code: "987654".into(),
            };
            // Port 1 is reserved/unreachable on every platform we
            // support, so the connect fails fast.
            let err = resolve_bearer(
                None,
                None,
                "http://127.0.0.1:1/webhook",
                dir.path(),
                Some(&m),
            )
            .await
            .unwrap_err()
            .to_string();
            // The error must come from pair_with_zeroclaw, not from
            // the bail message — match on something that only appears
            // in the HTTP path.
            assert!(
                err.contains("/pair") || err.contains("pair POST") || err.contains("POST"),
                "expected auto-mint pair error, got: {err}"
            );
            assert!(
                !err.contains("ZEROCLAW_AGENT_TOKEN"),
                "must not have fallen through to bail message: {err}"
            );
        }
    }
}

/// Strip the trailing `/webhook` segment from a webhook URL to derive
/// the gateway dashboard URL the operator opens in their browser.
/// Falls through unchanged when the URL doesn't end in `/webhook` so
/// non-canonical layouts still produce a reasonable fallback.
fn derive_dashboard_url(webhook_url: &str) -> String {
    let trimmed = webhook_url.trim_end_matches('/');
    if let Some(base) = trimmed.strip_suffix("/webhook") {
        base.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Print a clearly-delimited block to stdout pointing the operator at
/// the loopback browser-pairing helper, with a freshly-minted code
/// when the minter cooperates. Fails-soft on every step — this is
/// operator UX, not load-bearing.
async fn print_pair_block(url: &str, minter: Option<&MinterImpl>) {
    let bar = "═".repeat(64);
    let code_line = match minter {
        Some(m) => match m.mint().await {
            Ok(code) => format!(
                "  Pairing code:  {code}   (≈60s validity — reload the URL for a fresh one)"
            ),
            Err(_) => "  Pairing code:  (mint failed — the URL below will retry on every hit)".to_string(),
        },
        None => "  Pairing code:  (gateway CLI unavailable — see warning above)".to_string(),
    };
    // Blank lines around the block + bars on top/bottom give the
    // operator a clear visual landing in the daemon's startup log.
    println!();
    println!("{bar}");
    println!("  klodi · ZeroClaw browser pairing helper");
    println!();
    println!("{code_line}");
    println!();
    println!("  Open this URL — your browser code will be pre-copied to clipboard:");
    println!("    {url}");
    println!("{bar}");
    println!();
    tracing::info!(url = %url, "klodi_zeroclaw_pair_block_printed");
}

fn should_open_browser(setting: OpenBrowserDefault) -> bool {
    match setting {
        OpenBrowserDefault::Always => true,
        OpenBrowserDefault::Never => false,
        OpenBrowserDefault::Auto => std::io::stdout().is_terminal(),
    }
}

/// Spawn the OS-native browser-launcher pointed at `url`. Returns as
/// soon as the launcher is dispatched; we don't wait for the browser
/// to actually open (it never blocks on us, and on Linux `xdg-open`
/// detaches asynchronously).
fn open_browser_url(url: &str) -> std::io::Result<()> {
    let mut cmd = open_command();
    cmd.arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_command() -> std::process::Command {
    std::process::Command::new("open")
}

#[cfg(target_os = "windows")]
fn open_command() -> std::process::Command {
    // `cmd /c start "" <url>` — the empty string is the window title
    // placeholder that `start` requires when the URL would otherwise
    // be interpreted as the title arg.
    let mut c = std::process::Command::new("cmd");
    c.args(["/c", "start", ""]);
    c
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_command() -> std::process::Command {
    std::process::Command::new("xdg-open")
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

    #[test]
    fn derive_dashboard_url_strips_trailing_webhook() {
        assert_eq!(
            derive_dashboard_url("http://127.0.0.1:7070/webhook"),
            "http://127.0.0.1:7070"
        );
    }

    #[test]
    fn derive_dashboard_url_strips_trailing_slash_then_webhook() {
        assert_eq!(
            derive_dashboard_url("http://127.0.0.1:7070/webhook/"),
            "http://127.0.0.1:7070"
        );
    }

    #[test]
    fn derive_dashboard_url_handles_subpath_layout() {
        assert_eq!(
            derive_dashboard_url("https://gw.example/zc/webhook"),
            "https://gw.example/zc"
        );
    }

    #[test]
    fn derive_dashboard_url_falls_through_when_no_webhook_suffix() {
        // Operator passed something non-canonical — degrade to using
        // the URL as-is rather than guessing a different path.
        assert_eq!(
            derive_dashboard_url("https://gw.example/api/v1"),
            "https://gw.example/api/v1"
        );
    }

    #[test]
    fn should_open_browser_always_returns_true() {
        assert!(should_open_browser(OpenBrowserDefault::Always));
    }

    #[test]
    fn should_open_browser_never_returns_false() {
        assert!(!should_open_browser(OpenBrowserDefault::Never));
    }

    #[test]
    fn open_browser_default_display_matches_clap_value_enum_lowercase() {
        // clap `value_enum` parses lowercase variant names. The Display
        // impl must round-trip so help / errors show what the user
        // would actually type.
        assert_eq!(OpenBrowserDefault::Auto.to_string(), "auto");
        assert_eq!(OpenBrowserDefault::Always.to_string(), "always");
        assert_eq!(OpenBrowserDefault::Never.to_string(), "never");
    }
}
