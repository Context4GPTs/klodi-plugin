//! `DashboardChannel` — klodi-owned WebSocket transport against the
//! ZeroClaw dashboard's `/ws/chat` surface.
//!
//! The dashboard is the one channel klodi *must* own end-to-end: no
//! upstream primitive routes into a dashboard session, and every
//! probe constraint (every write triggers an agent loop, no SSE,
//! polling-only inbound, silent re-creation on delete) applies. This
//! module covers:
//!
//! - `notify()` — resolves a destination (T3 active-session heuristic
//!   for `Recipient::AutoActiveSession`) and writes a
//!   correlation-tagged payload via `zeroclaw_ws::send_session_message`.
//!   Single-destination per call: when T3 finds no operator-typed
//!   session, returns `Err`. Callers (the forwarder + MCP)
//!   fall back to a direct write into the dedicated session.
//! - The created-sessions ledger (`channels::ledger`) excludes
//!   klodi-owned sessions from the operator-primary candidate list.
//! - `replies()` — a polling bridge against `GET /api/sessions/<id>/messages`
//!   that classifies user messages into `OperatorReply`s using an
//!   explicit `/klodi` prefix or a bare-affirmation adjacency window.
//! - Stale-session detection (T5 silent re-creation) — pre-write
//!   `GET /api/sessions` check, resurrection breadcrumb, ledger
//!   update, T3 re-resolve.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use async_trait::async_trait;
use futures_util::Stream;
use reqwest::Client as HttpClient;
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};
use uuid::Uuid;

use crate::zeroclaw_ws::{SendAckPolicy, ZeroClawWsConfig, send_session_message};

use super::cursor::DispatcherCursor;
use super::ledger::CreatedSessionsLedger;
use super::session_health::{
    SessionHealth, check_session_alive, resurrection_breadcrumb,
};
use super::{
    Notification, NotificationId, OperatorChannel, OperatorReply, Recipient,
};

/// Default poll cadence for the inbound reply bridge. Surfaced here
/// so the registry construction in `klodi-zeroclaw-daemon` can keep a
/// single source of truth.
pub const DEFAULT_POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// Default REST timeout for `GET /api/sessions` calls. Bounded short:
/// the dashboard is local, the call shape is tiny, and the dispatcher
/// has its own loop cadence.
pub const SESSIONS_REST_TIMEOUT: Duration = Duration::from_secs(10);

/// Adjacency window for the bare-affirmation reply path.
/// A bare `yes / no / approve / deny / confirm / cancel` reply within
/// this window of the most recent notification correlates to that
/// notification.
pub const ADJACENCY_WINDOW: Duration = Duration::from_secs(60);

/// Reply broadcast channel capacity. 64 is plenty: the operator reply
/// rate is bounded by typing speed, the bridge publishes opportunistically,
/// and the only consumer (the registry's `replies()` stream) drains
/// each item immediately.
const REPLY_BROADCAST_CAPACITY: usize = 64;

/// `/klodi` prefix the dispatcher recognises on inbound chat
/// messages. Case-insensitive on the prefix; the verb and correlation
/// id are looked up verbatim by the approval gate.
pub const KLODI_REPLY_PREFIX: &str = "/klodi";

/// Bare-affirmation vocabulary recognised within
/// [`ADJACENCY_WINDOW`]. The exact set is open question 1 in the
/// implementation plan — refine via real use. Lower-cased ASCII
/// tokens; word-boundary matching at lookup time so `"approve"` in
/// the middle of "approve later" matches, but `"yes"` embedded in
/// `"eyes"` doesn't.
pub const BARE_AFFIRMATION_TOKENS: &[&str] = &[
    "yes", "y", "approve", "ok", "okay", "proceed", "confirm", "go", "do it",
];
pub const BARE_DENIAL_TOKENS: &[&str] =
    &["no", "n", "deny", "cancel", "stop", "refuse", "abort", "nope"];

/// Single-session entry as returned by `GET /api/sessions`. Only the
/// fields we consult are typed; everything else parses into the
/// catch-all and gets dropped. Per the wake-routing redesign §6 the
/// gateway returns `{session_id, created_at, last_activity, message_count}`
/// sorted by `last_activity` descending — `session_id` is renamed
/// onto `id` here so the rest of the dashboard channel can keep
/// using the shorter local name. The `alias = "id"` keeps decode
/// working against any legacy/test-only shape that still sends `id`.
#[derive(Debug, Clone, Deserialize)]
pub struct DashboardSession {
    #[serde(rename = "session_id", alias = "id")]
    pub id: String,
    #[serde(default)]
    pub last_activity: Option<String>,
    #[serde(default)]
    pub message_count: Option<u64>,
}

/// Single message returned by `GET /api/sessions/<id>/messages`. The
/// Phase 1 path only consults `role` to decide whether a session looks
/// operator-primary (most recent message has `role=user`). Phase 2 will
/// also consume `content` and `created_at`.
#[derive(Debug, Clone, Deserialize)]
pub struct DashboardMessage {
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    /// Per-message index inside the session — when the gateway
    /// returns one. Used by the Phase 2 cursor to advance past
    /// already-processed messages without scanning content.
    #[serde(default)]
    #[serde(alias = "sequence", alias = "index")]
    pub index: Option<u64>,
}

/// Klodi-owned dashboard transport.
pub struct DashboardChannel {
    inner: Arc<Inner>,
}

