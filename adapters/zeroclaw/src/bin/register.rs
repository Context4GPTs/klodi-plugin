//! `klodi-zeroclaw-register` — one-shot registration + ZeroClaw pairing
//! + Telegram pairing.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md` the binary:
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
//!    `config.toml`.
//! 5. NEW: pairs Telegram — validates the bot token via `getMe`, picks
//!    the operator's chat_id from a recent `/start`, persists
//!    `${KLODI_HOME}/telegram.json`, and sends a hello line so the
//!    operator's phone shows the bot is alive.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_nats_client::{KLODI_DEFAULT_API_URL, klodi_secret_write};
use klodi_rust_host::{
    BrowserPairConfig, HostMcpEntry, MinterImpl, RegisterArgs, TelegramClient,
    TelegramConfig, TelegramError, ZeroClawWsConfig, ZeroclawCliMinter, apply_host_mcp_entry,
    bootstrap_session_with_first_message, default_host_config_path, paths,
    persist_session_id, read_session_id, read_telegram_config, register, run_register,
    send_session_message, write_telegram_config,
};
use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::time::Duration;

const ZEROCLAW_CLI_TIMEOUT: Duration = Duration::from_secs(5);
const PAIR_HTTP_TIMEOUT: Duration = Duration::from_secs(10);
const TELEGRAM_FIRST_POLL_TIMEOUT_SECS: u32 = 2;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-register",
    about = "Register klodi for the ZeroClaw adapter, pair with the gateway, and onboard Telegram.",
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
    /// has already paired manually.
    #[arg(long)]
    skip_pair: bool,
    /// Bypass the "creds already on disk → skip" short-circuit in the
    /// shared register flow.
    #[arg(long)]
    force_register: bool,
    /// Telegram bot token. Non-interactive override; otherwise the
    /// binary prompts on stdin when no `telegram.json` is present.
    #[arg(long, env = "TELEGRAM_BOT_TOKEN")]
    bot_token: Option<String>,
    /// Telegram chat id. Non-interactive override; otherwise the binary
    /// long-polls `getUpdates` after the operator sends `/start`.
    #[arg(long, env = "TELEGRAM_CHAT_ID")]
    chat_id: Option<i64>,
    /// Force re-running the Telegram pairing even if telegram.json
    /// exists. Re-uses --bot-token / --chat-id if passed.
    #[arg(long)]
    re_pair_telegram: bool,
    /// Skip Telegram onboarding entirely. Use for hosts that genuinely
    /// don't want a bot (headless CI).
    #[arg(long)]
    skip_telegram: bool,
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
            .clone()
            .unwrap_or_else(|| default_host_config_path("zeroclaw"));
        let entry = HostMcpEntry {
            config_path: config_path.clone(),
            command: cli.mcp_command.clone(),
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

    if cli.skip_telegram {
        println!("Skipping Telegram pairing (--skip-telegram).");
    } else {
        pair_telegram(&cli, &klodi_home).await?;
    }

    Ok(())
}

