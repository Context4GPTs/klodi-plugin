//! Persisted ZeroClaw operator-session id under `${KLODI_HOME}/zeroclaw.session`.
//!
//! The plugin owns one operator session per persona and writes every
//! wake / report / approval prompt into it.
//!
//! Lifecycle:
//!
//! 1. Daemon starts → calls [`resolve_session_id`].
//! 2. If `${KLODI_HOME}/zeroclaw.session` exists, a non-side-effecting
//!    `GET /api/sessions` membership check decides what to do with the
//!    cached id:
//!    - Listed with `message_count > 0` → WS-probe to validate
//!      bearer/handshake; reuse the cached id.
//!    - Listed with `message_count == 0` (the phantom-empty shape) OR
//!      not listed → atomic-rebootstrap via
//!      [`zeroclaw_ws::bootstrap_session_with_first_message`] and
//!      persist the new id.
//!    - REST failure (5xx, 401, transport) → propagate as Err. Operator
//!      sees it; we don't silently rebootstrap on infrastructure
//!      problems.
//! 3. If the file is missing, mint a fresh session via the atomic path
//!    and persist the id.
//!
//! Why REST **before** WS, not after: connecting `/ws/chat?session_id=<X>`
//! to an unknown `<X>` silently re-mints `<X>` server-side as an empty
//! session. If we discovered the phantom only after probing WS we'd
//! already have created it ourselves — and the subsequent rebootstrap
//! would land on a different id than the one our
//! `${KLODI_HOME}/zeroclaw.session` references. `GET /api/sessions` is
//! the only way to ask "does this id exist with content?" without that
//! side effect. The dashboard channel's T5 stale-session check
//! (`channels::session_health`) already enforces the same invariant
//! before every notify; this is the operator-session resolver catching
//! up.
//!
//! The persistence layer reuses [`klodi_secret_write`] so the session-id
//! file lands atomically with mode 0600 (it's not as sensitive as
//! `nats.creds`, but it identifies the operator's chat session and we
//! treat anything written under `${KLODI_HOME}` consistently).

use anyhow::{Context, Result};
use klodi_nats_client::klodi_secret_write;
use reqwest::Client as HttpClient;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::channels::session_health::{SessionHealth, check_session_alive};
use crate::zeroclaw_ws::{self, SessionOutcome, ZeroClawWsConfig};

/// REST timeout for the pre-WS membership check. Bounded short because
/// the daemon's [`resolve_session_id`] is on the startup critical path —
/// every second the gate spends waiting on a wedged gateway is a second
/// before the forwarder can start draining wakes. Same posture as
/// `channels::upstream::CHANNELS_REST_TIMEOUT`.
const REST_GATE_TIMEOUT: Duration = Duration::from_secs(10);

/// `${KLODI_HOME}/zeroclaw.session` — the persisted operator-session UUID.
pub fn session_path(klodi_home: &Path) -> PathBuf {
    klodi_home.join("zeroclaw.session")
}

/// Outcome of a [`resolve_session_id`] call. Carries whether we minted a
/// fresh session this boot — the daemon uses this to decide whether to
/// post the bootstrap note or skip it on a steady-state restart.
#[derive(Debug, Clone)]
pub struct ResolvedSession {
    pub session_id: String,
    /// `true` iff this session was newly created during this call (no
    /// prior persisted id, OR the persisted id was rejected by the
    /// gateway and we re-bootstrapped). When `true`, the
    /// `bootstrap_message` passed into [`resolve_session_id`] has
    /// already been written into the session as its first user-role
    /// message — the daemon must NOT re-send the same heartbeat
    /// separately (it'd appear twice in the operator's chat).
    pub freshly_minted: bool,
    /// Whatever the gateway told us about message_count when we
    /// connected. Used in the bootstrap-note skip heuristic — a session
    /// with message_count > 0 has already received our intro.
    pub message_count: Option<u64>,
}

