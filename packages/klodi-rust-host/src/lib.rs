//! klodi-rust-host — host-orchestration glue for the Rust adapters.
//!
//! Per **D § D8** the wire-level NATS client (`klodi-nats-client`) and
//! the host-orchestration glue (this crate) live in separate crates so
//! the bare client stays usable in non-daemon contexts (Rust SDK,
//! cross-language test harness).
//!
//! Public modules:
//!
//! - [`forwarder`] — daemon that subscribes both consumers and POSTs
//!   each delivered event to a local host wake URL. SIGTERM-aware,
//!   bearer-token aware, optional `--health-port` probe.
//! - [`register`] — HTTP-only registration loop. Mints a session UUID,
//!   polls `${api_url}/api/sessions/<id>`, persists creds + config via
//!   `klodi_secret_write`, and seeds `${KLODI_HOME}/policies/` from the
//!   embedded skill bundle.
//! - [`paths`] — cross-platform default `${KLODI_HOME}` resolution and
//!   sub-path helpers (`policies/`, `buy/`, `sell/`).
//! - [`policy_seed`] — non-destructive seeding of
//!   `${KLODI_HOME}/policies/{negotiation_style,security}.md` from the
//!   embedded skill bundle. Driven by registration + the
//!   `klodi_setup_reseed_policies` MCP tool.
//! - [`buy_sell_files`] — frontmatter parse/write for
//!   `${KLODI_HOME}/{buy,sell}/<slug>.md` operator-edited strategy files.
//!   Powers `klodi_watch` / `klodi_unwatch` and listing-lifecycle hooks.
//! - [`setup_status`] — phase + missing-files + policy awareness +
//!   structured `next_action` reporter for the daemon CLI's
//!   `setup-status` subcommand and the in-agent `klodi_setup_status` tool.
//! - [`skill_bundle`] — `include_dir`-embedded canonical skill bundle.
//!   Powers both the MCP `resources/list` surface and policy seeding.
//! - [`health`] — minimal `/healthz` HTTP probe served by the forwarder
//!   when `--health-port` is set.
//!
//! Adapter binaries import `klodi_rust_host`'s host-orchestration types
//! directly and pull `KlodiClient` / `KLODI_DEFAULT_API_URL` / event
//! types from `klodi_nats_client` per their existing Cargo deps —
//! re-exporting here would just duplicate the public surface.

pub mod buy_sell_files;
pub mod forwarder;
pub mod health;
pub mod paths;
pub mod policy_seed;
pub mod register;
pub mod setup_status;
pub mod skill_bundle;

#[cfg(feature = "mcp")]
pub mod host_mcp_config;
#[cfg(feature = "mcp")]
pub mod mcp;

// `zeroclaw_session` feature only — see Cargo.toml. These modules carry
// the I-1/I-2/I-4/I-5/I-7/I-8 changes from the
// 2026-05-10-klodi-zeroclaw-wake-routing-redesign plan: WS client,
// persisted session id, plugin-authored bootstrap note, and the
// approval gate. Other adapters (Moltis, IronClaw) don't enable this
// feature and never compile this code in.
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_approval;
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_bootstrap_note;
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_browser_pairing;
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_pairing_shim;
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_session;
#[cfg(feature = "zeroclaw_session")]
pub mod zeroclaw_ws;

pub use forwarder::{BodyShape, ForwarderConfig, run_forwarder};
pub use register::{RegisterArgs, run_register};
pub use setup_status::{
    IssueSeverity, NextAction, SetupIssue, SetupPhase, SetupStatus, klodi_setup_status,
    klodi_setup_status_with_register_cli,
};

#[cfg(feature = "mcp")]
pub use host_mcp_config::{HostMcpEntry, apply_host_mcp_entry, default_host_config_path};
#[cfg(feature = "mcp")]
pub use mcp::{McpConfig, run_mcp_server};

#[cfg(feature = "zeroclaw_session")]
pub use zeroclaw_browser_pairing::{
    BrowserPairConfig, BrowserPairError, MinterImpl, ZeroclawCliMinter,
};
#[cfg(feature = "zeroclaw_session")]
pub use zeroclaw_pairing_shim::{ShimConfig, ShimHandle};
#[cfg(feature = "zeroclaw_session")]
pub use zeroclaw_session::{
    ResolvedSession, adopt_session_id, resolve_session_id, session_path,
};
#[cfg(feature = "zeroclaw_session")]
pub use zeroclaw_ws::{
    SessionOutcome, ZeroClawWsConfig, bootstrap_session,
    bootstrap_session_with_first_message, send_session_message,
};
