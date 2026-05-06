//! `klodi-ironclaw-register` — one-shot HTTP registration. After the
//! marketplace persists `nats.creds` + `config.json`, the binary also
//! wires klodi into IronClaw's `config.toml` so the agent sees the
//! `klodi-ironclaw-mcp` server on its next start.

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
    name = "klodi-ironclaw-register",
    about = "Register klodi for the IronClaw adapter and wire its MCP entry into IronClaw config.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_API_URL", default_value = KLODI_DEFAULT_API_URL)]
    api_url: String,
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// Path to IronClaw's `config.toml`. Defaults to `$IRONCLAW_CONFIG`
    /// or `~/.ironclaw/config.toml`.
    #[arg(long, env = "IRONCLAW_CONFIG")]
    ironclaw_config: Option<PathBuf>,
    /// `command` field written into `[[mcp.servers]]`. Override only if
    /// you've installed `klodi-ironclaw-mcp` under a non-PATH name.
    #[arg(long, default_value = "klodi-ironclaw-mcp")]
    mcp_command: String,
    /// Skip the `config.toml` write step. Use when registering for an
    /// adapter target that doesn't run IronClaw locally.
    #[arg(long)]
    skip_ironclaw_config: bool,
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
        user_agent: format!(
            "klodi-ironclaw-register/{}",
            env!("CARGO_PKG_VERSION")
        ),
        binary_name: "klodi-ironclaw-register".into(),
    })
    .await
    .context("running klodi-ironclaw-register")?;

    if cli.skip_ironclaw_config {
        println!("Skipping IronClaw config.toml update (--skip-ironclaw-config).");
        return Ok(());
    }

    let config_path = cli
        .ironclaw_config
        .unwrap_or_else(|| default_host_config_path("ironclaw"));
    let entry = HostMcpEntry {
        config_path: config_path.clone(),
        command: cli.mcp_command,
        klodi_home,
    };
    apply_host_mcp_entry(&entry).with_context(|| {
        format!("wiring klodi into {}", config_path.display())
    })?;
    println!(
        "Wired klodi into {} — IronClaw will spawn klodi-ironclaw-mcp on next agent start.",
        config_path.display(),
    );
    Ok(())
}
