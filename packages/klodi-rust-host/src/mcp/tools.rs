//! `tools/list` + `tools/call` dispatcher.
//!
//! Two sources contribute to the published tool list:
//!
//! 1. The 26 NATS request/reply tools from `schemas.json`. Each one is
//!    dispatched through `KlodiClient::request(<subject>, params)`; the
//!    marketplace's reply lands in `CallToolResult::structured`.
//! 2. A small set of local tools (no NATS subject): `klodi_setup_status`,
//!    `klodi_health`, `klodi_channel_message`. They run inside this
//!    process and reach `KlodiClient` directly when needed.
//!
//! The catalog is the single source of truth for both names and JSON
//! Schemas; mismatches between this dispatcher and the catalog (typoed
//! names, missing schemas) surface at startup via [`build_tool_list`].

use super::handler::KlodiMcpHandler;
use super::schemas::catalog;
use crate::setup_status::klodi_setup_status;
use klodi_nats_client::KlodiError;
use klodi_nats_client::catalog::ToolName;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    CallToolResult, Content, JsonObject, ListToolsResult, Tool,
};
use serde_json::{Value, json};
use std::sync::Arc;

const LOCAL_TOOL_HEALTH: &str = "klodi_health";
const LOCAL_TOOL_SETUP_STATUS: &str = "klodi_setup_status";
const LOCAL_TOOL_CHANNEL_MESSAGE: &str = "klodi_channel_message";

/// Build the tool list. Each NATS-passthrough entry pairs the catalog's
/// description + JSON Schema with the catalog-declared subject. Local
/// tools carry hand-written schemas because they have no NATS analogue.
pub(super) fn list_all_tools() -> ListToolsResult {
    ListToolsResult::with_all_items(build_tool_list())
}

fn build_tool_list() -> Vec<Tool> {
    let mut out: Vec<Tool> = Vec::with_capacity(32);
    let cat = catalog();
    for (name, entry) in cat.tools.iter() {
        // Cross-check the public name appears in the strongly-typed
        // ToolName enum. If catalog and enum disagree, codegen is stale.
        if ToolName::from_name(name).is_none() {
            tracing::warn!(
                tool = name.as_str(),
                "schemas.json tool not in ToolName enum — codegen drift, skipping"
            );
            continue;
        }
        out.push(make_tool(name, &entry.description, &entry.params));
    }

    out.push(make_tool(
        LOCAL_TOOL_SETUP_STATUS,
        "Inspect klodi setup state. Reports phase + missing files + user identity \
         (when registered). Used by the agent to decide whether to run klodi_register.",
        &json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    ));
    out.push(make_tool(
        LOCAL_TOOL_HEALTH,
        "Probe klodi connectivity. Round-trips through users.whoami and reports the \
         persistent NATS connection status.",
        &json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    ));
    out.push(make_tool(
        LOCAL_TOOL_CHANNEL_MESSAGE,
        "Publish a message on an open negotiation channel. Direct JetStream publish; \
         the recipient wakes when the message lands in their channels consumer.",
        &json!({
            "type": "object",
            "properties": {
                "channel_id": {
                    "description": "UUID of the open channel",
                    "type": "string",
                    "pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
                },
                "content": {
                    "description": "Message body (1..2000 chars)",
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 2000
                }
            },
            "required": ["channel_id", "content"],
            "additionalProperties": false
        }),
    ));
    out
}

fn make_tool(name: &str, description: &str, schema: &Value) -> Tool {
    let object = match schema {
        Value::Object(map) => map.clone(),
        _ => {
            tracing::warn!(tool = name, "tool schema is not an object — using empty");
            JsonObject::new()
        }
    };
    Tool::new(
        name.to_owned(),
        description.to_owned(),
        Arc::new(object),
    )
}

/// Dispatch a `tools/call` request. Branches on the tool name into
/// either a NATS passthrough or one of the local handlers.
pub(super) async fn dispatch(
    handler: &KlodiMcpHandler,
    name: &str,
    arguments: Option<JsonObject>,
) -> Result<CallToolResult, McpError> {
    let args = arguments.unwrap_or_default();

    if let Some(tool) = ToolName::from_name(name) {
        return dispatch_passthrough(handler, tool, args).await;
    }

    match name {
        LOCAL_TOOL_SETUP_STATUS => dispatch_setup_status(handler).await,
        LOCAL_TOOL_HEALTH => dispatch_health(handler).await,
        LOCAL_TOOL_CHANNEL_MESSAGE => dispatch_channel_message(handler, args).await,
        unknown => Err(McpError::invalid_params(
            format!("unknown klodi tool: {unknown}"),
            Some(json!({ "tool": unknown })),
        )),
    }
}

