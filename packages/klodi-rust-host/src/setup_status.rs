//! `klodi_setup_status` — phase + issue + next-action reporter.
//!
//! Two consumers:
//!
//! - The daemon CLI's `setup-status` subcommand (operator-side diagnostic).
//! - The in-agent `klodi_setup_status` MCP tool (under feature `mcp`).
//!
//! Per **D § D4** the catalog declares this tool with
//! `host_shapes: ["daemon"]`; daemons surface it as both a CLI subcommand
//! and an MCP tool. The shape returned here mirrors openclaw's
//! `klodi_setup_status` reply (TS) so agents that switch hosts see the
//! same fields.
//!
//! The function inspects:
//!
//! - `${KLODI_HOME}/{nats.creds,config.json}`             — registration state
//! - `${KLODI_HOME}/policies/{negotiation_style,security}.md` — user policy
//!
//! and returns:
//!
//! - `phase` — `"unconfigured" | "registering" | "needs_policy" | "ready"`
//! - flat presence flags for every file checked
//! - `creds_mode_secure` — mode bits with no group/world (P1-6 / D2)
//! - `negotiation_style_filled` — true when no template sentinels remain
//! - `user_id`, `handle`, `nats_url` — JSON-extracted from `config.json`
//! - `issues` — ordered list of actionable problems with `fix` directives
//! - `next_action` — single recommended step the agent / operator should
//!   take next, or `None` when phase is `Ready`
//!
//! Reports policy awareness in addition to creds/config presence so
//! agents can ask the operator to fill `negotiation_style.md` before
//! responding to wakes.

use crate::policy_seed;
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
    /// atomically; preserves `policies/`, `buy/`, `sell/`).
    Registering,
    /// Creds + config are present and parseable, but at least one policy
    /// file is missing or contains template sentinels the user hasn't
    /// replaced. Agent calls `klodi_setup_reseed_policies` (re-seeds
    /// non-destructively) or surfaces the dialog asking the user to fill
    /// `negotiation_style.md`.
    NeedsPolicy,
    /// All files present, policies filled. Daemon can connect and the
    /// agent can act on the user's behalf.
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
    pub negotiation_style_seeded: bool,
    pub negotiation_style_filled: bool,
    pub security_policy_seeded: bool,
    pub user_id: Option<String>,
    pub handle: Option<String>,
    pub nats_url: Option<String>,
    /// `${KLODI_HOME}/zeroclaw.token` exists with a non-empty body. Set
    /// for any adapter (the field is always present), but only
    /// load-bearing for the ZeroClaw daemon — moltis/ironclaw will
    /// always read `false` here. Surfaced so the operator can tell at a
    /// glance whether the pair-dance has run.
    pub zeroclaw_token_present: bool,
    /// `${KLODI_HOME}/zeroclaw.session` exists with a non-empty body —
    /// the persisted operator-session UUID the WS wake-delivery path
    /// relies on. Same caveat as `zeroclaw_token_present`: always
    /// present, only meaningful for ZeroClaw.
    pub zeroclaw_session_present: bool,
    /// Stable issue codes the agent / operator should surface. Order is
    /// significance-first (registration before perms before policy);
    /// `next_action` defaults to `issues[0].fix`.
    pub issues: Vec<SetupIssue>,
    /// Compatibility alias for `issues[].code` — older callers built a
    /// flat string list. New code should read `issues[]` for the full
    /// shape. Empty when no issues.
    pub issue_codes: Vec<String>,
    /// Recommended single next step. `None` when phase is `Ready`.
    pub next_action: Option<NextAction>,
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
    let creds_path = klodi_home.join("nats.creds");
    let config_path = klodi_home.join("config.json");
    let negotiation_style_path = klodi_home.join("policies/negotiation_style.md");
    let security_policy_path = klodi_home.join("policies/security.md");

    let creds_present = creds_path.is_file();
    let config_present = config_path.is_file();
    let creds_mode_secure = creds_present && creds_mode_is_secure(&creds_path);
    let negotiation_style_seeded = negotiation_style_path.is_file();
    let negotiation_style_filled =
        negotiation_style_seeded && policy_seed::is_negotiation_style_filled(&negotiation_style_path);
    let security_policy_seeded = security_policy_path.is_file();
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
    let config_unreadable = config_present && user_id.is_none() && handle.is_none() && nats_url.is_none();

    let issues = derive_issues(
        &Checks {
            creds_present,
            config_present,
            creds_mode_secure,
            config_unreadable,
            negotiation_style_seeded,
            negotiation_style_filled,
            security_policy_seeded,
            creds_path: &creds_path,
        },
        register_cli,
    );
    let issue_codes = issues.iter().map(|i| i.code.clone()).collect();
    let next_action = issues.first().map(|i| i.fix.clone());

    let phase = derive_phase(
        creds_present,
        config_present,
        config_unreadable,
        negotiation_style_seeded,
        negotiation_style_filled,
        security_policy_seeded,
    );

    SetupStatus {
        phase,
        klodi_home: klodi_home.to_path_buf(),
        creds_present,
        config_present,
        creds_mode_secure,
        negotiation_style_seeded,
        negotiation_style_filled,
        security_policy_seeded,
        user_id,
        handle,
        nats_url,
        zeroclaw_token_present,
        zeroclaw_session_present,
        issues,
        issue_codes,
        next_action,
    }
}

