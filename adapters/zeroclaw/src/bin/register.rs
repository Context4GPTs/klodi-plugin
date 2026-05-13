//! `klodi-zeroclaw-register` — one-shot registration + ZeroClaw pairing.
//!
//! Per `docs/plans/2026-05-12-klodi-wake-agent-spawn.md` §3 the binary:
//!
//! 1. Mints NATS creds + `config.json` via the shared `run_register`
//!    flow (browser auth → poll → atomic write).
//! 2. Pairs with the ZeroClaw gateway: shells out to
//!    `zeroclaw gateway get-paircode --new` for a fresh code, POSTs
//!    `/pair`, and persists the resulting `zc_<hex>` bearer at
//!    `${KLODI_HOME}/zeroclaw.token` (mode 0600).
//! 3. Bootstraps the operator chat session via WS `/ws/chat` with a
//!    single hello line, persisting the minted UUID at
//!    `${KLODI_HOME}/zeroclaw.session`.
//! 4. Idempotently wires the `klodi-zeroclaw-mcp` entry into ZeroClaw's
//!    `config.toml` so the marketplace tool catalog is reachable from
//!    every spawned agent session.
//!
//! On re-runs the marketplace flow rewrites `nats.creds` + `config.json`
//! atomically; pairing reuses the cached bearer when present (so
//! `gateway.paired_tokens` doesn't accumulate); the session is
//! resumed/probed if a prior id is on disk.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_nats_client::{KLODI_DEFAULT_API_URL, klodi_secret_write};
use klodi_rust_host::{
    BrowserPairConfig, HostMcpEntry, MinterImpl, RegisterArgs, ZeroClawWsConfig,
    ZeroclawCliMinter, apply_host_mcp_entry, bootstrap_session_with_first_message,
    default_host_config_path, paths, persist_session_id, read_session_id, register,
    run_register, send_session_message,
};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::path::PathBuf;
use std::time::Duration;

const ZEROCLAW_CLI_TIMEOUT: Duration = Duration::from_secs(5);
const PAIR_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-register",
    about = "Register klodi for the ZeroClaw adapter, pair with the gateway, and bootstrap the operator chat session.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    #[arg(long, env = "KLODI_API_URL", default_value = KLODI_DEFAULT_API_URL)]
    api_url: String,
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// Path to ZeroClaw's `config.toml`. Defaults to
    /// `$ZEROCLAW_CONFIG` or `~/.zeroclaw/config.toml`.
    #[arg(long, env = "ZEROCLAW_CONFIG")]
    zeroclaw_config: Option<PathBuf>,
    /// `command` field written into `[[mcp.servers]]`. Override only if
    /// you've installed `klodi-zeroclaw-mcp` under a non-PATH name.
    #[arg(long, default_value = "klodi-zeroclaw-mcp")]
    mcp_command: String,
    /// Skip the `config.toml` write step.
    #[arg(long)]
    skip_zeroclaw_config: bool,
    /// ZeroClaw gateway base URL (no path). The binary derives `/pair`,
    /// `/ws/chat`, and the spawn endpoints from this.
    #[arg(
        long,
        env = "ZEROCLAW_HTTP_BASE",
        default_value = "http://127.0.0.1:7070"
    )]
    zeroclaw_http_base: String,
    /// Path to the `zeroclaw` CLI used to mint a fresh pairing code.
    /// Default `"zeroclaw"`, resolved on PATH.
    #[arg(long, env = "ZEROCLAW_CLI", default_value = "zeroclaw")]
    zeroclaw_cli: PathBuf,
    /// Skip the pair + session-bootstrap step. Use when the operator
    /// has already paired manually (e.g. via a previous register run).
    #[arg(long)]
    skip_pair: bool,
    /// Bypass the "creds already on disk → skip" short-circuit in the
    /// shared register flow and mint a fresh klodi session via browser
    /// OAuth even when `${KLODI_HOME}/{nats.creds,config.json}` are
    /// present. Operator-side equivalent of Hermes's
    /// `klodi_setup_repair` MCP tool — repair lives at the CLI here
    /// because the Rust wake agent's MCP server holds the very creds
    /// the repair would delete.
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
        api_url: cli.api_url.clone(),
        klodi_home: klodi_home.clone(),
        user_agent: format!("klodi-zeroclaw-register/{}", env!("CARGO_PKG_VERSION")),
        binary_name: "klodi-zeroclaw-register".into(),
        force_register: cli.force_register,
    })
    .await
    .context("running klodi-zeroclaw-register")?;

    if !cli.skip_pair {
        pair_and_bootstrap(&cli, &klodi_home).await?;
    } else {
        println!("Skipping ZeroClaw pair + session bootstrap (--skip-pair).");
    }

    if cli.skip_zeroclaw_config {
        println!("Skipping ZeroClaw config.toml update (--skip-zeroclaw-config).");
    } else {
        let config_path = cli
            .zeroclaw_config
            .unwrap_or_else(|| default_host_config_path("zeroclaw"));
        let entry = HostMcpEntry {
            config_path: config_path.clone(),
            command: cli.mcp_command,
            klodi_home: klodi_home.clone(),
        };
        apply_host_mcp_entry(&entry)
            .with_context(|| format!("wiring klodi into {}", config_path.display()))?;
        println!(
            "Wired klodi into {} — ZeroClaw will spawn klodi-zeroclaw-mcp inside every \
             agent turn.",
            config_path.display(),
        );
    }
    Ok(())
}

