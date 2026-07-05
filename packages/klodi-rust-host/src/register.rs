//! Shared HTTP-only registration loop for the Rust adapters.
//!
//! Mints a session UUID, prints the auth URL, polls
//! `${api_url}/api/sessions/<id>` every 5s for up to 10 min, and on
//! `status: completed` writes `${KLODI_HOME}/nats.creds` (mode 0600) +
//! `${KLODI_HOME}/config.json` via [`klodi_secret_write`][secret-write]
//! — atomic + TOCTOU-free.
//!
//! [secret-write]: klodi_nats_client::klodi_secret_write

use anyhow::{Context, Result, bail};
use klodi_nats_client::klodi_secret_write;
use reqwest::Client as HttpClient;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use uuid::Uuid;

// Per **R § P2-10** + **D § Cluster V**: cadence lives in the catalog
// so TS / Py / Rust hosts agree.
const POLL_INTERVAL: Duration = Duration::from_secs(
    klodi_nats_client::catalog::REGISTER_POLL_INTERVAL_SECONDS as u64,
);
const POLL_DEADLINE: Duration = Duration::from_secs(
    klodi_nats_client::catalog::REGISTER_POLL_CEILING_SECONDS as u64,
);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// CLI-shaped registration arguments. Per-adapter binaries build this
/// from clap, then call [`run_register`].
pub struct RegisterArgs {
    pub api_url: String,
    pub klodi_home: PathBuf,
    /// User-Agent string the per-adapter binary identifies as.
    /// Example: `"klodi-moltis-register/0.2"`.
    pub user_agent: String,
    /// Name printed in error / re-run instructions when polling times
    /// out. Example: `"klodi-moltis-register"`.
    pub binary_name: String,
    /// When `true`, bypass the "creds already on disk → skip" branch
    /// and run a fresh OAuth flow even if `${KLODI_HOME}/nats.creds` +
    /// `config.json` are already populated. Wired to the
    /// `--force-register` flag on every Rust adapter's register binary
    /// — the operator-side equivalent of Hermes's `klodi_setup_repair`
    /// MCP tool. The Rust hosts can't expose an in-agent repair tool
    /// (the wake agent's MCP server runs on top of the very creds the
    /// repair would delete), so this flag is the runtime-native
    /// repair primitive for `klodi-zeroclaw`, `klodi-moltis`, and
    /// `klodi-ironclaw`.
    pub force_register: bool,
}

#[derive(Deserialize)]
struct SessionEnvelope {
    status: String,
    nats_creds: Option<String>,
    handle: Option<String>,
    user_id: Option<String>,
    nkey_public: Option<String>,
    nats_url: Option<String>,
    /// The register-response CA (card `auto-trust-nats-ca-from-register`).
    /// OPTIONAL — absent / null / empty ⇒ older `@klodi/web`; persist
    /// nothing, never fail registration. NOT in the required-field chain in
    /// `persist_session`.
    nats_ca: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<String>,
}

/// Run the registration flow. Returns once creds + config are written
/// to disk, or after `POLL_DEADLINE` of unproductive polling.
///
/// Short-circuits with `Ok(())` when `${KLODI_HOME}/nats.creds` is
/// non-empty and `${KLODI_HOME}/config.json` parses with a `handle` +
/// `user_id` — the operator already registered on a prior run, and a
/// fresh browser flow would just churn the marketplace `sessions` row.
/// This keeps non-interactive container boots alive on every restart
/// after the one-time setup.
///
/// Pass `force_register: true` (wired to the `--force-register` CLI
/// flag) to bypass the short-circuit and mint fresh credentials even
/// when creds already exist. That flag is the Rust-host equivalent of
/// Hermes's `klodi_setup_repair` MCP tool — operator-driven repair,
/// not an in-agent tool, because the Rust wake agent's MCP server
/// holds the very creds the repair would delete.
pub async fn run_register(args: RegisterArgs) -> Result<()> {
    if !args.force_register {
        if let Some(handle) = existing_creds_handle(&args.klodi_home) {
            println!(
                "Reusing existing klodi credentials at {} (handle @{}). \
                 Pass --force-register to mint fresh credentials.",
                args.klodi_home.display(),
                handle,
            );
            return Ok(());
        }
    } else if existing_creds_handle(&args.klodi_home).is_some() {
        println!(
            "--force-register set: minting fresh klodi credentials at {} \
             even though valid creds already exist there.",
            args.klodi_home.display(),
        );
    }
    let session_id = Uuid::new_v4().to_string();
    let auth_url = format!(
        "{}/authorize?session={}",
        trim_slash(&args.api_url),
        session_id,
    );
    println!("Open this URL in your browser to complete registration:");
    println!();
    println!("    {auth_url}");
    println!();
    println!(
        "Polling for completion (every {}s, up to {} min)…",
        POLL_INTERVAL.as_secs(),
        POLL_DEADLINE.as_secs() / 60,
    );

    let http = HttpClient::builder()
        .user_agent(&args.user_agent)
        .timeout(HTTP_TIMEOUT)
        .build()
        .context("building HTTP client")?;
    let session_url = format!(
        "{}/api/sessions/{}",
        trim_slash(&args.api_url),
        session_id,
    );

    let started = Instant::now();
    loop {
        if started.elapsed() >= POLL_DEADLINE {
            bail!(
                "registration timed out after {} min — re-run {} to start a new session",
                POLL_DEADLINE.as_secs() / 60,
                args.binary_name,
            );
        }
        match poll_once(&http, &session_url).await? {
            PollOutcome::Pending => {
                tokio::time::sleep(POLL_INTERVAL).await;
            }
            PollOutcome::Expired => {
                bail!(
                    "registration session expired before sign-up completed — re-run {} to start a new session",
                    args.binary_name,
                );
            }
            PollOutcome::AlreadyClaimed => {
                bail!(
                    "registration session was already claimed on another device — re-run {} to start a new session",
                    args.binary_name,
                );
            }
            PollOutcome::Completed(env) => {
                persist_session(&args.klodi_home, &env).await?;
                println!(
                    "Registration complete — welcome, @{}.",
                    env.handle.as_deref().unwrap_or("?"),
                );
                return Ok(());
            }
        }
    }
}

