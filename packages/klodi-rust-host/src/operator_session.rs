//! Per-operator coordinator wiring NATS + Telegram inbound events into
//! the single-flight ZeroClaw chat session.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md`:
//!
//! - One [`OperatorSessionController`] per operator (one `chat_id` =
//!   one zeroclaw session).
//! - The controller's `dispatch` is a non-blocking mpsc send; sources
//!   (NATS subscriber, Telegram poller) fan in here.
//! - The worker task drains the inbox serially, runs one `/ws/chat`
//!   turn per event, forwards the agent's reply to Telegram.
//! - Bursts that overflow the inbox drop oldest. The agent re-grounds
//!   from `klodi_*` tools each turn, so transient drops don't corrupt
//!   marketplace state.

use crate::forwarder::WakeEvent;
use crate::telegram::{TelegramClient, TelegramError};
use crate::telegram_config;
use crate::zeroclaw_chat::ChatClient;
use std::path::PathBuf;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::mpsc;

const INBOX_CAPACITY: usize = 64;

/// Event types the controller serialises through the zeroclaw session.
#[derive(Debug, Clone)]
pub enum InboundEvent {
    /// Marketplace wake from NATS (offer, channel message, transaction…).
    Wake(WakeEvent),
    /// Operator-typed message from Telegram.
    OperatorMessage {
        text: String,
        telegram_message_id: i64,
    },
}

#[derive(Debug, Error)]
pub enum DispatchError {
    #[error("operator inbox closed")]
    Closed,
    #[error("operator inbox full ({0} pending)")]
    Full(usize),
}

/// Hand to `OperatorSessionController::spawn` to send events into the
/// worker. Cheap to clone — the underlying mpsc::Sender is `Arc`-backed.
#[derive(Clone)]
pub struct OperatorInbox {
    tx: mpsc::Sender<InboundEvent>,
}

impl OperatorInbox {
    /// Non-blocking enqueue. Returns `Full` on burst — the caller should
    /// log + drop + emit a metric, then continue.
    pub fn dispatch(&self, event: InboundEvent) -> Result<(), DispatchError> {
        match self.tx.try_send(event) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(_)) => {
                Err(DispatchError::Full(self.tx.capacity()))
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err(DispatchError::Closed),
        }
    }
}

/// Long-running worker that drains the inbox and runs one zeroclaw turn
/// per event. Construct with [`spawn`]; hold the returned `JoinHandle`
/// to observe shutdown.
pub struct OperatorSessionController {
    pub inbox: OperatorInbox,
    pub join: tokio::task::JoinHandle<()>,
}

impl OperatorSessionController {
    pub fn spawn(
        chat_id: i64,
        chat: Arc<ChatClient>,
        telegram: Arc<TelegramClient>,
        klodi_home: PathBuf,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<InboundEvent>(INBOX_CAPACITY);
        let inbox = OperatorInbox { tx };
        let join = tokio::spawn(run_worker(
            WorkerCtx {
                chat_id,
                chat,
                telegram,
                klodi_home,
            },
            rx,
        ));
        Self { inbox, join }
    }
}

struct WorkerCtx {
    chat_id: i64,
    chat: Arc<ChatClient>,
    telegram: Arc<TelegramClient>,
    klodi_home: PathBuf,
}

async fn run_worker(ctx: WorkerCtx, mut rx: mpsc::Receiver<InboundEvent>) {
    while let Some(event) = rx.recv().await {
        let prompt = format_prompt(&event);
        let outcome = match ctx.chat.send_and_wait(&prompt).await {
            Ok(o) => o,
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    "klodi_zeroclaw_chat_turn_failed"
                );
                continue;
            }
        };
        let reply = outcome.full_response.trim();
        if reply.is_empty() {
            tracing::info!(
                turn_duration = ?outcome.turn_duration,
                "klodi_zeroclaw_chat_empty_reply_skipped"
            );
            continue;
        }
        match ctx.telegram.send(ctx.chat_id, reply).await {
            Ok(message_id) => {
                tracing::info!(
                    chat_id = ctx.chat_id,
                    message_id,
                    turn_duration = ?outcome.turn_duration,
                    "klodi_telegram_reply_sent"
                );
                if let Err(err) = telegram_config::write_last_send(
                    &ctx.klodi_home,
                    &iso_now(),
                ) {
                    tracing::warn!(
                        error = %err,
                        "klodi_telegram_last_send_persist_failed"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(
                    error = %err,
                    chat_id = ctx.chat_id,
                    "klodi_telegram_send_failed_reply_lost"
                );
                if let TelegramError::BadToken = err {
                    tracing::error!(
                        "klodi_telegram_bot_token_revoked_daemon_unable_to_send"
                    );
                }
            }
        }
    }
    tracing::info!("klodi_zeroclaw_operator_session_inbox_drained");
}

fn format_prompt(event: &InboundEvent) -> String {
    match event {
        InboundEvent::Wake(wake) => {
            let pretty = serde_json::to_string_pretty(wake).unwrap_or_else(|_| "{}".into());
            format!(
                "[wake] kind={} event_id={}\n\nPayload:\n{}\n",
                wake.kind(),
                wake.event_id(),
                pretty,
            )
        }
        InboundEvent::OperatorMessage {
            text,
            telegram_message_id,
        } => format!(
            "[operator] telegram_message_id={telegram_message_id}\n\n{text}\n",
        ),
    }
}

fn iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    // RFC3339 / ISO 8601 in UTC. Avoid pulling in `chrono` for one
    // timestamp: format manually with rough math. Precision is seconds.
    let mut secs = now.as_secs() as i64;
    // Subtract from 1970 + appropriate years/months/days.
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
    let month_lengths = [31, if is_leap_year(y) { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m: u32 = 0;
    while m < 12 {
        let len = month_lengths[m as usize] as i64 * 86400;
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

#[cfg(test)]
mod tests {
    use super::*;
    use klodi_nats_client::NotificationEvent;

    fn wake_for_test() -> WakeEvent {
        let evt = NotificationEvent::ListingCreated {
            event_id: "e1".into(),
            listing_id: "l1".into(),
            title: Some("vintage chair".into()),
        };
        WakeEvent::Notification {
            kind: evt.kind().to_string(),
            event_id: evt.event_id().to_string(),
            user_id: "u1".into(),
            payload: evt,
        }
    }

    #[test]
    fn format_prompt_wake_includes_kind_and_payload() {
        let prompt = format_prompt(&InboundEvent::Wake(wake_for_test()));
        assert!(prompt.starts_with("[wake] kind=listing.created event_id=e1"));
        assert!(prompt.contains("\"channel\""));
        assert!(prompt.contains("\"kind\": \"listing.created\""));
    }

    #[test]
    fn format_prompt_operator_message_includes_message_id() {
        let prompt = format_prompt(&InboundEvent::OperatorMessage {
            text: "hello from chat".into(),
            telegram_message_id: 42,
        });
        assert!(prompt.starts_with("[operator] telegram_message_id=42"));
        assert!(prompt.contains("hello from chat"));
    }

    #[test]
    fn iso_now_round_shape() {
        let ts = iso_now();
        // YYYY-MM-DDTHH:MM:SSZ = 20 chars
        assert_eq!(ts.len(), 20, "got {ts}");
        assert!(ts.ends_with('Z'));
    }
}
