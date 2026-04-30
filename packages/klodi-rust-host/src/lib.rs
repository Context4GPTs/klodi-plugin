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
//!   `klodi_secret_write`.
//! - [`paths`] — cross-platform default `${KLODI_HOME}` resolution.
//! - [`setup_status`] — phase + missing-files + JWT-decoded user-id
//!   reporter for the daemon CLI's `setup-status` subcommand.
//! - [`health`] — minimal `/healthz` HTTP probe served by the forwarder
//!   when `--health-port` is set.
//!
//! Adapter binaries import `klodi_rust_host`'s host-orchestration types
//! directly and pull `KlodiClient` / `KLODI_DEFAULT_API_URL` / event
//! types from `klodi_nats_client` per their existing Cargo deps —
//! re-exporting here would just duplicate the public surface.

pub mod forwarder;
pub mod health;
pub mod paths;
pub mod register;
pub mod setup_status;

pub use forwarder::{ForwarderConfig, run_forwarder};
pub use register::{RegisterArgs, run_register};
pub use setup_status::{SetupPhase, SetupStatus, klodi_setup_status};