struct Inner {
    /// Channel name as exposed to the registry / replies stream.
    name: String,
    ws_config: ZeroClawWsConfig,
    http: HttpClient,
    /// Sessions klodi created (dedicated + any silently-recreated
    /// dashboard sessions Phase 3 detects). Used by the T3 heuristic to
    /// avoid posting into our own session.
    ledger: Arc<CreatedSessionsLedger>,
    /// Per-session cursor — last processed message index. Survives
    /// daemon restarts (`${KLODI_HOME}/zeroclaw.dispatcher_cursor.json`).
    cursor: Arc<DispatcherCursor>,
    /// Adjacency map — `correlation_id → (sent_at, session_id)` for
    /// notifications posted within the last [`ADJACENCY_WINDOW`]. The
    /// reply bridge consults this to decide whether a bare
    /// affirmation should be tied to an open notification.
    adjacency: Mutex<HashMap<String, AdjacencyEntry>>,
    /// Per-session timestamp of the most recent USER message the
    /// dispatcher has seen. Used by the cursor advance logic to avoid
    /// races where an agent reply lands between operator typing and
    /// the dispatcher poll (race-condition guard).
    last_user_seen: Mutex<HashMap<String, MessageMark>>,
    /// Poll cadence for the inbound reply bridge.
    poll_interval: Duration,
    /// `${KLODI_HOME}/zeroclaw.dispatcher_cursor.json` — the on-disk
    /// path corresponding to `cursor`. Kept for log fields.
    #[allow(dead_code)]
    cursor_path: PathBuf,
    /// Broadcast publisher for `OperatorReply` events. Lazy-created on
    /// the first `replies()` call; subsequent calls subscribe new
    /// receivers.
    reply_publisher: OnceLock<broadcast::Sender<OperatorReply>>,
}

/// Per-notification adjacency record.
#[derive(Debug, Clone)]
pub(crate) struct AdjacencyEntry {
    pub(crate) sent_at: Instant,
    #[allow(dead_code)] // surfaced in Phase 3 stale-session detection
    pub(crate) session_id: String,
}

/// Per-session "what's the most recent user message we've observed"
/// mark. Pair of (index, timestamp) — index for cursor advance,
/// timestamp for the T3 race-condition guard.
#[derive(Debug, Clone)]
#[allow(dead_code)] // read in Phase 3 stale-session detection
struct MessageMark {
    index: u64,
    seen_at: Instant,
}

impl DashboardChannel {
    /// Construct a dashboard channel from a resolved WS config + on-disk
    /// support state.
    pub fn new(
        ws_config: ZeroClawWsConfig,
        ledger: Arc<CreatedSessionsLedger>,
        cursor_path: PathBuf,
    ) -> Result<Self> {
        Self::new_with_config(
            "dashboard".to_string(),
            ws_config,
            ledger,
            cursor_path,
            DEFAULT_POLL_INTERVAL,
        )
    }

    /// Override-friendly constructor — kept distinct so tests can plug
    /// shorter poll intervals without rebuilding the public API.
    pub fn new_with_config(
        name: String,
        ws_config: ZeroClawWsConfig,
        ledger: Arc<CreatedSessionsLedger>,
        cursor_path: PathBuf,
        poll_interval: Duration,
    ) -> Result<Self> {
        let http = HttpClient::builder()
            .timeout(SESSIONS_REST_TIMEOUT)
            .build()
            .context("building dashboard REST client")?;
        let cursor = Arc::new(
            DispatcherCursor::open(cursor_path.clone())
                .context("opening dispatcher cursor")?,
        );
        tracing::info!(
            channel_name = %name,
            http_base = %ws_config.http_base,
            ws_url = %ws_config.ws_url,
            poll_interval_ms = poll_interval.as_millis() as u64,
            cursor_path = %cursor_path.display(),
            "klodi_zeroclaw_dashboard_channel_registered"
        );
        Ok(Self {
            inner: Arc::new(Inner {
                name,
                ws_config,
                http,
                ledger,
                cursor,
                adjacency: Mutex::new(HashMap::new()),
                last_user_seen: Mutex::new(HashMap::new()),
                poll_interval,
                cursor_path,
                reply_publisher: OnceLock::new(),
            }),
        })
    }

    /// Resolve a destination session id for this notification. Surface
    /// kept `pub(crate)` so Phase 2 / Phase 3 can call into it from the
    /// poll task without re-implementing the heuristic.
    pub(crate) async fn resolve_destination(
        &self,
        recipient: &Recipient,
    ) -> Result<Option<String>> {
        match recipient {
            Recipient::AutoActiveSession => self.resolve_auto().await,
            Recipient::SessionId(id) => {
                let sessions = self.list_sessions().await?;
                if sessions.iter().any(|s| &s.id == id) {
                    Ok(Some(id.clone()))
                } else {
                    // Pinned id no longer on the gateway. Phase 3's
                    // resurrection-detection will turn this into a
                    // warning + re-resolution; for Phase 1 we surface
                    // `None` so the queue absorbs the notification.
                    tracing::warn!(
                        session_id = %id,
                        "klodi_zeroclaw_dashboard_pinned_session_missing"
                    );
                    Ok(None)
                }
            }
            Recipient::Address(_) => {
                bail!(
                    "DashboardChannel can only deliver to a SessionId or AutoActiveSession recipient"
                );
            }
        }
    }

