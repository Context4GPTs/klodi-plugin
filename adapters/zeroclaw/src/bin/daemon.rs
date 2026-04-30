//! `klodi-zeroclaw-daemon` — long-running NATS-native wake forwarder
//! for ZeroClaw.
//!
//! Per **D § D8** the daemon body lives in `klodi_rust_host::forwarder`;
//! this binary only binds CLI / env.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{ForwarderConfig, paths, run_forwarder};
use std::path::PathBuf;

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
    /// Local ZeroClaw `/hooks/wake` URL.
    #[arg(
        long,
        env = "ZEROCLAW_HOOKS_WAKE_URL",
        default_value = "http://127.0.0.1:7070/hooks/wake"
    )]
    zeroclaw_hooks_wake_url: String,
    /// Optional bearer token for ZeroClaw's hooks endpoint. P1-14:
    /// shared bearer-token mechanism — accepts a token where one is
    /// configured server-side, otherwise request goes unauthenticated.
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

    if cli.zeroclaw_hooks_wake_url.is_empty() {
        bail!(
            "--zeroclaw-hooks-wake-url (or ZEROCLAW_HOOKS_WAKE_URL) must be set"
        );
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

    run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        wake_url: cli.zeroclaw_hooks_wake_url,
        bearer_token: cli.zeroclaw_token,
        user_agent: format!(
            "klodi-zeroclaw-daemon/{}",
            env!("CARGO_PKG_VERSION")
        ),
        log_event_prefix: "klodi_zeroclaw".into(),
        health_port: cli.health_port,
    })
    .await
    .context("running klodi-zeroclaw-daemon")
}
