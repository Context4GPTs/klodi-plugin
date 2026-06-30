//! `klodi-zeroclaw-daemon` — long-running operator-session bridge.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md` the daemon
//! brings together three concurrent sources of input into one
//! single-flight ZeroClaw chat session:
//!
//! 1. NATS subscriber → marketplace wakes (`InboundEvent::Wake`).
//! 2. Telegram long-poll → operator-typed messages
//!    (`InboundEvent::OperatorMessage`).
//! 3. The `OperatorSessionController` worker → drains the mpsc inbox,
//!    runs one `/ws/chat` turn per event, forwards the agent's reply
//!    to Telegram.
//!
//! NATS ACKs at *dispatch time*, not on agent completion — preserves
//! <50ms ack latency regardless of LLM duration. The Telegram poller
//! persists the `last_acked_update_id` offset after every successful
//! dispatch so a crash redelivers at most one update.

use anyhow::{Context, Result, bail};
use clap::Parser;
use klodi_nats_client::KlodiError;
use klodi_rust_host::forwarder::{WakeEvent, WakeHandler, WakeHandlerFuture};
use klodi_rust_host::{
    ChatClient, DispatchError, ForwarderConfig, InboundEvent, OperatorInbox,
    OperatorSessionController, TelegramClient, TelegramError, TelegramOffset, paths,
    read_session_id, read_telegram_config, read_telegram_offset, register, run_forwarder,
    write_telegram_offset,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Long-poll window for `getUpdates`. Telegram recommends 25s.
const TELEGRAM_POLL_TIMEOUT_SECS: u32 = 25;

#[derive(Parser, Debug)]
#[command(
    name = "klodi-zeroclaw-daemon",
    about = "Long-running operator-session bridge. NATS + Telegram fan in through one zeroclaw /ws/chat session.",
    version = env!("CARGO_PKG_VERSION"),
)]
struct Cli {
    /// Override `${KLODI_HOME}/nats.creds`.
    #[arg(long, env = "KLODI_CREDS")]
    creds: Option<PathBuf>,
    /// Override `${KLODI_HOME}/config.json`.
    #[arg(long, env = "KLODI_CONFIG")]
    config: Option<PathBuf>,
    /// Override `${KLODI_HOME}` for persisted artifacts (`zeroclaw.{token,session}`,
    /// `telegram.{json,offset.json,last-send.json}`).
    #[arg(long, env = "KLODI_HOME")]
    klodi_home: Option<PathBuf>,
    /// ZeroClaw gateway base URL (no path). Used to derive `ws(s)://…/ws/chat`.
    #[arg(
        long,
        env = "ZEROCLAW_HTTP_BASE",
        default_value = "http://127.0.0.1:7070"
    )]
    zeroclaw_http_base: String,
    /// Override the default `${KLODI_HOME}/telegram.json` location.
    #[arg(long, env = "TELEGRAM_CONFIG")]
    telegram_config: Option<PathBuf>,
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
    let klodi_home = cli.klodi_home.clone().unwrap_or_else(paths::klodi_home);
    let creds_path = cli.creds.clone().unwrap_or_else(|| klodi_home.join("nats.creds"));
    let config_path = cli.config.clone().unwrap_or_else(|| klodi_home.join("config.json"));

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

    let bearer = read_bearer(&klodi_home)?;
    let identity = register::read_config_identity(&klodi_home)
        .context("reading handle + user_id from config.json")?;
    let session_id = read_session_id(&klodi_home)?.ok_or_else(|| {
        anyhow::anyhow!(
            "operator session id not found at {} — run klodi-zeroclaw-register first \
             (the daemon resumes this session on every wake)",
            klodi_home.join("zeroclaw.session").display(),
        )
    })?;

    // Telegram config — we honour --telegram-config (defaulting to the
    // klodi_home-relative path) so tests can stage an isolated file.
    let telegram_cfg_path = cli
        .telegram_config
        .clone()
        .unwrap_or_else(|| klodi_home.join("telegram.json"));
    if !telegram_cfg_path.exists() {
        bail!(
            "telegram.json not found at {} — run klodi-zeroclaw-register to pair Telegram. \
             Pass --skip-telegram on register if this host genuinely doesn't have a paired bot.",
            telegram_cfg_path.display(),
        );
    }
    let telegram_cfg = read_telegram_config(&klodi_home)?.ok_or_else(|| {
        anyhow::anyhow!(
            "telegram.json present but empty / unreadable at {}",
            telegram_cfg_path.display(),
        )
    })?;

    let telegram = Arc::new(TelegramClient::new(telegram_cfg.bot_token.clone()));
    // One ChatClient per operator; the per-turn session_id is chosen by the
    // worker (a wake's `klodi:<entity_id>` key, or the operator session below).
    let chat = Arc::new(ChatClient::new(cli.zeroclaw_http_base.clone(), bearer));

    tracing::info!(
        handle = %identity.handle,
        user_id = %identity.user_id,
        chat_id = telegram_cfg.chat_id,
        operator_session_id = %session_id,
        http_base = %cli.zeroclaw_http_base,
        bot_username = telegram_cfg.bot_username.as_deref().unwrap_or(""),
        "klodi_zeroclaw_daemon_starting"
    );

    let controller = OperatorSessionController::spawn(
        telegram_cfg.chat_id,
        session_id.clone(),
        chat.clone(),
        telegram.clone(),
        klodi_home.clone(),
    );

    // Telegram long-poll task — pushes operator messages into the inbox.
    let poller_inbox = controller.inbox.clone();
    let poller_telegram = telegram.clone();
    let poller_chat_id = telegram_cfg.chat_id;
    let poller_klodi_home = klodi_home.clone();
    let poller_join = tokio::spawn(async move {
        if let Err(err) = run_telegram_poller(
            poller_telegram,
            poller_inbox,
            poller_chat_id,
            poller_klodi_home,
        )
        .await
        {
            tracing::error!(error = ?err, "klodi_zeroclaw_telegram_poller_exited");
        }
    });

    // NATS subscriber — pushes wake events into the inbox.
    let handler: Arc<dyn WakeHandler> = Arc::new(InboxWakeHandler {
        inbox: controller.inbox.clone(),
    });

    let forwarder_handle = tokio::spawn(run_forwarder(ForwarderConfig {
        creds_path,
        config_path,
        handler,
        log_event_prefix: "klodi_zeroclaw".into(),
        health_port: cli.health_port,
    }));

    // First task to exit signals shutdown of the daemon. We don't try
    // to be graceful here — each source task is independent and a
    // restart via the supervisor brings things back cleanly.
    let worker_join = controller.join;
    tokio::select! {
        res = forwarder_handle => {
            tracing::info!(?res, "klodi_zeroclaw_forwarder_exited");
        }
        res = poller_join => {
            tracing::info!(?res, "klodi_zeroclaw_telegram_poller_exited");
        }
        res = worker_join => {
            tracing::info!(?res, "klodi_zeroclaw_operator_worker_exited");
        }
    }
    Ok(())
}

