//! Plugin-side approval gate for irreversible klodi tool calls.
//!
//! Implements I-5 of `docs/plans/2026-05-10-klodi-zeroclaw-wake-routing-redesign.md`:
//! the agent's call to a destructive tool can't go through until the
//! operator types an affirmation in their ZeroClaw session. The
//! plugin's role here is structural — it persists pending state, posts
//! the prompt to the session, and ratchets the gate open *only* after
//! the agent relays the operator's reply text back through the same
//! tool call.
//!
//! Per user direction (2026-05-10), the affirmation parsing happens at
//! the agent side: the agent reads the operator's free-text reply, then
//! retries the original tool call with `operator_approval_text` carrying
//! the verbatim operator reply. The plugin checks the text against an
//! affirmation regex and matches the `request_id` against pending
//! state. If both match, the gate opens and the original tool call
//! executes.
//!
//! State is persisted under `${KLODI_HOME}/approvals/<request_id>.json`
//! so a crashed MCP server can recover the pending list on restart —
//! per **Risks** row "leaks state across crashes" in the redesign plan.

use anyhow::{Context, Result, bail};
use klodi_nats_client::klodi_secret_write;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use uuid::Uuid;

/// The hardcoded list of klodi tools that go through the approval gate.
/// Listed by exact tool name (matches the MCP catalog and the
/// `ToolName::as_str` enum). Keep in sync with the README's "gated
/// tools" section and with `bootstrap_note` so the operator sees the
/// same list the plugin enforces.
///
/// Coverage rationale: only the **irreversible** plugin operations are
/// hardcoded. The plugin's job is mechanism, not policy — operators
/// configure `negotiation_style.md` to tell the agent when to ask
/// before any other call (`klodi_offer_respond`, `klodi_list_update`,
/// `klodi_channel_message`, etc.). The plugin won't lock the agent
/// into a specific approval pattern beyond the irreversibles.
///
/// - `klodi_tx_confirm` — moves escrow funds; not undoable.
/// - `klodi_tx_cancel` — same; counterparty-visible cancellation.
/// - `klodi_list_withdraw` — once a listing is gone the open offers go
///   too; rebuilding state requires the operator to repost manually.
pub const GATED_TOOLS: &[&str] = &[
    "klodi_tx_confirm",
    "klodi_tx_cancel",
    "klodi_list_withdraw",
];

/// Decide whether a given `(tool, args)` requires operator approval.
/// Used by the MCP dispatcher before running the tool body.
///
/// `args` is unused today — kept in the signature so the plugin can add
/// args-dependent gates later without a signature change.
///
/// Per user direction (2026-05-10): the plugin gates only the
/// hardcoded irreversibles in [`GATED_TOOLS`]. Everything else (offer
/// accepts, listing updates, channel messages, …) is the agent's
/// decision based on operator policy + on-disk sell/buy files. The
/// plugin enables the agent's freedom to choose its own workflow; it
/// doesn't lock a pattern.
pub fn should_gate(tool: &str, _args: &serde_json::Value) -> bool {
    GATED_TOOLS.contains(&tool)
}

/// Persisted pending-approval entry. One file per `request_id` under
/// `${KLODI_HOME}/approvals/`. Lives until the operator approves /
/// denies / it's reaped.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PendingApproval {
    /// Stable id surfaced to the agent in the first-call response.
    /// The agent must echo this back on the retry — prevents the agent
    /// from "approving" a call without the plugin first having posted a
    /// prompt for it.
    pub request_id: String,
    /// The tool the agent originally called (e.g. `klodi_tx_confirm`).
    pub tool: String,
    /// The args the agent passed on the original call. The retry's args
    /// must hash to the same value — prevents the agent from approving
    /// "tx X" and then quietly executing "tx Y" with the same approval.
    pub args_fingerprint: String,
    /// When the entry was created (epoch seconds, UTC). Used by
    /// [`reap_expired`] to drop stale pending state.
    pub created_at_unix_seconds: i64,
    /// One-line summary the plugin already posted to the operator. Kept
    /// here so a recovered MCP server can reproduce the prompt context
    /// in any error response without re-rendering it.
    pub summary: String,
}