    /// T3 heuristic — pick the most-recent `/api/sessions` entry whose
    /// latest message has `role=user`, skipping any session in the
    /// created-sessions ledger. Used by [`Self::resolve_destination`]
    /// for every `AutoActiveSession` recipient.
    ///
    /// Emits `klodi_zeroclaw_target_session_resolved` at info on each
    /// successful pick and `klodi_zeroclaw_target_session_unresolved`
    /// at info when no non-ledger session has operator activity (the
    /// caller then falls back to the dedicated klodi session).
    /// Grep-friendly for operators diagnosing "where did my
    /// notification go?" reports.
    async fn resolve_auto(&self) -> Result<Option<String>> {
        let sessions = self.list_sessions().await?;
        let total_listed = sessions.len();
        let mut skipped_ledger = 0usize;
        let mut skipped_empty = 0usize;
        let mut skipped_no_user_message = 0usize;
        for session in sessions.iter() {
            if self.inner.ledger.contains(&session.id).await {
                skipped_ledger += 1;
                continue;
            }
            if session.message_count.unwrap_or(0) == 0 {
                // Empty session — wouldn't have a user-typed message to
                // satisfy the heuristic. Skip.
                skipped_empty += 1;
                continue;
            }
            match self.last_user_message(&session.id).await {
                Ok(Some(_)) => {
                    tracing::info!(
                        target_id = %session.id,
                        reason = "active",
                        source = "dashboard",
                        sessions_total = total_listed,
                        sessions_skipped_ledger = skipped_ledger,
                        sessions_skipped_empty = skipped_empty,
                        last_activity = ?session.last_activity,
                        message_count = ?session.message_count,
                        "klodi_zeroclaw_target_session_resolved"
                    );
                    return Ok(Some(session.id.clone()));
                }
                Ok(None) => {
                    skipped_no_user_message += 1;
                    continue;
                }
                Err(err) => {
                    tracing::warn!(
                        session_id = %session.id,
                        error = %format!("{err:#}"),
                        "klodi_zeroclaw_dashboard_session_probe_failed"
                    );
                    continue;
                }
            }
        }
        tracing::info!(
            source = "dashboard",
            sessions_total = total_listed,
            sessions_skipped_ledger = skipped_ledger,
            sessions_skipped_empty = skipped_empty,
            sessions_skipped_no_user_message = skipped_no_user_message,
            "klodi_zeroclaw_target_session_unresolved"
        );
        Ok(None)
    }

    /// `GET /api/sessions` against the gateway. Returns the session list
    /// in the order the gateway sent it (which is `last_activity desc`
    /// per probe T1).
    pub(crate) async fn list_sessions(&self) -> Result<Vec<DashboardSession>> {
        let url = format!("{}/api/sessions", self.inner.ws_config.http_base);
        let resp = self
            .inner
            .http
            .get(&url)
            .bearer_auth(&self.inner.ws_config.bearer)
            .send()
            .await
            .with_context(|| format!("GET {url}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            bail!("GET /api/sessions returned {status}: {body}");
        }
        let body: Value = resp
            .json()
            .await
            .context("decoding /api/sessions response")?;
        // Probe T1 documents the response as `{sessions: [...]}` but the
        // gateway has historically also returned a bare array. Accept both.
        let arr = match body {
            Value::Object(ref map) => match map.get("sessions") {
                Some(Value::Array(a)) => a.clone(),
                Some(other) => bail!(
                    "/api/sessions: expected `sessions` array, got {}",
                    short_type(other)
                ),
                None => bail!("/api/sessions: missing `sessions` field"),
            },
            Value::Array(a) => a,
            other => bail!(
                "/api/sessions: expected array or object, got {}",
                short_type(&other)
            ),
        };
        let mut out = Vec::with_capacity(arr.len());
        for entry in arr {
            match serde_json::from_value::<DashboardSession>(entry) {
                Ok(s) => out.push(s),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        "klodi_zeroclaw_dashboard_sessions_entry_decode_failed"
                    );
                }
            }
        }
        Ok(out)
    }

    /// `GET /api/sessions/<id>/messages` and return the most recent
    /// USER-role message, if any. Tail-only walk so we don't load the
    /// whole history just to check the latest message's role.
    pub(crate) async fn last_user_message(
        &self,
        session_id: &str,
    ) -> Result<Option<DashboardMessage>> {
        let messages = self.list_messages(session_id).await?;
        Ok(messages
            .into_iter()
            .rev()
            .find(|m| m.role.as_deref() == Some("user")))
    }

    /// `GET /api/sessions/<id>/messages` — full message list as the
    /// gateway returns it. Phase 2's poll consumes this directly with a
    /// cursor.
    pub(crate) async fn list_messages(
        &self,
        session_id: &str,
    ) -> Result<Vec<DashboardMessage>> {
        let url = format!(
            "{}/api/sessions/{session_id}/messages",
            self.inner.ws_config.http_base
        );
        let resp = self
            .inner
            .http
            .get(&url)
            .bearer_auth(&self.inner.ws_config.bearer)
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
                Some(other) => bail!(
                    "/api/sessions/{session_id}/messages: expected `messages` array, got {}",
                    short_type(other)
                ),
                None => bail!(
                    "/api/sessions/{session_id}/messages: missing `messages` field"
                ),
            },
            Value::Array(a) => a,
            other => bail!(
                "/api/sessions/{session_id}/messages: expected array or object, got {}",
                short_type(&other)
            ),
        };
        let mut out = Vec::with_capacity(arr.len());
        for entry in arr {
            match serde_json::from_value::<DashboardMessage>(entry) {
                Ok(m) => out.push(m),
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        "klodi_zeroclaw_dashboard_messages_entry_decode_failed"
                    );
                }
            }
        }
        Ok(out)
    }

    /// Record a `(correlation_id, session_id, now)` adjacency entry —
    /// the reply bridge uses this to match bare affirmations against
    /// the most recent outbound notification.
    async fn record_adjacency(&self, correlation_id: &str, session_id: &str) {
        let now = Instant::now();
        let mut g = self.inner.adjacency.lock().await;
        // Reap expired entries while we have the lock.
        g.retain(|_, e| now.duration_since(e.sent_at) <= ADJACENCY_WINDOW);
        g.insert(
            correlation_id.to_string(),
            AdjacencyEntry {
                sent_at: now,
                session_id: session_id.to_string(),
            },
        );
    }

    /// Snapshot the adjacency map for classification — returns only
    /// entries within [`ADJACENCY_WINDOW`]. Mirrored on `Inner` for the
    /// poll-task path; this surface is the same logic exposed via the
    /// public type so test code can build deterministic fixtures.
    #[cfg(test)]
    pub(crate) async fn adjacency_snapshot(&self) -> HashMap<String, AdjacencyEntry> {
        self.inner.snapshot_adjacency().await
    }

    /// Inspect the adjacency map — used by Phase 3 to surface
    /// resurrected-session metadata to operator logs.
    #[allow(dead_code)]
    pub(crate) async fn adjacency_len(&self) -> usize {
        self.inner.adjacency.lock().await.len()
    }

    /// Stale-session detection: probe `GET /api/sessions` for
    /// `session_id`. Returns:
    ///
    /// - `Ok(Some(id))` — session is alive (or unknown). `id` may
    ///   differ from input when resurrection-driven re-resolution
    ///   yielded a different destination.
    /// - `Ok(None)` — resurrection detected and no live operator
    ///   session is currently available. Caller should queue.
    /// - `Err(_)` — caller decides; we typically log + write anyway.
    pub(crate) async fn verify_or_reroute_destination(
        &self,
        session_id: &str,
    ) -> Result<Option<String>> {
        let health = check_session_alive(
            &self.inner.http,
            &self.inner.ws_config,
            session_id,
        )
        .await;
        let (resurrected, message_count) = match &health {
            SessionHealth::Alive { .. } => (false, None),
            SessionHealth::Resurrected { message_count } => (true, Some(*message_count)),
            SessionHealth::Missing => (true, None),
            SessionHealth::Unknown { error } => {
                tracing::warn!(
                    session_id = %session_id,
                    error = %error,
                    "klodi_zeroclaw_dashboard_session_health_unknown_writing_anyway"
                );
                return Ok(Some(session_id.to_string()));
            }
        };
        if !resurrected {
            return Ok(Some(session_id.to_string()));
        }
        tracing::warn!(
            session_id = %session_id,
            message_count = ?message_count,
            "klodi_zeroclaw_session_resurrection_detected"
        );
        // Move the (now-stale) destination into the ledger so the T3
        // heuristic skips it on the next pass.
        self.inner.ledger.record(session_id).await;
        // Post a breadcrumb in the resurrected session — when the
        // gateway gives us back the same id, it's a fresh chat with
        // no prior history, and the operator should see why klodi
        // suddenly looks empty. Only meaningful when the session
        // still exists (Resurrected, not Missing).
        if matches!(health, SessionHealth::Resurrected { .. }) {
            let _ = send_session_message(
                &self.inner.ws_config,
                session_id,
                &resurrection_breadcrumb(),
                SendAckPolicy::OnAgentObservation,
            )
            .await;
        }
        // Try one re-resolution. If T3 picks a different session,
        // return that; otherwise queue.
        let re_resolved = self
            .resolve_auto()
            .await
            .ok()
            .flatten()
            .filter(|id| id != session_id);
        Ok(re_resolved)
    }

    /// Ensure the reply broadcast publisher exists, spawning the poll
    /// task on first call. Idempotent — subsequent calls return the
    /// same sender.
    fn ensure_reply_publisher(&self) -> &broadcast::Sender<OperatorReply> {
        self.inner.reply_publisher.get_or_init(|| {
            let (tx, _rx) = broadcast::channel(REPLY_BROADCAST_CAPACITY);
            let inner = self.inner.clone();
            let tx_clone = tx.clone();
            tokio::spawn(async move {
                inner.poll_replies_forever(tx_clone).await;
            });
            tx
        })
    }
}

