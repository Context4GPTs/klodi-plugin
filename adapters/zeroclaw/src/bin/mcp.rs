//! `klodi-zeroclaw-mcp` — stdio MCP server that exposes klodi's tool
//! catalog and skill bundle to ZeroClaw's agent.
//!
//! ZeroClaw spawns one subprocess per agent session per its
//! `[[mcp.servers]]` config; the body lives in `klodi_rust_host::mcp`.
//!
//! When `${KLODI_HOME}/zeroclaw.{token,session}` are present (added in
//! 0.2.6), the binary plugs a `KlodiSessionTarget` into `McpConfig`
//! so `klodi_report_to_operator` and the irreversible-tool approval
//! gate can write into the persisted dedicated klodi session via
//! WebSocket. 0.2.9 additionally builds a `ChannelRegistry` from
//! `${KLODI_HOME}/klodi.toml`'s `[notifications]` block so the
//! approval gate fans the prompt out across every configured surface
//! (dashboard, dedicated session, upstream channels). When either
//! on-disk file is missing the binary still starts cleanly — those
//! features simply degrade (`klodi_report_to_operator` returns an
//! actionable error if called; gated tools fall through without the
//! gate; the registry stays `None` and the tools see a single-target
//! path).

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_rust_host::{
    McpConfig, SessionBinding, ZeroClawWsConfig,
    channels::factory::build_channel_registry,
    paths, run_mcp_server, session_path,
    mcp::KlodiSessionTarget,
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
    /// Path to the `zeroclaw` CLI used by `UpstreamChannel` to invoke
    /// `zeroclaw channel send` for configured upstream channels
    /// (Telegram, Slack, etc.). Default `"zeroclaw"`, resolved on PATH.
    /// Override when the gateway lives at a non-canonical path or when
    /// the MCP server runs on a different host. If unreachable, upstream
    /// channel sends fail with `klodi_zeroclaw_upstream_cli_missing`
    /// warn logs; the registry continues serving dashboard + dedicated
    /// session.
    #[arg(long, env = "ZEROCLAW_CLI", default_value = "zeroclaw")]
    zeroclaw_cli: PathBuf,
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

    let klodi_session_target = build_klodi_session_target(
        &klodi_home,
        &cli.zeroclaw_webhook_url,
        cli.zeroclaw_ws_url.as_deref(),
        cli.zeroclaw_http_base.as_deref(),
    );

    // Channel registry — only constructible when the dedicated session
    // target resolved (we need the WS config + the dedicated session id
    // for the ledger + the dedicated-session channel adapter). When
    // `None`, the MCP server falls back to the single-target path
    // (klodi_session_target writes directly).
    let channel_registry = match klodi_session_target.as_ref() {
        Some(target) => {
            let binding = SessionBinding {
                ws_config: target.ws_config.clone(),
                session_id: target.session_id.clone(),
            };
            match build_channel_registry(&klodi_home, &binding, &cli.zeroclaw_cli).await {
                Ok((registry, _cfg)) => Some(registry),
                Err(err) => {
                    tracing::warn!(
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_mcp_channel_registry_build_failed_falling_back_to_single_target"
                    );
                    None
                }
            }
        }
        None => None,
    };

    run_mcp_server(McpConfig {
        creds_path,
        config_path,
        klodi_home,
        server_name: "klodi-zeroclaw-mcp".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
        register_cli: "klodi-zeroclaw-register".to_owned(),
        klodi_session_target,
        channel_registry,
    })
    .await
    .context("running klodi-zeroclaw-mcp")
}

/// Best-effort: build a [`KlodiSessionTarget`] from the on-disk
/// `${KLODI_HOME}/zeroclaw.{token,session}` files. Missing files / empty
/// values degrade to `None` — the MCP server still starts and the
/// affected tools return actionable errors when called.
fn build_klodi_session_target(
    klodi_home: &std::path::Path,
    webhook_url: &str,
    ws_override: Option<&str>,
    http_base_override: Option<&str>,
) -> Option<KlodiSessionTarget> {
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

    Some(KlodiSessionTarget {
        ws_config,
        session_id,
    })
}
