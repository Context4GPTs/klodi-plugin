//! `tools/list` + `tools/call` dispatcher.
//!
//! Two sources contribute to the published tool list:
//!
//! 1. The NATS request/reply tools from `schemas.json` (catalog passthrough).
//!    Each one is dispatched through `KlodiClient::request(<subject>, params)`;
//!    the marketplace's reply lands in `CallToolResult::structured`.
//! 2. A set of local tools (no 1:1 NATS subject) that run inside this process:
//!    - `klodi_setup_status` — reads `${KLODI_HOME}/{nats.creds,config.json,policies/}`
//!    - `klodi_setup_reseed_policies` — non-destructive seed of `policies/{negotiation_style,security}.md`
//!    - `klodi_health` — round-trips through `users.whoami`
//!    - `klodi_channel_message` — direct JetStream publish
//!    - `klodi_watch` — composite: `searches.create` (or one-shot `listings.search`) + `${KLODI_HOME}/buy/<slug>.md`
//!    - `klodi_unwatch` — composite: `searches.delete` + delete `${KLODI_HOME}/buy/<slug>.md`
//!
//! Per spec §§ 2/5, registration and repair (`klodi_register`,
//! `klodi_setup_repair`) are NOT MCP tools on the Rust path — they live in
//! the per-host CLI binary (`klodi-<host>-register`). `klodi_setup_status`'s
//! `next_action` field surfaces the binary name to the agent.

use super::handler::KlodiMcpHandler;
use super::schemas::catalog;
use crate::buy_sell_files::{self, ActionOnMatch, BuyFile, slugify};
use crate::policy_seed;
use crate::setup_status::klodi_setup_status_with_register_cli;
use klodi_nats_client::KlodiError;
use klodi_nats_client::catalog::ToolName;
use rmcp::ErrorData as McpError;
use rmcp::model::{
    CallToolResult, Content, JsonObject, ListToolsResult, Tool,
};
use serde_json::{Map, Value, json};
use std::sync::Arc;

const LOCAL_TOOL_HEALTH: &str = "klodi_health";
const LOCAL_TOOL_SETUP_STATUS: &str = "klodi_setup_status";
const LOCAL_TOOL_SETUP_RESEED_POLICIES: &str = "klodi_setup_reseed_policies";
const LOCAL_TOOL_CHANNEL_MESSAGE: &str = "klodi_channel_message";
const LOCAL_TOOL_WATCH: &str = "klodi_watch";
const LOCAL_TOOL_UNWATCH: &str = "klodi_unwatch";