/// Best-effort: file exists, is a regular file, has at least one
/// non-whitespace byte. Used by the zeroclaw_{token,session}_present
/// fields so an empty leftover file doesn't get reported as "ready".
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
    negotiation_style_seeded: bool,
    negotiation_style_filled: bool,
    security_policy_seeded: bool,
    creds_path: &'a Path,
}

fn derive_phase(
    creds_present: bool,
    config_present: bool,
    config_unreadable: bool,
    negotiation_style_seeded: bool,
    negotiation_style_filled: bool,
    security_policy_seeded: bool,
) -> SetupPhase {
    if !creds_present && !config_present {
        return SetupPhase::Unconfigured;
    }
    if creds_present != config_present || config_unreadable {
        return SetupPhase::Registering;
    }
    if !negotiation_style_seeded || !security_policy_seeded || !negotiation_style_filled {
        return SetupPhase::NeedsPolicy;
    }
    SetupPhase::Ready
}

fn derive_issues(c: &Checks<'_>, register_cli: &str) -> Vec<SetupIssue> {
    let mut out: Vec<SetupIssue> = Vec::new();

    // Registration issues — strictly ordered so the agent picks the
    // right CLI invocation when multiple files are missing.
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
                    "Run {register_cli} — opens a browser link, polls for completion, writes nats.creds + config.json + seeds policies/.",
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
                    "Re-run {register_cli} to overwrite the broken half-state. Policies, buy/, and sell/ are preserved.",
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
                    "Re-run {register_cli} to mint fresh creds + config. Policies and on-disk strategy files are preserved.",
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

    if !c.security_policy_seeded {
        out.push(SetupIssue {
            code: "security_policy_missing".to_string(),
            severity: IssueSeverity::Error,
            message:
                "policies/security.md is missing. Call klodi_setup_reseed_policies to restore it from the bundled template."
                    .to_string(),
            fix: NextAction::Tool {
                tool: "klodi_setup_reseed_policies".to_string(),
                message:
                    "Re-seed policies/security.md from the bundled template (non-destructive)."
                        .to_string(),
            },
        });
    }
    if !c.negotiation_style_seeded {
        out.push(SetupIssue {
            code: "negotiation_style_missing".to_string(),
            severity: IssueSeverity::Error,
            message:
                "policies/negotiation_style.md is missing. The agent needs a pricing + posture rulebook before negotiating. Call klodi_setup_reseed_policies."
                    .to_string(),
            fix: NextAction::Tool {
                tool: "klodi_setup_reseed_policies".to_string(),
                message:
                    "Re-seed policies/negotiation_style.md from the bundled template, then ask the user to fill the placeholders."
                        .to_string(),
            },
        });
    } else if !c.negotiation_style_filled {
        out.push(SetupIssue {
            code: "negotiation_style_unfilled".to_string(),
            severity: IssueSeverity::Error,
            message:
                "policies/negotiation_style.md still holds template placeholders. Walk the user through filling pricing, posture, and logistics sections before negotiating on their behalf."
                    .to_string(),
            fix: NextAction::Dialog {
                path: "policies/negotiation_style.md".to_string(),
                message:
                    "Open policies/negotiation_style.md and replace every <e.g., …> placeholder with the user's actual preferences. Pick one of `firm | flexible | aggressive` for Posture."
                        .to_string(),
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
    // Windows: NTFS ACLs aren't expressible as octal mode bits and the
    // OS doesn't enforce a "world readable" semantics in the same way.
    // Treat as secure — the registration flow's `klodi_secret_write`
    // owns the actual file-mode discipline.
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
            fs::set_permissions(
                dir.join("nats.creds"),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
    }

    fn fill_negotiation_style(dir: &Path) {
        fs::write(
            dir.join("policies/negotiation_style.md"),
            "Posture: firm\nFloor: $40\n",
        )
        .unwrap();
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
    fn needs_policy_when_creds_ok_but_negotiation_unfilled() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        policy_seed::seed_policies_if_absent(dir.path()).unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::NeedsPolicy);
        let codes: Vec<&str> = status.issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"negotiation_style_unfilled"), "got {codes:?}");
        assert!(matches!(
            status.next_action,
            Some(NextAction::Dialog { .. }),
        ));
    }

    #[test]
    fn needs_policy_when_security_missing() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        fs::create_dir_all(dir.path().join("policies")).unwrap();
        fs::write(
            dir.path().join("policies/negotiation_style.md"),
            "Posture: firm\nFloor: $40\n",
        )
        .unwrap();
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::NeedsPolicy);
        let codes: Vec<&str> = status.issues.iter().map(|i| i.code.as_str()).collect();
        assert!(codes.contains(&"security_policy_missing"));
        assert!(matches!(status.next_action, Some(NextAction::Tool { .. })));
    }

    #[test]
    fn ready_when_all_files_present_and_filled() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        policy_seed::seed_policies_if_absent(dir.path()).unwrap();
        fill_negotiation_style(dir.path());
        let status = klodi_setup_status(dir.path());
        assert_eq!(status.phase, SetupPhase::Ready);
        assert!(status.issues.is_empty());
        assert!(status.next_action.is_none());
        assert_eq!(status.user_id.as_deref(), Some("u1"));
        assert_eq!(status.handle.as_deref(), Some("alice"));
        // ZeroClaw artifacts absent on a fresh KLODI_HOME — these
        // fields are always present in the JSON, but `false` until the
        // daemon writes them.
        assert!(!status.zeroclaw_token_present);
        assert!(!status.zeroclaw_session_present);
    }

    #[test]
    fn zeroclaw_session_and_token_flagged_when_present() {
        let dir = tempdir().unwrap();
        write_valid_config(dir.path());
        policy_seed::seed_policies_if_absent(dir.path()).unwrap();
        fill_negotiation_style(dir.path());
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
        policy_seed::seed_policies_if_absent(dir.path()).unwrap();
        fill_negotiation_style(dir.path());
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
        assert!(matches!(
            status.next_action,
            Some(NextAction::Shell { .. }),
        ));
    }

    #[test]
    fn register_cli_name_substitutes_into_messages() {
        let dir = tempdir().unwrap();
        let status = klodi_setup_status_with_register_cli(
            dir.path(),
            "klodi-ironclaw-register",
        );
        let msg = &status.issues[0].message;
        assert!(
            msg.contains("klodi-ironclaw-register"),
            "expected per-host CLI name in message, got: {msg}",
        );
    }
}
