//! `tools/list` + `tools/call` dispatcher.
//!
//! Two sources contribute to the published tool list:
//!
//! 1. The NATS request/reply tools from `schemas.json` (catalog passthrough).
//!    Each one is dispatched through `KlodiClient::request(<subject>, params)`;
//!    the marketplace's reply lands in `CallToolResult::structured`.
//! 2. A small set of local tools (no 1:1 NATS subject):
//!    - `klodi_setup_status` — reads `${KLODI_HOME}/{nats.creds,config.json}`
//!    - `klodi_health` — round-trips through `users.whoami`
//!    - `klodi_channel_message` — direct JetStream publish
//!    - `klodi_watch` — composite: `searches.create` (or one-shot `listings.search`) + `${KLODI_HOME}/buy/<slug>.md`
//!    - `klodi_unwatch` — composite: `searches.delete` + delete `${KLODI_HOME}/buy/<slug>.md`
//!
//! The 2026-05-12 wake-agent-spawn redesign deletes
//! `klodi_escalate_to_user` and the irreversible-tool approval gate —
//! the spawned wake agent calls `sessions_send` directly when the
//! operator should see something, and approvals happen in chat (the
//! next wake's agent reads the operator's reply via
//! `sessions_history`).

use super::envelope::{
    envelope_from_klodi_err_with_cli, envelope_to_call_tool_result,
    internal_error_envelope, invalid_request_envelope, upload_failed_envelope,
};
use super::guards::{ArgKind, guard_creds, run_pre_call_guards};
use super::handler::KlodiMcpHandler;
use super::schemas::catalog;
use crate::buy_sell_files::{self, ActionOnMatch, BuyFile, slugify};
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
        "Inspect klodi setup state. Reports phase (unconfigured | registering | ready), \
         file-presence flags, and a structured `next_action` describing the single next \
         step (run a CLI binary, call another klodi tool, edit a file, or tighten file \
         perms). Call this at the start of every session and any time a connection issue \
         surfaces.",
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
///
/// Every state-mutating arm runs the pre-call guard chain (R4 — guards
/// fail before any I/O) BEFORE opening the NATS connection or touching
/// the filesystem. The two diagnostic tools (`klodi_setup_status`,
/// `klodi_health`) are exempt per R5 — they are the *target* of recovery
/// hints and must always return their diagnostic payload, even when the
/// adapter is degraded. See ADR-0011.
pub(super) async fn dispatch(
    handler: &KlodiMcpHandler,
    name: &str,
    arguments: Option<JsonObject>,
) -> Result<CallToolResult, McpError> {
    let args = arguments.unwrap_or_default();

    match name {
        // R5 exemption — diagnostic targets of recovery hints. Never
        // gated, never enveloped.
        LOCAL_TOOL_SETUP_STATUS => return dispatch_setup_status(handler).await,
        LOCAL_TOOL_HEALTH => return dispatch_health(handler).await,
        LOCAL_TOOL_CHANNEL_MESSAGE => return dispatch_channel_message(handler, args).await,
        LOCAL_TOOL_WATCH => return dispatch_watch(handler, args).await,
        LOCAL_TOOL_UNWATCH => return dispatch_unwatch(handler, args).await,
        _ => {}
    }

    if let Some(tool) = ToolName::from_name(name) {
        return dispatch_passthrough(handler, tool, args).await;
    }

    Ok(envelope_to_call_tool_result(invalid_request_envelope(
        "tool",
        "wrong_type",
    )))
}

