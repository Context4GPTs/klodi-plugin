//! Request handlers + shared state for the three inbox endpoints.
//!
//! The shim layer (`crate::zeroclaw_pairing_shim`) parses HTTP wire
//! frames and dispatches to these functions. Handlers themselves stay
//! agnostic of HTTP framing — they take parsed inputs (no body for
//! escalations; a `ReplyRequest` for replies) and return structured
//! results the shim renders into HTTP responses.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use reqwest::Client as HttpClient;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::channels::dashboard::{DashboardMessage, SESSIONS_REST_TIMEOUT};
use crate::inbox::filter::{OpenEscalation, open_escalations};
use crate::zeroclaw_session::session_path;
use crate::zeroclaw_ws::{SendAckPolicy, ZeroClawWsConfig, send_session_message};

/// Embedded inbox SPA. The shim's `GET /inbox/` handler serves this
/// verbatim with `Content-Type: text/html; charset=utf-8`.
pub const INBOX_HTML: &str = include_str!("../../assets/inbox.html");

/// Shared state every handler call needs. Cheap to clone (`Arc`s
/// inside): the shim threads a single instance through all request
/// handler invocations.
#[derive(Clone)]
pub struct InboxState {
    inner: Arc<InboxStateInner>,
}

struct InboxStateInner {
    ws_config: ZeroClawWsConfig,
    klodi_home: PathBuf,
    http: HttpClient,
}

impl InboxState {
    /// Build the shared state. The HTTP client is constructed once and
    /// reused for every poll — keeps connection pools warm and avoids
    /// per-request handshake cost.
    pub fn new(ws_config: ZeroClawWsConfig, klodi_home: PathBuf) -> Result<Self> {
        let http = HttpClient::builder()
            .timeout(SESSIONS_REST_TIMEOUT)
            .build()
            .context("building inbox HTTP client")?;
        Ok(Self {
            inner: Arc::new(InboxStateInner {
                ws_config,
                klodi_home,
                http,
            }),
        })
    }

    /// Resolve the klodi session id from `${KLODI_HOME}/zeroclaw.session`
    /// on every request. The daemon writes this file once on startup;
    /// reading lazily here lets the inbox become reachable before the
    /// session is fully bootstrapped (the handler returns a 503 with a
    /// retry hint until the file is populated).
    fn klodi_session_id(&self) -> Result<String> {
        let path = session_path(&self.inner.klodi_home);
        if !path.exists() {
            bail!(
                "klodi session not yet bootstrapped — \
                 `${{KLODI_HOME}}/zeroclaw.session` is missing. \
                 The daemon writes it after pairing; retry shortly."
            );
        }
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            bail!("klodi session file at {} is empty", path.display());
        }
        Ok(trimmed)
    }

    pub fn ws_config(&self) -> &ZeroClawWsConfig {
        &self.inner.ws_config
    }
}

/// Body of `GET /inbox/api/escalations`. Shape kept stable across
/// patch versions: clients must tolerate unknown fields gracefully.
#[derive(Debug, Clone, Serialize)]
pub struct InboxResponseBody {
    pub session_id: String,
    /// ISO8601 timestamp the daemon polled the gateway at, server-side.
    pub polled_at: String,
    pub escalations: Vec<EscalationDto>,
}

