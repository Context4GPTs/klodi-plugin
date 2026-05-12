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
            "klodi marketplace tools (klodi_*). Use these to act on the marketplace \
             (offers, channels, listings, transactions). The spawned wake agent's \
             prompt tells you when to write back to the operator via sessions_send."
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
