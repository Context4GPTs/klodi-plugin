//! Library error type.
//!
//! `KlodiError` covers every recoverable failure the public surface
//! produces: config and creds I/O, transport-level NATS, JSON
//! (de)serialization, JetStream consumer errors, and the marketplace's
//! `{ error, message }` envelope. Callers can match on variants to
//! decide whether to retry or surface to the user.
//!
//! Internally we use `thiserror` for the From-impls and the Display
//! plumbing. Adapter binaries wrap this in `anyhow` for convenience.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum KlodiError {
    #[error("klodi config missing at {0}: run klodi_register first")]
    ConfigNotFound(String),

    #[error("klodi config at {path} is missing/invalid fields: {missing}")]
    ConfigInvalid { path: String, missing: String },

    /// Config-level invariant violated outside the schema check (e.g.
    /// the D10 TLS posture refusing a plaintext non-localhost
    /// `nats_url`). Distinct from `ConfigInvalid` which is per-field.
    #[error("klodi config invalid: {0}")]
    InvalidConfig(String),

    #[error("klodi credentials missing at {0}: run klodi_register first")]
    CredsNotFound(String),

    #[error("klodi credentials read failed at {path}: {source}")]
    CredsRead {
        path: String,
        #[source]
        source: std::io::Error,
    },

    #[error("nats connect failed: {0}")]
    NatsConnect(#[from] async_nats::ConnectError),

    /// The served CA cannot anchor the `tls://` handshake — a deterministic,
    /// terminal CA-trust / TLS-verification failure (wrong-signer,
    /// keyUsage-missing, or unparseable). Surfaced *instead of* async-nats'
    /// `retry_on_initial_connect` retrying the same verify failure forever
    /// (which pins the caller at a "connecting" state). `ca_source`
    /// names the CA origin (`KLODI_NATS_CA_FILE`, the persisted register CA,
    /// or the bundled constant) so the operator knows what to fix;
    /// verification is never disabled to work around it.
    #[error("served NATS CA {ca_source} could not be trusted: {message}")]
    CaTrust { ca_source: String, message: String },

    #[error("nats request failed: {0}")]
    NatsRequest(#[from] async_nats::RequestError),

    #[error("nats publish failed: {0}")]
    NatsPublish(String),

    #[error("jetstream context unavailable: {0}")]
    JetStreamContext(String),

    #[error("jetstream consumer setup failed: {0}")]
    JetStreamConsumer(String),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("json: {0}")]
    Json(#[from] serde_json::Error),

    #[error("marketplace error envelope: code={code} message={message}")]
    Marketplace {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },

    #[error("not connected: call connect() first")]
    NotConnected,

    #[error("invalid channel content: {0}")]
    InvalidContent(&'static str),

    /// A server-managed durable consumer is missing.
    ///
    /// Per **D § D5 + D7** the per-user JWT no longer carries
    /// `CONSUMER.CREATE`; consumers are provisioned server-side at
    /// user registration. If the client subscribes before the
    /// marketplace's provisioning pass has run, this surfaces with a
    /// stable code (`notifications_consumer_missing` /
    /// `channels_consumer_missing`) so the host adapter can map it
    /// to a `klodi_setup_status` issue (`consumer_missing`).
    #[error("klodi setup error: {code} — {message}")]
    Setup { code: &'static str, message: String },
}