async fn pair_and_bootstrap(cli: &Cli, klodi_home: &std::path::Path) -> Result<()> {
    let bearer = pair(cli, klodi_home).await.context("pairing with ZeroClaw")?;
    let identity = register::read_config_identity(klodi_home)
        .context("reading handle + user_id from config.json")?;
    let ws_cfg = ZeroClawWsConfig::from_http_base(&cli.zeroclaw_http_base, bearer.clone())?;
    let hello = hello_line(&identity.handle);

    match read_session_id(klodi_home)? {
        Some(existing) => {
            // Best-effort resume: append the hello line to the existing
            // session so the operator's chat reflects the re-pair. If
            // the session was GC'd we fall through to a fresh bootstrap.
            match send_session_message(&ws_cfg, &existing, &hello).await {
                Ok(_) => {
                    println!(
                        "Resumed existing operator chat session ({}). \
                         Hello line appended.",
                        existing,
                    );
                    return Ok(());
                }
                Err(err) => {
                    tracing::warn!(
                        cached_session = %existing,
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_register_resume_failed_falling_through_to_bootstrap"
                    );
                }
            }
        }
        None => {}
    }

    let outcome = bootstrap_session_with_first_message(&ws_cfg, &hello)
        .await
        .context("bootstrapping operator chat session via WS /ws/chat")?;
    persist_session_id(klodi_home, &outcome.session_id)?;
    println!(
        "Operator chat session bootstrapped ({}). Open the ZeroClaw \
         dashboard to see the hello line.",
        outcome.session_id,
    );
    Ok(())
}

fn hello_line(handle: &str) -> String {
    format!(
        "klodi paired as @{handle}. I'll surface anything that needs you here."
    )
}

#[derive(Deserialize)]
struct PairResponse {
    token: String,
    #[serde(default)]
    paired: bool,
}

async fn pair(cli: &Cli, klodi_home: &std::path::Path) -> Result<String> {
    let cache_path = klodi_home.join("zeroclaw.token");
    if let Some(cached) = read_cached_token(&cache_path)? {
        println!("Reusing cached ZeroClaw bearer from {}.", cache_path.display());
        return Ok(cached);
    }

    // Mint a pairing code via the gateway CLI. We do not fall through to
    // a sidecar code file here — register is interactive and we'd rather
    // fail loud than silently leave the operator un-paired.
    let cfg = BrowserPairConfig {
        cli_path: cli.zeroclaw_cli.clone(),
        timeout: ZEROCLAW_CLI_TIMEOUT,
    };
    let minter = ZeroclawCliMinter::detect(cfg).await.ok_or_else(|| {
        anyhow::anyhow!(
            "zeroclaw CLI at {} not callable. Install ZeroClaw locally, or pass \
             --zeroclaw-cli <path>. Skip this step entirely with --skip-pair when \
             the gateway lives on another host (you'll need to provision \
             ${{KLODI_HOME}}/zeroclaw.token + ${{KLODI_HOME}}/zeroclaw.session by hand).",
            cli.zeroclaw_cli.display(),
        )
    })?;
    let minter = MinterImpl::Cli(minter);
    let code = minter
        .mint()
        .await
        .context("minting a fresh ZeroClaw pairing code")?;

    let pair_url = format!(
        "{}/pair",
        cli.zeroclaw_http_base.trim_end_matches('/'),
    );
    let token = pair_with_zeroclaw(&pair_url, &code).await?;
    persist_token(&cache_path, &token)?;
    println!(
        "Paired with ZeroClaw at {} — bearer cached at {}.",
        pair_url,
        cache_path.display(),
    );
    Ok(token)
}

fn read_cached_token(path: &std::path::Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

async fn pair_with_zeroclaw(pair_url: &str, code: &str) -> Result<String> {
    let http = HttpClient::builder()
        .timeout(PAIR_HTTP_TIMEOUT)
        .user_agent(concat!(
            "klodi-zeroclaw-register/",
            env!("CARGO_PKG_VERSION"),
        ))
        .build()
        .context("building pair HTTP client")?;
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
        bail!("pair POST to {pair_url} returned {status}: {body}");
    }
    let parsed: PairResponse = serde_json::from_str(&body)
        .with_context(|| format!("decoding pair response (status {status}): {body}"))?;
    if !parsed.token.starts_with("zc_") {
        bail!(
            "unexpected token shape from /pair (expected 'zc_' prefix): {:?}",
            parsed.token,
        );
    }
    if !parsed.paired {
        tracing::warn!("klodi_zeroclaw_pair_response_paired_false");
    }
    Ok(parsed.token)
}

fn persist_token(target: &std::path::Path, token: &str) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    klodi_secret_write(target, token.as_bytes(), 0o600)
        .with_context(|| format!("klodi_secret_write {}", target.display()))
}