/// Wire shape of one open escalation. Mirrors
/// [`crate::inbox::filter::OpenEscalation`] but kept distinct so the
/// public JSON contract can evolve independently of the internal type.
#[derive(Debug, Clone, Serialize)]
pub struct EscalationDto {
    pub req_id: String,
    pub posted_at: Option<String>,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

impl From<OpenEscalation> for EscalationDto {
    fn from(e: OpenEscalation) -> Self {
        Self {
            req_id: e.escalation.req_id,
            posted_at: e.posted_at,
            summary: e.escalation.summary,
            details: e.escalation.details,
        }
    }
}

/// Request body for `POST /inbox/api/reply`.
#[derive(Debug, Clone, Deserialize)]
pub struct ReplyRequest {
    pub req_id: String,
    pub content: String,
}

/// Response body for `POST /inbox/api/reply` (success path).
#[derive(Debug, Clone, Serialize)]
pub struct ReplyOkResponse {
    pub ok: bool,
    pub posted_to: String,
}

/// Response body when the reply request was rejected — invalid input,
/// unknown req_id, or downstream WS failure.
#[derive(Debug, Clone, Serialize)]
pub struct ReplyErrResponse {
    pub ok: bool,
    pub error: String,
}

/// `GET /inbox/api/escalations` handler. Polls the gateway's REST
/// message history for the klodi session and returns the open
/// escalations.
pub async fn handle_escalations_request(state: &InboxState) -> Result<InboxResponseBody> {
    let session_id = state.klodi_session_id()?;
    let messages = fetch_messages(&state.inner.http, &state.inner.ws_config, &session_id)
        .await
        .with_context(|| format!("polling klodi session {session_id} messages"))?;
    let escalations: Vec<EscalationDto> = open_escalations(&messages)
        .into_iter()
        .map(EscalationDto::from)
        .collect();
    Ok(build_escalations_response(session_id, escalations))
}

/// Compose an `InboxResponseBody` for the given session id +
/// escalations. Split out from [`handle_escalations_request`] so unit
/// tests can construct the response without an HTTP fixture.
pub fn build_escalations_response(
    session_id: String,
    escalations: Vec<EscalationDto>,
) -> InboxResponseBody {
    InboxResponseBody {
        session_id,
        polled_at: now_iso8601_utc(),
        escalations,
    }
}

/// `POST /inbox/api/reply` handler. Validates the request body,
/// verifies the targeted escalation is still open, then writes the
/// reply into the klodi session via the existing WS path.
///
/// The reply text is composed as `req=<id> — <operator-content>` so the
/// next escalations-poll closes the card via the explicit-correlation
/// branch in [`crate::inbox::filter::open_escalations`].
pub async fn handle_reply_request(
    state: &InboxState,
    request: ReplyRequest,
) -> Result<ReplyOkResponse> {
    let req_id = request.req_id.trim();
    if req_id.is_empty() {
        bail!("`req_id` must be a non-empty string");
    }
    if !is_safe_req_id(req_id) {
        // Defensive — the daemon controls req_id minting, so anything
        // that fails this check came from an attacker poking at the
        // loopback endpoint. Reject before composing the reply string.
        bail!("`req_id` contains characters that aren't alphanumeric / `-_`");
    }
    let content = request.content.trim();
    if content.is_empty() {
        bail!("`content` must be a non-empty string");
    }

    let session_id = state.klodi_session_id()?;

    // Re-poll the message history so the operator can't accidentally
    // double-reply to an escalation that another client already closed.
    let messages = fetch_messages(&state.inner.http, &state.inner.ws_config, &session_id)
        .await
        .with_context(|| format!("re-polling klodi session {session_id} before reply"))?;
    let still_open = open_escalations(&messages)
        .iter()
        .any(|e| e.escalation.req_id == req_id);
    if !still_open {
        bail!(
            "escalation req={req_id} is no longer open — refresh the inbox to see current state"
        );
    }

    let reply_text = format!("req={req_id} — {content}");
    send_session_message(
        &state.inner.ws_config,
        &session_id,
        &reply_text,
        SendAckPolicy::OnAgentObservation,
    )
    .await
    .with_context(|| {
        format!("posting inbox reply for req={req_id} to session {session_id}")
    })?;
    tracing::info!(
        req_id = %req_id,
        session_id = %session_id,
        content_len = content.len(),
        "klodi_zeroclaw_inbox_reply_posted"
    );
    Ok(ReplyOkResponse {
        ok: true,
        posted_to: session_id,
    })
}

/// `GET /api/sessions/<session_id>/messages` against the gateway —
/// mirrors `channels::dashboard::list_messages` so the inbox doesn't
/// have to reach into the dashboard channel's `Inner` privates.
async fn fetch_messages(
    http: &HttpClient,
    ws_config: &ZeroClawWsConfig,
    session_id: &str,
) -> Result<Vec<DashboardMessage>> {
    let url = format!("{}/api/sessions/{session_id}/messages", ws_config.http_base);
    let resp = http
        .get(&url)
        .bearer_auth(&ws_config.bearer)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("GET /api/sessions/{session_id}/messages returned {status}: {body}");
    }
    let body: Value = resp
        .json()
        .await
        .with_context(|| format!("decoding {url}"))?;
    let arr = match body {
        Value::Object(ref map) => match map.get("messages") {
            Some(Value::Array(a)) => a.clone(),
            _ => bail!("/api/sessions/{session_id}/messages: missing `messages` array"),
        },
        Value::Array(a) => a,
        other => bail!(
            "/api/sessions/{session_id}/messages: expected array or object, got {other:?}"
        ),
    };
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        if let Ok(m) = serde_json::from_value::<DashboardMessage>(entry) {
            out.push(m);
        }
    }
    Ok(out)
}

