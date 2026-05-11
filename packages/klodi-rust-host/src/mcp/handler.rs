//! `ServerHandler` for the klodi stdio MCP server.

use super::{resources, tools};
use anyhow::Result;
use klodi_nats_client::KlodiClient;
use rmcp::ErrorData as McpError;
use rmcp::RoleServer;
use rmcp::ServerHandler;
use rmcp::model::{
    CallToolRequestParams, CallToolResult, Implementation, ListResourcesResult,
    ListToolsResult, PaginatedRequestParams, ProtocolVersion, ReadResourceRequestParams,
    ReadResourceResult, ServerCapabilities, ServerInfo,
};
use rmcp::service::RequestContext;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::OnceCell;

/// Per-process configuration. Built by the bin from CLI/env, passed once
/// to [`run_mcp_server`](super::run_mcp_server).
pub struct McpConfig {
    pub creds_path: PathBuf,
    pub config_path: PathBuf,
    pub klodi_home: PathBuf,
    /// Server identity advertised in `initialize` responses.
    pub server_name: String,
    pub server_version: String,
    /// Name of the host-specific register CLI binary (e.g.
    /// `klodi-ironclaw-register`). Substituted into `klodi_setup_status`
    /// `next_action` messages so the agent surfaces the correct command
    /// for the current host. Default: `"klodi-register"`.
    pub register_cli: String,
    /// Dedicated klodi-session binding. Set by the `klodi-zeroclaw-mcp`
    /// binary so the I-4 (`klodi_report_to_operator`) and I-5 (approval
    /// gate) tools can write into the persisted dedicated klodi session.
    /// Daemon-only adapters leave this `None`; in that case the
    /// operator-channel surface is filtered out of the catalog and the
    /// approval gate is a no-op (the host's own approval mechanism is
    /// responsible).
    ///
    /// **Renamed from `operator_channel` in 0.3.0** — the new
    /// `channels` module owns the operator-channel abstraction. This
    /// field now names the specific surface (the dedicated klodi
    /// session) it always was; the multi-surface fan-out happens
    /// through `channel_registry` below.
    #[cfg(feature = "zeroclaw_session")]
    pub klodi_session_target: Option<KlodiSessionTarget>,

    /// Multi-channel registry used by the approval gate +
    /// `klodi_report_to_operator` to fan a single notification across
    /// every operator-visible surface (dashboard + dedicated klodi
    /// session + any upstream-delegated channels) per
    /// `docs/plans/2026-05-10-klodi-zeroclaw-channels-implementation.md`.
    /// `None` for daemon-only adapters; daemons that plug a `Some`
    /// here get full fan-out at the approval-gate path (Phase 5).
    #[cfg(feature = "zeroclaw_session")]
    pub channel_registry: Option<crate::channels::ChannelRegistry>,
}

/// Resolved (`ZeroClawWsConfig`, persisted `session_id`) pair. Built by
/// `klodi-zeroclaw-mcp` from `${KLODI_HOME}/zeroclaw.{token,session}`
/// + the gateway URL on process start. Represents the **dedicated klodi
/// session** — the agent's reasoning surface + chronicle of record.
///
/// **Renamed from `OperatorChannel` in 0.3.0** to reduce confusion with
/// the new `channels::OperatorChannel` trait. The new trait abstracts
/// over every operator-visible surface; this struct only knows about
/// the one dedicated klodi session.
#[cfg(feature = "zeroclaw_session")]
#[derive(Clone)]
pub struct KlodiSessionTarget {
    pub ws_config: crate::zeroclaw_ws::ZeroClawWsConfig,
    pub session_id: String,
}

#[derive(Clone)]
pub(super) struct KlodiMcpHandler {
    inner: Arc<Inner>,
}

struct Inner {
    cfg: McpConfig,
    client: OnceCell<KlodiClient>,
}

impl KlodiMcpHandler {
    pub(super) fn new(cfg: McpConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                cfg,
                client: OnceCell::new(),
            }),
        }
    }

    pub(super) fn klodi_home(&self) -> &Path {
        &self.inner.cfg.klodi_home
    }

    pub(super) fn register_cli(&self) -> &str {
        &self.inner.cfg.register_cli
    }

    /// `Some(target)` iff the binary plugged a dedicated klodi session
    /// in; `None` for daemon-only adapters.
    #[cfg(feature = "zeroclaw_session")]
    pub(super) fn klodi_session_target(&self) -> Option<&KlodiSessionTarget> {
        self.inner.cfg.klodi_session_target.as_ref()
    }

    /// `Some(registry)` iff the binary built a `ChannelRegistry` for
    /// multi-surface fan-out. `None` falls back to the single-target
    /// dedicated-klodi-session path (back-compat for old MCP server
    /// drivers).
    #[cfg(feature = "zeroclaw_session")]
    #[allow(dead_code)] // wired up in Phase 5 (approval-gate re-routing)
    pub(super) fn channel_registry(
        &self,
    ) -> Option<&crate::channels::ChannelRegistry> {
        self.inner.cfg.channel_registry.as_ref()
    }

    /// Lazily open the persistent NATS-WS connection. Subsequent calls
    /// return the same client, so a single MCP session shares one
    /// upstream connection across many tool calls.
    pub(super) async fn klodi_client(&self) -> Result<&KlodiClient, McpError> {
        self.inner
            .client
            .get_or_try_init(|| async {
                let client = KlodiClient::new(
                    &self.inner.cfg.creds_path,
                    &self.inner.cfg.config_path,
                )
                .await
                .map_err(|err| {
                    McpError::internal_error(
                        format!("loading klodi client: {err}"),
                        None,
                    )
                })?;
                client.connect().await.map_err(|err| {
                    McpError::internal_error(
                        format!("connecting to klodi NATS: {err}"),
                        None,
                    )
                })?;
                Ok(client)
            })
            .await
    }
}

impl ServerHandler for KlodiMcpHandler {
    fn get_info(&self) -> ServerInfo {
        let server_info = Implementation::new(
            self.inner.cfg.server_name.clone(),
            self.inner.cfg.server_version.clone(),
        );
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_resources()
                .build(),
        )
        .with_server_info(server_info)
        .with_protocol_version(ProtocolVersion::V_2024_11_05)
        .with_instructions(
            "klodi marketplace tools (klodi_*). Read klodi://skill/SKILL.md before \
             responding to wake events — it documents the negotiation playbook, \
             policy hierarchy, and per-event actions. The skill bundle is exposed \
             as MCP resources under klodi://skill/*."
                .to_string(),
        )
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools::list_all_tools())
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        tools::dispatch(self, &request.name, request.arguments).await
    }

    async fn list_resources(
        &self,
        _request: Option<PaginatedRequestParams>,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ListResourcesResult, McpError> {
        Ok(resources::list_skill_resources())
    }

    async fn read_resource(
        &self,
        request: ReadResourceRequestParams,
        _ctx: RequestContext<RoleServer>,
    ) -> Result<ReadResourceResult, McpError> {
        resources::read_skill_resource(&request.uri)
    }
}