async fn dispatch_passthrough(
    handler: &KlodiMcpHandler,
    tool: ToolName,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let client = handler.klodi_client().await?;
    let payload = Value::Object(args);
    let result: Value = client
        .request(tool.subject(), &payload, None)
        .await
        .map_err(map_klodi_err)?;
    Ok(structured_with_text(result))
}

async fn dispatch_setup_status(
    handler: &KlodiMcpHandler,
) -> Result<CallToolResult, McpError> {
    let status = klodi_setup_status(handler.klodi_home());
    let body = serde_json::to_value(&status).map_err(|err| {
        McpError::internal_error(
            format!("encoding setup_status: {err}"),
            None,
        )
    })?;
    Ok(structured_with_text(body))
}

async fn dispatch_health(handler: &KlodiMcpHandler) -> Result<CallToolResult, McpError> {
    let started = std::time::Instant::now();
    let probe = match handler.klodi_client().await {
        Ok(client) => match client
            .request::<Value, _>(
                ToolName::KlodiWhoami.subject(),
                &json!({}),
                None,
            )
            .await
        {
            Ok(reply) => json!({
                "ok": true,
                "connected": client.is_connected().await,
                "user_id": reply.get("user_id"),
                "handle": reply.get("handle"),
                "latency_ms": started.elapsed().as_millis() as u64,
            }),
            Err(err) => json!({
                "ok": false,
                "connected": client.is_connected().await,
                "issue": format!("{err}"),
            }),
        },
        Err(err) => json!({
            "ok": false,
            "connected": false,
            "issue": format!("{err:?}"),
        }),
    };
    Ok(structured_with_text(probe))
}

async fn dispatch_channel_message(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let channel_id = args
        .get("channel_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            McpError::invalid_params(
                "klodi_channel_message: channel_id (string) is required".to_owned(),
                None,
            )
        })?;
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            McpError::invalid_params(
                "klodi_channel_message: content (string) is required".to_owned(),
                None,
            )
        })?;

    let client = handler.klodi_client().await?;
    let ack = client
        .publish_channel_message(channel_id, content)
        .await
        .map_err(map_klodi_err)?;
    let body = json!({
        "sequence": ack.sequence,
        "event_id": ack.event_id,
        "message_id": ack.message_id,
        "created_at": ack.created_at,
    });
    Ok(structured_with_text(body))
}

fn structured_with_text(value: Value) -> CallToolResult {
    // MCP clients vary in which content channel they prefer.
    // Setting both a structured body and a text fallback keeps every
    // client useful — agents that look at `structured_content` get the
    // typed tree, agents that only render text get a JSON-formatted
    // line. The two are derived from the same value, so they cannot
    // disagree.
    let text = serde_json::to_string(&value).unwrap_or_else(|_| value.to_string());
    let mut result = CallToolResult::structured(value);
    result.content = vec![Content::text(text)];
    result
}

fn map_klodi_err(err: KlodiError) -> McpError {
    match &err {
        KlodiError::Marketplace { code, message, details } => McpError::invalid_request(
            format!("{code}: {}", if message.is_empty() { code } else { message }),
            Some(json!({
                "error": code,
                "message": message,
                "details": details,
            })),
        ),
        _ => McpError::internal_error(format!("{err}"), None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_tool_list_includes_passthrough_and_local() {
        let tools = build_tool_list();
        let names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
        assert!(names.contains(&"klodi_list_create"));
        assert!(names.contains(&"klodi_offer_create"));
        assert!(names.contains(&"klodi_setup_status"));
        assert!(names.contains(&"klodi_health"));
        assert!(names.contains(&"klodi_channel_message"));
        assert!(
            tools.len() >= 28,
            "expected at least 26 passthrough + 3 local tools — got {}",
            tools.len(),
        );
    }

    #[test]
    fn every_passthrough_tool_carries_an_object_schema() {
        for tool in build_tool_list() {
            let schema_type = tool.input_schema.get("type").and_then(Value::as_str);
            assert_eq!(
                schema_type,
                Some("object"),
                "tool {} must have an object input schema",
                tool.name,
            );
        }
    }
}