/// `${KLODI_HOME}/approvals/` — per-request pending-approval files.
pub fn approvals_dir(klodi_home: &Path) -> PathBuf {
    klodi_home.join("approvals")
}

/// `${KLODI_HOME}/approvals/<request_id>.json`
pub fn approval_path(klodi_home: &Path, request_id: &str) -> PathBuf {
    approvals_dir(klodi_home).join(format!("{request_id}.json"))
}

/// Generate a fresh approval record (does not persist).
pub fn new_pending(tool: &str, args: &serde_json::Value, summary: String) -> PendingApproval {
    PendingApproval {
        request_id: Uuid::new_v4().to_string(),
        tool: tool.to_string(),
        args_fingerprint: fingerprint_args(args),
        created_at_unix_seconds: now_unix_seconds(),
        summary,
    }
}

/// Persist a pending entry to disk. Atomic + 0600 via `klodi_secret_write`.
pub fn persist(klodi_home: &Path, entry: &PendingApproval) -> Result<()> {
    let dir = approvals_dir(klodi_home);
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("creating {}", dir.display()))?;
    let path = approval_path(klodi_home, &entry.request_id);
    let body = serde_json::to_vec_pretty(entry)
        .context("encoding pending approval")?;
    klodi_secret_write(&path, &body, 0o600)
        .with_context(|| format!("klodi_secret_write {}", path.display()))
}

/// Load a previously-persisted pending entry, if it exists. Returns
/// `Ok(None)` if the file is missing — the agent may have presented a
/// stale or never-issued request_id, which is a normal "denied / not
/// found" outcome rather than an error.
pub fn load(klodi_home: &Path, request_id: &str) -> Result<Option<PendingApproval>> {
    let path = approval_path(klodi_home, request_id);
    if !path.exists() {
        return Ok(None);
    }
    let body = std::fs::read(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let entry: PendingApproval = serde_json::from_slice(&body)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(entry))
}

/// Remove a pending entry — called once the gate has been resolved
/// (approved + tool executed, or denied + error returned).
pub fn clear(klodi_home: &Path, request_id: &str) -> Result<()> {
    let path = approval_path(klodi_home, request_id);
    if !path.exists() {
        return Ok(());
    }
    std::fs::remove_file(&path)
        .with_context(|| format!("removing {}", path.display()))
}

