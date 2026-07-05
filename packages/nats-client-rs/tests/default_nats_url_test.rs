//! RED [unit] — `KLODI_DEFAULT_NATS_URL` pinned to the tls:// L4 proxy
//! (rs codegen mirror: `tool-catalog/dist/rust-types.rs`).
//!
//! Card: collapse-nats-transport-guard-to-tls-only.
//!
//! The constant is codegen'd from `tool-catalog/src/index.ts` into the
//! gitignored `rust-types.rs` that `catalog.rs` embeds via `#[path]`. This
//! pins the cutover value `tls://hayabusa.proxy.rlwy.net:32770` (devops §1)
//! and guards against the retired `wss://` edge and pgvector's `kodama`
//! Postgres proxy.
//!
//! NB: this crate only compiles once `pnpm -C packages/tool-catalog codegen`
//! has regenerated `rust-types.rs` (else `E0432`) — run codegen before
//! `cargo test`.
//!
//! QA-owned. NEVER weaken.

const PINNED: &str = "tls://hayabusa.proxy.rlwy.net:32770";

#[test]
fn default_nats_url_is_pinned_tls_endpoint() {
    assert_eq!(klodi_nats_client::KLODI_DEFAULT_NATS_URL, PINNED);
}

#[test]
fn default_nats_url_is_not_legacy_wss_or_kodama() {
    let value = klodi_nats_client::KLODI_DEFAULT_NATS_URL;
    assert!(
        !value.contains("wss://"),
        "must not be the legacy wss:// edge: {value}"
    );
    assert!(
        !value.contains("klodi-net.4gpts.com"),
        "must not be the retired edge host: {value}"
    );
    assert!(
        !value.contains("kodama"),
        "must not be pgvector's kodama Postgres proxy: {value}"
    );
}