enum PollOutcome {
    Pending,
    Expired,
    AlreadyClaimed,
    Completed(SessionEnvelope),
}

async fn poll_once(http: &HttpClient, url: &str) -> Result<PollOutcome> {
    let resp = http
        .get(url)
        .send()
        .await
        .context("polling registration session")?;
    if !resp.status().is_success() {
        let status = resp.status();
        // 404 means the session row hasn't been materialised yet — the
        // web app's `GET /authorize` handler creates it on first browser
        // hit. Treat as pending so the next tick re-polls instead of
        // aborting the 10-min window on the first request.
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(PollOutcome::Pending);
        }
        let body: Option<ErrorEnvelope> = resp.json().await.ok();
        if body.as_ref().and_then(|b| b.error.as_deref())
            == Some("CREDENTIALS_ALREADY_CLAIMED")
        {
            return Ok(PollOutcome::AlreadyClaimed);
        }
        bail!("registration poll returned HTTP {status}");
    }
    let env: SessionEnvelope = resp
        .json()
        .await
        .context("parsing registration session response")?;
    match env.status.as_str() {
        "completed" => Ok(PollOutcome::Completed(env)),
        "expired" => Ok(PollOutcome::Expired),
        _ => Ok(PollOutcome::Pending),
    }
}

async fn persist_session(klodi_home: &Path, env: &SessionEnvelope) -> Result<()> {
    let creds = env
        .nats_creds
        .as_deref()
        .context("registration response missing nats_creds")?;
    let handle = env
        .handle
        .as_deref()
        .context("registration response missing handle")?;
    let user_id = env
        .user_id
        .as_deref()
        .context("registration response missing user_id")?;
    let nkey_public = env
        .nkey_public
        .as_deref()
        .context("registration response missing nkey_public")?;
    let nats_url = env
        .nats_url
        .as_deref()
        .context("registration response missing nats_url")?;

    // Per **D § D10** (P2-17 closure): refuse to persist a non-`tls://`
    // nats_url on a non-localhost host. Delegates to the single shared
    // client guard (accepts only `tls://` off localhost, rejecting
    // `wss://` / `ws://` / `nats://`) so persist-time and connect-time
    // policy can never drift. A compromised registration endpoint could
    // otherwise inject `ws://attacker.com` and trick the next connect
    // into an attacker-controlled session. The wrapping context keeps the
    // "plaintext" wording — the common refused case is a plaintext url.
    klodi_nats_client::config::assert_tls_or_localhost(nats_url)
        .context("registration response had a plaintext non-localhost nats_url")?;

    tokio::fs::create_dir_all(klodi_home)
        .await
        .with_context(|| format!("creating {}", klodi_home.display()))?;
    chmod_klodi_home(klodi_home).await?;

    // `klodi_secret_write` opens with mode at creation time and renames
    // atomically — closes the TOCTOU window the prior write+chmod pair
    // opened (P1-8 / P1-9). The helper runs synchronously, so we offload
    // to spawn_blocking to keep the async runtime healthy on slow disks.
    write_secret(klodi_home.join("nats.creds"), creds.as_bytes().to_vec()).await?;

    let config_bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "handle": handle,
        "user_id": user_id,
        "nkey_public": nkey_public,
        "nats_url": nats_url,
    }))?;
    write_secret(klodi_home.join("config.json"), config_bytes).await?;

    // Auto-trust the register-response CA (card
    // auto-trust-nats-ca-from-register): the ONE rust-host persist site
    // covers moltis + ironclaw + zeroclaw. `nats_ca` is OPTIONAL — it is not
    // in the `context()?` required-field chain above, so its absence never
    // fails registration. The shared helper skips an empty / non-PEM-shaped
    // value and never Errs, and an omission on a later re-register does NOT
    // delete the persisted file ("no update" ≠ "revoke"). A fresh value
    // overwrites → re-register is the CA-rotation path.
    if let Some(nats_ca) = env.nats_ca.clone() {
        let home = klodi_home.to_path_buf();
        tokio::task::spawn_blocking(move || {
            klodi_nats_client::persist_nats_ca(&home, &nats_ca)
        })
        .await
        .context("spawn_blocking persist_nats_ca")?
        .context("persisting register nats_ca")?;
    }
    Ok(())
}

