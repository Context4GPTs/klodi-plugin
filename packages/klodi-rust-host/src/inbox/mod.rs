//! Klodi inbox — self-hosted operator UI for `klodi_escalate_to_user`
//! replies.
//!
//! The ZeroClaw dashboard does not surface klodi escalations to an
//! operator's already-open browser tab (see
//! `docs/reports/2026-05-12-zeroclaw-ws-broadcast-topology-and-escalation-surface.md`
//! for the empirical evidence). The inbox is the operator-visibility
//! surface that sits in front of the dedicated klodi session: it polls
//! the gateway's REST history for open escalations, renders them, and
//! threads the operator's reply back into the klodi session via the
//! existing `zeroclaw_ws::send_session_message` path. Nothing about
//! the dedicated session changes — it is still the chronicle of record.
//!
//! Three HTTP routes, all served by the existing pairing-shim listener
//! (`crate::zeroclaw_pairing_shim`):
//!
//! - `GET /inbox/` → the static SPA HTML.
//! - `GET /inbox/api/escalations` → JSON list of open escalations.
//! - `POST /inbox/api/reply` → write the operator's reply into the
//!   klodi session.
//!
//! The plan that motivates this module:
//! `docs/plans/2026-05-12-klodi-inbox-self-hosted-ui.md`.

pub(crate) mod civil;
pub mod filter;
pub mod handlers;
pub mod parser;

pub use filter::{OpenEscalation, open_escalations};
pub use handlers::{
    InboxResponseBody, InboxState, build_escalations_response,
    handle_escalations_request, handle_reply_request, INBOX_HTML,
};
pub use parser::{Escalation, is_plugin_injected, parse_escalation};
