//! `klodi_setup_status` — phase + issue + next-action reporter.
//!
//! Two consumers:
//!
//! - The per-adapter `klodi-<host>-setup-status` binary
//!   (operator-side diagnostic).
//! - The in-agent `klodi_setup_status` MCP tool (under feature `mcp`).
//!
//! Inspects `${KLODI_HOME}/{nats.creds,config.json}` and (for the
//! ZeroClaw adapter) `zeroclaw.{token,session}`. Returns a structured
//! phase, an issues list, and a single recommended `next_action`.
//!
//! The 2026-05-12 wake-agent-spawn redesign moved every operator-facing
//! decision into the spawned agent's prompt — including how to react to
//! missing or empty strategy files. The plugin no longer seeds
//! `policies/`, no longer enforces a `NeedsPolicy` phase, and no longer
//! surfaces `klodi_setup_reseed_policies` from this reporter.

use serde::Serialize;
use std::path::{Path, PathBuf};

/// Phase the agent / operator is in. Mirrors openclaw's reply shape so
/// agents read the same field across hosts. Order matters — phase
/// derivation walks the file checks top-to-bottom and returns the first
/// matching variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupPhase {
    /// Neither creds nor config exist yet — operator should run the
    /// `klodi-<host>-register` CLI binary.
    Unconfigured,
    /// One of creds / config is present but the other is missing — the
    /// previous registration crashed mid-write or the user deleted one
    /// file. Operator re-runs `klodi-<host>-register` (it overwrites
    /// atomically; preserves `buy/`, `sell/`, and operator-authored
    /// negotiation_style.md).
    Registering,
    /// All required files present. Daemon can connect and the spawn
    /// path can fire wakes.
    Ready,
}

/// Single recommended next step. Daemons map `Cli` to a console message;
/// agents map `Tool` to an in-process `tools/call`, `Shell` to a console
/// message, and `Dialog` to a UI prompt. Empty when phase is `Ready`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NextAction {
    /// Run a host-specific CLI binary. The agent surfaces the command;
    /// it does not invoke shells itself.
    Cli {
        command: String,
        message: String,
    },
    /// Call another klodi MCP tool. The agent invokes it directly.
    Tool {
        tool: String,
        message: String,
    },
    /// A shell command the user runs. The agent surfaces it; no execution.
    Shell {
        shell: String,
        message: String,
    },
    /// Prompt the user to edit a file or answer questions in chat.
    Dialog {
        path: String,
        message: String,
    },
}

/// Issue surfaced in the `issues[]` array. `code` is stable across
/// versions; `message` is human-readable. `fix` mirrors `next_action`'s
/// shape so the agent can pick any issue to act on (typically the first).
#[derive(Debug, Clone, Serialize)]
pub struct SetupIssue {
    pub code: String,
    pub severity: IssueSeverity,
    pub message: String,
    pub fix: NextAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueSeverity {
    Error,
    Warn,
}

/// JSON-serializable shape for both the daemon CLI's `setup-status`
/// subcommand and the MCP `klodi_setup_status` tool reply.
#[derive(Debug, Clone, Serialize)]
pub struct SetupStatus {
    pub phase: SetupPhase,
    pub klodi_home: PathBuf,
    pub creds_present: bool,
    pub config_present: bool,
    pub creds_mode_secure: bool,
    pub user_id: Option<String>,
    pub handle: Option<String>,
    pub nats_url: Option<String>,
    /// `${KLODI_HOME}/zeroclaw.token` exists with a non-empty body. Set
    /// for any adapter (the field is always present), but only
    /// load-bearing for the ZeroClaw daemon — moltis/ironclaw will
    /// always read `false` here.
    pub zeroclaw_token_present: bool,
    /// `${KLODI_HOME}/zeroclaw.session` exists with a non-empty body —
    /// the persisted operator-session UUID that gets interpolated into
    /// every wake prompt. Same caveat as `zeroclaw_token_present`.
    pub zeroclaw_session_present: bool,
    /// `${KLODI_HOME}/telegram.json` exists with a non-empty body —
    /// the per-operator bot token + chat id. Only load-bearing for the
    /// ZeroClaw daemon (gated via `require_telegram`).
    pub telegram_config_present: bool,
    /// Bot username from telegram.json. `None` when absent / unreadable.
    pub telegram_bot_username: Option<String>,
    /// Chat id from telegram.json. `None` when absent / unreadable.
    pub telegram_chat_id: Option<i64>,
    /// Most recent successful sendMessage timestamp read from the
    /// sidecar `telegram.last-send.json`. Debug-only; `None` when
    /// absent.
    pub telegram_last_send_ts: Option<String>,
    /// Stable issue codes the agent / operator should surface. Order is
    /// significance-first (registration before perms); `next_action`
    /// defaults to `issues[0].fix`.
    pub issues: Vec<SetupIssue>,
    /// Compatibility alias for `issues[].code`. Empty when no issues.
    pub issue_codes: Vec<String>,
    /// Recommended single next step. `None` when phase is `Ready`.
    pub next_action: Option<NextAction>,
}

/// Optional knobs for [`klodi_setup_status_with_options`]. Adapters that
/// want to require Telegram-pairing before `phase: "ready"` pass
/// `require_telegram: true`; ZeroClaw's setup-status binary does. Other
/// adapters keep the default `false` so their phase machine is
/// unaffected.
#[derive(Debug, Clone)]
pub struct SetupStatusOptions<'a> {
    pub register_cli: &'a str,
    pub require_telegram: bool,
}