impl Inner {
    /// Forever-loop polling `/api/sessions` then per-session message
    /// lists. Publishes `OperatorReply`s into `tx`.
    async fn poll_replies_forever(
        self: Arc<Self>,
        tx: broadcast::Sender<OperatorReply>,
    ) {
        let mut ticker = tokio::time::interval(self.poll_interval);
        ticker.set_missed_tick_behavior(
            tokio::time::MissedTickBehavior::Skip,
        );
        loop {
            ticker.tick().await;
            if let Err(err) = self.poll_replies_once(&tx).await {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_dashboard_reply_poll_failed_iteration"
                );
            }
        }
    }

    async fn poll_replies_once(
        &self,
        tx: &broadcast::Sender<OperatorReply>,
    ) -> Result<()> {
        let sessions = list_sessions_http(&self.http, &self.ws_config).await?;
        let adjacency = self.snapshot_adjacency().await;
        for session in sessions {
            if self.ledger.contains(&session.id).await {
                continue;
            }
            if let Err(err) =
                self.poll_session_replies(&session.id, tx, &adjacency).await
            {
                tracing::warn!(
                    session_id = %session.id,
                    error = %format!("{err:#}"),
                    "klodi_zeroclaw_dashboard_reply_poll_session_failed"
                );
            }
        }
        Ok(())
    }

    async fn poll_session_replies(
        &self,
        session_id: &str,
        tx: &broadcast::Sender<OperatorReply>,
        adjacency: &HashMap<String, AdjacencyEntry>,
    ) -> Result<()> {
        let messages = list_messages_http(
            &self.http,
            &self.ws_config,
            session_id,
        )
        .await?;
        let cursor = self.cursor.get(session_id).await;
        let mut max_seen = cursor;

        for (offset, msg) in messages.iter().enumerate() {
            // Resolve the wire index. If the gateway omitted it, fall
            // back to position-in-array (1-based so a fresh cursor of
            // 0 doesn't re-emit the first message on every tick).
            let wire_index = msg
                .index
                .unwrap_or((offset as u64).saturating_add(1));
            if wire_index <= cursor {
                continue;
            }
            if wire_index > max_seen {
                max_seen = wire_index;
            }
            if msg.role.as_deref() != Some("user") {
                continue;
            }
            // Update the per-session most-recent-user-message mark for
            // the race-condition guard.
            self.mark_user_message(session_id, wire_index).await;

            let Some(text) = msg.content.as_deref() else {
                continue;
            };
            let outcomes = classify_reply(text, adjacency);
            for outcome in outcomes {
                let reply = OperatorReply {
                    channel_name: self.name.clone(),
                    text: outcome.text.clone(),
                    correlation_id: outcome.correlation_id.clone(),
                    origin: session_id.to_string(),
                };
                tracing::info!(
                    session_id = %session_id,
                    correlation_id = ?outcome.correlation_id,
                    "klodi_zeroclaw_dashboard_reply_bridged"
                );
                // Ignore Send errors — they only fire when no
                // receivers are alive, which is fine.
                let _ = tx.send(reply);
            }
        }

        if max_seen > cursor {
            self.cursor.advance(session_id, max_seen).await;
        }
        Ok(())
    }

    async fn snapshot_adjacency(&self) -> HashMap<String, AdjacencyEntry> {
        let now = Instant::now();
        let g = self.adjacency.lock().await;
        g.iter()
            .filter(|(_, e)| now.duration_since(e.sent_at) <= ADJACENCY_WINDOW)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    async fn mark_user_message(&self, session_id: &str, index: u64) {
        let mut g = self.last_user_seen.lock().await;
        g.insert(
            session_id.to_string(),
            MessageMark {
                index,
                seen_at: Instant::now(),
            },
        );
    }
}

