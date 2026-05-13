//! Wake-time HTTP client for the ZeroClaw `spawn-an-agent-per-event`
//! transition described in `docs/plans/2026-05-12-klodi-wake-agent-spawn.md`.
//!
//! Two paths, picked at runtime based on what the gateway supports:
//!
//! - **Native spawn** — `POST /api/agent/spawn` with the wake prompt as
//!   `prompt`. One round-trip; gateway runs `agent::run` in a fresh
//!   isolated session and returns when the turn ends. Used when the
//!   gateway advertises the endpoint.
//! - **Cron fallback** — two-step `POST /api/cron` (one-shot, isolated,
//!   delete-after-run) + `POST /api/cron/{id}/run`. Semantically the
//!   same; heavier; ships today against current ZeroClaw releases.
//!
//! Both paths ACK on HTTP 200, decoupled from the agent turn duration.
//! That preserves NATS ack latency (<50ms) regardless of how long the
//! LLM takes to reason about the event.

use anyhow::{Context, Result};
use reqwest::Client as HttpClient;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

/// What ZeroClaw returns after a successful spawn. The native and cron
/// paths normalise to the same shape so the caller doesn't need to know
/// which path was used.
#[derive(Debug, Clone)]
pub struct SpawnOutcome {
    /// The transient session id ZeroClaw ran the turn in. Returned by
    /// both `/api/agent/spawn` (`session_id`) and `/api/cron/{id}/run`
    /// (`session_id`). Useful for log correlation; the operator never
    /// sees this id directly.
    pub session_id: Option<String>,
    /// Which path served this spawn — informational; the caller treats
    /// both as equivalent.
    pub path: SpawnPath,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnPath {
    /// `POST /api/agent/spawn`.
    Native,
    /// `POST /api/cron` + `POST /api/cron/{id}/run`.
    Cron,
}

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("spawn HTTP transport: {0}")]
    Transport(#[from] reqwest::Error),
    #[error("spawn returned non-2xx: {status} {body}")]
    NonSuccess { status: StatusCode, body: String },
    #[error("spawn response decode: {0}")]
    Decode(String),
}

/// Per-call timeout for each individual HTTP request. The spawn endpoints
/// return as soon as the agent has been scheduled (cron path) or its
/// turn has ended (native path). Cron `/run` may block on the turn, but
/// the gateway's `TimeoutLayer` for cron is not the same 30s ceiling
/// that bit `/webhook` — the gateway tolerates long turns there.
const SPAWN_REQUEST_TIMEOUT: Duration = Duration::from_secs(600);

/// HTTP client for the ZeroClaw spawn endpoints. One instance per
/// daemon; clones cheap (the inner `reqwest::Client` is `Arc`).
#[derive(Clone)]
pub struct SpawnClient {
    http: HttpClient,
    http_base: String,
    bearer: String,
    /// Whether the daemon should try native `/api/agent/spawn` first.
    /// Defaults to `true`; the first 404/405 silently flips it to
    /// `false` for the rest of this process's lifetime so we don't
    /// pay the failed-native round-trip on every wake against an
    /// older gateway. Stored behind an atomic so the flip is
    /// observable from all NATS subscriber tasks without contention.
    native_enabled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Serialize)]
struct NativeSpawnBody<'a> {
    prompt: &'a str,
    allowed_tools: &'a [&'static str],
}

#[derive(Deserialize)]
struct NativeSpawnResponse {
    #[serde(default)]
    session_id: Option<String>,
}

#[derive(Serialize)]
struct CronCreateBody<'a> {
    /// Upstream zeroclaw wants `schedule` as a bare string (`"now"` for
    /// fire-on-next-tick) — serialising it as `{ "at": "now" }` makes the
    /// gateway 422 with `invalid type: map, expected a string`. The
    /// daemon also explicitly calls `/run` after create to avoid relying
    /// on the gateway's tick latency.
    schedule: &'static str,
    agent: bool,
    command: &'a str,
    session_target: &'static str,
    delete_after_run: bool,
    delivery: CronDelivery,
}

#[derive(Serialize)]
struct CronDelivery {
    mode: &'static str,
}

