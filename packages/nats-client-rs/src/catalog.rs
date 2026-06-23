//! Tool catalog — re-exports `ToolName` from the generated source.
//!
//! `dist/rust-types.rs` is the single source of truth for tool name +
//! subject mapping; it's regenerated from the TS catalog at
//! `klodi-plugin/packages/tool-catalog/src/index.ts` via
//! `pnpm --filter @klodi/tool-catalog codegen`.
//!
//! Embedding the generated file via `include!` keeps the codegen
//! contract exactly the same as Module C's Python adapters consuming
//! `dist/schemas.json`: any TS catalog change ships once and breaks
//! the build of any Rust adapter whose vendored copy of
//! `rust-types.rs` is stale.

// Loading via `#[path]` (rather than `include!`) makes Rust treat the
// file as a real module: its leading `//!` doc comments become the
// generated module's own header, and the `use serde::…` declaration
// is parsed at module scope as intended. `include!` would inline the
// file at the macro site and reject those inner doc comments.
#[path = "../../tool-catalog/dist/rust-types.rs"]
mod generated;

pub use generated::{
    KLODI_DEFAULT_API_URL, KLODI_DEFAULT_NATS_URL, MAX_CHANNEL_MESSAGE_CHARS,
    REGISTER_POLL_CEILING_SECONDS, REGISTER_POLL_INTERVAL_SECONDS, ToolName,
};

/// Re-export the cross-language logging contract so downstream crates
/// (`klodi-logger`, `klodi-rust-host`) reach it via a single canonical
/// path: `klodi_nats_client::catalog::logging::*`.
pub use generated::logging;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_tool_name_round_trips_through_from_name() {
        let names = [
            ToolName::KlodiWhoami,
            ToolName::KlodiRatings,
            ToolName::KlodiListCreate,
            ToolName::KlodiListUpdate,
            ToolName::KlodiListGet,
            ToolName::KlodiListMine,
            ToolName::KlodiListWithdraw,
            ToolName::KlodiListRelist,
            ToolName::KlodiListComments,
            ToolName::KlodiSearch,
            ToolName::KlodiSearchesCreate,
            ToolName::KlodiSearchesList,
            ToolName::KlodiChannelCreate,
            ToolName::KlodiChannelMine,
            ToolName::KlodiChannelHistory,
            ToolName::KlodiChannelClose,
            ToolName::KlodiComment,
            ToolName::KlodiOfferCreate,
            ToolName::KlodiOfferRespond,
            ToolName::KlodiOfferMine,
            ToolName::KlodiTxConfirm,
            ToolName::KlodiTxCancel,
            ToolName::KlodiTxRate,
            ToolName::KlodiTxStatus,
        ];
        for tool in names {
            let parsed = ToolName::from_name(tool.name())
                .unwrap_or_else(|| panic!("from_name failed for {}", tool.name()));
            assert_eq!(parsed, tool);
            assert!(tool.subject().starts_with("p2p.v1."));
        }
    }

    #[test]
    fn from_name_rejects_unknown() {
        assert!(ToolName::from_name("not_a_klodi_tool").is_none());
    }
}