impl<'a> Default for SetupStatusOptions<'a> {
    fn default() -> Self {
        Self {
            register_cli: "klodi-register",
            require_telegram: false,
        }
    }
}

/// Inspect `${klodi_home}` and produce a [`SetupStatus`]. Never panics
/// on malformed config — surfaces the problem via `issues` so the
/// operator sees actionable text.
pub fn klodi_setup_status(klodi_home: &Path) -> SetupStatus {
    klodi_setup_status_with_register_cli(klodi_home, "klodi-register")
}

/// Same as [`klodi_setup_status`], but lets the caller (typically a
/// per-adapter binary) substitute the host-specific register CLI name —
/// `klodi-ironclaw-register`, `klodi-moltis-register`, etc. — into the
/// generated `next_action` messages.
pub fn klodi_setup_status_with_register_cli(
    klodi_home: &Path,
    register_cli: &str,
) -> SetupStatus {
    klodi_setup_status_with_options(
        klodi_home,
        SetupStatusOptions {
            register_cli,
            require_telegram: false,
        },
    )
}

/// Full-featured variant. ZeroClaw's setup-status binary passes
/// `require_telegram: true` so a missing `telegram.json` keeps the
/// phase out of `Ready` and surfaces a Telegram-pairing next-action.
pub fn klodi_setup_status_with_options(
    klodi_home: &Path,
    options: SetupStatusOptions<'_>,
) -> SetupStatus {
    let creds_path = klodi_home.join("nats.creds");
    let config_path = klodi_home.join("config.json");

    let creds_present = creds_path.is_file();
    let config_present = config_path.is_file();
    let creds_mode_secure = creds_present && creds_mode_is_secure(&creds_path);
    let zeroclaw_token_present = file_with_body_present(&klodi_home.join("zeroclaw.token"));
    let zeroclaw_session_present =
        file_with_body_present(&klodi_home.join("zeroclaw.session"));

    let (user_id, handle, nats_url) = if config_present {
        match read_config(&config_path) {
            Ok(parsed) => (parsed.user_id, parsed.handle, parsed.nats_url),
            Err(_) => (None, None, None),
        }
    } else {
        (None, None, None)
    };
    let config_unreadable =
        config_present && user_id.is_none() && handle.is_none() && nats_url.is_none();

    let (telegram_config_present, telegram_bot_username, telegram_chat_id) =
        match read_telegram_config(klodi_home) {
            Ok(Some(cfg)) => (true, cfg.bot_username, Some(cfg.chat_id)),
            _ => (false, None, None),
        };
    let telegram_last_send_ts = read_telegram_last_send_ts(klodi_home);

    let issues = derive_issues(
        &Checks {
            creds_present,
            config_present,
            creds_mode_secure,
            config_unreadable,
            creds_path: &creds_path,
            telegram_config_present,
            require_telegram: options.require_telegram,
        },
        options.register_cli,
    );
    let issue_codes = issues.iter().map(|i| i.code.clone()).collect();
    let next_action = issues.first().map(|i| i.fix.clone());

    let phase = derive_phase(
        creds_present,
        config_present,
        config_unreadable,
        telegram_config_present,
        options.require_telegram,
    );

    SetupStatus {
        phase,
        klodi_home: klodi_home.to_path_buf(),
        creds_present,
        config_present,
        creds_mode_secure,
        user_id,
        handle,
        nats_url,
        zeroclaw_token_present,
        zeroclaw_session_present,
        telegram_config_present,
        telegram_bot_username,
        telegram_chat_id,
        telegram_last_send_ts,
        issues,
        issue_codes,
        next_action,
    }
}