#[derive(Deserialize)]
struct CronCreateResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default, alias = "cron_id")]
    cron_id: Option<String>,
}

#[derive(Deserialize)]
struct CronRunResponse {
    #[serde(default)]
    session_id: Option<String>,
}

/// Tools the spawned agent is allowed to use. The wake prompt advertises
/// `klodi_*` for marketplace actions and `sessions_send` for writing to
/// the operator's chat. Anything else the gateway exposes is intentionally
/// not authorised — keeps each spawn's blast radius narrow.
const ALLOWED_TOOLS: &[&str] = &["klodi_*", "sessions_send", "sessions_history"];

impl SpawnClient {
    /// Build a new client. `http_base` is the gateway base URL with no
    /// trailing slash (e.g. `http://127.0.0.1:7070`).
    pub fn new(http_base: impl Into<String>, bearer: impl Into<String>) -> Result<Self> {
        let http = HttpClient::builder()
            .timeout(SPAWN_REQUEST_TIMEOUT)
            .user_agent(concat!(
                "klodi-rust-host/",
                env!("CARGO_PKG_VERSION"),
                " (spawn)"
            ))
            .build()
            .context("building spawn HTTP client")?;
        Ok(Self {
            http,
            http_base: http_base.into().trim_end_matches('/').to_string(),
            bearer: bearer.into(),
            native_enabled: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
        })
    }

    /// Force the cron-fallback path for the entire lifetime of this
    /// client. Useful for operators who know their gateway doesn't
    /// implement `/api/agent/spawn` and want to avoid the per-wake
    /// probe cost on the first request.
    pub fn force_cron_fallback(self) -> Self {
        self.native_enabled
            .store(false, std::sync::atomic::Ordering::Relaxed);
        self
    }

    /// Spawn an isolated agent session for `prompt`. Tries the native
    /// path first when enabled; falls back to cron transparently on
    /// 404 / 405 from `/api/agent/spawn`.
    pub async fn spawn(&self, prompt: &str) -> Result<SpawnOutcome, SpawnError> {
        if self.native_enabled.load(std::sync::atomic::Ordering::Relaxed) {
            match self.try_native(prompt).await {
                Ok(outcome) => return Ok(outcome),
                Err(SpawnError::NonSuccess { status, .. })
                    if status == StatusCode::NOT_FOUND
                        || status == StatusCode::METHOD_NOT_ALLOWED =>
                {
                    self.native_enabled
                        .store(false, std::sync::atomic::Ordering::Relaxed);
                    tracing::info!(
                        status = %status,
                        "klodi_zeroclaw_spawn_native_unavailable_falling_back_to_cron"
                    );
                }
                Err(err) => return Err(err),
            }
        }
        self.try_cron(prompt).await
    }

