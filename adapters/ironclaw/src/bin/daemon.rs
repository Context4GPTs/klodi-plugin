//! `klodi-ironclaw-daemon` — long-running NATS-native wake forwarder
//! for IronClaw.
//!
//! Per 0012 § Lifecycle, IronClaw runs a dedicated background subscriber
//! inside the plugin. The daemon owns one persistent NATS-WS connection
//! and POSTs each delivered klodi event to IronClaw's local
//! event-trigger endpoint.
//!
//! Per **D § D8** the daemon body lives in `klodi_rust_host::forwarder`;
//! this binary only binds CLI / env.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{BodyShape, ForwarderConfig, paths, run_forwarder};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-ironclaw-daemon",
    about = "Long-running NATS-WS wake daemon for klodi on IronClaw.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    /// Local IronClaw event-trigger URL.
    #[arg(
        long,
        env = "IRONCLAW_EVENT_URL",
        default_value = "http://127.0.0.1:7171/event-trigger"
    )]
    ironclaw_event_url: String,
    /// Optional bearer token for IronClaw's event-trigger endpoint.
    /// P1-14: shared bearer-token mechanism — accepts a token where one
    /// is configured server-side, otherwise request goes unauthenticated.
    #[arg(long, env = "IRONCLAW_AGENT_TOKEN")]
    ironclaw_token: Option<String>,
    /// Optional `/healthz` HTTP probe port (P2-25).
    #[arg(long, env = "IRONCLAW_HEALTH_PORT")]
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

    if cli.ironclaw_event_url.is_empty() {
        bail!(
            "--ironclaw-event-url (or IRONCLAW_EVENT_URL) must be set — \
             refusing to start a wake daemon with no host endpoint"
        );
    }
    if !creds_path.exists() {
        bail!(
            "klodi creds not found at {} — run klodi-ironclaw-register first",
            creds_path.display(),
        );
    }
    if !config_path.exists() {
        bail!(
            "klodi config not found at {} — run klodi-ironclaw-register first",
            config_path.display(),
        );
    }

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        wake_url: cli.ironclaw_event_url,
        bearer_token: cli.ironclaw_token,
        user_agent: format!(
            "klodi-ironclaw-daemon/{}",
            env!("CARGO_PKG_VERSION")
        ),
        log_event_prefix: "klodi_ironclaw".into(),
        health_port: cli.health_port,
        body_shape: BodyShape::Structured,
    })
    .await
    .context("running klodi-ironclaw-daemon")
}