async fn chmod_klodi_home(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o700);
        tokio::fs::set_permissions(path, perms)
            .await
            .with_context(|| format!("chmod 0700 {}", path.display()))?;
    }
    let _ = path; // silence unused-warning on non-unix
    Ok(())
}

async fn write_secret(path: PathBuf, body: Vec<u8>) -> Result<()> {
    let display = path.display().to_string();
    tokio::task::spawn_blocking(move || klodi_secret_write(&path, &body, 0o600))
        .await
        .with_context(|| format!("spawn_blocking write_secret {display}"))?
        .with_context(|| format!("klodi_secret_write {display}"))?;
    Ok(())
}

fn trim_slash(url: &str) -> &str {
    url.trim_end_matches('/')
}

/// Returns the cached handle when `${KLODI_HOME}/nats.creds` is
/// non-empty AND `config.json` parses with both `handle` + `user_id`
/// populated. Used by [`run_register`] to short-circuit the OAuth flow
/// on container restarts where the operator has already registered.
fn existing_creds_handle(klodi_home: &Path) -> Option<String> {
    let creds = klodi_home.join("nats.creds");
    if !creds.exists() || std::fs::metadata(&creds).ok()?.len() == 0 {
        return None;
    }
    read_config_identity(klodi_home).ok().map(|id| id.handle)
}

/// Read the `handle` + `user_id` fields from `${KLODI_HOME}/config.json`.
/// Used by adapter binaries that need them on the startup path before
/// `KlodiClient::new` has been called.
pub fn read_config_identity(klodi_home: &Path) -> Result<ConfigIdentity> {
    let path = klodi_home.join("config.json");
    let bytes = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let parsed: serde_json::Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parsing {} as JSON", path.display()))?;
    let handle = parsed
        .get("handle")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("config.json missing 'handle'"))?
        .to_string();
    let user_id = parsed
        .get("user_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("config.json missing 'user_id'"))?
        .to_string();
    Ok(ConfigIdentity { handle, user_id })
}

/// Subset of `${KLODI_HOME}/config.json` adapter binaries need before
/// dialling NATS.
#[derive(Debug, Clone)]
pub struct ConfigIdentity {
    pub handle: String,
    pub user_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn trim_slash_handles_trailing() {
        assert_eq!(trim_slash("https://klodi.4gpts.com/"), "https://klodi.4gpts.com");
        assert_eq!(trim_slash("https://klodi.4gpts.com"), "https://klodi.4gpts.com");
        assert_eq!(trim_slash("https://klodi.4gpts.com//"), "https://klodi.4gpts.com");
    }