#[derive(Debug, serde::Deserialize)]
struct ParsedTelegramConfig {
    chat_id: i64,
    #[serde(default)]
    bot_username: Option<String>,
}

fn read_telegram_config(klodi_home: &Path) -> std::io::Result<Option<ParsedTelegramConfig>> {
    let path = klodi_home.join("telegram.json");
    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path)?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return Ok(None);
    }
    let parsed: ParsedTelegramConfig = serde_json::from_slice(&bytes)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    Ok(Some(parsed))
}

#[derive(Debug, serde::Deserialize)]
struct ParsedLastSend {
    ts: String,
}

fn read_telegram_last_send_ts(klodi_home: &Path) -> Option<String> {
    let path = klodi_home.join("telegram.last-send.json");
    if !path.is_file() {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        return None;
    }
    let parsed: ParsedLastSend = serde_json::from_slice(&bytes).ok()?;
    Some(parsed.ts)
}

fn file_with_body_present(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    match std::fs::read_to_string(path) {
        Ok(s) => !s.trim().is_empty(),
        Err(_) => false,
    }
}

struct Checks<'a> {
    creds_present: bool,
    config_present: bool,
    creds_mode_secure: bool,
    config_unreadable: bool,
    creds_path: &'a Path,
    telegram_config_present: bool,
    require_telegram: bool,
}

fn derive_phase(
    creds_present: bool,
    config_present: bool,
    config_unreadable: bool,
    telegram_config_present: bool,
    require_telegram: bool,
) -> SetupPhase {
    if !creds_present && !config_present {
        return SetupPhase::Unconfigured;
    }
    if creds_present != config_present || config_unreadable {
        return SetupPhase::Registering;
    }
    if require_telegram && !telegram_config_present {
        return SetupPhase::Registering;
    }
    SetupPhase::Ready
}