async fn pair_and_bootstrap(cli: &Cli, klodi_home: &std::path::Path) -> Result<()> {
    let bearer = pair(cli, klodi_home).await.context("pairing with ZeroClaw")?;
    let identity = register::read_config_identity(klodi_home)
        .context("reading handle + user_id from config.json")?;
    let ws_cfg = ZeroClawWsConfig::from_http_base(&cli.zeroclaw_http_base, bearer.clone())?;
    let hello = hello_line(&identity.handle);

    if let Some(existing) = read_session_id(klodi_home)? {
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

    let outcome = bootstrap_session_with_first_message(&ws_cfg, &hello)
        .await
        .context("bootstrapping operator chat session via WS /ws/chat")?;
    persist_session_id(klodi_home, &outcome.session_id)?;
    println!(
        "Operator chat session bootstrapped ({}). The daemon will resume this on every wake.",
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

// ----- Telegram pairing -----------------------------------------------------

async fn pair_telegram(cli: &Cli, klodi_home: &std::path::Path) -> Result<()> {
    if !cli.re_pair_telegram {
        if let Some(existing) = read_telegram_config(klodi_home)? {
            println!(
                "Reusing existing telegram.json (bot=@{} chat_id={}). \
                 Pass --re-pair-telegram to redo.",
                existing.bot_username.as_deref().unwrap_or("unknown"),
                existing.chat_id,
            );
            // Even on reuse, send a hello line so the operator sees the
            // bot is alive after register.
            send_telegram_hello(&existing).await;
            return Ok(());
        }
    }

    let bot_token = match cli.bot_token.clone() {
        Some(t) => {
            let trimmed = t.trim().to_string();
            if trimmed.is_empty() {
                bail!("--bot-token / TELEGRAM_BOT_TOKEN was set but empty");
            }
            trimmed
        }
        None => prompt_for_bot_token()?,
    };

    let client = TelegramClient::new(bot_token.clone());
    let bot = match client.get_me().await {
        Ok(b) => b,
        Err(TelegramError::BadToken) => {
            bail!(
                "Telegram rejected the bot token (401). Re-check what you pasted from \
                 @BotFather and run again."
            );
        }
        Err(err) => bail!("Telegram getMe failed: {err}"),
    };
    let bot_username = bot.username.clone().unwrap_or_else(|| bot.first_name.clone());
    println!(
        "Bot validated: @{} (id={}). Now open Telegram, search @{}, and send /start.",
        bot_username, bot.id, bot_username,
    );

    let chat_id = match cli.chat_id {
        Some(id) => id,
        None => {
            print!("Press Enter once you've sent /start in Telegram... ");
            std::io::stdout().flush().ok();
            let mut buf = String::new();
            std::io::stdin()
                .lock()
                .read_line(&mut buf)
                .context("reading stdin for /start gate")?;
            discover_chat_id(&client).await?
        }
    };

    if cli.chat_id.is_none() {
        print!(
            "Pair with chat_id {chat_id} (from @{bot_username})? [y/N] "
        );
        std::io::stdout().flush().ok();
        let mut buf = String::new();
        std::io::stdin()
            .lock()
            .read_line(&mut buf)
            .context("reading stdin for chat_id confirmation")?;
        if !matches!(buf.trim(), "y" | "Y" | "yes" | "YES") {
            bail!("operator declined chat_id {chat_id}; re-run with --chat-id to override");
        }
    }

    let cfg = TelegramConfig {
        bot_token: bot_token.clone(),
        chat_id,
        bot_username: Some(bot_username.clone()),
        paired_at: Some(iso_now()),
    };
    write_telegram_config(klodi_home, &cfg).context("writing telegram.json")?;
    println!(
        "Telegram paired: bot=@{bot_username} chat_id={chat_id} \
         (written to {}).",
        klodi_home.join("telegram.json").display(),
    );

    send_telegram_hello(&cfg).await;
    Ok(())
}

fn prompt_for_bot_token() -> Result<String> {
    print!(
        "Paste your Telegram bot token (from @BotFather): "
    );
    std::io::stdout().flush().ok();
    let mut buf = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut buf)
        .context("reading bot token from stdin")?;
    let trimmed = buf.trim().to_string();
    if trimmed.is_empty() {
        bail!("empty bot token");
    }
    Ok(trimmed)
}

async fn discover_chat_id(client: &TelegramClient) -> Result<i64> {
    let (updates, _) = client
        .poll_updates(0, TELEGRAM_FIRST_POLL_TIMEOUT_SECS)
        .await
        .context("polling getUpdates for the operator's /start message")?;
    let chat_id = updates
        .into_iter()
        .filter_map(|u| u.message)
        .max_by_key(|m| m.date)
        .map(|m| m.chat.id)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no recent updates from the bot — make sure you sent /start in Telegram and try again",
            )
        })?;
    Ok(chat_id)
}

async fn send_telegram_hello(cfg: &TelegramConfig) {
    let client = TelegramClient::new(cfg.bot_token.clone());
    let bot = cfg.bot_username.as_deref().unwrap_or("klodi");
    let body = format!(
        "Klodi paired with @{bot}. I'll surface marketplace events here.",
    );
    match client.send(cfg.chat_id, &body).await {
        Ok(_) => {
            println!("Hello message sent to chat_id={}.", cfg.chat_id);
        }
        Err(err) => {
            tracing::warn!(
                error = %err,
                chat_id = cfg.chat_id,
                "klodi_zeroclaw_register_telegram_hello_failed"
            );
            println!(
                "Telegram hello send failed ({err}); pairing file was still written.",
            );
        }
    }
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    let mut secs = now.as_secs() as i64;
    let mut y: i64 = 1970;
    loop {
        let days = if is_leap_year(y) { 366 } else { 365 };
        let year_secs = days * 86400;
        if secs < year_secs {
            break;
        }
        secs -= year_secs;
        y += 1;
    }
    let month_lengths = [
        31,
        if is_leap_year(y) { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut m: usize = 0;
    while m < 12 {
        let len = month_lengths[m] as i64 * 86400;
        if secs < len {
            break;
        }
        secs -= len;
        m += 1;
    }
    let day = (secs / 86400) as u32 + 1;
    secs %= 86400;
    let hour = (secs / 3600) as u32;
    secs %= 3600;
    let min = (secs / 60) as u32;
    let sec = (secs % 60) as u32;
    format!(
        "{y:04}-{:02}-{day:02}T{hour:02}:{min:02}:{sec:02}Z",
        m + 1,
    )
}

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}
