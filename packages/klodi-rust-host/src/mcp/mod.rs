//! Stdio MCP server — exposes klodi's tool catalog and skill bundle to
//! Rust hosts that act as MCP clients (ZeroClaw today; Moltis / IronClaw
//! when their adapter wires it up).
//!
//! Why this lives in `klodi-rust-host` rather than per-adapter: every
//! Rust adapter that boots an in-agent tool surface needs the same
//! catalog + skill plumbing. Per **D § D8** shared host-orchestration
//! glue collapses into this crate.
//!
//! The server speaks MCP JSON-RPC 2.0 over stdin/stdout. ZeroClaw spawns
//! one short-lived subprocess per agent session, lists tools via
//! `tools/list`, calls them via `tools/call`, and reads the embedded
//! skill bundle via `resources/read` (URIs `klodi://skill/<rel-path>`).
//! Each invocation reuses one persistent NATS-WS connection across
//! every passthrough call within the same MCP session.

mod handler;
mod resources;
mod schemas;
mod skill_data;
mod tools;

pub use handler::McpConfig;

use anyhow::{Context, Result};
use rmcp::ServiceExt;
use rmcp::transport::stdio;

/// Run the stdio MCP server until the host closes its end.
///
/// Wires the configured handler onto stdin/stdout and waits for the
/// transport to drain. Returns once the host disconnects. Errors from
/// the underlying tokio runtime / serde decoding propagate up to the
/// caller (the bin's `main`) for tracing-friendly context.
pub async fn run_mcp_server(cfg: McpConfig) -> Result<()> {
    let handler = handler::KlodiMcpHandler::new(cfg);
    let service = handler
        .serve(stdio())
        .await
        .context("starting klodi stdio MCP server")?;
    service
        .waiting()
        .await
        .context("klodi stdio MCP server failed while serving")?;
    Ok(())
}
