//! `klodi-zeroclaw-mcp` — stdio MCP server that exposes klodi's tool
//! catalog and skill bundle to ZeroClaw's agent.
//!
//! ZeroClaw spawns one subprocess per agent session per its
//! `[[mcp.servers]]` config; the body lives in `klodi_rust_host::mcp`.
//!
//! 0.2.6: when `${KLODI_HOME}/zeroclaw.{token,session}` are present, the
//! binary plugs an `OperatorChannel` into `McpConfig` so the
//! `klodi_report_to_operator` tool (I-4) and the irreversible-tool
//! approval gate (I-5) can write into the persisted operator session
//! via WebSocket. When either file is missing the binary still starts
//! cleanly — those features simply degrade (`klodi_report_to_operator`
//! returns an actionable error if called; gated tools fall through
//! without the gate).

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{
    McpConfig, ZeroClawWsConfig, paths, run_mcp_server, session_path,
    mcp::OperatorChannel,
};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-mcp",
    about = "Stdio MCP server exposing klodi tools + skill bundle to ZeroClaw.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// Local ZeroClaw `/webhook` URL — used to derive the WS endpoint
    /// for `klodi_report_to_operator` and the approval gate. Matches the
    /// daemon's default so an MCP server spawned beside the daemon
    /// targets the same gateway out of the box.
    #[arg(
        long,
        env = "ZEROCLAW_WEBHOOK_URL",
        default_value = "http://127.0.0.1:7070/webhook"
    )]
    zeroclaw_webhook_url: String,
    /// Override the derived `/ws/chat` URL.
    #[arg(long, env = "ZEROCLAW_WS_URL")]
    zeroclaw_ws_url: Option<String>,
    /// Override the derived REST base used for diagnostics.
    #[arg(long, env = "ZEROCLAW_HTTP_BASE")]
    zeroclaw_http_base: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    // MCP servers MUST keep stdout pristine — the host parses every line
    // as JSON-RPC. Route tracing to stderr so debug logs don't break the
    // protocol. Default to `warn` since stdio sessions are typically
    // production-shaped, not interactive.
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

    let operator_channel = build_operator_channel(
        &klodi_home,
        &cli.zeroclaw_webhook_url,
        cli.zeroclaw_ws_url.as_deref(),
        cli.zeroclaw_http_base.as_deref(),
    );

    run_mcp_server(McpConfig {
        creds_path,
        config_path,
        klodi_home,
        server_name: "klodi-zeroclaw-mcp".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
        register_cli: "klodi-zeroclaw-register".to_owned(),
        operator_channel,
    })
    .await
    .context("running klodi-zeroclaw-mcp")
}

/// Best-effort: build an [`OperatorChannel`] from the on-disk
/// `${KLODI_HOME}/zeroclaw.{token,session}` files. Missing files / empty
/// values degrade to `None` — the MCP server still starts and the
/// affected tools return actionable errors when called.
fn build_operator_channel(
    klodi_home: &std::path::Path,
    webhook_url: &str,
    ws_override: Option<&str>,
    http_base_override: Option<&str>,
) -> Option<OperatorChannel> {
    let token_path = klodi_home.join("zeroclaw.token");
    let session_path_buf = session_path(klodi_home);

    let bearer = match std::fs::read_to_string(&token_path) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            tracing::info!(
                token_path = %token_path.display(),
                "klodi_zeroclaw_mcp_no_bearer_skipping_operator_channel"
            );
            return None;
        }
    };
    if bearer.is_empty() {
        tracing::warn!(
            token_path = %token_path.display(),
            "klodi_zeroclaw_mcp_empty_bearer_skipping_operator_channel"
        );
        return None;
    }

    let session_id = match std::fs::read_to_string(&session_path_buf) {
        Ok(s) => s.trim().to_string(),
        Err(_) => {
            tracing::info!(
                session_path = %session_path_buf.display(),
                "klodi_zeroclaw_mcp_no_session_skipping_operator_channel"
            );
            return None;
        }
    };
    if session_id.is_empty() {
        tracing::warn!(
            session_path = %session_path_buf.display(),
            "klodi_zeroclaw_mcp_empty_session_skipping_operator_channel"
        );
        return None;
    }

    let ws_config = match ZeroClawWsConfig::from_webhook_url(webhook_url, bearer.clone()) {
        Ok(mut cfg) => {
            if let Some(o) = ws_override {
                cfg.ws_url = o.to_string();
            }
            if let Some(o) = http_base_override {
                cfg.http_base = o.to_string();
            }
            cfg
        }
        Err(err) => {
            tracing::warn!(
                error = %format!("{err:#}"),
                "klodi_zeroclaw_mcp_ws_config_invalid_skipping_operator_channel"
            );
            return None;
        }
    };

    Some(OperatorChannel {
        ws_config,
        session_id,
    })
}
