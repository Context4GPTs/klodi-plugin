//! klodi-rust-host — host-orchestration glue for the Rust adapters.
//!
//! Per **D § D8** the wire-level NATS client (`klodi-nats-client`) and
//! the host-orchestration glue (this crate) live in separate crates so
//! the bare client stays usable in non-daemon contexts (Rust SDK,
//! cross-language test harness).
//!
//! Public modules:
//!
//! - [`forwarder`] — daemon that subscribes both consumers and hands
//!   each delivered event to a per-adapter callback. SIGTERM-aware,
//!   optional `--health-port` probe.
//! - [`register`] — HTTP-only registration loop. Mints a session UUID,
//!   polls `${api_url}/api/sessions/<id>`, persists creds + config via
//!   `klodi_secret_write`.
//! - [`paths`] — cross-platform default `${KLODI_HOME}` resolution and
//!   sub-path helpers (`buy/`, `sell/`).
//! - [`buy_sell_files`] — frontmatter parse/write for
//!   `${KLODI_HOME}/{buy,sell}/<slug>.md` operator-edited strategy files.
//!   Powers `klodi_watch` / `klodi_unwatch` and listing-lifecycle hooks.
//! - [`setup_status`] — phase + missing-files + structured `next_action`
//!   reporter for the daemon CLI's `setup-status` subcommand and the
//!   in-agent `klodi_setup_status` tool.
//! - [`health`] — minimal `/healthz` HTTP probe served by the forwarder
//!   when `--health-port` is set.
//!
//! ZeroClaw-only surface (under the `zeroclaw` feature):
//!
//! - [`zeroclaw_ws`] — minimal WS client used by `register` to bootstrap
//!   the operator chat session with a single hello line.
//! - [`zeroclaw_session`] — `${KLODI_HOME}/zeroclaw.session` persistence
//!   helpers.
//! - [`zeroclaw_browser_pairing`] — minter that shells out to
//!   `zeroclaw gateway get-paircode --new` so `register` can pair
//!   without operator copy-paste.
//! - [`zeroclaw_chat`] — `/ws/chat` single-flight client. One turn per
//!   event; the daemon waits for `done.full_response` and forwards it
//!   to Telegram.
//! - [`telegram`] — Telegram Bot API client used by the daemon for
//!   outbound `sendMessage` + inbound `getUpdates` polling.
//! - [`telegram_config`] — `${KLODI_HOME}/telegram.json` (bot_token +
//!   chat_id), the offset file, and the last-send sidecar.
//! - [`operator_session`] — per-operator coordinator that fan-ins NATS
//!   wakes + Telegram messages into the single zeroclaw session.
//! - [`wake_prompt`] — pure builder for the canonical wake prompt the
//!   operator session agent reads on every NATS event.

pub mod buy_sell_files;
pub mod forwarder;
pub mod health;
pub mod paths;
pub mod register;
pub mod setup_status;

#[cfg(feature = "mcp")]
pub mod host_mcp_config;
#[cfg(feature = "mcp")]
pub mod mcp;

#[cfg(feature = "zeroclaw")]
pub mod operator_session;
#[cfg(feature = "zeroclaw")]
pub mod telegram;
#[cfg(feature = "zeroclaw")]
pub mod telegram_config;
#[cfg(feature = "zeroclaw")]
pub mod wake_prompt;
#[cfg(feature = "zeroclaw")]
pub mod zeroclaw_browser_pairing;
#[cfg(feature = "zeroclaw")]
pub mod zeroclaw_chat;
#[cfg(feature = "zeroclaw")]
pub mod zeroclaw_session;
#[cfg(feature = "zeroclaw")]
pub mod zeroclaw_ws;

pub use forwarder::{ForwarderConfig, run_forwarder};
pub use register::{RegisterArgs, run_register};
pub use setup_status::{
    IssueSeverity, NextAction, SetupIssue, SetupPhase, SetupStatus, SetupStatusOptions,
    klodi_setup_status, klodi_setup_status_with_options,
    klodi_setup_status_with_register_cli,
};

#[cfg(feature = "mcp")]
pub use host_mcp_config::{HostMcpEntry, apply_host_mcp_entry, default_host_config_path};
#[cfg(feature = "mcp")]
pub use mcp::envelope::not_registered_envelope_json;
#[cfg(feature = "mcp")]
pub use mcp::{McpConfig, run_mcp_server};

#[cfg(feature = "zeroclaw")]
pub use operator_session::{
    DispatchError, InboundEvent, OperatorInbox, OperatorSessionController,
};
#[cfg(feature = "zeroclaw")]
pub use telegram::{
    TelegramBot, TelegramChat, TelegramClient, TelegramError, TelegramMessage, TelegramUpdate,
    TelegramUser,
};
#[cfg(feature = "zeroclaw")]
pub use telegram_config::{
    TelegramConfig, TelegramLastSend, TelegramOffset, config_path as telegram_config_path,
    last_send_path as telegram_last_send_path, offset_path as telegram_offset_path,
    read_config as read_telegram_config, read_last_send as read_telegram_last_send,
    read_offset as read_telegram_offset, write_config as write_telegram_config,
    write_last_send as write_telegram_last_send, write_offset as write_telegram_offset,
};
#[cfg(feature = "zeroclaw")]
pub use wake_prompt::{WakePromptInputs, build_wake_prompt};
#[cfg(feature = "zeroclaw")]
pub use zeroclaw_browser_pairing::{
    BrowserPairConfig, BrowserPairError, MinterImpl, ZeroclawCliMinter,
};
#[cfg(feature = "zeroclaw")]
pub use zeroclaw_chat::{ChatClient, ChatError, TurnOutcome};
#[cfg(feature = "zeroclaw")]
pub use zeroclaw_session::{persist_session_id, read_session_id, session_path};
#[cfg(feature = "zeroclaw")]
pub use zeroclaw_ws::{
    SessionOutcome, ZeroClawWsConfig, bootstrap_session_with_first_message,
    send_session_message,
};
