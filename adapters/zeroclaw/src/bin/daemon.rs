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
    OperatorSessionController, TelegramClient, TelegramConfig, TelegramError, TelegramOffset,
    WakeOnlyController, paths, read_session_id, read_telegram_config, read_telegram_offset,
    register, run_forwarder, write_telegram_offset,
};
use std::path::{Path, PathBuf};
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
    /// Boot headless / wake-only: skip the Telegram poll + reply relay and the
    /// operator `zeroclaw.session` requirement. Still hard-requires nats.creds,
    /// config.json, and a non-empty zeroclaw.token bearer. Named to mirror
    /// klodi-zeroclaw-register's own `--skip-telegram` (the persist-side flag).
    #[arg(long)]
    skip_telegram: bool,
}

/// On-disk artifacts a daemon boot hard-requires. `NatsCreds`, `Config`, and
/// `Bearer` (a non-empty `zeroclaw.token`) are required in EVERY mode (BR-A) —
/// they are the NATS + gateway connect prerequisites, which `--skip-telegram`
/// never relaxes. `OperatorSession` (`zeroclaw.session`) and `TelegramConfig`
/// (`telegram.json`) are the human-surface prerequisites the flag relaxes
/// (BR-B/BR-C).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequiredArtifact {
    NatsCreds,
    Config,
    Bearer,
    OperatorSession,
    TelegramConfig,
}

/// The pure boot-precondition selector. `main` branches on it, and the checks
/// in `resolve_common` / `run_operator_bridge` mirror it exactly — so a unit
/// test over this fn is the real AC5/AC6 contract, not an aspirational
/// restatement of the branch.
fn required_artifacts(skip_telegram: bool) -> Vec<RequiredArtifact> {
    let mut required = vec![
        RequiredArtifact::NatsCreds,
        RequiredArtifact::Config,
        RequiredArtifact::Bearer,
    ];
    if !skip_telegram {
        required.push(RequiredArtifact::OperatorSession);
        required.push(RequiredArtifact::TelegramConfig);
    }
    required
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    // The always-required NATS/bearer prelude is shared by both modes; the
    // human-surface prerequisites (session + telegram.json) are resolved only
    // by the operator bridge. `required_artifacts` is the single source of
    // truth for which mode needs which — see AC5/AC6.
    let common = resolve_common(&cli)?;
    if required_artifacts(cli.skip_telegram).contains(&RequiredArtifact::OperatorSession) {
        run_operator_bridge(cli, common).await
    } else {
        run_wake_only(cli, common).await
    }
}

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
}

/// Boot prerequisites shared by both modes: the NATS creds + config paths, the
/// gateway bearer (validated non-empty by `read_bearer`), the config identity,
/// and the single per-operator [`ChatClient`]. These are the artifacts
/// `--skip-telegram` never relaxes (BR-A). Building the (side-effect-free)
/// `ChatClient` here — before the operator bridge's session/telegram checks —
/// keeps the operator-bridge bail order byte-for-byte (BR-E): creds → config →
/// bearer → identity, then session → telegram.
struct BootCommon {
    klodi_home: PathBuf,
    creds_path: PathBuf,
    config_path: PathBuf,
    identity: register::ConfigIdentity,
    chat: Arc<ChatClient>,
}

