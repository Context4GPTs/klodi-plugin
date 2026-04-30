//! klodi-nats-client — Rust port of the TS client.
//!
//! One persistent NATS-WS connection per klodi session. Three logical
//! channels of traffic:
//!
//!   - tool calls         (`request` / NATS request-reply)
//!   - notifications      (`subscribe_notifications` / JetStream durable)
//!   - channel streams    (`subscribe_channels` / JetStream durable)
//!   - channel publish    (`publish_channel_message` / direct JetStream)
//!
//! Public surface tracks `klodi-plugin/packages/nats-client-ts/`. The
//! catalog (subject + ToolName) is embedded from the generated
//! `rust-types.rs` artifact at compile time — adapters consume it via
//! `klodi_nats_client::catalog::ToolName`.
//!
//! See `klodi-plugin/docs/plans/0012-nats-native-host-plugins.md` for the
//! authoritative architecture.

pub mod backoff;
pub mod catalog;
pub mod client;
pub mod config;
pub mod consumers;
pub mod error;
pub mod events;
pub mod metrics;
pub mod publish;
pub mod secret_write;
pub mod wake_pump;

pub use backoff::{
    BackoffConfig, DEFAULT_BASE, DEFAULT_CAP, DEFAULT_JITTER_RATIO, DEFAULT_MULTIPLIER,
    compute_backoff, default_reconnect_delay,
};
pub use catalog::{KLODI_DEFAULT_API_URL, KLODI_DEFAULT_NATS_URL, MAX_CHANNEL_MESSAGE_CHARS};
pub use client::{KlodiClient, RequestOptions};
pub use config::{KlodiConfig, load_config, load_creds};
pub use consumers::{ActiveSubscription, ChannelHandler, NotificationHandler};
pub use error::KlodiError;
pub use events::{ChannelMessageEvent, NotificationEvent};
pub use metrics::{ClientMetrics, MetricsRecorder};
pub use publish::PublishAck;
pub use secret_write::{DEFAULT_MODE as SECRET_WRITE_DEFAULT_MODE, klodi_secret_write};
pub use wake_pump::{
    ActiveSubscriptionLike, ChannelHandlerFn, NotifyHandlerFn, WakePump, WakePumpClient,
    WakePumpHealth, __reset_wake_pump_registry_for_tests, create_wake_pump,
};
