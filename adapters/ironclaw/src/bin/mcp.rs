//! `klodi-ironclaw-mcp` — stdio MCP server that exposes klodi's tool
//! catalog and skill bundle to IronClaw's agent.
//!
//! IronClaw spawns one subprocess per agent session per its
//! `[[mcp.servers]]` config; the body lives in `klodi_rust_host::mcp`.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{McpConfig, paths, run_mcp_server};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-ironclaw-mcp",
    about = "Stdio MCP server exposing klodi tools + skill bundle to IronClaw.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // MCP servers MUST keep stdout pristine — the host parses every line
    // as JSON-RPC. Route tracing to stderr so debug logs don't break the
    // protocol.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "warn".into()),
        )
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    let cli = Cli::parse();
    let klodi_home = cli.klodi_home.clone().unwrap_or_else(paths::klodi_home);
    let creds_path = cli.creds.unwrap_or_else(|| klodi_home.join("nats.creds"));
    let config_path = cli.config.unwrap_or_else(|| klodi_home.join("config.json"));

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

    run_mcp_server(McpConfig {
        creds_path,
        config_path,
        klodi_home,
        server_name: "klodi-ironclaw-mcp".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
    })
    .await
    .context("running klodi-ironclaw-mcp")
}