async fn dispatch_passthrough(
    handler: &KlodiMcpHandler,
    tool: ToolName,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    // R4 — creds guard runs BEFORE klodi_client() opens the WS
    // connection (and before the photo-resolution mint call below). A
    // failed guard returns the envelope without any I/O.
    if let Some(env) = guard_creds(handler.klodi_home(), handler.register_cli()) {
        return Ok(envelope_to_call_tool_result(env));
    }
    let client = match handler.klodi_client().await {
        Ok(c) => c,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
    // For photos-aware listing tools, run params.photos through the
    // adapter-internal validate / sniff / mint / PUT pipeline before the
    // listing request is dispatched. The pipeline rewrites every local
    // path into a durable asset_url, preserving index order; URL-only
    // inputs pass through unchanged. A resolution failure surfaces as the
    // canonical `upload_failed` envelope (R2) — not an McpError — so the
    // agent sees the same vocabulary as every other failure path. See
    // ADR-0006 + ADR-0011.
    let args = if matches!(tool, ToolName::KlodiListCreate | ToolName::KlodiListUpdate) {
        match super::photos::apply_photos(client, tool.name(), args).await {
            Ok(resolved) => resolved,
            Err(err) => {
                return Ok(envelope_to_call_tool_result(upload_failed_envelope(
                    &err.stage,
                    &err.message,
                    err.path.as_deref(),
                )));
            }
        }
    } else {
        args
    };
    let payload = Value::Object(args);
    match client.request::<Value, _>(tool.subject(), &payload, None).await {
        Ok(result) => Ok(structured_with_text(result)),
        Err(err) => Ok(envelope_for(handler, err)),
    }
}

async fn dispatch_setup_status(
    handler: &KlodiMcpHandler,
) -> Result<CallToolResult, McpError> {
    let status =
        klodi_setup_status_with_register_cli(handler.klodi_home(), handler.register_cli());
    // R5 — setup_status is the *target* of recovery hints; it must
    // never return the failure envelope on its own. The serde encode
    // here is effectively infallible (Status is plain serde), but
    // collapse on failure so the response remains JSON-RPC-shaped
    // rather than triggering an MCP-level error. The agent reading the
    // recovery hint then re-calls setup_status; the second call
    // succeeds (the encode failure was transient).
    let body = match serde_json::to_value(&status) {
        Ok(v) => v,
        Err(err) => {
            return Ok(envelope_to_call_tool_result(internal_error_envelope(
                &format!("encoding setup_status: {err}"),
                "serde_json::Error",
            )));
        }
    };
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
    // R4 — creds + args guards fail BEFORE any I/O. Same envelope shape
    // hermes / nanobot emit for the same failure modes (R1 parity).
    if let Some(env) = run_pre_call_guards(
        handler.klodi_home(),
        handler.register_cli(),
        &args,
        &[
            ("channel_id", ArgKind::Uuid),
            ("content", ArgKind::NonEmptyString),
        ],
    ) {
        return Ok(envelope_to_call_tool_result(env));
    }
    let channel_id = args
        .get("channel_id")
        .and_then(Value::as_str)
        .expect("guard_args proved channel_id is a non-empty UUID string");
    let content = args
        .get("content")
        .and_then(Value::as_str)
        .expect("guard_args proved content is a non-empty string");

    let client = match handler.klodi_client().await {
        Ok(c) => c,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
    let ack = match client.publish_channel_message(channel_id, content).await {
        Ok(a) => a,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
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
    // R4 — creds guard fails BEFORE any I/O.
    if let Some(env) = guard_creds(handler.klodi_home(), handler.register_cli()) {
        return Ok(envelope_to_call_tool_result(env));
    }
    let payload = Value::Object(compact_search_payload(&args));
    let client = match handler.klodi_client().await {
        Ok(c) => c,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
    match client
        .request::<Value, _>(ToolName::KlodiSearch.subject(), &payload, None)
        .await
    {
        Ok(result) => Ok(structured_with_text(result)),
        Err(err) => Ok(envelope_for(handler, err)),
    }
}

async fn dispatch_watch_persist(
    handler: &KlodiMcpHandler,
    args: JsonObject,
) -> Result<CallToolResult, McpError> {
    // R4 — creds guard fails BEFORE any I/O. The watch persist path
    // writes a buy file under ${KLODI_HOME}; without creds we never
    // reach that filesystem side-effect.
    if let Some(env) = guard_creds(handler.klodi_home(), handler.register_cli()) {
        return Ok(envelope_to_call_tool_result(env));
    }
    let query_raw = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let id_suffix: String = uuid::Uuid::new_v4().to_string().chars().take(6).collect();
    let title = if query_raw.is_empty() { "watch" } else { &query_raw };
    let slug = slugify(title, &id_suffix);

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

    let client = match handler.klodi_client().await {
        Ok(c) => c,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
    let mut result: Value = match client
        .request::<Value, _>(
            ToolName::KlodiSearchesCreate.subject(),
            &Value::Object(payload),
            None,
        )
        .await
    {
        Ok(v) => v,
        Err(err) => return Ok(envelope_for(handler, err)),
    };

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
    // R1 envelope parity — the filesystem write is the last side-effect
    // of klodi_watch persist. Failures collapse to `internal_error`
    // (catalog R2) with the exception class in `details` so operators
    // can triage; the agent retries once or surfaces.
    if let Err(err) = buy_sell_files::write_buy_file_at(&buy_dir, &buy_file) {
        return Ok(envelope_to_call_tool_result(internal_error_envelope(
            &format!("writing buy file: {err}"),
            "buy_sell_files::write_buy_file_at",
        )));
    }

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
    // R4 — creds + args guards fail BEFORE any I/O. Same shape hermes /
    // nanobot emit for the same failure modes.
    if let Some(env) = run_pre_call_guards(
        handler.klodi_home(),
        handler.register_cli(),
        &args,
        &[("buy_slug", ArgKind::NonEmptyString)],
    ) {
        return Ok(envelope_to_call_tool_result(env));
    }
    let slug = args
        .get("buy_slug")
        .and_then(Value::as_str)
        .expect("guard_args proved buy_slug is a non-empty string")
        .to_string();

    let client = match handler.klodi_client().await {
        Ok(c) => c,
        Err(err) => return Ok(envelope_for(handler, err)),
    };
    if let Err(err) = client
        .request::<Value, _>(
            ToolName::KlodiSearchesDelete.subject(),
            &json!({ "slug": slug }),
            None,
        )
        .await
    {
        return Ok(envelope_for(handler, err));
    }

    let buy_file_path = handler.klodi_home().join("buy").join(format!("{slug}.md"));
    let buy_file_removed = match buy_sell_files::delete_buy_file_at(&buy_file_path) {
        Ok(b) => b,
        Err(err) => {
            return Ok(envelope_to_call_tool_result(internal_error_envelope(
                &format!("removing buy file: {err}"),
                "buy_sell_files::delete_buy_file_at",
            )));
        }
    };

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
    let text = serde_json::to_string(&value).unwrap_or_else(|_| value.to_string());
    let mut result = CallToolResult::structured(value);
    result.content = vec![Content::text(text)];
    result
}

/// Build the cross-language envelope `CallToolResult` from any
/// `KlodiError`. The handler's per-bin `register_cli` is substituted
/// into the `not_registered` recovery hint so the agent surfaces the
/// literal command the operator runs (R8). See ADR-0011.
fn envelope_for(handler: &KlodiMcpHandler, err: KlodiError) -> CallToolResult {
    let env = envelope_from_klodi_err_with_cli(err, handler.register_cli());
    envelope_to_call_tool_result(env)
}

// `invalid_request_envelope` + `internal_error_envelope` live in
// `super::envelope` so the cross-language drift gate
// (`packages/tool-catalog/tests/error-codes-cross-language.test.ts`)
// finds the literal `error: "<code>"` patterns at a single canonical
// emission site. The dispatcher imports them above.

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
        assert!(names.contains(&"klodi_watch"));
        assert!(names.contains(&"klodi_unwatch"));
        // Cuts per 2026-05-12 wake-agent-spawn redesign — these must
        // NOT appear in the catalog. The spawned wake agent uses
        // `sessions_send` (ZeroClaw-supplied) instead.
        assert!(!names.contains(&"klodi_escalate_to_user"));
        assert!(!names.contains(&"klodi_report_to_operator"));
        assert!(!names.contains(&"klodi_setup_reseed_policies"));
        // Register-only tools never appear on the agent's MCP surface.
        assert!(!names.contains(&"klodi_register"));
        assert!(!names.contains(&"klodi_setup_repair"));
        // Per card fold-uploads-into-listing-tools: the standalone
        // klodi_assets_upload_url tool is gone from every adapter's
        // MCP surface. klodi_list_create / klodi_list_update accept
        // local paths directly and handle the mint+PUT internally.
        assert!(!names.contains(&"klodi_assets_upload_url"));
    }

    #[test]
    fn klodi_assets_upload_url_is_not_a_known_tool_name() {
        // ToolName is generated from the canonical TS catalog; once
        // the entry is gone there, the enum no longer carries
        // KlodiAssetsUploadUrl and the round-trip from_name(...) for
        // the old string must return None.
        assert!(
            ToolName::from_name("klodi_assets_upload_url").is_none(),
            "klodi_assets_upload_url must be gone from the generated \
             ToolName enum after the catalog deletion + codegen step",
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

/// ## Round 2 RED — dispatcher-path envelope parity (qa-developer)
///
/// CQG Review round 1 found that the lib layer (envelope.rs + guards.rs)
/// is well-built but production dispatch paths in `tools.rs` do NOT
/// route through them. Specifically:
///
/// - **P1.1** — four sites still return `Err(McpError::invalid_params)` /
///   `McpError::internal_error` instead of `Ok(envelope_to_call_tool_result(...))`.
///   `klodi_channel_message`, `klodi_unwatch`, `klodi_watch` (persist
///   filesystem) leak rmcp errors; the agent sees an MCP JSON-RPC error
///   response with no `details.field`, no `recovery_hint`.
///
/// - **P1.2** — the `guards::*` chain is dead code: grep across `tools.rs`
///   for `guards::` returns zero callers. Architect R4 ("guards fail
///   before any I/O") is structurally unreachable; the dispatcher opens
///   `klodi_client()` BEFORE any creds check, so creds-missing on an
///   irreversible-tool call surfaces as the lazy-init failure, not a
///   `not_registered` guard rejection.
///
/// These tests pin the contract at the dispatcher seam. Each test drives
/// `tools::dispatch(...)` end-to-end with a `KlodiMcpHandler` configured
/// to the failure mode and asserts the returned `CallToolResult` carries
/// the canonical four-key envelope.
///
/// **Why they fail today**:
///   - Channel/unwatch/watch sites: dispatcher `?`-propagates `McpError`
///     → tests see `Err(...)` instead of `Ok(CallToolResult{structured:
///     {error: "invalid_request", ...}})`.
///   - Creds-missing on a guarded tool: dispatcher races to
///     `klodi_client()` and KlodiClient::new fails on the file load,
///     producing a `connection_not_ready`-shape envelope via
///     `envelope_for` instead of the architect's `not_registered` +
///     CLI recovery hint expected by R4 + R8.
///
/// **NEVER weaken these asserts to compile/pass**. The expert wires the
/// guard chain into dispatch and converts the `McpError` arms to
/// envelope `Ok(...)` so the asserts hold. See the card's Review round 1
/// FAIL handoff for the prioritised fix list.
#[cfg(test)]
mod dispatch_tests {
    use super::*;
    use crate::mcp::handler::{KlodiMcpHandler, McpConfig};
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Build a handler whose `klodi_home` contains BOTH nats.creds and
    /// config.json (so the creds guard passes) but whose paths point at
    /// non-existent locations (so any actual NATS dial would fail).
    ///
    /// Use this for tests that exercise pure arg-validation paths in
    /// local tools — guards should reject on arg-shape BEFORE attempting
    /// to dial NATS, so the test never needs a real (or even fake)
    /// connection.
    fn handler_with_valid_creds(register_cli: &str) -> (KlodiMcpHandler, TempDir) {
        let dir = tempfile::tempdir().expect("tempdir for klodi_home");
        let home: PathBuf = dir.path().to_path_buf();
        let creds = home.join("nats.creds");
        let config = home.join("config.json");
        std::fs::write(&creds, "fake-creds").unwrap();
        std::fs::write(
            &config,
            r#"{"handle":"t","user_id":"u","nkey_public":"K","nats_url":"wss://test:1"}"#,
        )
        .unwrap();
        let cfg = McpConfig {
            creds_path: creds,
            config_path: config,
            klodi_home: home,
            server_name: "test".to_string(),
            server_version: "0".to_string(),
            register_cli: register_cli.to_string(),
        };
        (KlodiMcpHandler::new(cfg), dir)
    }

    /// Build a handler whose `klodi_home` is EMPTY (no nats.creds,
    /// no config.json). The creds guard MUST fire on any guarded tool
    /// invocation, returning `not_registered` BEFORE any client is
    /// initialised. R4 + R8.
    fn handler_without_creds(register_cli: &str) -> (KlodiMcpHandler, TempDir) {
        let dir = tempfile::tempdir().expect("tempdir for klodi_home");
        let home: PathBuf = dir.path().to_path_buf();
        let cfg = McpConfig {
            // creds_path / config_path point at locations that DO NOT
            // exist; if the dispatcher attempts klodi_client() it will
            // fail. The test asserts the guard short-circuits BEFORE
            // that attempt — i.e. the envelope is `not_registered`, not
            // `connection_not_ready` or `internal_error`.
            creds_path: home.join("nats.creds"),
            config_path: home.join("config.json"),
            klodi_home: home,
            server_name: "test".to_string(),
            server_version: "0".to_string(),
            register_cli: register_cli.to_string(),
        };
        (KlodiMcpHandler::new(cfg), dir)
    }

    /// Extract the structured envelope JSON from a `CallToolResult`.
    /// Panics if the result is not the four-key shape (R1).
    fn envelope_from_result(result: &CallToolResult) -> Value {
        let structured = result
            .structured_content
            .as_ref()
            .expect("CallToolResult must carry structured envelope (R1)");
        let obj = structured
            .as_object()
            .expect("envelope must be a JSON object");
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["details", "error", "message", "recovery_hint"],
            "envelope must carry exactly the four R1 keys",
        );
        structured.clone()
    }

    // ── P1.1 — local-tool args validation must return envelope, not McpError ──

    /// dispatch_channel_message with NO channel_id today returns
    /// `Err(McpError::invalid_params(...))` — hermes / nanobot return
    /// the four-key `invalid_request` envelope for the same input.
    /// Parity is broken on the Rust trio. Fix: convert the `?` site at
    /// tools.rs:~290 to `Ok(envelope_to_call_tool_result(make_envelope(...)))`
    /// driven through `guards::guard_args`.
    #[tokio::test]
    async fn channel_message_missing_channel_id_returns_invalid_request_envelope() {
        let (handler, _dir) = handler_with_valid_creds("klodi-zeroclaw-register");
        let mut args = JsonObject::new();
        args.insert("content".to_string(), json!("hello"));
        let result = dispatch(&handler, LOCAL_TOOL_CHANNEL_MESSAGE, Some(args))
            .await
            .expect("local-tool validation MUST return Ok(envelope), not McpError");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "invalid_request");
        assert_eq!(env["details"]["field"], "channel_id");
        assert_eq!(env["details"]["problem"], "missing");
        assert!(env["recovery_hint"].is_null(), "invalid_request carries no recovery_hint");
    }

    /// dispatch_channel_message with NO content. Today: `Err(McpError)`.
    /// Required: `Ok(envelope{error: "invalid_request", details: {field:
    /// "content", problem: "missing"}})`.
    #[tokio::test]
    async fn channel_message_missing_content_returns_invalid_request_envelope() {
        let (handler, _dir) = handler_with_valid_creds("klodi-zeroclaw-register");
        let mut args = JsonObject::new();
        args.insert(
            "channel_id".to_string(),
            json!("550e8400-e29b-41d4-a716-446655440000"),
        );
        let result = dispatch(&handler, LOCAL_TOOL_CHANNEL_MESSAGE, Some(args))
            .await
            .expect("Ok(envelope) for missing content");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "invalid_request");
        assert_eq!(env["details"]["field"], "content");
        assert_eq!(env["details"]["problem"], "missing");
    }

    /// dispatch_channel_message with EMPTY content. R2 specifies
    /// `problem: "empty"` (distinct from "missing"); hermes / nanobot
    /// produce this. Today the Rust dispatcher treats empty-string as
    /// "no string at all" — same `Err(McpError)`.
    ///
    /// Acceptance criterion (card body):
    ///   > Given `klodi_channel_message` is invoked with an empty
    ///   > `content`, when the adapter responds, then the envelope is
    ///   > `{error: "invalid_request", message: "content must be a
    ///   > non-empty string", details: {field: "content", problem:
    ///   > "empty"}, recovery_hint: null}`. Identical across hermes,
    ///   > nanobot, and the rust-host's `dispatch_channel_message`.
    #[tokio::test]
    async fn channel_message_empty_content_returns_invalid_request_envelope() {
        let (handler, _dir) = handler_with_valid_creds("klodi-zeroclaw-register");
        let mut args = JsonObject::new();
        args.insert(
            "channel_id".to_string(),
            json!("550e8400-e29b-41d4-a716-446655440000"),
        );
        args.insert("content".to_string(), json!(""));
        let result = dispatch(&handler, LOCAL_TOOL_CHANNEL_MESSAGE, Some(args))
            .await
            .expect("Ok(envelope) for empty content");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "invalid_request");
        assert_eq!(env["details"]["field"], "content");
        assert_eq!(env["details"]["problem"], "empty");
    }

    /// dispatch_unwatch with NO buy_slug. Today: `Err(McpError::invalid_params)`.
    /// Required: `Ok(envelope{error: "invalid_request", details: {field:
    /// "buy_slug", problem: "missing"}})`.
    #[tokio::test]
    async fn unwatch_missing_buy_slug_returns_invalid_request_envelope() {
        let (handler, _dir) = handler_with_valid_creds("klodi-zeroclaw-register");
        let args = JsonObject::new();
        let result = dispatch(&handler, LOCAL_TOOL_UNWATCH, Some(args))
            .await
            .expect("Ok(envelope) for missing buy_slug");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "invalid_request");
        assert_eq!(env["details"]["field"], "buy_slug");
        assert_eq!(env["details"]["problem"], "missing");
    }

    // ── P1.2 — guards must run BEFORE any I/O ─────────────────────────────

    /// Channel-message dispatched without creds. R4 says the creds guard
    /// MUST short-circuit BEFORE the dispatcher dials NATS, so the agent
    /// sees `not_registered` with the per-host CLI recovery hint, NOT
    /// `connection_not_ready` (the symptom of letting the client init
    /// fail) or `internal_error` (catch-all).
    ///
    /// Today's code path: dispatcher calls `handler.klodi_client()` —
    /// which tries to read nats.creds, fails with `KlodiError::CredsNotFound`,
    /// flows through `envelope_for` → `envelope_from_klodi_err_with_cli`.
    /// That MIGHT produce `not_registered` (the envelope helper handles
    /// `CredsNotFound`) — but the dispatcher races validation against
    /// client init, and the lib-vs-dispatch wiring is implicit. This
    /// test pins the explicit contract: the GUARD fires, not the client.
    ///
    /// The expert wires `guards::guard_creds(handler.klodi_home(),
    /// handler.register_cli())` at the top of `dispatch_channel_message`
    /// (and the other state-mutating arms). R8 — the recovery_hint
    /// carries the per-host CLI verbatim.
    #[tokio::test]
    async fn channel_message_without_creds_returns_not_registered_via_guard() {
        let (handler, _dir) = handler_without_creds("klodi-moltis-register");
        let mut args = JsonObject::new();
        args.insert(
            "channel_id".to_string(),
            json!("550e8400-e29b-41d4-a716-446655440000"),
        );
        args.insert("content".to_string(), json!("hi"));
        let result = dispatch(&handler, LOCAL_TOOL_CHANNEL_MESSAGE, Some(args))
            .await
            .expect("Ok(envelope) for missing creds");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "not_registered");
        // R8 — per-host CLI is substituted, not the catalog default.
        assert_eq!(env["recovery_hint"]["kind"], "cli");
        assert_eq!(env["recovery_hint"]["command"], "klodi-moltis-register");
    }

    /// Unwatch dispatched without creds. Same R4 + R8 contract as
    /// channel_message.
    #[tokio::test]
    async fn unwatch_without_creds_returns_not_registered_via_guard() {
        let (handler, _dir) = handler_without_creds("klodi-ironclaw-register");
        let mut args = JsonObject::new();
        args.insert("buy_slug".to_string(), json!("some-slug-abc123"));
        let result = dispatch(&handler, LOCAL_TOOL_UNWATCH, Some(args))
            .await
            .expect("Ok(envelope) for missing creds");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "not_registered");
        assert_eq!(env["recovery_hint"]["kind"], "cli");
        assert_eq!(env["recovery_hint"]["command"], "klodi-ironclaw-register");
    }

    /// Passthrough tool (klodi_whoami — pure read) dispatched without
    /// creds. R6 says read-only tools also run the creds + connection
    /// guards. The agent must see `not_registered`, NOT `internal_error`
    /// (today's failure mode when the underlying client init throws an
    /// uncategorised error).
    #[tokio::test]
    async fn passthrough_without_creds_returns_not_registered_via_guard() {
        let (handler, _dir) = handler_without_creds("klodi-zeroclaw-register");
        let result = dispatch(&handler, "klodi_whoami", Some(JsonObject::new()))
            .await
            .expect("Ok(envelope) for missing creds on passthrough");
        let env = envelope_from_result(&result);
        assert_eq!(env["error"], "not_registered");
        assert_eq!(env["recovery_hint"]["kind"], "cli");
        assert_eq!(env["recovery_hint"]["command"], "klodi-zeroclaw-register");
    }

    /// State-mutating passthrough (klodi_tx_confirm) dispatched without
    /// creds and with a malformed transaction_id. R4 guard ordering:
    /// creds-first. The agent sees `not_registered`, NOT `invalid_request`,
    /// even though the args are also bad.
    #[tokio::test]
    async fn passthrough_creds_guard_fires_before_args_guard() {
        let (handler, _dir) = handler_without_creds("klodi-zeroclaw-register");
        let mut args = JsonObject::new();
        // Bad UUID + missing creds — creds guard MUST fire first per R4.
        args.insert("transaction_id".to_string(), json!("not-a-uuid"));
        let result = dispatch(&handler, "klodi_tx_confirm", Some(args))
            .await
            .expect("Ok(envelope) for missing creds on tx_confirm");
        let env = envelope_from_result(&result);
        assert_eq!(
            env["error"], "not_registered",
            "R4 creds guard MUST fire before args guard"
        );
    }

    /// Base-drift reconciliation (round 3): the photos-folded list tools
    /// (`klodi_list_create` / `klodi_list_update`) run the photo-resolution
    /// pipeline — whose mint step is NATS I/O — only AFTER the R4 creds
    /// guard. This pins that ordering for a LIST tool: a local-path photo
    /// supplied without creds MUST yield `not_registered`, NOT a photo
    /// `upload_failed` / `connection_not_ready` — proving the guard fires
    /// before `apply_photos` dials anything. Parity with openclaw / hermes /
    /// nanobot, which assert the same creds-before-photo ordering at their
    /// dispatch level. The `upload_failed` envelope shape itself is pinned
    /// by `mcp::photos::tests::upload_failed_envelope_*` (the dispatcher
    /// cannot reach `apply_photos` here without a live NATS connection, so
    /// the envelope-shape assertion correctly lives at the helper tier).
    /// See ADR-0011 R4 + ADR-0006.
    #[tokio::test]
    async fn list_create_without_creds_returns_not_registered_before_photo_mint() {
        let (handler, _dir) = handler_without_creds("klodi-zeroclaw-register");
        let mut args = JsonObject::new();
        args.insert("title".to_string(), json!("Vintage lamp"));
        args.insert("description".to_string(), json!("x"));
        args.insert("category".to_string(), json!("home"));
        args.insert("asking_price".to_string(), json!(100));
        // A local absolute path — if the creds guard did NOT fire first,
        // apply_photos would attempt to read/mint it (NATS I/O). The guard
        // MUST short-circuit before any of that.
        args.insert("photos".to_string(), json!(["/tmp/some-photo.jpg"]));
        let result = dispatch(&handler, "klodi_list_create", Some(args))
            .await
            .expect("Ok(envelope) for missing creds on klodi_list_create");
        let env = envelope_from_result(&result);
        assert_eq!(
            env["error"], "not_registered",
            "R4 creds guard MUST fire before the photo-resolution mint"
        );
        assert_eq!(env["recovery_hint"]["kind"], "cli");
        assert_eq!(env["recovery_hint"]["command"], "klodi-zeroclaw-register");
    }

    // ── P1.1 — filesystem failure paths must convert to envelope ──────────

    /// dispatch_watch_persist with creds present but `${klodi_home}/buy`
    /// path made un-writable (a file exists where the buy directory
    /// should be). Today: `Err(McpError::internal_error(...))` at line
    /// 419. Required: `Ok(envelope{error: "internal_error", details:
    /// {exception_class: ...}})`.
    ///
    /// Note: this test cannot run the full happy path (which would dial
    /// NATS). It exercises the search-create call path, which fails
    /// because the lazy NATS init fails on the test creds. The contract
    /// pinned here is: WHATEVER goes wrong inside the dispatcher, the
    /// agent sees an `Ok(envelope)` shape — never an `Err(McpError)`.
    /// (Earlier `?` propagations on the FS write site are the easiest
    /// to convert; the test verifies the envelope shape, not the exact
    /// failure mode.)
    #[tokio::test]
    async fn watch_persist_failure_returns_envelope_not_mcp_error() {
        // Build a handler where klodi_home is a file (not a directory)
        // — the search-create call goes first, fails, falls through to
        // `envelope_for` which returns Ok(...). But we also want the
        // explicit test that if the FS step were reached and failed, it
        // would not bubble up as McpError. We force the FS failure
        // surface by making the buy dir a regular file.
        let outer = tempfile::tempdir().expect("tempdir");
        let home = outer.path().to_path_buf();
        let creds = home.join("nats.creds");
        let config = home.join("config.json");
        std::fs::write(&creds, "fake").unwrap();
        std::fs::write(
            &config,
            r#"{"handle":"t","user_id":"u","nkey_public":"K","nats_url":"wss://test:1"}"#,
        )
        .unwrap();
        // Create a file at <home>/buy so write_buy_file_at fails when
        // the dispatcher tries to mkdir.
        std::fs::write(home.join("buy"), "blocker").unwrap();
        let cfg = McpConfig {
            creds_path: creds,
            config_path: config,
            klodi_home: home,
            server_name: "test".to_string(),
            server_version: "0".to_string(),
            register_cli: "klodi-zeroclaw-register".to_string(),
        };
        let handler = KlodiMcpHandler::new(cfg);

        let mut args = JsonObject::new();
        args.insert("query".to_string(), json!("watch this"));
        args.insert("persist".to_string(), json!(true));

        // The dispatcher MUST return Ok(envelope) — even on a filesystem
        // failure. The legacy McpError::internal_error site at
        // tools.rs:~419 must be converted.
        let result = dispatch(&handler, LOCAL_TOOL_WATCH, Some(args)).await;
        let call_result = result.expect(
            "watch_persist failures (including FS) must return Ok(envelope), not Err(McpError)",
        );
        let env = envelope_from_result(&call_result);
        // Whether the failure is in search-create (NATS init) or FS,
        // the agent gets a four-key envelope. R1 holds.
        assert!(env["error"].is_string(), "envelope.error is a string");
    }

    // ── R5 exemption — diagnostic tools never return the failure envelope ─

    /// klodi_setup_status MUST always return its diagnostic payload,
    /// even when the adapter is degraded (no creds, no connection). R5.
    #[tokio::test]
    async fn setup_status_is_exempt_from_envelope_failure_path() {
        let (handler, _dir) = handler_without_creds("klodi-zeroclaw-register");
        let result = dispatch(&handler, LOCAL_TOOL_SETUP_STATUS, None)
            .await
            .expect("setup_status returns Ok regardless of state");
        // setup_status's structured payload is the Status struct, NOT
        // a failure envelope. Specifically: it MUST NOT have an `error`
        // key (envelopes always have one); it has `phase`, `next_action`.
        let structured = result
            .structured_content
            .as_ref()
            .expect("setup_status returns structured content");
        let obj = structured.as_object().expect("object");
        // Diagnostic payloads never carry the envelope `error` key.
        assert!(
            !obj.contains_key("error") || obj.contains_key("phase"),
            "setup_status returns its diagnostic payload, never the failure envelope. R5."
        );
    }

    /// klodi_health MUST always return its diagnostic payload, even
    /// when the adapter is degraded.
    #[tokio::test]
    async fn health_is_exempt_from_envelope_failure_path() {
        let (handler, _dir) = handler_without_creds("klodi-zeroclaw-register");
        let result = dispatch(&handler, LOCAL_TOOL_HEALTH, None)
            .await
            .expect("health returns Ok regardless of state");
        let structured = result
            .structured_content
            .as_ref()
            .expect("health returns structured content");
        let obj = structured.as_object().expect("object");
        // klodi_health uses `{ok: bool, ...}` shape per
        // packages/klodi-rust-host/src/mcp/tools.rs ~262.
        assert!(
            obj.contains_key("ok"),
            "health returns its {{ok, connected, issue}} payload, not the failure envelope"
        );
    }
}