// Manual `Debug` (not derived) so the `ChatClient`'s bearer secret never lands
// in a debug render — and so `resolve_common(..).expect_err(..)` in the
// precondition tests can name the (never-taken) Ok value without `ChatClient`
// having to be `Debug` (which would expose the token).
impl std::fmt::Debug for BootCommon {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BootCommon")
            .field("klodi_home", &self.klodi_home)
            .field("creds_path", &self.creds_path)
            .field("config_path", &self.config_path)
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

fn resolve_common(cli: &Cli) -> Result<BootCommon> {
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
    // One ChatClient per operator; the per-turn session_id is chosen by the
    // worker (a wake's `klodi:<entity_id>` key, or — in the bridge — the
    // operator session).
    let chat = Arc::new(ChatClient::new(cli.zeroclaw_http_base.clone(), bearer));

    Ok(BootCommon {
        klodi_home,
        creds_path,
        config_path,
        identity,
        chat,
    })
}

/// Operator-bridge-only prerequisite: the persisted operator session the
/// daemon resumes on operator-typed turns. Missing under the bridge is a bail
/// pointing at register; relaxed entirely under `--skip-telegram` (BR-B).
fn resolve_operator_session(klodi_home: &Path) -> Result<String> {
    read_session_id(klodi_home)?.ok_or_else(|| {
        anyhow::anyhow!(
            "operator session id not found at {} — run klodi-zeroclaw-register first \
             (the daemon resumes this session on every wake)",
            klodi_home.join("zeroclaw.session").display(),
        )
    })
}

/// Operator-bridge-only prerequisite: the paired-bot config. We honour
/// `--telegram-config` for the existence check (so tests can stage an isolated
/// file) but read the value from the klodi_home default, matching today's
/// behaviour byte-for-byte (BR-E).
fn resolve_telegram_config(cli: &Cli, klodi_home: &Path) -> Result<TelegramConfig> {
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
    read_telegram_config(klodi_home)?.ok_or_else(|| {
        anyhow::anyhow!(
            "telegram.json present but empty / unreadable at {}",
            telegram_cfg_path.display(),
        )
    })
}

/// Default path: NATS + Telegram fan in through one operator session. Behaviour
/// is byte-for-byte the pre-`--skip-telegram` daemon (BR-E).
async fn run_operator_bridge(cli: Cli, common: BootCommon) -> Result<()> {
    let BootCommon {
        klodi_home,
        creds_path,
        config_path,
        identity,
        chat,
    } = common;
    let session_id = resolve_operator_session(&klodi_home)?;
    let telegram_cfg = resolve_telegram_config(&cli, &klodi_home)?;

    let telegram = Arc::new(TelegramClient::new(telegram_cfg.bot_token.clone()));

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

/// Headless `--skip-telegram` path: NATS wakes fan into a wake-only worker that
/// dials `/ws/chat` per wake and logs the reply. No operator session, no
/// Telegram poller, no reply relay (BR-C). The NATS subscriber + inbox worker +
/// `/ws/chat` dial are wired exactly as the bridge; only the human surface is
/// switched off.
async fn run_wake_only(cli: Cli, common: BootCommon) -> Result<()> {
    let BootCommon {
        creds_path,
        config_path,
        identity,
        chat,
        ..
    } = common;

    tracing::warn!(
        handle = %identity.handle,
        user_id = %identity.user_id,
        http_base = %cli.zeroclaw_http_base,
        "klodi_zeroclaw_wake_only_mode_active: no operator session, no Telegram \
         bridge; agent replies are logged, not surfaced (--skip-telegram)"
    );

    let controller = WakeOnlyController::spawn(chat);

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

    let worker_join = controller.join;
    tokio::select! {
        res = forwarder_handle => {
            tracing::info!(?res, "klodi_zeroclaw_forwarder_exited");
        }
        res = worker_join => {
            tracing::info!(?res, "klodi_zeroclaw_wake_only_worker_exited");
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
            match self.inbox.dispatch(InboundEvent::Wake(Box::new(event.clone()))) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// AC5 — with NO `--skip-telegram`, the operator bridge still hard-requires
    /// the human-surface artifacts (operator session + telegram.json) on top of
    /// the always-required NATS/bearer connect prerequisites. The boot branches
    /// on this exact set, so the resolved session/telegram bails are what an
    /// operator sees when either is missing (behaviour identical to today).
    #[test]
    fn required_artifacts_operator_bridge_requires_session_and_telegram() {
        let required = required_artifacts(false);
        assert!(required.contains(&RequiredArtifact::NatsCreds));
        assert!(required.contains(&RequiredArtifact::Config));
        assert!(required.contains(&RequiredArtifact::Bearer));
        assert!(required.contains(&RequiredArtifact::OperatorSession));
        assert!(required.contains(&RequiredArtifact::TelegramConfig));
    }

    /// AC6 — `--skip-telegram` relaxes ONLY the operator session + telegram.json;
    /// the NATS creds, config.json, and bearer connect prerequisites stay
    /// hard-required (the flag never loosens the connect path).
    #[test]
    fn required_artifacts_wake_only_relaxes_only_session_and_telegram() {
        let required = required_artifacts(true);
        assert!(required.contains(&RequiredArtifact::NatsCreds));
        assert!(required.contains(&RequiredArtifact::Config));
        assert!(required.contains(&RequiredArtifact::Bearer));
        assert!(!required.contains(&RequiredArtifact::OperatorSession));
        assert!(!required.contains(&RequiredArtifact::TelegramConfig));
    }

    #[test]
    fn skip_telegram_flag_defaults_false() {
        let cli = Cli::parse_from(["klodi-zeroclaw-daemon"]);
        assert!(!cli.skip_telegram);
    }

    #[test]
    fn skip_telegram_flag_parses_true() {
        let cli = Cli::parse_from(["klodi-zeroclaw-daemon", "--skip-telegram"]);
        assert!(cli.skip_telegram);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AC5/AC6 error-string contracts — qa-developer (adversarial coverage).
//
// `required_artifacts` (tested above) proves WHICH artifacts each mode requires,
// but not WHAT an operator sees when one is missing. AC5 demands TODAY'S EXACT
// bail strings pointing at klodi-zeroclaw-register (BR-E, byte-for-byte); AC6
// demands the connect prerequisites (creds / config / bearer) still fail fast
// NAMING the artifact + register even under `--skip-telegram` (the flag relaxes
// only session + telegram). These drive the REAL error-producing fns
// (`resolve_common` / `resolve_operator_session` / `resolve_telegram_config` /
// `read_bearer`) against a staged tempdir, hermetically (explicit
// --creds/--config/--telegram-config so ambient env can't leak in). A
// set-membership test alone would stay green even if these strings regressed —
// hence these. Never weaken an assertion to match an implementation.
#[cfg(test)]
mod precondition_error_string_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn cli_home(home: &Path) -> Cli {
        // Explicit overrides for every env-backed path so the resolver is
        // hermetic regardless of KLODI_HOME / KLODI_CREDS / … in the test env.
        Cli::parse_from([
            "klodi-zeroclaw-daemon",
            "--klodi-home",
            home.to_str().unwrap(),
            "--creds",
            home.join("nats.creds").to_str().unwrap(),
            "--config",
            home.join("config.json").to_str().unwrap(),
            "--telegram-config",
            home.join("telegram.json").to_str().unwrap(),
        ])
    }

    // ── AC5 — default-path session bail is today's EXACT string + register ──
    #[test]
    fn resolve_operator_session_missing_is_todays_register_error() {
        let dir = tempdir().unwrap();
        let err = resolve_operator_session(dir.path())
            .expect_err("a missing zeroclaw.session must bail (AC5)")
            .to_string();
        assert!(
            err.contains("operator session id not found at")
                && err.contains("run klodi-zeroclaw-register first")
                && err.contains("the daemon resumes this session on every wake"),
            "AC5/BR-E: the default-path session bail must be today's EXACT string \
             pointing at klodi-zeroclaw-register; got: {err}",
        );
    }

    // ── AC5 — default-path telegram bail is today's EXACT string + register ──
    #[test]
    fn resolve_telegram_config_missing_is_todays_register_error() {
        let dir = tempdir().unwrap();
        let cli = cli_home(dir.path());
        let err = resolve_telegram_config(&cli, dir.path())
            .expect_err("a missing telegram.json must bail (AC5)")
            .to_string();
        assert!(
            err.contains("telegram.json not found at")
                && err.contains("run klodi-zeroclaw-register to pair Telegram")
                && err.contains("Pass --skip-telegram on register"),
            "AC5/BR-E: the default-path telegram bail must be today's EXACT string \
             pointing at klodi-zeroclaw-register; got: {err}",
        );
    }

    // ── AC6 — creds prerequisite never relaxed; names the artifact + register ──
    #[test]
    fn resolve_common_missing_creds_fails_fast_naming_creds() {
        let dir = tempdir().unwrap();
        let cli = cli_home(dir.path()); // nothing staged → nats.creds absent
        let err = resolve_common(&cli)
            .expect_err("missing nats.creds must fail fast even under any mode (AC6)")
            .to_string();
        assert!(
            err.contains("klodi creds not found at")
                && err.contains("nats.creds")
                && err.contains("klodi-zeroclaw-register"),
            "AC6: a missing NATS creds file must name the artifact + register; got: {err}",
        );
    }

    // ── AC6 — config prerequisite never relaxed ──
    #[test]
    fn resolve_common_missing_config_fails_fast_naming_config() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap(); // creds present
        let cli = cli_home(dir.path());
        let err = resolve_common(&cli)
            .expect_err("missing config.json must fail fast even under any mode (AC6)")
            .to_string();
        assert!(
            err.contains("klodi config not found at")
                && err.contains("config.json")
                && err.contains("klodi-zeroclaw-register"),
            "AC6: a missing config.json must name the artifact + register; got: {err}",
        );
    }

    // ── AC6 — bearer prerequisite never relaxed: a missing zeroclaw.token ──
    #[test]
    fn read_bearer_missing_token_names_token_and_register() {
        let dir = tempdir().unwrap();
        let err = read_bearer(dir.path())
            .expect_err("a missing zeroclaw.token must fail fast (AC6)")
            .to_string();
        assert!(
            err.contains("zeroclaw.token") && err.contains("klodi-zeroclaw-register"),
            "AC6/BR-A: the flag relaxes session + telegram ONLY — a missing bearer \
             must still fail fast naming zeroclaw.token + register; got: {err}",
        );
    }

    // ── AC6 — bearer prerequisite never relaxed: an empty zeroclaw.token ──
    #[test]
    fn read_bearer_empty_token_names_token_and_register() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("zeroclaw.token"), "   \n").unwrap();
        let err = read_bearer(dir.path())
            .expect_err("an empty zeroclaw.token must fail fast (AC6)")
            .to_string();
        assert!(
            err.contains("is empty") && err.contains("klodi-zeroclaw-register"),
            "AC6/BR-A: an empty bearer must fail fast pointing at register; got: {err}",
        );
    }
}