/// Drop any pending entries older than `max_age_seconds`. Called on MCP
/// server start so the approvals directory doesn't grow unbounded if
/// agents stop retrying.
pub fn reap_expired(klodi_home: &Path, max_age_seconds: i64) -> Result<usize> {
    let dir = approvals_dir(klodi_home);
    if !dir.exists() {
        return Ok(0);
    }
    let now = now_unix_seconds();
    let mut removed = 0;
    for entry in std::fs::read_dir(&dir)
        .with_context(|| format!("reading {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let body = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let parsed: Option<PendingApproval> = serde_json::from_slice(&body).ok();
        let too_old = parsed
            .as_ref()
            .map(|e| now - e.created_at_unix_seconds > max_age_seconds)
            .unwrap_or(true);
        if too_old {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Decision for an incoming `(request_id, operator_approval_text, args)`
/// retry. The MCP dispatcher uses this to decide whether to run the
/// original tool or surface an error.
#[derive(Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Operator's reply contains an affirmation phrase AND the
    /// fingerprints / request_id all match — run the tool.
    Approved,
    /// Operator's reply contains a denial phrase — return an error and
    /// drop the pending entry.
    Denied,
    /// Reply doesn't match either pattern, OR the args drifted, OR the
    /// request_id isn't on file. Surface a "not granted" error and keep
    /// the pending entry alive (in case the operator is mid-conversation).
    NotGranted { reason: String },
}

/// Evaluate a retry against the persisted pending entry.
///
/// `args` is the args the agent presented on the retry. They must
/// fingerprint-match the original call.
pub fn evaluate_retry(
    pending: &PendingApproval,
    operator_approval_text: &str,
    args: &serde_json::Value,
) -> ApprovalDecision {
    let fp = fingerprint_args(args);
    if fp != pending.args_fingerprint {
        return ApprovalDecision::NotGranted {
            reason: format!(
                "args drifted between original call (fingerprint {}) and retry (fingerprint {}); \
                 operator approved the original args, not the retry's args",
                pending.args_fingerprint, fp,
            ),
        };
    }
    let normalised = operator_approval_text.trim().to_ascii_lowercase();
    if normalised.is_empty() {
        return ApprovalDecision::NotGranted {
            reason: "operator_approval_text is empty — pass the verbatim operator reply".into(),
        };
    }
    // Denial check runs first. The affirmation vocabulary contains
    // multi-word tokens like "do it" / "go ahead" that would
    // false-match against denial phrasings like "don't do it" or
    // "don't go ahead". Treating any negation as authoritative is the
    // safer UX — if the operator's reply is ambiguous, default to
    // "no", not "yes".
    if matches_denial(&normalised) {
        return ApprovalDecision::Denied;
    }
    if matches_affirmation(&normalised) {
        return ApprovalDecision::Approved;
    }
    ApprovalDecision::NotGranted {
        reason: format!(
            "operator_approval_text {operator_approval_text:?} doesn't match an \
             affirmation (yes / approve / ok / proceed / confirm / go) or a denial \
             (no / deny / cancel / stop / refuse) phrase"
        ),
    }
}

fn matches_affirmation(s: &str) -> bool {
    // Word-boundary checks so "no thanks" doesn't match "ok" embedded in
    // a longer denial. Lower-cased input.
    has_token(s, &["yes", "y", "approve", "ok", "okay", "proceed", "confirm", "go ahead", "go", "do it", "sure"])
}

fn matches_denial(s: &str) -> bool {
    has_token(s, &["no", "n", "deny", "cancel", "stop", "refuse", "abort", "don't", "do not", "nope"])
}

fn has_token(s: &str, tokens: &[&str]) -> bool {
    for t in tokens {
        let needle = *t;
        if needle.contains(' ') {
            // Multi-word tokens — substring match against the lowercased
            // input is fine; we don't expect "do nothing" to false-match
            // "do not" because the latter ends with "not".
            if s.contains(needle) {
                return true;
            }
            continue;
        }
        // Single-word — require word-boundary on both sides so "no" in
        // "not really" doesn't fire as a denial. Bytes are fine here
        // since affirmation/denial vocab is ASCII.
        let bytes = s.as_bytes();
        let n = needle.len();
        // Skip needles longer than the haystack — `bytes.len() - n`
        // would saturate to 0 and the loop body would slice past the
        // end of `bytes`. Common case: searching for "approve" (7
        // bytes) inside "no" (2 bytes).
        let max_start = match bytes.len().checked_sub(n) {
            Some(m) => m,
            None => continue,
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
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn fingerprint_args(args: &serde_json::Value) -> String {
    // Stable canonical JSON: serde_json::to_string sorts object keys
    // by insertion order, NOT lexicographically. We need lex-sorted
    // keys for the fingerprint so two equivalent argument objects with
    // different key ordering compare equal.
    let canonical = canonicalise(args);
    let body = serde_json::to_string(&canonical).unwrap_or_default();
    let mut hasher = SimpleHash::new();
    hasher.write(body.as_bytes());
    format!("{:016x}", hasher.finish())
}

fn canonicalise(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonicalise(&map[k]));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalise).collect()),
        other => other.clone(),
    }
}

/// FNV-1a 64. Adequate for an args-fingerprint where the threat model
/// is "a misaligned agent quietly mutating args" — collisions need to
/// flip both a tool name AND swap args while keeping the same
/// canonical JSON length / byte distribution. Cryptographic hashes
/// would be overkill and add a transitive dep we don't currently pull.
struct SimpleHash {
    state: u64,
}

impl SimpleHash {
    fn new() -> Self {
        Self {
            state: 0xcbf29ce484222325,
        }
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.state ^= b as u64;
            self.state = self.state.wrapping_mul(0x100000001b3);
        }
    }
    fn finish(&self) -> u64 {
        self.state
    }
}

fn now_unix_seconds() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Format the approval-prompt string the daemon / MCP server posts to
/// the operator session via WS. Kept here so the formatting stays in one
/// place and the unit tests can assert on it.
pub fn format_prompt(tool: &str, request_id: &str, summary: &str) -> String {
    format!(
        "🔒 **Operator approval needed** (request_id `{request_id}`)\n\
         \n\
         The agent wants to call `{tool}`:\n\
         \n\
         {summary}\n\
         \n\
         Reply **yes** / **approve** / **ok** to authorize, or **no** / **deny** / **cancel** \
         to refuse. The agent will retry the tool call once you respond.",
    )
}

/// Returned when an agent retries with no `request_id`. Wraps any free
/// text the agent passed so the MCP error includes context.
pub fn missing_request_id_error(tool: &str) -> anyhow::Error {
    anyhow::anyhow!(
        "{tool}: this tool is gated. The plugin returned `approval_required: true` and a \
         `request_id` on a previous call. Retry the call with `request_id` and \
         `operator_approval_text` set."
    )
}

/// Convenience: return Err if the persisted pending entry can't be loaded.
pub fn load_required(klodi_home: &Path, request_id: &str) -> Result<PendingApproval> {
    match load(klodi_home, request_id)? {
        Some(entry) => Ok(entry),
        None => bail!(
            "no pending approval on file for request_id={request_id} \
             (it may have been reaped, never issued, or already resolved)"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn unconditional_gated_tools() {
        for t in GATED_TOOLS {
            assert!(should_gate(t, &json!({})), "{t} should be gated");
        }
    }

    #[test]
    fn ungated_tools_pass_through() {
        for t in &[
            "klodi_search",
            "klodi_offer_create",
            "klodi_channel_message",
            "klodi_health",
            "klodi_setup_status",
        ] {
            assert!(!should_gate(t, &json!({})), "{t} should NOT be gated");
        }
    }

    #[test]
    fn offer_respond_never_gated_by_plugin() {
        // Per user direction the plugin doesn't gate offer_respond at
        // all — the agent reads the operator's negotiation policy and
        // sell-file floor and decides whether to call klodi_report_to_operator
        // before responding. Locking a "below-min" gate inside the
        // plugin would prevent operators who want different workflows
        // (e.g. "always ask", "never ask if buyer is verified").
        for action in ["accept", "reject", "counter_then_accept"] {
            assert!(!should_gate(
                "klodi_offer_respond",
                &json!({
                    "action": action,
                    "price_cents": 1,
                    "min_acceptable_price_cents": 1_000_000,
                }),
            ));
        }
    }

    #[test]
    fn fingerprint_is_key_order_independent() {
        let a = json!({"x": 1, "y": 2, "z": 3});
        let b = json!({"z": 3, "y": 2, "x": 1});
        assert_eq!(fingerprint_args(&a), fingerprint_args(&b));
    }

    #[test]
    fn fingerprint_changes_when_value_changes() {
        let a = json!({"x": 1});
        let b = json!({"x": 2});
        assert_ne!(fingerprint_args(&a), fingerprint_args(&b));
    }

    #[test]
    fn persist_load_roundtrip() {
        let dir = tempdir().unwrap();
        let entry = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "summary text".into(),
        );
        persist(dir.path(), &entry).unwrap();
        let loaded = load(dir.path(), &entry.request_id).unwrap().unwrap();
        assert_eq!(loaded, entry);
    }

    #[test]
    fn load_returns_none_for_unknown_id() {
        let dir = tempdir().unwrap();
        assert!(load(dir.path(), "no-such-id").unwrap().is_none());
    }

    #[test]
    fn clear_removes_persisted_entry() {
        let dir = tempdir().unwrap();
        let entry = new_pending("klodi_tx_confirm", &json!({}), "s".into());
        persist(dir.path(), &entry).unwrap();
        clear(dir.path(), &entry.request_id).unwrap();
        assert!(load(dir.path(), &entry.request_id).unwrap().is_none());
    }

    #[test]
    fn reap_expired_drops_old_entries_only() {
        let dir = tempdir().unwrap();
        let mut fresh = new_pending("klodi_tx_confirm", &json!({"a": 1}), "fresh".into());
        let mut stale = new_pending("klodi_tx_confirm", &json!({"a": 2}), "stale".into());
        stale.created_at_unix_seconds = now_unix_seconds() - 10_000;
        fresh.created_at_unix_seconds = now_unix_seconds();
        persist(dir.path(), &fresh).unwrap();
        persist(dir.path(), &stale).unwrap();
        let removed = reap_expired(dir.path(), 5_000).unwrap();
        assert_eq!(removed, 1);
        assert!(load(dir.path(), &fresh.request_id).unwrap().is_some());
        assert!(load(dir.path(), &stale.request_id).unwrap().is_none());
    }

    #[test]
    fn evaluate_retry_approved_on_yes() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(&pending, "yes", &json!({"tx_id": "T1"}));
        assert_eq!(dec, ApprovalDecision::Approved);
    }

    #[test]
    fn evaluate_retry_approved_on_approve_with_punctuation() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(
            &pending,
            "Approve!",
            &json!({"tx_id": "T1"}),
        );
        assert_eq!(dec, ApprovalDecision::Approved);
    }

    #[test]
    fn evaluate_retry_approved_on_freetext_with_yes() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(
            &pending,
            "yes please go ahead",
            &json!({"tx_id": "T1"}),
        );
        assert_eq!(dec, ApprovalDecision::Approved);
    }

    #[test]
    fn evaluate_retry_denied_on_no() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(&pending, "no", &json!({"tx_id": "T1"}));
        assert_eq!(dec, ApprovalDecision::Denied);
    }

    #[test]
    fn evaluate_retry_denied_on_dont() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(&pending, "don't do it", &json!({"tx_id": "T1"}));
        assert_eq!(dec, ApprovalDecision::Denied);
    }

    #[test]
    fn evaluate_retry_not_granted_on_args_drift() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(&pending, "yes", &json!({"tx_id": "T2"}));
        assert!(matches!(dec, ApprovalDecision::NotGranted { .. }));
    }

    #[test]
    fn evaluate_retry_not_granted_on_empty_text() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(&pending, "   ", &json!({"tx_id": "T1"}));
        assert!(matches!(dec, ApprovalDecision::NotGranted { .. }));
    }

    #[test]
    fn evaluate_retry_not_granted_on_ambiguous_text() {
        let pending = new_pending(
            "klodi_tx_confirm",
            &json!({"tx_id": "T1"}),
            "s".into(),
        );
        let dec = evaluate_retry(
            &pending,
            "let me think about it",
            &json!({"tx_id": "T1"}),
        );
        assert!(matches!(dec, ApprovalDecision::NotGranted { .. }));
    }

    #[test]
    fn affirmation_word_boundary_avoids_false_positives() {
        // "approval" embeds the bytes "approv" but not the word
        // "approve" (8 bytes vs 7) — the token check must respect word
        // boundaries so this case lands on NotGranted, not Approved.
        // "noticed" embeds "no" but not as a standalone word — same
        // deal: must NOT register as Denied.
        let pending = new_pending("klodi_tx_confirm", &json!({}), "s".into());
        assert!(matches!(
            evaluate_retry(&pending, "approval pending", &json!({})),
            ApprovalDecision::NotGranted { .. },
        ));
        assert!(matches!(
            evaluate_retry(&pending, "noticed your message", &json!({})),
            ApprovalDecision::NotGranted { .. },
        ));
    }

    #[test]
    fn format_prompt_includes_request_id_and_summary() {
        let s = format_prompt("klodi_tx_confirm", "req-1", "buy chair for €600");
        assert!(s.contains("klodi_tx_confirm"));
        assert!(s.contains("req-1"));
        assert!(s.contains("buy chair for €600"));
        assert!(s.contains("yes"));
        assert!(s.contains("no"));
    }
}