/// Read-or-bootstrap the ZeroClaw operator session for this persona.
///
/// Behaviour:
/// - If `${KLODI_HOME}/zeroclaw.session` exists, queries the gateway
///   via `GET /api/sessions` to classify the cached id:
///     - **Listed with `message_count > 0`** → WS-probes the id to
///       validate bearer/handshake; returns it (`freshly_minted: false`).
///       `bootstrap_message` is **ignored** in this path.
///     - **Listed with `message_count == 0`** OR **not listed** →
///       atomic-rebootstrap (`freshly_minted: true`). The old id is
///       overwritten on disk. Per the module-level lifecycle, this
///       covers both the phantom-empty case (gateway lost our session
///       and an unknown-id WS probe minted a fresh empty one) and the
///       outright-deleted case.
///     - **REST itself failed** (5xx, 401, transport) → returns Err.
///       Refuses to silently rebootstrap on infrastructure problems
///       since that would mask an outage as a successful first boot.
/// - If the file is missing, mints a new session **and atomically
///   writes `bootstrap_message` as the session's first user-role
///   message** (`freshly_minted: true`). Closes the empty-session GC
///   window observed against the gateway — a session with at least
///   one durable write survives the gateway's cleanup pass and is no
///   longer indistinguishable from the phantom-empty shape.
pub async fn resolve_session_id(
    klodi_home: &Path,
    cfg: &ZeroClawWsConfig,
    bootstrap_message: &str,
) -> Result<ResolvedSession> {
    let http = HttpClient::builder()
        .timeout(REST_GATE_TIMEOUT)
        .build()
        .context("building REST client for ZeroClaw session membership check")?;
    resolve_session_id_with_http(klodi_home, &http, cfg, bootstrap_message).await
}

/// Test seam for [`resolve_session_id`]. Production code calls the
/// public function (which builds its own client); tests inject a client
/// pointing at a [`wiremock`] server.
async fn resolve_session_id_with_http(
    klodi_home: &Path,
    http: &HttpClient,
    cfg: &ZeroClawWsConfig,
    bootstrap_message: &str,
) -> Result<ResolvedSession> {
    let path = session_path(klodi_home);
    let cached = read_session_file(&path)?;

    if let Some(session_id) = cached.as_deref() {
        match classify_cached_session(http, cfg, session_id).await {
            CachedSessionDecision::Alive { message_count } => {
                tracing::debug!(
                    cached_session = %session_id,
                    rest_message_count = message_count,
                    "klodi_zeroclaw_session_rest_alive_verifying_via_ws"
                );
                // REST vouched for "session exists with history". Now
                // verify the bearer + WS handshake by probing — that's
                // the one thing REST can't tell us. The phantom case
                // is already ruled out, so any WS error here is genuine
                // infrastructure (TLS, network, bearer rejected) and
                // must not silently rebootstrap.
                match zeroclaw_ws::probe_session(cfg, session_id).await {
                    Ok(SessionOutcome {
                        session_id: server_id,
                        message_count,
                        ..
                    }) => {
                        if server_id != session_id {
                            // REST said our cached id was alive but the
                            // WS resume landed on something else.
                            // Unexpected; persist the gateway's
                            // authoritative answer. bootstrap_message is
                            // NOT re-sent — REST confirmed the cached id
                            // already had content, so the daemon's
                            // bootstrap-note decision treats this as
                            // freshly_minted=false.
                            persist_session_file(&path, &server_id)?;
                            return Ok(ResolvedSession {
                                session_id: server_id,
                                freshly_minted: false,
                                message_count,
                            });
                        }
                        return Ok(ResolvedSession {
                            session_id: session_id.to_string(),
                            freshly_minted: false,
                            message_count,
                        });
                    }
                    Err(probe_err) => {
                        return Err(probe_err.context(format!(
                            "WS probe failed for cached ZeroClaw session at {} \
                             after REST confirmed it (REST/WS disagreement \
                             or transport failure — not silently rebootstrapping)",
                            path.display(),
                        )));
                    }
                }
            }
            CachedSessionDecision::PhantomEmpty { message_count } => {
                tracing::warn!(
                    cached_session = %session_id,
                    message_count = message_count,
                    "klodi_zeroclaw_session_rebootstrapping_phantom_empty"
                );
                // Fall through to bootstrap path.
            }
            CachedSessionDecision::RestMissing => {
                tracing::warn!(
                    cached_session = %session_id,
                    "klodi_zeroclaw_session_rebootstrapping_rest_missing"
                );
                // Fall through to bootstrap path.
            }
            CachedSessionDecision::Failed(err) => {
                return Err(err.context(format!(
                    "REST membership check for cached ZeroClaw session at {} \
                     failed; refusing to silently rebootstrap (infrastructure \
                     vs. state loss is an operator-visible distinction)",
                    path.display(),
                )));
            }
        }
    }

    // Bootstrap path: open WS, mint a session, atomically write the
    // first message before closing. This is the only place
    // bootstrap_message is consumed.
    let outcome =
        zeroclaw_ws::bootstrap_session_with_first_message(cfg, bootstrap_message)
            .await
            .context(
                "bootstrapping a fresh ZeroClaw session via WS /ws/chat \
                 with atomic first message",
            )?;
    persist_session_file(&path, &outcome.session_id)?;
    Ok(ResolvedSession {
        session_id: outcome.session_id,
        freshly_minted: true,
        message_count: outcome.message_count,
    })
}