fn derive_issues(c: &Checks<'_>, register_cli: &str) -> Vec<SetupIssue> {
    let mut out: Vec<SetupIssue> = Vec::new();

    if !c.creds_present && !c.config_present {
        out.push(SetupIssue {
            code: "not_registered".to_string(),
            severity: IssueSeverity::Error,
            message: format!(
                "No credentials found. Run {register_cli} from a shell to start registration.",
            ),
            fix: NextAction::Cli {
                command: register_cli.to_string(),
                message: format!(
                    "Run {register_cli} — opens a browser link, polls for completion, writes nats.creds + config.json.",
                ),
            },
        });
        return out;
    }
    if c.creds_present != c.config_present {
        let (present, missing) = if c.creds_present {
            ("nats.creds", "config.json")
        } else {
            ("config.json", "nats.creds")
        };
        out.push(SetupIssue {
            code: "partial_credentials".to_string(),
            severity: IssueSeverity::Error,
            message: format!(
                "Partial state: {present} present, {missing} missing. \
                 Re-run {register_cli} (it overwrites both files atomically).",
            ),
            fix: NextAction::Cli {
                command: register_cli.to_string(),
                message: format!(
                    "Re-run {register_cli} to overwrite the broken half-state. buy/ and sell/ are preserved.",
                ),
            },
        });
        return out;
    }
    if c.config_unreadable {
        out.push(SetupIssue {
            code: "config_unreadable".to_string(),
            severity: IssueSeverity::Error,
            message: format!(
                "config.json failed to parse. Re-run {register_cli} to overwrite it.",
            ),
            fix: NextAction::Cli {
                command: register_cli.to_string(),
                message: format!(
                    "Re-run {register_cli} to mint fresh creds + config. buy/ and sell/ are preserved.",
                ),
            },
        });
        return out;
    }

    if !c.creds_mode_secure {
        out.push(SetupIssue {
            code: "creds_perms".to_string(),
            severity: IssueSeverity::Warn,
            message:
                "nats.creds has group or world bits set. Tighten to 0600 so other local users cannot read it."
                    .to_string(),
            fix: NextAction::Shell {
                shell: format!("chmod 600 {}", c.creds_path.display()),
                message: "Tighten nats.creds permissions to 0600.".to_string(),
            },
        });
    }

    if c.require_telegram && !c.telegram_config_present {
        out.push(SetupIssue {
            code: "telegram_unpaired".to_string(),
            severity: IssueSeverity::Error,
            message: format!(
                "telegram.json missing — run {register_cli} to pair Telegram (operator-facing surface for the ZeroClaw daemon).",
                register_cli = register_cli,
            ),
            fix: NextAction::Cli {
                command: register_cli.to_string(),
                message: format!(
                    "Run {register_cli} to pair Telegram — bot token + chat id are written to ${{KLODI_HOME}}/telegram.json (mode 0600).",
                ),
            },
        });
    }

    out
}

#[derive(serde::Deserialize)]
struct ParsedConfig {
    user_id: Option<String>,
    handle: Option<String>,
    nats_url: Option<String>,
}

fn read_config(path: &Path) -> Result<ParsedConfig, std::io::Error> {
    let bytes = std::fs::read(path)?;
    let parsed: ParsedConfig = serde_json::from_slice(&bytes)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
    Ok(parsed)
}

