//! `klodi-zeroclaw-daemon` — long-running NATS-native wake forwarder
//! for ZeroClaw.
//!
//! Per `docs/plans/2026-05-12-klodi-wake-agent-spawn.md` §2 the daemon
//! is a thin driver:
//!
//! 1. Subscribe to the user's two NATS consumers.
//! 2. For each delivered event, serialise it, compose the canonical
//!    wake prompt (`wake_prompt::build_wake_prompt`), POST it to
//!    `/api/agent/spawn` (or the cron-fallback pair), and ACK NATS on
//!    HTTP 200.
//! 3. The spawned agent runs in an isolated ZeroClaw session, reasons
//!    over the event, acts via `klodi_*` and writes to the operator's
//!    chat via `sessions_send` only when the operator should see
//!    something.
//!
//! No WS write. No webhook. No queue. No klodi-side approval gate.
//! The daemon never sees the agent's turn duration.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_nats_client::KlodiError;
use klodi_rust_host::forwarder::{WakeEvent, WakeHandler, WakeHandlerFuture};
use klodi_rust_host::{
    ForwarderConfig, SpawnClient, SpawnError, WakePromptInputs, build_wake_prompt, paths,
    read_session_id, register, run_forwarder,
};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-daemon",
    about = "Long-running NATS-native wake daemon. Each event spawns an isolated agent turn.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    /// Override `${KLODI_HOME}/nats.creds`.
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    /// Override `${KLODI_HOME}/config.json`.
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    /// Override `${KLODI_HOME}` for the persisted session id +
    /// `zeroclaw.token` lookups.
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// ZeroClaw gateway base URL (no path). The daemon derives
    /// `/api/agent/spawn` and `/api/cron` from this. Default matches
    /// the canonical `klodi-zeroclaw` docker setup.
    #[arg(
        long,
        env = "ZEROCLAW_HTTP_BASE",
        default_value = "http://127.0.0.1:7070"
    )]
    zeroclaw_http_base: String,
    /// Bearer token used as `Authorization: Bearer` on every spawn
    /// call. When unset the daemon reads `${KLODI_HOME}/zeroclaw.token`
    /// (written by `klodi-zeroclaw-register`).
    #[arg(long, env = "ZEROCLAW_AGENT_TOKEN")]
    zeroclaw_token: Option<String>,
    /// Skip the native `/api/agent/spawn` probe and use the cron
    /// fallback (`/api/cron` + `/api/cron/{id}/run`) for every wake.
    /// Set when you know the gateway hasn't shipped `/api/agent/spawn`
    /// yet and want to avoid the per-process probe round-trip.
    #[arg(long, env = "ZEROCLAW_FORCE_CRON_FALLBACK", default_value_t = false)]
    force_cron_fallback: bool,
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
    let klodi_home = cli.klodi_home.clone().unwrap_or_else(paths::klodi_home);
    let creds_path = cli.creds.unwrap_or_else(|| klodi_home.join("nats.creds"));
    let config_path = cli.config.unwrap_or_else(|| klodi_home.join("config.json"));

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

    let bearer = resolve_bearer(cli.zeroclaw_token.as_deref(), &klodi_home)?;
    let identity = register::read_config_identity(&klodi_home)
        .context("reading handle + user_id from config.json")?;
    let operator_session_id = read_session_id(&klodi_home)?.ok_or_else(|| {
        anyhow::anyhow!(
            "operator session id not found at {} — run klodi-zeroclaw-register first \
             (the daemon needs it to interpolate into every wake prompt so the spawned \
             agent knows where to write back via sessions_send)",
            klodi_home.join("zeroclaw.session").display(),
        )
    })?;

    let mut spawn_client = SpawnClient::new(&cli.zeroclaw_http_base, bearer)?;
    if cli.force_cron_fallback {
        spawn_client = spawn_client.force_cron_fallback();
    }

    tracing::info!(
        handle = %identity.handle,
        user_id = %identity.user_id,
        operator_session_id = %operator_session_id,
        http_base = %cli.zeroclaw_http_base,
        force_cron_fallback = cli.force_cron_fallback,
        "klodi_zeroclaw_daemon_starting"
    );

    let handler: Arc<dyn WakeHandler> = Arc::new(SpawnWakeHandler {
        spawn_client,
        handle: identity.handle,
        user_id: identity.user_id,
        operator_session_id,
    });

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        handler,
        log_event_prefix: "klodi_zeroclaw".into(),
        health_port: cli.health_port,
    })
    .await
    .context("running klodi-zeroclaw-daemon")
}

/// Wake handler — composes the prompt and spawns an isolated agent
/// session for each delivered NATS event.
struct SpawnWakeHandler {
    spawn_client: SpawnClient,
    handle: String,
    user_id: String,
    operator_session_id: String,
}

impl WakeHandler for SpawnWakeHandler {
    fn handle<'a>(&'a self, event: &'a WakeEvent) -> WakeHandlerFuture<'a> {
        Box::pin(async move {
            let event_json_pretty = serde_json::to_string_pretty(event).map_err(|err| {
                KlodiError::NatsPublish(format!("serialising wake event: {err}"))
            })?;
            let prompt = build_wake_prompt(&WakePromptInputs {
                handle: &self.handle,
                user_id: &self.user_id,
                event_json_pretty: &event_json_pretty,
                operator_session_id: &self.operator_session_id,
            });
            match self.spawn_client.spawn(&prompt).await {
                Ok(outcome) => {
                    tracing::info!(
                        kind = %event.kind(),
                        event_id = %event.event_id(),
                        spawn_path = ?outcome.path,
                        spawn_session_id = outcome.session_id.as_deref().unwrap_or(""),
                        "klodi_zeroclaw_wake_spawned"
                    );
                    Ok(())
                }
                Err(err) => {
                    tracing::warn!(
                        kind = %event.kind(),
                        event_id = %event.event_id(),
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_wake_spawn_failed"
                    );
                    Err(spawn_error_to_klodi(err))
                }
            }
        })
    }
}

fn spawn_error_to_klodi(err: SpawnError) -> KlodiError {
    KlodiError::NatsPublish(format!("zeroclaw spawn: {err}"))
}

/// Resolve the bearer token. Explicit `--zeroclaw-token` wins; otherwise
/// read `${KLODI_HOME}/zeroclaw.token` (written by `register`).
fn resolve_bearer(env_token: Option<&str>, klodi_home: &std::path::Path) -> Result<String> {
    if let Some(token) = env_token {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            bail!("ZEROCLAW_AGENT_TOKEN is set but empty");
        }
        return Ok(trimmed.to_string());
    }
    let path = klodi_home.join("zeroclaw.token");
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} — run klodi-zeroclaw-register first to pair with the gateway",
            path.display(),
        )
    })?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!(
            "{} is empty — re-run klodi-zeroclaw-register to re-pair",
            path.display(),
        );
    }
    Ok(trimmed.to_string())
}