    #[test]
    fn read_config_identity_extracts_handle_and_user_id() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"handle":"alice","user_id":"u1","nats_url":"wss://x"}"#,
        )
        .unwrap();
        let id = read_config_identity(dir.path()).unwrap();
        assert_eq!(id.handle, "alice");
        assert_eq!(id.user_id, "u1");
    }

    #[test]
    fn read_config_identity_errors_on_missing_handle() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"user_id":"u1","nats_url":"x"}"#,
        )
        .unwrap();
        let err = read_config_identity(dir.path()).unwrap_err().to_string();
        assert!(err.contains("handle"), "got: {err}");
    }

    fn write_valid_creds(dir: &Path) {
        std::fs::write(dir.join("nats.creds"), b"-----BEGIN NATS USER JWT-----\nstub\n").unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"handle":"alice","user_id":"u1","nkey_public":"UAAA","nats_url":"wss://x"}"#,
        )
        .unwrap();
    }

    #[test]
    fn existing_creds_handle_returns_handle_when_present() {
        let dir = tempdir().unwrap();
        write_valid_creds(dir.path());
        assert_eq!(existing_creds_handle(dir.path()).as_deref(), Some("alice"));
    }

    #[test]
    fn existing_creds_handle_rejects_missing_creds() {
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"handle":"alice","user_id":"u1"}"#,
        )
        .unwrap();
        assert!(existing_creds_handle(dir.path()).is_none());
    }

    #[test]
    fn existing_creds_handle_rejects_empty_creds() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nats.creds"), b"").unwrap();
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"handle":"alice","user_id":"u1"}"#,
        )
        .unwrap();
        assert!(existing_creds_handle(dir.path()).is_none());
    }

    #[test]
    fn existing_creds_handle_rejects_malformed_config() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("nats.creds"), b"stub").unwrap();
        // Missing `user_id` — `read_config_identity` errors, helper
        // swallows the Err and returns None so registration proceeds.
        std::fs::write(
            dir.path().join("config.json"),
            r#"{"handle":"alice"}"#,
        )
        .unwrap();
        assert!(existing_creds_handle(dir.path()).is_none());
    }

    #[tokio::test]
    async fn run_register_short_circuits_when_creds_exist() {
        use wiremock::MockServer;

        let dir = tempdir().unwrap();
        write_valid_creds(dir.path());

        // No mocks installed: any HTTP hit would 404 from wiremock and
        // the polling loop would either bail or run for 10 min. The
        // short-circuit branch must return before any request goes out.
        let server = MockServer::start().await;
        let api_url = server.uri();

        run_register(RegisterArgs {
            api_url,
            klodi_home: dir.path().to_path_buf(),
            user_agent: "klodi-test/0".into(),
            binary_name: "klodi-test".into(),
            force_register: false,
        })
        .await
        .expect("short-circuit should return Ok");

        assert!(
            server.received_requests().await.unwrap().is_empty(),
            "run_register hit the network despite valid creds being on disk",
        );
    }

    #[tokio::test]
    async fn run_register_force_register_bypasses_short_circuit() {
        use wiremock::matchers::{method, path_regex};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        // The operator-side repair primitive: creds exist on disk, but
        // --force-register is set, so the OAuth path must run anyway.
        let dir = tempdir().unwrap();
        write_valid_creds(dir.path());

        // Stub the first poll as "expired" — that exits the loop fast
        // with a known error so we can assert the OAuth path actually
        // ran without driving the full completed-session response.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/api/sessions/.+$"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "status": "expired" })),
            )
            .mount(&server)
            .await;

        let err = run_register(RegisterArgs {
            api_url: server.uri(),
            klodi_home: dir.path().to_path_buf(),
            user_agent: "klodi-test/0".into(),
            binary_name: "klodi-test".into(),
            force_register: true,
        })
        .await
        .expect_err("expired-session response should propagate as Err");
        assert!(
            err.to_string().contains("expired"),
            "expected expired-session error, got: {err}",
        );

        let requests = server.received_requests().await.unwrap();
        assert!(
            requests.iter().any(|r| r.url.path().starts_with("/api/sessions/")),
            "force_register=true must run the OAuth+poll path, but wiremock saw paths: {:?}",
            requests.iter().map(|r| r.url.path()).collect::<Vec<_>>(),
        );

        // The pre-existing creds on disk are untouched — the failed
        // OAuth attempt returned `Err(Expired)` before `persist_session`
        // had a chance to overwrite them. Operators who hit a transient
        // failure during repair don't lose their previous identity.
        assert!(dir.path().join("nats.creds").exists());
        assert!(dir.path().join("config.json").exists());
    }

    #[tokio::test]
    async fn run_register_after_creds_deleted_runs_full_flow() {
        use wiremock::matchers::{method, path_regex};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        // Covers the alternative repair flow: operator manually rm's
        // creds before re-running register. After the delete the
        // short-circuit must NOT fire even with force_register=false.
        let dir = tempdir().unwrap();
        write_valid_creds(dir.path());
        std::fs::remove_file(dir.path().join("nats.creds")).unwrap();
        std::fs::remove_file(dir.path().join("config.json")).unwrap();

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path_regex(r"^/api/sessions/.+$"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "status": "expired" })),
            )
            .mount(&server)
            .await;

        let err = run_register(RegisterArgs {
            api_url: server.uri(),
            klodi_home: dir.path().to_path_buf(),
            user_agent: "klodi-test/0".into(),
            binary_name: "klodi-test".into(),
            force_register: false,
        })
        .await
        .expect_err("expired-session response should propagate as Err");
        assert!(
            err.to_string().contains("expired"),
            "expected expired-session error, got: {err}",
        );
        let requests = server.received_requests().await.unwrap();
        assert!(
            requests.iter().any(|r| r.url.path().starts_with("/api/sessions/")),
            "expected at least one GET /api/sessions/<id> after creds were deleted, \
             got paths: {:?}",
            requests.iter().map(|r| r.url.path()).collect::<Vec<_>>(),
        );
    }
}