const BUY_FILE_HINT: &str =
    "Append your standing-search strategy (target price, walk-away rules, dialogue digest) \
     to the body below the frontmatter. The agent reads this file before responding to \
     search.match wakes.";

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
        "Inspect klodi setup state. Reports phase (unconfigured | registering | needs_policy | ready), \
         file-presence flags, policy-fill state, and a structured `next_action` describing the single \
         next step (run a CLI binary, call another klodi tool, edit a file, or tighten file perms). \
         Call this at the start of every session and any time a connection or policy issue surfaces.",
        &json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        }),
    ));
    out.push(make_tool(
        LOCAL_TOOL_SETUP_RESEED_POLICIES,
        "Re-seed ${KLODI_HOME}/policies/{negotiation_style,security}.md from the embedded skill \
         bundle, non-destructively. Existing files are preserved verbatim — use this to restore a \
         deleted policy file without touching the user's edits to the others. Returns per-file \
         seed flags: `{ negotiation_style_seeded, security_policy_seeded }`.",
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
    out.push(make_tool(
        LOCAL_TOOL_WATCH,
        "Create a standing (persistent) search OR run a one-shot search. \
         persist=true registers the search server-side AND writes a buy file at \
         ${KLODI_HOME}/buy/<slug>.md (the agent reads this file when search.match wakes \
         arrive). persist=false (default) is a one-shot equivalent of klodi_search. \
         `delivery` is a discriminated union — pickup, ship, digital, or any (default).",
        &json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "Text search" },
                "category": { "type": "string", "description": "Listing category" },
                "max_price": {
                    "type": "integer",
                    "description": "Maximum acceptable asking price, in cents",
                    "minimum": 0
                },
                "delivery": {
                    "type": "object",
                    "description": "Delivery filter — pickup, ship, digital, or any (default)",
                    "additionalProperties": true
                },
                "limit": {
                    "type": "integer",
                    "description": "Result cap for one-shot mode (default 20)",
                    "minimum": 1
                },
                "persist": {
                    "type": "boolean",
                    "description": "true = register server-side standing search; false = one-shot"
                },
                "target_price": {
                    "type": "integer",
                    "description": "Target price in cents — recorded in buy file frontmatter",
                    "minimum": 0
                },
                "action_on_match": {
                    "type": "string",
                    "enum": ["notify", "negotiate"],
                    "description": "What to do on match (default notify)"
                }
            },
            "additionalProperties": false
        }),
    ));
    out.push(make_tool(
        LOCAL_TOOL_UNWATCH,
        "Close out a standing search: deletes the server-side registration AND the \
         ${KLODI_HOME}/buy/<slug>.md file. Irreversible — call klodi_watch persist=true to recreate.",
        &json!({
            "type": "object",
            "properties": {
                "buy_slug": {
                    "type": "string",
                    "description": "Slug of the buy file to remove (e.g. gaming-laptop-abc123)"
                }
            },
            "required": ["buy_slug"],
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

    // Locally-handled tools take priority over passthrough lookup so a
    // catalog rename can't accidentally shadow a local handler.
    match name {
        LOCAL_TOOL_SETUP_STATUS => return dispatch_setup_status(handler).await,
        LOCAL_TOOL_SETUP_RESEED_POLICIES => return dispatch_setup_reseed_policies(handler).await,
        LOCAL_TOOL_HEALTH => return dispatch_health(handler).await,
        LOCAL_TOOL_CHANNEL_MESSAGE => return dispatch_channel_message(handler, args).await,
        LOCAL_TOOL_WATCH => return dispatch_watch(handler, args).await,
        LOCAL_TOOL_UNWATCH => return dispatch_unwatch(handler, args).await,
        _ => {}
    }

    if let Some(tool) = ToolName::from_name(name) {
        return dispatch_passthrough(handler, tool, args).await;
    }

    Err(McpError::invalid_params(
        format!("unknown klodi tool: {name}"),
        Some(json!({ "tool": name })),
    ))
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
    let status =
        klodi_setup_status_with_register_cli(handler.klodi_home(), handler.register_cli());
    let body = serde_json::to_value(&status).map_err(|err| {
        McpError::internal_error(
            format!("encoding setup_status: {err}"),
            None,
        )
    })?;
    Ok(structured_with_text(body))
}

async fn dispatch_setup_reseed_policies(
    handler: &KlodiMcpHandler,
) -> Result<CallToolResult, McpError> {
    let report = policy_seed::seed_policies_if_absent(handler.klodi_home())
        .map_err(|err| McpError::internal_error(format!("reseed_policies: {err}"), None))?;
    let body = serde_json::to_value(&report).map_err(|err| {
        McpError::internal_error(
            format!("encoding seed report: {err}"),
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

async fn dispatch_watch(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let persist = args
        .get("persist")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if persist {
        dispatch_watch_persist(handler, args).await
    } else {
        dispatch_watch_one_shot(handler, args).await
    }
}

async fn dispatch_watch_one_shot(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let payload = Value::Object(compact_search_payload(&args));
    let client = handler.klodi_client().await?;
    let result: Value = client
        .request(ToolName::KlodiSearch.subject(), &payload, None)
        .await
        .map_err(map_klodi_err)?;
    Ok(structured_with_text(result))
}

async fn dispatch_watch_persist(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let query_raw = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let id_suffix: String = uuid::Uuid::new_v4().to_string().chars().take(6).collect();
    let title = if query_raw.is_empty() { "watch" } else { &query_raw };
    let slug = slugify(title, &id_suffix);

    // Catalog payload = strict subset of args plus the chosen slug.
    let mut payload = Map::new();
    payload.insert("slug".to_string(), Value::String(slug.clone()));
    if !query_raw.is_empty() {
        payload.insert("query".to_string(), Value::String(query_raw.clone()));
    }
    if let Some(category) = args.get("category").cloned() {
        payload.insert("category".to_string(), category);
    }
    if let Some(max_price) = args.get("max_price").cloned() {
        payload.insert("max_price".to_string(), max_price);
    }
    let delivery = args
        .get("delivery")
        .cloned()
        .unwrap_or_else(|| json!({ "method": "any" }));
    payload.insert("delivery".to_string(), delivery.clone());

    let client = handler.klodi_client().await?;
    let mut result: Value = client
        .request(
            ToolName::KlodiSearchesCreate.subject(),
            &Value::Object(payload),
            None,
        )
        .await
        .map_err(map_klodi_err)?;

    // Side effect: persist the buy file. Failure here is surfaced as an
    // error so the caller can decide whether to retry — the server-side
    // search is already created at this point, so a failed buy-file
    // write leaves a half-state the agent should reconcile.
    let action_on_match = match args.get("action_on_match").and_then(Value::as_str) {
        Some("negotiate") => ActionOnMatch::Negotiate,
        _ => ActionOnMatch::Notify,
    };
    let buy_dir = handler.klodi_home().join("buy");
    let buy_file_path = buy_dir.join(format!("{slug}.md"));
    let buy_file = BuyFile {
        query: query_raw,
        max_price: args.get("max_price").and_then(Value::as_i64),
        target_price: args.get("target_price").and_then(Value::as_i64),
        delivery,
        action_on_match,
        slug: slug.clone(),
        body: String::new(),
    };
    buy_sell_files::write_buy_file_at(&buy_dir, &buy_file)
        .map_err(|err| McpError::internal_error(format!("writing buy file: {err}"), None))?;

    if let Value::Object(ref mut map) = result {
        map.insert(
            "buy_file".to_string(),
            json!({
                "slug": slug,
                "path": buy_file_path.to_string_lossy(),
                "hint": BUY_FILE_HINT,
            }),
        );
    }
    Ok(structured_with_text(result))
}

async fn dispatch_unwatch(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    let slug = args
        .get("buy_slug")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            McpError::invalid_params(
                "klodi_unwatch: buy_slug (string) is required".to_owned(),
                None,
            )
        })?
        .to_string();

    let client = handler.klodi_client().await?;
    let _: Value = client
        .request(
            ToolName::KlodiSearchesDelete.subject(),
            &json!({ "slug": slug }),
            None,
        )
        .await
        .map_err(map_klodi_err)?;

    let buy_file_path = handler.klodi_home().join("buy").join(format!("{slug}.md"));
    let buy_file_removed = buy_sell_files::delete_buy_file_at(&buy_file_path)
        .map_err(|err| McpError::internal_error(format!("removing buy file: {err}"), None))?;

    Ok(structured_with_text(json!({
        "removed": true,
        "slug": slug,
        "buy_file_removed": buy_file_removed,
    })))
}

/// Strip adapter-internal fields before forwarding a search payload to
/// the marketplace's `listings.search` subject, and drop empty values.
fn compact_search_payload(args: &JsonObject) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in args {
        if matches!(
            key.as_str(),
            "persist" | "action_on_match" | "target_price",
        ) {
            continue;
        }
        if value.is_null() {
            continue;
        }
        if let Value::String(s) = value {
            if s.is_empty() {
                continue;
            }
        }
        out.insert(key.clone(), value.clone());
    }
    out
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
        // Passthrough sample
        assert!(names.contains(&"klodi_list_create"));
        assert!(names.contains(&"klodi_offer_create"));
        // Local tools
        assert!(names.contains(&"klodi_setup_status"));
        assert!(names.contains(&"klodi_setup_reseed_policies"));
        assert!(names.contains(&"klodi_health"));
        assert!(names.contains(&"klodi_channel_message"));
        assert!(names.contains(&"klodi_watch"));
        assert!(names.contains(&"klodi_unwatch"));
        // Tools that intentionally do NOT appear on the Rust MCP surface:
        // klodi_register / klodi_register_poll / klodi_setup_repair /
        // klodi_setup_reseed_skill all live in the per-host CLI binary
        // (klodi-<host>-register) or in the embedded skill bundle, not as
        // agent tools.
        assert!(!names.contains(&"klodi_register"));
        assert!(!names.contains(&"klodi_setup_repair"));
        assert!(
            tools.len() >= 26 + 6,
            "expected at least 26 passthrough + 6 local tools — got {}",
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

    #[test]
    fn watch_compact_payload_drops_adapter_fields() {
        let mut args = JsonObject::new();
        args.insert("query".to_string(), json!("kindle"));
        args.insert("max_price".to_string(), json!(8000));
        args.insert("persist".to_string(), json!(true));
        args.insert("action_on_match".to_string(), json!("notify"));
        args.insert("target_price".to_string(), json!(6000));
        args.insert("empty_string".to_string(), json!(""));
        let compacted = compact_search_payload(&args);
        assert!(compacted.contains_key("query"));
        assert!(compacted.contains_key("max_price"));
        assert!(!compacted.contains_key("persist"));
        assert!(!compacted.contains_key("action_on_match"));
        assert!(!compacted.contains_key("target_price"));
        assert!(!compacted.contains_key("empty_string"));
    }
}
