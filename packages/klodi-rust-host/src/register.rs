//! Shared HTTP-only registration loop for the Rust adapters.
//!
//! Mints a session UUID, prints the auth URL, polls
//! `${api_url}/api/sessions/<id>` every 5s for up to 10 min, and on
//! `status: completed` writes `${KLODI_HOME}/nats.creds` (mode 0600) +
//! `${KLODI_HOME}/config.json` via [`klodi_secret_write`][secret-write]
//! — atomic + TOCTOU-free.
//!
//! Three identical copies previously lived under
//! `adapters/{moltis,ironclaw,zeroclaw}/src/register.rs`. Per **D § D8**
//! they collapse to one implementation here; the per-adapter binary
//! supplies the user-agent string + reset-instruction text via
//! [`RegisterArgs`].
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
}

#[derive(Deserialize)]
struct SessionEnvelope {
    status: String,
    nats_creds: Option<String>,
    handle: Option<String>,
    user_id: Option<String>,
    nkey_public: Option<String>,
    nats_url: Option<String>,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<String>,
}

/// Run the registration flow. Returns once creds + config are written
/// to disk, or after `POLL_DEADLINE` of unproductive polling.
pub async fn run_register(args: RegisterArgs) -> Result<()> {
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
                seed_policies_after_register(&args.klodi_home);
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

/// Best-effort policy seeding. Failures are logged + reported on stdout
/// but never block registration — the user's creds are already on disk
/// at this point and we'd rather have a registered host with missing
/// policies than fail the whole flow because a template is unreadable.
/// Surfaced issues are reported by `klodi_setup_status` on the next
/// run via the `negotiation_style_missing` / `security_policy_missing`
/// issue codes.
fn seed_policies_after_register(klodi_home: &Path) {
    match crate::policy_seed::seed_policies_if_absent(klodi_home) {
        Ok(report) => {
            let parts: Vec<&str> = [
                report.negotiation_style_seeded.then_some("negotiation_style.md"),
                report.security_policy_seeded.then_some("security.md"),
            ]
            .into_iter()
            .flatten()
            .collect();
            if !parts.is_empty() {
                println!("Seeded {}.", parts.join(" + "));
            }
        }
        Err(err) => {
            tracing::warn!(error = %err, "policy seeding failed during register");
            eprintln!(
                "warning: policy seeding failed ({err}); run klodi_setup_reseed_policies later.",
            );
        }
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

    // Per **D § D10** (P2-17 closure): refuse to persist a plaintext
    // nats_url on a non-localhost host. A compromised registration
    // endpoint could otherwise inject `ws://attacker.com` and trick the
    // next connect into a plaintext, attacker-controlled session.
    klodi_nats_client::config::assert_wss_or_localhost(nats_url)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_slash_handles_trailing() {
        assert_eq!(trim_slash("https://klodi.4gpts.com/"), "https://klodi.4gpts.com");
        assert_eq!(trim_slash("https://klodi.4gpts.com"), "https://klodi.4gpts.com");
        assert_eq!(trim_slash("https://klodi.4gpts.com//"), "https://klodi.4gpts.com");
    }
}