#[cfg(unix)]
fn creds_mode_is_secure(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(path) {
        Ok(md) => md.mode() & 0o077 == 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn creds_mode_is_secure(_path: &Path) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_valid_config(dir: &Path) {
        let cfg = serde_json::json!({
            "user_id": "u1",
            "handle": "alice",
            "nats_url": "wss://example/4222",
            "nkey_public": "U1",
        });
        fs::write(dir.join("config.json"), cfg.to_string()).unwrap();
        fs::write(dir.join("nats.creds"), "creds-bytes").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(dir.join("nats.creds"), fs::Permissions::from_mode(0o600))
                .unwrap();
        }
    }

    #[test]
    fn unconfigured_when_both_missing() {
        let dir = tempdir().unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Unconfigured);
        assert!(!status.creds_present);
        assert_eq!(status.issues.len(), 1);
        assert_eq!(status.issues[0].code, "not_registered");
        assert!(matches!(status.next_action, Some(NextAction::Cli { .. })));
    }

    #[test]
    fn registering_when_half_state() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Registering);
        assert_eq!(status.issues[0].code, "partial_credentials");
    }

    #[test]
    fn config_unreadable_drops_to_registering() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("nats.creds"), "creds").unwrap();
        fs::write(dir.path().join("config.json"), "{not json").unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Registering);
        assert_eq!(status.issues[0].code, "config_unreadable");
    }

    #[test]
    fn ready_when_creds_and_config_present() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Ready);
        assert!(status.issues.is_empty());
        assert!(status.next_action.is_none());
        assert_eq!(status.user_id.as_deref(), Some("u1"));
        assert_eq!(status.handle.as_deref(), Some("alice"));
        assert!(!status.zeroclaw_token_present);
        assert!(!status.zeroclaw_session_present);
    }

    #[test]
    fn zeroclaw_session_and_token_flagged_when_present() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        fs::write(dir.path().join("zeroclaw.token"), "zc_abc\n").unwrap();
        fs::write(dir.path().join("zeroclaw.session"), "abc-uuid\n").unwrap();
        let status = klodi_setup_status(dir.path());
        assert!(status.zeroclaw_token_present);
        assert!(status.zeroclaw_session_present);
    }

    #[test]
    fn zeroclaw_artifacts_treated_as_absent_when_empty() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        fs::write(dir.path().join("zeroclaw.token"), "   \n").unwrap();
        fs::write(dir.path().join("zeroclaw.session"), "").unwrap();
        let status = klodi_setup_status(dir.path());
        assert!(!status.zeroclaw_token_present);
        assert!(!status.zeroclaw_session_present);
    }

    #[cfg(unix)]
    #[test]
    fn creds_perms_warning_does_not_block_ready() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        fs::set_permissions(
            dir.path().join("nats.creds"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let status = klodi_setup_status(dir.path());
        // Phase is still Ready — perms warning is severity::warn, not an
        // error that blocks normal operation.
        assert_eq!(status.phase, SetupPhase::Ready);
        let codes: Vec<&str> = status.issues.iter().map(|i| i.code.as_str()).collect();
        assert_eq!(codes, vec!["creds_perms"]);
        assert!(matches!(status.next_action, Some(NextAction::Shell { .. })));
    }

    #[test]
    fn register_cli_name_substitutes_into_messages() {
        let dir = tempdir().unwrap();
        let status =
            klodi_setup_status_with_register_cli(dir.path(), "klodi-ironclaw-register");
        let msg = &status.issues[0].message;
        assert!(
            msg.contains("klodi-ironclaw-register"),
            "expected per-host CLI name in message, got: {msg}",
        );
    }

    fn write_valid_telegram(dir: &Path) {
        let cfg = serde_json::json!({
            "bot_token": "tok",
            "chat_id": 42,
            "bot_username": "DemoKlodiBot",
            "paired_at": "2026-05-14T07:25:00Z",
        });
        fs::write(dir.join("telegram.json"), cfg.to_string()).unwrap();
    }

    #[test]
    fn require_telegram_blocks_ready_when_missing() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        let status = klodi_setup_status_with_options(
            dir.path(),
            SetupStatusOptions {
                register_cli: "klodi-zeroclaw-register",
                require_telegram: true,
            },
        );
        assert_eq!(status.phase, SetupPhase::Registering);
        let codes: Vec<&str> = status.issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"telegram_unpaired"), "got {codes:?}");
        assert!(!status.telegram_config_present);
    }

    #[test]
    fn require_telegram_ready_when_present() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        write_valid_telegram(dir.path());
        let status = klodi_setup_status_with_options(
            dir.path(),
            SetupStatusOptions {
                register_cli: "klodi-zeroclaw-register",
                require_telegram: true,
            },
        );
        assert_eq!(status.phase, SetupPhase::Ready);
        assert!(status.telegram_config_present);
        assert_eq!(status.telegram_bot_username.as_deref(), Some("DemoKlodiBot"));
        assert_eq!(status.telegram_chat_id, Some(42));
    }

    #[test]
    fn telegram_fields_surface_without_require() {
        // Even without `require_telegram`, the fields are populated for
        // observability so `setup_status` is a single source of truth.
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        write_valid_telegram(dir.path());
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Ready);
        assert!(status.telegram_config_present);
        assert_eq!(status.telegram_chat_id, Some(42));
    }

    #[test]
    fn telegram_last_send_ts_is_read() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        write_valid_telegram(dir.path());
        fs::write(
            dir.path().join("telegram.last-send.json"),
            serde_json::json!({ "ts": "2026-05-14T07:33:00Z" }).to_string(),
        )
        .unwrap();
        let status = klodi_setup_status_with_options(
            dir.path(),
            SetupStatusOptions {
                register_cli: "klodi-zeroclaw-register",
                require_telegram: true,
            },
        );
        assert_eq!(
            status.telegram_last_send_ts.as_deref(),
            Some("2026-05-14T07:33:00Z"),
        );
    }
}