/// True for req_id values the daemon itself mints: hex from
/// `short_token()` and the longer marker tokens approval gates use.
/// Keep the ASCII-allowed set tight so an attacker can't inject markup
/// or shell metacharacters via the composed reply line.
fn is_safe_req_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Format the current wall-clock instant as `YYYY-MM-DDTHH:MM:SSZ`.
/// Avoids the chrono / time crate dependency — the gateway emits the
/// same shape so the inbox JSON contract is internally consistent.
fn now_iso8601_utc() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_secs() as i64;
    crate::inbox::civil::format_unix_seconds(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_safe_req_id_accepts_short_hex() {
        assert!(is_safe_req_id("cae78f10"));
        assert!(is_safe_req_id("ABC-123"));
        assert!(is_safe_req_id("req_42"));
    }

    #[test]
    fn is_safe_req_id_rejects_unsafe_chars() {
        assert!(!is_safe_req_id(""));
        assert!(!is_safe_req_id("../etc/passwd"));
        assert!(!is_safe_req_id("<script>"));
        assert!(!is_safe_req_id("req 1"));
        assert!(!is_safe_req_id(&"x".repeat(65)));
    }

    #[test]
    fn build_escalations_response_carries_all_fields() {
        let dto = EscalationDto {
            req_id: "abc12345".into(),
            posted_at: Some("2026-05-12T10:00:00Z".into()),
            summary: "Need pickup".into(),
            details: Some("more context".into()),
        };
        let body = build_escalations_response("sess".into(), vec![dto.clone()]);
        assert_eq!(body.session_id, "sess");
        assert_eq!(body.escalations.len(), 1);
        assert!(body.polled_at.ends_with('Z'));
        // Sanity-check polled_at shape — `YYYY-MM-DDTHH:MM:SSZ`, 20 chars.
        assert_eq!(body.polled_at.len(), 20);
    }

    #[test]
    fn escalation_dto_skips_none_details() {
        let dto = EscalationDto {
            req_id: "x".into(),
            posted_at: None,
            summary: "s".into(),
            details: None,
        };
        let json = serde_json::to_string(&dto).unwrap();
        // `details` is the field the UI key-checks for "long body
        // present?" — skip it when absent so the SPA can use plain
        // `if (e.details)` without branching on null vs undefined.
        assert!(
            !json.contains("\"details\""),
            "details should be skipped when None; got: {json}"
        );
        // `posted_at` is informative to the client (null says "we
        // couldn't determine when this landed") so it stays in the
        // payload as an explicit null.
        assert!(json.contains("\"posted_at\":null"));
    }

    // civil_from_days / format_unix_seconds round-trip is covered by
    // `inbox::civil::tests` — those helpers now live in the shared
    // module so the inbox filter and the handlers consume one
    // implementation.
}
