//! `klodi-moltis-register` — one-shot HTTP registration. After the
//! marketplace persists `nats.creds` + `config.json`, the binary also
//! wires klodi into Moltis's `config.toml` so the agent sees the
//! `klodi-moltis-mcp` server on its next start.

use anyhow::{Context, Result};
use clap::Parser;
use klodi_nats_client::KLODI_DEFAULT_API_URL;
use klodi_rust_host::{
    HostMcpEntry, RegisterArgs, apply_host_mcp_entry, default_host_config_path, paths,
    run_register,
};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-moltis-register",
    about = "Register klodi for the Moltis adapter and wire its MCP entry into Moltis config.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    /// Klodi API URL (web app). Defaults to the catalog-canonical
    /// production deployment.
    #[arg(long, env = "KLODI_API_URL", default_value = KLODI_DEFAULT_API_URL)]
    api_url: String,
    /// Override `${KLODI_HOME}`.
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// Path to Moltis's `config.toml`. Defaults to `$MOLTIS_CONFIG` or
    /// `~/.moltis/config.toml`.
    #[arg(long, env = "MOLTIS_CONFIG")]
    moltis_config: Option<PathBuf>,
    /// `command` field written into `[[mcp.servers]]`. Override only if
    /// you've installed `klodi-moltis-mcp` under a non-PATH name.
    #[arg(long, default_value = "klodi-moltis-mcp")]
    mcp_command: String,
    /// Skip the `config.toml` write step. Use when registering for an
    /// adapter target that doesn't run Moltis (e.g. a remote daemon
    /// host that only forwards wakes).
    #[arg(long)]
    skip_moltis_config: bool,
    /// Bypass the "creds already on disk → skip" short-circuit in the
    /// shared register flow and mint a fresh klodi session via browser
    /// OAuth even when `${KLODI_HOME}/{nats.creds,config.json}` are
    /// present. Operator-side equivalent of Hermes's
    /// `klodi_setup_repair` MCP tool.
    #[arg(long)]
    force_register: bool,
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

    run_register(RegisterArgs {
        api_url: cli.api_url,
        klodi_home: klodi_home.clone(),
        user_agent: format!("klodi-moltis-register/{}", env!("CARGO_PKG_VERSION")),
        binary_name: "klodi-moltis-register".into(),
        force_register: cli.force_register,
    })
    .await
    .context("running klodi-moltis-register")?;

    if cli.skip_moltis_config {
        println!("Skipping Moltis config.toml update (--skip-moltis-config).");
        return Ok(());
    }

    let config_path = cli
        .moltis_config
        .unwrap_or_else(|| default_host_config_path("moltis"));
    let entry = HostMcpEntry {
        config_path: config_path.clone(),
        command: cli.mcp_command,
        klodi_home,
    };
    apply_host_mcp_entry(&entry).with_context(|| {
        format!("wiring klodi into {}", config_path.display())
    })?;
    println!(
        "Wired klodi into {} — Moltis will spawn klodi-moltis-mcp on next agent start.",
        config_path.display(),
    );
    Ok(())
}