/// Outcome of [`classify_reply`] — one operator reply per item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClassifiedReply {
    pub(crate) text: String,
    pub(crate) correlation_id: Option<String>,
}

/// Classify a single user-role message into zero, one, or many
/// `OperatorReply`s:
///
/// - Empty / whitespace-only → drop.
/// - Starts with `/klodi` (case-insensitive) → bridge.
///   - First whitespace-separated token after the prefix may carry a
///     `verb:correlation_id` shape (e.g. `yes:abc12345`); when
///     present, the colon-separated trailing part becomes the
///     `correlation_id`.
///   - Otherwise: bridge with `correlation_id = None` (operator's
///     general chat; the agent will figure it out).
/// - Else if the message is a bare affirmation/denial within the
///   adjacency window: bridge with each open correlation_id as a
///   candidate. Single-candidate → unambiguous; multi-candidate →
///   one outcome per id so the approval gate can pick the right one
///   idempotently.
/// - Else: drop. The bridge stays out of the operator's general chat.
pub(crate) fn classify_reply(
    text: &str,
    adjacency: &HashMap<String, AdjacencyEntry>,
) -> Vec<ClassifiedReply> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    if let Some(rest) = strip_prefix_ci(trimmed, KLODI_REPLY_PREFIX) {
        let rest = rest.trim_start();
        if rest.is_empty() {
            return vec![ClassifiedReply {
                text: text.to_string(),
                correlation_id: None,
            }];
        }
        // First whitespace-separated token may be `verb:reqId`.
        let first = rest.split_whitespace().next().unwrap_or("");
        let correlation = first.rfind(':').and_then(|idx| {
            let id = &first[idx + 1..];
            if id.is_empty() { None } else { Some(id.to_string()) }
        });
        return vec![ClassifiedReply {
            text: text.to_string(),
            correlation_id: correlation,
        }];
    }
    if matches_bare_vocab(trimmed) {
        let candidates: Vec<String> = adjacency.keys().cloned().collect();
        if candidates.is_empty() {
            return vec![];
        }
        return candidates
            .into_iter()
            .map(|id| ClassifiedReply {
                text: text.to_string(),
                correlation_id: Some(id),
            })
            .collect();
    }
    vec![]
}

fn strip_prefix_ci<'a>(haystack: &'a str, prefix: &str) -> Option<&'a str> {
    let prefix_lower = prefix.to_ascii_lowercase();
    if haystack.len() < prefix.len() {
        return None;
    }
    if !haystack
        .get(..prefix.len())
        .map(|s| s.eq_ignore_ascii_case(&prefix_lower))
        .unwrap_or(false)
    {
        return None;
    }
    Some(&haystack[prefix.len()..])
}

fn matches_bare_vocab(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    BARE_AFFIRMATION_TOKENS
        .iter()
        .chain(BARE_DENIAL_TOKENS.iter())
        .any(|tok| has_word(&lower, tok))
}