/// Outcome of the REST membership check on a cached session id.
/// Internal — [`resolve_session_id_with_http`] dispatches on it.
#[derive(Debug)]
enum CachedSessionDecision {
    /// `GET /api/sessions` listed the id with `message_count > 0`.
    /// Caller proceeds to the WS probe.
    Alive { message_count: u64 },
    /// `GET /api/sessions` listed the id but with `message_count == 0`.
    /// Proof of server-side state loss: any session this plugin owns
    /// was created by `bootstrap_session_with_first_message`, so it
    /// always has at least the heartbeat as message #1. A count of 0
    /// on a cached id means the gateway lost the session and an
    /// unknown-id WS probe (likely a prior daemon startup before this
    /// fix) silently re-minted it empty. Rebootstrap.
    PhantomEmpty { message_count: u64 },
    /// `GET /api/sessions` didn't list the id. Rebootstrap.
    RestMissing,
    /// REST itself failed — 5xx, 401, transport. Infrastructure, not
    /// state loss; caller propagates so the operator sees it.
    Failed(anyhow::Error),
}

async fn classify_cached_session(
    http: &HttpClient,
    cfg: &ZeroClawWsConfig,
    session_id: &str,
) -> CachedSessionDecision {
    match check_session_alive(http, cfg, session_id).await {
        SessionHealth::Alive { message_count } => {
            CachedSessionDecision::Alive { message_count }
        }
        SessionHealth::Resurrected { message_count } => {
            CachedSessionDecision::PhantomEmpty { message_count }
        }
        SessionHealth::Missing => CachedSessionDecision::RestMissing,
        SessionHealth::Unknown { error } => {
            CachedSessionDecision::Failed(anyhow::anyhow!(error))
        }
    }
}

/// Adopt an explicit operator-supplied session id. Probes the gateway
/// to confirm the id exists + the bearer can resume it; persists
/// `${KLODI_HOME}/zeroclaw.session` on success. Bails loudly on any
/// failure — operator typos must not silently fall through to a fresh
/// bootstrap (that'd defeat the purpose of the explicit adopt).
///
/// Used by the `klodi-zeroclaw-daemon --adopt-session=<uuid>` /
/// `ZEROCLAW_ADOPT_SESSION=<uuid>` operator opt-in for the
/// pre-existing-session-collision case.
pub async fn adopt_session_id(
    klodi_home: &Path,
    cfg: &ZeroClawWsConfig,
    session_id: &str,
) -> Result<ResolvedSession> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        anyhow::bail!("--adopt-session value is empty");
    }
    let outcome = zeroclaw_ws::probe_session(cfg, trimmed).await
        .with_context(|| format!(
            "adopting ZeroClaw session {trimmed}: gateway rejected the resume \
             (typo? wrong bearer? session deleted?)"
        ))?;
    if outcome.session_id != trimmed {
        anyhow::bail!(
            "--adopt-session={trimmed}: gateway echoed back a different id ({}) — refusing to persist a mismatched session",
            outcome.session_id,
        );
    }
    let path = session_path(klodi_home);
    persist_session_file(&path, &outcome.session_id)?;
    Ok(ResolvedSession {
        session_id: outcome.session_id,
        // Adopted sessions count as not-freshly-minted: the daemon
        // should post a heartbeat into them but skip the bootstrap
        // note (the operator already has chat history they care about).
        freshly_minted: false,
        message_count: outcome.message_count,
    })
}

fn read_session_file(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        // Empty file = treat as not-yet-persisted; safer than passing
        // the empty string into the WS resume URL (where it'd produce
        // a "missing session_id" error).
        return Ok(None);
    }
    Ok(Some(trimmed.to_string()))
}