    async fn try_native(&self, prompt: &str) -> Result<SpawnOutcome, SpawnError> {
        let url = format!("{}/api/agent/spawn", self.http_base);
        let body = NativeSpawnBody {
            prompt,
            allowed_tools: ALLOWED_TOOLS,
        };
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.bearer)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(SpawnError::NonSuccess { status, body });
        }
        let parsed: NativeSpawnResponse = resp
            .json()
            .await
            .map_err(|err| SpawnError::Decode(err.to_string()))?;
        Ok(SpawnOutcome {
            session_id: parsed.session_id,
            path: SpawnPath::Native,
        })
    }

    async fn try_cron(&self, prompt: &str) -> Result<SpawnOutcome, SpawnError> {
        let cron_id = self.create_cron(prompt).await?;
        let session_id = self.run_cron(&cron_id).await?;
        Ok(SpawnOutcome {
            session_id,
            path: SpawnPath::Cron,
        })
    }

    async fn create_cron(&self, prompt: &str) -> Result<String, SpawnError> {
        let url = format!("{}/api/cron", self.http_base);
        let body = CronCreateBody {
            schedule: "now",
            agent: true,
            command: prompt,
            session_target: "isolated",
            delete_after_run: true,
            delivery: CronDelivery { mode: "none" },
        };
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.bearer)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(SpawnError::NonSuccess { status, body });
        }
        let parsed: CronCreateResponse = resp
            .json()
            .await
            .map_err(|err| SpawnError::Decode(err.to_string()))?;
        parsed
            .id
            .or(parsed.cron_id)
            .ok_or_else(|| SpawnError::Decode("cron create response missing id".into()))
    }

    async fn run_cron(&self, cron_id: &str) -> Result<Option<String>, SpawnError> {
        let url = format!("{}/api/cron/{cron_id}/run", self.http_base);
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.bearer)
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(SpawnError::NonSuccess { status, body });
        }
        // Some gateway versions return no body; tolerate that.
        let body = resp.text().await.unwrap_or_default();
        if body.trim().is_empty() {
            return Ok(None);
        }
        let parsed: CronRunResponse = serde_json::from_str(&body)
            .map_err(|err| SpawnError::Decode(err.to_string()))?;
        Ok(parsed.session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, header, method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client_for(server: &MockServer) -> SpawnClient {
        SpawnClient::new(server.uri(), "zc_test_bearer".to_string()).unwrap()
    }

    #[tokio::test]
    async fn native_path_returns_session_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/api/agent/spawn"))
            .and(header("Authorization", "Bearer zc_test_bearer"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "session_id": "s-1" })),
            )
            .mount(&server)
            .await;
        let client = client_for(&server);
        let outcome = client.spawn("prompt body").await.unwrap();
        assert_eq!(outcome.session_id.as_deref(), Some("s-1"));
        assert_eq!(outcome.path, SpawnPath::Native);
    }

    #[tokio::test]
    async fn falls_back_to_cron_on_404() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/api/agent/spawn"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        // Asserts the wire shape upstream zeroclaw expects: `schedule` as a
        // bare string, not `{ "at": "now" }`. A regression here would 422
        // every wake against the live gateway.
        Mock::given(method("POST"))
            .and(wm_path("/api/cron"))
            .and(body_partial_json(serde_json::json!({
                "schedule": "now",
                "agent": true,
                "session_target": "isolated",
                "delete_after_run": true,
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "cron-1" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wm_path("/api/cron/cron-1/run"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "session_id": "s-2" })),
            )
            .mount(&server)
            .await;
        let client = client_for(&server);
        let outcome = client.spawn("prompt body").await.unwrap();
        assert_eq!(outcome.session_id.as_deref(), Some("s-2"));
        assert_eq!(outcome.path, SpawnPath::Cron);
    }

    #[tokio::test]
    async fn second_call_after_404_skips_native() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/api/agent/spawn"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wm_path("/api/cron"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "cron_id": "c-1" })),
            )
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wm_path("/api/cron/c-1/run"))
            .respond_with(ResponseTemplate::new(200).set_body_string(""))
            .expect(2)
            .mount(&server)
            .await;
        let client = client_for(&server);
        let first = client.spawn("p1").await.unwrap();
        let second = client.spawn("p2").await.unwrap();
        assert_eq!(first.path, SpawnPath::Cron);
        assert_eq!(second.path, SpawnPath::Cron);
        assert!(second.session_id.is_none());
    }

    #[tokio::test]
    async fn force_cron_fallback_bypasses_native() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/api/cron"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "id": "c-1" })),
            )
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(wm_path("/api/cron/c-1/run"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "session_id": "s-3" })),
            )
            .mount(&server)
            .await;
        let client = client_for(&server).force_cron_fallback();
        let outcome = client.spawn("prompt").await.unwrap();
        assert_eq!(outcome.path, SpawnPath::Cron);
        assert_eq!(outcome.session_id.as_deref(), Some("s-3"));
    }

    #[tokio::test]
    async fn non_404_native_error_surfaces() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(wm_path("/api/agent/spawn"))
            .respond_with(ResponseTemplate::new(500).set_body_string("boom"))
            .mount(&server)
            .await;
        let client = client_for(&server);
        let err = client.spawn("prompt").await.unwrap_err();
        match err {
            SpawnError::NonSuccess { status, body } => {
                assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
                assert!(body.contains("boom"));
            }
            other => panic!("expected NonSuccess, got {other:?}"),
        }
    }
}
