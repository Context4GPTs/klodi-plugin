//! `klodi-moltis-daemon` — long-running NATS-native wake forwarder.
//!
//! Runs alongside Moltis (systemd / launchd / whatever supervisor you
//! prefer). Owns a single persistent NATS-WS connection per the user's
//! creds. Each delivered klodi notification or channel message is
//! POSTed to Moltis's local agent-wake API, which schedules the agent.
//!
//! Per **D § D8** the daemon body lives in `klodi_rust_host::forwarder`;
//! this binary only binds CLI / env to the shared `ForwarderConfig`.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{ForwarderConfig, paths, run_forwarder};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-moltis-daemon",
    about = "Long-running NATS-WS wake daemon for klodi on Moltis.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    /// Override `${KLODI_HOME}/nats.creds`.
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    /// Override `${KLODI_HOME}/config.json`.
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    /// Local Moltis agent-wake URL.
    #[arg(
        long,
        env = "MOLTIS_WAKE_URL",
        default_value = "http://127.0.0.1:5000/agents/default/wake"
    )]
    moltis_wake_url: String,
    /// Bearer token for Moltis's agent API.
    #[arg(long, env = "MOLTIS_AGENT_TOKEN")]
    moltis_token: Option<String>,
    /// Optional `/healthz` HTTP probe port (P2-25).
    #[arg(long, env = "MOLTIS_HEALTH_PORT")]
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

    if cli.moltis_wake_url.is_empty() {
        bail!(
            "--moltis-wake-url (or MOLTIS_WAKE_URL) must be set — \
             refusing to start a wake daemon with no host endpoint"
        );
    }
    if !creds_path.exists() {
        bail!(
            "klodi creds not found at {} — run klodi-moltis-register first",
            creds_path.display(),
        );
    }
    if !config_path.exists() {
        bail!(
            "klodi config not found at {} — run klodi-moltis-register first",
            config_path.display(),
        );
    }

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        wake_url: cli.moltis_wake_url,
        bearer_token: cli.moltis_token,
        user_agent: format!("klodi-moltis-daemon/{}", env!("CARGO_PKG_VERSION")),
        log_event_prefix: "klodi_moltis".into(),
        health_port: cli.health_port,
    })
    .await
    .context("running klodi-moltis-daemon")
}