fn persist_session_file(path: &Path, session_id: &str) -> Result<()> {
    if session_id.is_empty() {
        anyhow::bail!("refusing to persist empty session id at {}", path.display());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    klodi_secret_write(path, session_id.as_bytes(), 0o600)
        .with_context(|| format!("klodi_secret_write {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn session_path_lives_under_klodi_home() {
        let dir = tempdir().unwrap();
        assert_eq!(
            session_path(dir.path()),
            dir.path().join("zeroclaw.session"),
        );
    }

    #[test]
    fn read_session_file_returns_none_when_absent() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        assert!(read_session_file(&path).unwrap().is_none());
    }

    #[test]
    fn read_session_file_treats_whitespace_as_absent() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        fs::write(&path, "   \n\t  \n").unwrap();
        assert!(read_session_file(&path).unwrap().is_none());
    }

    #[test]
    fn read_session_file_strips_trailing_whitespace() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        fs::write(&path, "abc-123\n").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("abc-123"),
        );
    }

    #[test]
    fn persist_session_file_writes_and_reads_back() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "session-uuid-1").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("session-uuid-1"),
        );
    }

    #[test]
    fn persist_session_file_rejects_empty() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        assert!(persist_session_file(&path, "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn persist_session_file_writes_mode_0600() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "abc").unwrap();
        let mode = fs::metadata(&path).unwrap().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 mode, got {mode:o}");
    }

    #[test]
    fn persist_session_file_overwrites_existing() {
        let dir = tempdir().unwrap();
        let path = session_path(dir.path());
        persist_session_file(&path, "first").unwrap();
        persist_session_file(&path, "second").unwrap();
        assert_eq!(
            read_session_file(&path).unwrap().as_deref(),
            Some("second"),
        );
    }

    // ---------------------------------------------------------------
    // REST gate (classify_cached_session) — wiremock-driven.
    //
    // Pins the GET /api/sessions decision matrix so the phantom-empty
    // fix can't silently regress. End-to-end coverage of the
    // rebootstrap WS path (REST Missing/Phantom → bootstrap_session_with_first_message)
    // needs a WS mock harness and lives in a follow-up — for now we
    // assert that REST failures don't trigger a silent rebootstrap.
    // ---------------------------------------------------------------

    use wiremock::matchers::{method, path as wm_path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Builds a `ZeroClawWsConfig` pointing REST at the wiremock URI.
    /// `ws_url` is set to a port that won't connect — these tests
    /// must never reach WS; a regression that does will surface as a
    /// loud test failure rather than a silent pass.
    fn test_config(http_base: &str) -> ZeroClawWsConfig {
        ZeroClawWsConfig {
            ws_url: "ws://127.0.0.1:9/ws/chat".to_string(),
            http_base: http_base.to_string(),
            bearer: "zc_test_bearer".to_string(),
        }
    }

    #[tokio::test]
    async fn classify_alive_when_listed_with_messages() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessions": [
                    {"id": "other-id", "message_count": 1},
                    {"id": "cached-id", "message_count": 3}
                ]
            })))
            .mount(&server)
            .await;
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        match classify_cached_session(&http, &cfg, "cached-id").await {
            CachedSessionDecision::Alive { message_count } => {
                assert_eq!(message_count, 3);
            }
            other => panic!("expected Alive, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn classify_phantom_when_listed_with_zero_count() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessions": [{"id": "cached-id", "message_count": 0}]
            })))
            .mount(&server)
            .await;
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        match classify_cached_session(&http, &cfg, "cached-id").await {
            CachedSessionDecision::PhantomEmpty { message_count } => {
                assert_eq!(message_count, 0);
            }
            other => panic!("expected PhantomEmpty, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn classify_missing_when_not_listed() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "sessions": [{"id": "some-other-id", "message_count": 1}]
            })))
            .mount(&server)
            .await;
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        match classify_cached_session(&http, &cfg, "cached-id").await {
            CachedSessionDecision::RestMissing => {}
            other => panic!("expected RestMissing, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn classify_failed_on_5xx() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        match classify_cached_session(&http, &cfg, "cached-id").await {
            CachedSessionDecision::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn classify_failed_on_401() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        match classify_cached_session(&http, &cfg, "cached-id").await {
            CachedSessionDecision::Failed(_) => {}
            other => panic!("expected Failed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_propagates_5xx_and_leaves_file_intact() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let dir = tempdir().unwrap();
        let session_file = session_path(dir.path());
        persist_session_file(&session_file, "cached-id").unwrap();
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        let err = resolve_session_id_with_http(dir.path(), &http, &cfg, "heartbeat")
            .await
            .expect_err("REST 503 must propagate as Err");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("refusing to silently rebootstrap"),
            "error must explain the infrastructure-vs-state-loss posture, got: {msg}",
        );
        // Persisted file must be unchanged — operator can debug the
        // outage without losing the cached id.
        assert_eq!(
            read_session_file(&session_file).unwrap().as_deref(),
            Some("cached-id"),
            "session file must not be rewritten when REST itself fails",
        );
    }

    #[tokio::test]
    async fn resolve_propagates_401() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(wm_path("/api/sessions"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let dir = tempdir().unwrap();
        let session_file = session_path(dir.path());
        persist_session_file(&session_file, "cached-id").unwrap();
        let cfg = test_config(&server.uri());
        let http = reqwest::Client::new();
        let err = resolve_session_id_with_http(dir.path(), &http, &cfg, "heartbeat")
            .await
            .expect_err("REST 401 must propagate as Err");
        assert!(
            format!("{err:#}").contains("refusing to silently rebootstrap"),
        );
        assert_eq!(
            read_session_file(&session_file).unwrap().as_deref(),
            Some("cached-id"),
        );
    }
}