fn has_word(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    if needle.contains(' ') {
        return haystack.contains(needle);
    }
    let bytes = haystack.as_bytes();
    let n = needle.len();
    let Some(max_start) = bytes.len().checked_sub(n) else {
        return false;
    };
    for start in 0..=max_start {
        if &bytes[start..start + n] != needle.as_bytes() {
            continue;
        }
        let left_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let right_ok = start + n == bytes.len() || !is_word_byte(bytes[start + n]);
        if left_ok && right_ok {
            return true;
        }
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Free-standing HTTP wrapper used by the poll loop — duplicates the
/// `DashboardChannel::list_sessions` body so the poll task doesn't need
/// to hold a `&DashboardChannel`. (The task owns an `Arc<Inner>` to
/// keep the borrow-checker simple across the spawn boundary.)
async fn list_sessions_http(
    http: &HttpClient,
    ws_config: &ZeroClawWsConfig,
) -> Result<Vec<DashboardSession>> {
    let url = format!("{}/api/sessions", ws_config.http_base);
    let resp = http
        .get(&url)
        .bearer_auth(&ws_config.bearer)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("GET /api/sessions returned {status}: {body}");
    }
    let body: Value = resp
        .json()
        .await
        .context("decoding /api/sessions response")?;
    let arr = match body {
        Value::Object(ref map) => match map.get("sessions") {
            Some(Value::Array(a)) => a.clone(),
            _ => bail!("/api/sessions: missing `sessions` array"),
        },
        Value::Array(a) => a,
        other => bail!(
            "/api/sessions: expected array or object, got {}",
            short_type(&other)
        ),
    };
    let mut out = Vec::with_capacity(arr.len());
    for entry in arr {
        if let Ok(s) = serde_json::from_value::<DashboardSession>(entry) {
            out.push(s);
        }
    }
    Ok(out)
}

async fn list_messages_http(
    http: &HttpClient,
    ws_config: &ZeroClawWsConfig,
    session_id: &str,
) -> Result<Vec<DashboardMessage>> {
    let url = format!(
        "{}/api/sessions/{session_id}/messages",
        ws_config.http_base
    );
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
            _ => bail!(
                "/api/sessions/{session_id}/messages: missing `messages` array"
            ),
        },
        Value::Array(a) => a,
        other => bail!(
            "/api/sessions/{session_id}/messages: expected array or object, got {}",
            short_type(&other)
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

#[async_trait]
impl OperatorChannel for DashboardChannel {
    fn name(&self) -> &str {
        &self.inner.name
    }

    fn agent_surface(&self) -> bool {
        // Writes go to `/ws/chat`; every write fires a server-side
        // agent loop in the target dashboard session.
        true
    }

    async fn notify(
        &self,
        recipient: &Recipient,
        payload: &Notification,
    ) -> Result<NotificationId> {
        let correlation_id = payload
            .correlation_id
            .clone()
            .unwrap_or_else(|| short_token());

        let rendered = render_payload(payload, &correlation_id);

        // Single-destination: T3 picks one operator-typed session, or
        // the pinned recipient is honoured directly. On no-destination
        // we return Err — the caller (the registry's `route()`
        // wrapper, the forwarder, MCP `klodi_escalate_to_user`)
        // decides on the fallback path (typically: write to the
        // dedicated klodi session). No queuing in the dashboard
        // channel — the routing decision lives with the caller.
        let destination = self.resolve_destination(recipient).await?;
        let session_id = match destination {
            Some(id) => id,
            None => {
                tracing::info!(
                    correlation_id = %correlation_id,
                    event_kind = %payload.event_kind,
                    "klodi_zeroclaw_dashboard_no_active_session"
                );
                bail!(
                    "DashboardChannel: T3 resolved no operator-typed session \
                     (correlation_id={correlation_id}, event_kind={kind}); \
                     caller is expected to fall back to the dedicated klodi \
                     session.",
                    kind = payload.event_kind,
                );
            }
        };

        // Stale-session pre-write check: list-membership AND message_count
        // verification. We picked the session because it had operator
        // activity. If the session is missing or has zero count, it's
        // deletion-in-progress (silent recreation per T5) — log,
        // ledger, and let the next poll tick re-resolve.
        let final_session = self
            .verify_or_reroute_destination(&session_id)
            .await
            .unwrap_or_else(|err| {
                tracing::warn!(
                    error = %format!("{err:#}"),
                    session_id = %session_id,
                    "klodi_zeroclaw_dashboard_session_verify_failed_writing_anyway"
                );
                Some(session_id.clone())
            });

        let session_id = match final_session {
            Some(id) => id,
            None => {
                bail!(
                    "DashboardChannel: resurrection detected and re-resolve \
                     found no replacement session (correlation_id={correlation_id}); \
                     caller is expected to fall back to the dedicated klodi session."
                );
            }
        };

        send_session_message(
            &self.inner.ws_config,
            &session_id,
            &rendered,
            SendAckPolicy::OnAgentObservation,
        )
        .await
        .with_context(|| {
            format!(
                "posting dashboard notification {correlation_id} to session {session_id}"
            )
        })?;
        // Record the adjacency entry so a bare affirmation within
        // [`ADJACENCY_WINDOW`] correlates to this notification.
        self.record_adjacency(&correlation_id, &session_id).await;
        // NB: deliberately do NOT record the destination session in
        // the created-sessions ledger — that's where the operator's
        // chat lives, not klodi's own. The ledger only grows when the
        // verify step above detected a resurrection.
        tracing::info!(
            correlation_id = %correlation_id,
            session_id = %session_id,
            event_kind = %payload.event_kind,
            "klodi_zeroclaw_dashboard_notified"
        );
        Ok(NotificationId(correlation_id))
    }

    fn replies(&self) -> Pin<Box<dyn Stream<Item = OperatorReply> + Send + 'static>> {
        let sender = self.ensure_reply_publisher();
        let receiver = sender.subscribe();
        Box::pin(futures_util::stream::unfold(receiver, |mut rx| async move {
            loop {
                match rx.recv().await {
                    Ok(item) => return Some((item, rx)),
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            dropped = n,
                            "klodi_zeroclaw_dashboard_reply_stream_lagged"
                        );
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        return None;
                    }
                }
            }
        }))
    }
}

/// Render a [`Notification`] into the dashboard's safe-as-user-input
/// format:
///
/// ```text
/// ── klodi · req=<id> · <event_kind> ──
/// <summary>
/// <optional details>
/// Reply: /klodi yes:<id>  to confirm   /klodi no:<id>  to cancel
/// ```
///
/// The leading `── klodi ·` delimiter is the recognisable visual signal
/// to the operator's general agent ("system notification, don't try to
/// handle this"). The trailing `Reply:` line is operator-directed.
pub fn render_payload(payload: &Notification, correlation_id: &str) -> String {
    let mut out = String::with_capacity(256);
    out.push_str("── klodi · req=");
    out.push_str(correlation_id);
    out.push_str(" · ");
    out.push_str(&payload.event_kind);
    out.push_str(" ──\n");
    out.push_str(&payload.summary);
    if let Some(details) = &payload.details {
        out.push('\n');
        out.push_str(details);
    }
    if let Some(structured) = &payload.structured {
        out.push_str("\n```json\n");
        let pretty = serde_json::to_string_pretty(structured)
            .unwrap_or_else(|_| structured.to_string());
        out.push_str(&pretty);
        out.push_str("\n```");
    }
    let reply_hint = payload.reply_hint.clone().unwrap_or_else(|| {
        format!(
            "Reply: /klodi yes:{correlation_id}  to confirm   /klodi no:{correlation_id}  to cancel"
        )
    });
    out.push('\n');
    out.push_str(&reply_hint);
    out
}

/// Short correlation token, lower-case hex. 8 chars is plenty for
/// disambiguation within the 60s adjacency window — birthday-bound is
/// ~256 — and short enough that the operator can re-type it without
/// errors.
fn short_token() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    raw.chars().take(8).collect()
}