/// Long-poll loop. On each successful dispatch the new offset is
/// persisted so a crash redelivers at most one update.
async fn run_telegram_poller(
    telegram: Arc<TelegramClient>,
    inbox: OperatorInbox,
    chat_id: i64,
    klodi_home: PathBuf,
) -> Result<()> {
    let mut offset = read_telegram_offset(&klodi_home)
        .unwrap_or_default()
        .last_acked_update_id
        + 1;
    loop {
        match telegram.poll_updates(offset, TELEGRAM_POLL_TIMEOUT_SECS).await {
            Ok((updates, next_offset)) => {
                for update in updates {
                    let Some(message) = update.message else {
                        offset = update.update_id + 1;
                        persist_offset(&klodi_home, update.update_id);
                        continue;
                    };
                    // Filter: this daemon serves exactly one chat_id;
                    // anything else is a stray bot user and should be
                    // silently dropped.
                    if message.chat.id != chat_id {
                        tracing::debug!(
                            from = message.chat.id,
                            expected = chat_id,
                            "klodi_zeroclaw_telegram_message_dropped_wrong_chat"
                        );
                        offset = update.update_id + 1;
                        persist_offset(&klodi_home, update.update_id);
                        continue;
                    }
                    let Some(text) = message.text else {
                        // Non-text messages (photos, stickers) are out
                        // of scope today.
                        offset = update.update_id + 1;
                        persist_offset(&klodi_home, update.update_id);
                        continue;
                    };
                    match inbox.dispatch(InboundEvent::OperatorMessage {
                        text,
                        telegram_message_id: message.message_id,
                    }) {
                        Ok(()) => {
                            offset = update.update_id + 1;
                            persist_offset(&klodi_home, update.update_id);
                        }
                        Err(DispatchError::Closed) => {
                            bail!("operator inbox closed; worker exited");
                        }
                        Err(DispatchError::Full(cap)) => {
                            tracing::warn!(
                                capacity = cap,
                                "klodi_zeroclaw_inbox_full_dropping_telegram_message"
                            );
                            // Don't advance offset: the next poll will
                            // redeliver this update once the worker has
                            // drained.
                            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        }
                    }
                }
                if next_offset > offset {
                    offset = next_offset;
                }
            }
            Err(TelegramError::BadToken) => {
                bail!(
                    "Telegram bot token rejected (401) — re-run klodi-zeroclaw-register \
                     --re-pair-telegram"
                );
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "klodi_zeroclaw_telegram_poll_failed_will_retry"
                );
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
}

fn persist_offset(klodi_home: &std::path::Path, update_id: i64) {
    if let Err(err) = write_telegram_offset(
        klodi_home,
        &TelegramOffset {
            last_acked_update_id: update_id,
        },
    ) {
        tracing::warn!(
            error = %err,
            update_id,
            "klodi_zeroclaw_telegram_offset_persist_failed"
        );
    }
}

/// Wake handler that pushes events into the operator's mpsc inbox.
/// Returns Ok (→ NATS ACK) on dispatch, Err (→ NATS NAK + redelivery)
/// when the inbox is closed or full so the JetStream consumer can
/// back-pressure operator bursts.
struct InboxWakeHandler {
    inbox: OperatorInbox,
}

impl WakeHandler for InboxWakeHandler {
    fn handle<'a>(&'a self, event: &'a WakeEvent) -> WakeHandlerFuture<'a> {
        Box::pin(async move {
            match self.inbox.dispatch(InboundEvent::Wake(event.clone())) {
                Ok(()) => {
                    tracing::info!(
                        kind = %event.kind(),
                        event_id = %event.event_id(),
                        "klodi_zeroclaw_wake_dispatched_to_inbox"
                    );
                    Ok(())
                }
                Err(DispatchError::Full(cap)) => {
                    tracing::warn!(
                        kind = %event.kind(),
                        event_id = %event.event_id(),
                        capacity = cap,
                        "klodi_zeroclaw_inbox_full_naking_for_redelivery"
                    );
                    Err(KlodiError::NatsPublish(format!(
                        "operator inbox full (cap={cap}); redeliver"
                    )))
                }
                Err(DispatchError::Closed) => Err(KlodiError::NatsPublish(
                    "operator inbox closed; worker exited".into(),
                )),
            }
        })
    }
}

/// Resolve the ZeroClaw bearer from `${KLODI_HOME}/zeroclaw.token`. The
/// daemon no longer accepts a CLI override here — operators wanting to
/// move tokens around should re-run `klodi-zeroclaw-register`.
fn read_bearer(klodi_home: &std::path::Path) -> Result<String> {
    let path = klodi_home.join("zeroclaw.token");
    let raw = std::fs::read_to_string(&path).with_context(|| {
        format!(
            "reading {} — run klodi-zeroclaw-register first to pair with the gateway",
            path.display(),
        )
    })?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        bail!(
            "{} is empty — re-run klodi-zeroclaw-register to re-pair",
            path.display(),
        );
    }
    Ok(trimmed.to_string())
}