fn short_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channels::Severity;
    use std::path::Path;

    fn ws_config() -> ZeroClawWsConfig {
        ZeroClawWsConfig {
            ws_url: "ws://127.0.0.1:7070/ws/chat".into(),
            http_base: "http://127.0.0.1:7070".into(),
            bearer: "zc_test".into(),
        }
    }

    fn ledger() -> Arc<CreatedSessionsLedger> {
        let dir = tempfile::tempdir().unwrap();
        Arc::new(
            CreatedSessionsLedger::open(dir.path().join("ledger.json"))
                .expect("open ledger"),
        )
    }

    fn cursor_path(dir: &Path) -> PathBuf {
        dir.join("cursor.json")
    }

    #[test]
    fn dashboard_channel_constructor_smoke() {
        let dir = tempfile::tempdir().unwrap();
        let ch = DashboardChannel::new(
            ws_config(),
            ledger(),
            cursor_path(dir.path()),
        )
        .unwrap();
        assert_eq!(ch.name(), "dashboard");
    }

    /// Regression: the gateway returns `session_id` (not `id`) per the
    /// wake-routing redesign §6. A naive `id: String` decode silently
    /// drops every entry, leaves T3 with an empty candidate list, and
    /// the dashboard never lights up (see
    /// `docs/reports/2026-05-11-klodi-zeroclaw-0.2.9-operator-fanout-bugs.md`).
    #[test]
    fn dashboard_session_decodes_realistic_gateway_response() {
        let body = serde_json::json!({
            "sessions": [
                {
                    "session_id": "abc-123",
                    "created_at": "2026-05-11T08:00:00Z",
                    "last_activity": "2026-05-11T09:00:00Z",
                    "message_count": 5,
                },
                {
                    "session_id": "def-456",
                    "created_at": "2026-05-11T07:00:00Z",
                    "last_activity": "2026-05-11T08:00:00Z",
                    "message_count": 0,
                },
            ]
        });
        let entries = body["sessions"].as_array().unwrap();
        let decoded: Vec<DashboardSession> = entries
            .iter()
            .map(|e| serde_json::from_value(e.clone()).expect("decode session"))
            .collect();
        assert_eq!(decoded.len(), 2);
        assert_eq!(decoded[0].id, "abc-123");
        assert_eq!(decoded[0].message_count, Some(5));
        assert_eq!(decoded[0].last_activity.as_deref(), Some("2026-05-11T09:00:00Z"));
        assert_eq!(decoded[1].id, "def-456");
        assert_eq!(decoded[1].message_count, Some(0));
    }

    /// The `alias = "id"` keeps decode working against any legacy or
    /// test-only response shape that still emits `id`.
    #[test]
    fn dashboard_session_accepts_legacy_id_alias() {
        let entry = serde_json::json!({
            "id": "legacy-uuid",
            "last_activity": null,
            "message_count": 1,
        });
        let decoded: DashboardSession = serde_json::from_value(entry).unwrap();
        assert_eq!(decoded.id, "legacy-uuid");
    }

    #[test]
    fn render_payload_includes_correlation_header_and_reply_hint() {
        let payload = Notification {
            event_kind: "offer.accepted".into(),
            summary: "Deal struck at €140".into(),
            details: Some("Counterparty awaiting confirmation.".into()),
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: None,
            reply_hint: None,
        };
        let rendered = render_payload(&payload, "abc12345");
        assert!(rendered.contains("── klodi · req=abc12345 · offer.accepted ──"));
        assert!(rendered.contains("Deal struck at €140"));
        assert!(rendered.contains("Counterparty awaiting confirmation."));
        assert!(rendered.contains("/klodi yes:abc12345"));
        assert!(rendered.contains("/klodi no:abc12345"));
    }

    #[test]
    fn render_payload_honours_explicit_reply_hint() {
        let payload = Notification {
            event_kind: "klodi_tx_confirm.approval".into(),
            summary: "Authorize €600 escrow release?".into(),
            details: None,
            severity: Severity::ApprovalRequest,
            structured: None,
            correlation_id: None,
            reply_hint: Some("Reply: /klodi approve:req-1  or  /klodi deny:req-1".into()),
        };
        let rendered = render_payload(&payload, "req-1");
        assert!(rendered.contains("/klodi approve:req-1"));
        assert!(rendered.contains("/klodi deny:req-1"));
        // Default hint must NOT appear when an explicit one is given.
        assert!(!rendered.contains("to confirm"));
    }

    #[test]
    fn render_payload_embeds_structured_as_fenced_json() {
        let payload = Notification {
            event_kind: "search.match".into(),
            summary: "3 matches".into(),
            details: None,
            severity: Severity::Operator,
            structured: Some(serde_json::json!({ "count": 3 })),
            correlation_id: None,
            reply_hint: None,
        };
        let rendered = render_payload(&payload, "tok");
        assert!(rendered.contains("```json"));
        assert!(rendered.contains("\"count\""));
        assert!(rendered.contains("```\n") || rendered.ends_with("```")
                || rendered.contains("```"));
    }

    #[test]
    fn short_token_is_lower_case_hex_eight_chars() {
        let t = short_token();
        assert_eq!(t.len(), 8);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[tokio::test]
    async fn resolve_destination_address_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let ch = DashboardChannel::new(
            ws_config(),
            ledger(),
            cursor_path(dir.path()),
        )
        .unwrap();
        let err = ch
            .resolve_destination(&Recipient::Address("123".into()))
            .await
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("DashboardChannel"),
            "expected DashboardChannel error, got: {err}"
        );
    }

    fn empty_adjacency() -> HashMap<String, AdjacencyEntry> {
        HashMap::new()
    }

    fn single_adjacency(id: &str, session: &str) -> HashMap<String, AdjacencyEntry> {
        let mut m = HashMap::new();
        m.insert(
            id.to_string(),
            AdjacencyEntry {
                sent_at: Instant::now(),
                session_id: session.to_string(),
            },
        );
        m
    }

    #[test]
    fn classify_drops_empty_text() {
        assert!(classify_reply("", &empty_adjacency()).is_empty());
        assert!(classify_reply("   \n\t ", &empty_adjacency()).is_empty());
    }

    #[test]
    fn classify_klodi_prefix_with_verb_colon_id_extracts_id() {
        let outcomes = classify_reply("/klodi yes:abc12345", &empty_adjacency());
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].correlation_id.as_deref(), Some("abc12345"));
        assert_eq!(outcomes[0].text, "/klodi yes:abc12345");
    }

    #[test]
    fn classify_klodi_prefix_without_colon_returns_none_correlation() {
        let outcomes = classify_reply("/klodi confirm please", &empty_adjacency());
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].correlation_id.is_none());
    }

    #[test]
    fn classify_klodi_prefix_case_insensitive() {
        let outcomes = classify_reply("/KLODI yes:tok-9", &empty_adjacency());
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].correlation_id.as_deref(), Some("tok-9"));
    }

    #[test]
    fn classify_bare_affirmation_inside_window_matches_open_notification() {
        let adj = single_adjacency("req-1", "session-X");
        let outcomes = classify_reply("yes", &adj);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].correlation_id.as_deref(), Some("req-1"));
    }

    #[test]
    fn classify_bare_denial_inside_window_matches_open_notification() {
        let adj = single_adjacency("req-1", "session-X");
        let outcomes = classify_reply("cancel that", &adj);
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].correlation_id.as_deref(), Some("req-1"));
    }

    #[test]
    fn classify_bare_token_without_open_notification_drops() {
        let outcomes = classify_reply("yes please", &empty_adjacency());
        assert!(outcomes.is_empty());
    }

    #[test]
    fn classify_word_boundary_avoids_false_positive() {
        // "yesterday" contains the bytes of "yes" but isn't a word
        // boundary match — must not bridge.
        let adj = single_adjacency("req-1", "session-X");
        let outcomes = classify_reply("yesterday i sold a chair", &adj);
        assert!(outcomes.is_empty());
    }

    #[test]
    fn classify_multiple_open_notifications_emits_one_per_candidate() {
        let mut adj = HashMap::new();
        adj.insert(
            "req-a".to_string(),
            AdjacencyEntry {
                sent_at: Instant::now(),
                session_id: "s".into(),
            },
        );
        adj.insert(
            "req-b".to_string(),
            AdjacencyEntry {
                sent_at: Instant::now(),
                session_id: "s".into(),
            },
        );
        let outcomes = classify_reply("approve", &adj);
        assert_eq!(outcomes.len(), 2);
        let ids: std::collections::HashSet<_> = outcomes
            .iter()
            .map(|o| o.correlation_id.as_deref().unwrap_or(""))
            .collect();
        assert!(ids.contains("req-a"));
        assert!(ids.contains("req-b"));
    }

    #[test]
    fn classify_non_reply_text_drops() {
        let outcomes = classify_reply("just thinking out loud", &empty_adjacency());
        assert!(outcomes.is_empty());
    }

    #[test]
    fn classify_klodi_prefix_with_only_prefix_returns_none_correlation() {
        let outcomes = classify_reply("/klodi", &empty_adjacency());
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].correlation_id.is_none());
    }

    #[tokio::test]
    async fn record_adjacency_inserts_and_reaps_expired() {
        let dir = tempfile::tempdir().unwrap();
        let ch = DashboardChannel::new(
            ws_config(),
            ledger(),
            cursor_path(dir.path()),
        )
        .unwrap();
        ch.record_adjacency("req-1", "session-A").await;
        let snap = ch.adjacency_snapshot().await;
        assert_eq!(snap.len(), 1);
        assert!(snap.contains_key("req-1"));
        // Manually push an expired entry and confirm next record reaps.
        {
            let mut g = ch.inner.adjacency.lock().await;
            g.insert(
                "req-old".to_string(),
                AdjacencyEntry {
                    sent_at: Instant::now()
                        .checked_sub(ADJACENCY_WINDOW + Duration::from_secs(1))
                        .unwrap(),
                    session_id: "session-A".into(),
                },
            );
        }
        ch.record_adjacency("req-2", "session-A").await;
        let snap = ch.adjacency_snapshot().await;
        assert!(snap.contains_key("req-1"));
        assert!(snap.contains_key("req-2"));
        assert!(!snap.contains_key("req-old"));
    }

    #[test]
    fn has_word_respects_word_boundaries() {
        assert!(has_word("yes", "yes"));
        assert!(has_word("oh yes please", "yes"));
        assert!(!has_word("yesterday", "yes"));
        assert!(!has_word("eyes", "yes"));
        assert!(has_word("approve!", "approve"));
        assert!(has_word("approve. please.", "approve"));
        assert!(!has_word("approval", "approve"));
    }

    #[test]
    fn matches_bare_vocab_recognises_affirmation_and_denial() {
        assert!(matches_bare_vocab("yes"));
        assert!(matches_bare_vocab("YES PLEASE"));
        assert!(matches_bare_vocab("no thanks"));
        assert!(matches_bare_vocab("cancel"));
        assert!(matches_bare_vocab("deny"));
        assert!(!matches_bare_vocab("maybe"));
        // `ok maybe later` matches via the bare `ok` token — that's
        // an acknowledged false-positive of the bare-affirmation
        // approach (open question to refine on real-use feedback).
        // It only matters when there's an open notification in the
        // adjacency window AND `klodi.toml` allows bare-affirmation
        // matching; the approval gate's stricter `evaluate_retry`
        // then has the final say.
        assert!(matches_bare_vocab("ok maybe later"));
        // Multi-word token.
        assert!(matches_bare_vocab("do it"));
    }
}
