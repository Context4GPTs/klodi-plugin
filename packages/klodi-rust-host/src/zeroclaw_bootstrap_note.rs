//! Plugin-authored bootstrap + heartbeat notes for the operator session.
//!
//! These are the strings the daemon writes into the operator's ZeroClaw
//! session at startup so:
//!
//! - The operator can tell the daemon is alive ("klodi daemon
//!   connected as @… NATS: …").
//! - The agent has a baseline of plugin-bundled context (handle,
//!   user_id, wake event kinds, klodi-namespaced tools, the
//!   approval-via-chat convention) without the operator having to author
//!   any policy file.
//!
//! The note bodies are formatted here so the daemon binary stays a thin
//! CLI shell. Everything the operator sees is a deterministic function
//! of inputs the daemon already has on hand (handle, user_id, NATS URL,
//! version) — easy to unit-test, and easy to swap out when the
//! plugin-vs-operator content boundary shifts.

/// Inputs the bootstrap-note formatter needs from the daemon.
pub struct BootstrapInputs<'a> {
    pub handle: &'a str,
    pub user_id: &'a str,
    pub nats_url: &'a str,
    pub daemon_version: &'a str,
    /// Loopback URL of the browser-pairing helper shim
    /// (`crate::zeroclaw_pairing_shim`). `None` when the shim is
    /// disabled (`--no-browser-pair-shim`) or failed to bind. When
    /// present, the heartbeat surfaces it so an operator who hasn't yet
    /// paired their browser has a clickable affordance in the chat.
    pub browser_pair_url: Option<&'a str>,
    /// Channel names registered in the routing chain — `["dashboard",
    /// "dedicated_session", "upstream:telegram", …]`. Surfaced in the
    /// bootstrap note's multi-surface copy so the operator sees every
    /// surface klodi might page them on. Empty list = single-surface
    /// behaviour (dedicated klodi session only).
    pub channel_names: &'a [String],
}

/// One-line heartbeat written on every daemon (re)start. Always-on
/// regardless of whether the bootstrap note is being skipped — the
/// operator should always see "the daemon just started" the moment they
/// open the dashboard.
pub fn heartbeat(inputs: &BootstrapInputs<'_>) -> String {
    let pair_phrase = match inputs.browser_pair_url {
        Some(url) => format!(" Browser pairing: {url}."),
        None => String::new(),
    };
    format!(
        "🟢 klodi daemon connected as @{handle} ({user_id}). NATS: {nats_url}. \
         Daemon: klodi-zeroclaw v{ver}.{pair_phrase} Wakes will appear in this session.",
        handle = inputs.handle,
        user_id = inputs.user_id,
        nats_url = inputs.nats_url,
        ver = inputs.daemon_version,
        pair_phrase = pair_phrase,
    )
}

/// Multi-line plugin-authored bootstrap note. Posted exactly once per
/// session — the daemon checks the gateway-reported `message_count`
/// against zero before posting. Ships the catalog of wake event kinds,
/// klodi-namespaced tools, and the approval convention.
pub fn bootstrap_note(inputs: &BootstrapInputs<'_>) -> String {
    // Plain-text + markdown — ZeroClaw renders the operator dashboard as
    // a chat surface; we want this readable by a human and parseable by
    // the agent.
    let mut s = String::with_capacity(2048);

    s.push_str(&format!(
        "👋 **klodi just connected for @{handle} ({user_id}).**\n\n",
        handle = inputs.handle,
        user_id = inputs.user_id,
    ));

    s.push_str(
        "This is your klodi inbox. Marketplace events arrive here as they happen, and the \
         counterparty agent reasons about them inline. You can read what it does, intervene \
         with chat at any time, or approve / deny gated actions when it asks you to.\n\n",
    );

    // Multi-surface model: list the other surfaces klodi is
    // configured to page the operator on, so the operator never has
    // to wonder "where will klodi find me?"
    let other_surfaces: Vec<&String> = inputs
        .channel_names
        .iter()
        .filter(|n| n.as_str() != "dedicated_session")
        .collect();
    if !other_surfaces.is_empty() {
        s.push_str("**Other surfaces klodi will page you on:**\n");
        for name in &other_surfaces {
            let pretty = match name.as_str() {
                "dashboard" => "whichever dashboard session you're actively typing in",
                other if other.starts_with("upstream:") => {
                    let id = &other["upstream:".len()..];
                    s.push_str(&format!("- {id} (via `zeroclaw channel send`)\n"));
                    continue;
                }
                other => other,
            };
            s.push_str(&format!("- {pretty}\n"));
        }
        s.push_str(
            "\nReply with `/klodi yes:<reqId>` in the dashboard, or just type your answer \
             in this session. Approvals released on either surface release the gate — the \
             first matching reply wins. Upstream channels (Telegram/Slack/etc.) are \
             notification-only in 0.2.9; release approvals via dashboard or this session.\n\n",
        );
    }

    s.push_str("**Wake event kinds you'll see:**\n");
    s.push_str("- `listing.created` — your listing was published\n");
    s.push_str("- `listing.matched` — a counterparty's search matched your listing\n");
    s.push_str("- `offer.created` — somebody offered on your listing\n");
    s.push_str("- `offer.responded` — counterparty responded to your offer\n");
    s.push_str("- `transaction.*` — escrow / settlement events\n");
    s.push_str("- `channel.message` — incoming chat in an open negotiation\n\n");

    s.push_str(
        "**klodi-namespaced tools the agent can call (selection):**\n\
         - `klodi_search` / `klodi_watch` / `klodi_unwatch` — discovery\n\
         - `klodi_offer_create` / `klodi_offer_respond` — bidding (the agent decides whether to ask you, per your `negotiation_style.md`)\n\
         - `klodi_channel_message` — replies in open negotiations\n\
         - `klodi_escalate_to_user` — when the agent can't proceed autonomously and needs your input (posts a `── klodi · req=…` note in whichever dashboard tab you're typing in)\n\
         - `klodi_list_update` — listing edits (the agent decides whether to ask you)\n\
         - `klodi_tx_confirm` / `klodi_tx_cancel` / `klodi_list_withdraw` — **gated by the plugin: irreversible, the plugin always asks before executing**\n\n",
    );

    s.push_str(
        "**Approval convention.** Two kinds of asks reach you:\n\
         - 🔒 **Plugin-gated** (`tx_confirm`, `tx_cancel`, `list_withdraw`): the plugin posts the request to whichever dashboard tab you're typing in (or here, if no dashboard session is active) and refuses to execute the tool until you reply. Reply `yes` (or `approve` / `ok` / `proceed`) to authorize, or `no` (or `deny` / `cancel` / `stop`) to refuse. The agent then retries the call on your behalf.\n\
         - ℹ️ **Agent-discretion** (everything else): the agent reads your `negotiation_style.md` and on-disk strategy files (`buy/`, `sell/`) to decide whether to ask. When it asks, it uses `klodi_escalate_to_user` — the message lands in your most-recently-active dashboard tab with a `── klodi · req=…` prefix, falling through to this session when no dashboard is open. Same affirmation vocabulary applies.\n\n",
    );

    s.push_str(&format!(
        "_NATS: `{nats_url}` · Daemon: klodi-zeroclaw v{ver}_\n",
        nats_url = inputs.nats_url,
        ver = inputs.daemon_version,
    ));

    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture<'a>() -> BootstrapInputs<'a> {
        // Static empty slice so we can hand it out by reference from a
        // function that returns BootstrapInputs<'static>.
        static EMPTY: &[String] = &[];
        BootstrapInputs {
            handle: "alice",
            user_id: "u_alice_123",
            nats_url: "wss://nats.klodi.4gpts.com:4222",
            daemon_version: "0.2.6",
            browser_pair_url: None,
            channel_names: EMPTY,
        }
    }

    #[test]
    fn heartbeat_includes_handle_and_user_id() {
        let line = heartbeat(&fixture());
        assert!(line.contains("@alice"), "got: {line}");
        assert!(line.contains("u_alice_123"), "got: {line}");
        assert!(line.contains("wss://nats.klodi.4gpts.com:4222"), "got: {line}");
        assert!(line.contains("0.2.6"), "got: {line}");
    }

    #[test]
    fn heartbeat_is_one_line() {
        // The heartbeat is meant to read as a single chat-line so the
        // operator's session log stays tight on every (re)start.
        let line = heartbeat(&fixture());
        assert!(!line.contains('\n'), "heartbeat must be one line, got: {line}");
    }

    #[test]
    fn heartbeat_omits_browser_pair_url_when_none() {
        let line = heartbeat(&fixture());
        assert!(
            !line.contains("Browser pairing"),
            "heartbeat must not mention browser pairing when url is None: {line}"
        );
    }

    #[test]
    fn heartbeat_appends_browser_pair_url_when_some() {
        let mut inputs = fixture();
        inputs.browser_pair_url = Some("http://127.0.0.1:53219");
        let line = heartbeat(&inputs);
        assert!(
            line.contains("Browser pairing: http://127.0.0.1:53219"),
            "heartbeat must surface the shim URL: {line}"
        );
    }

    #[test]
    fn heartbeat_one_line_invariant_holds_with_url() {
        // Adding the URL must not split the line — operators rely on
        // the heartbeat occupying a single chat-line.
        let mut inputs = fixture();
        inputs.browser_pair_url = Some("http://127.0.0.1:53219");
        let line = heartbeat(&inputs);
        assert!(!line.contains('\n'), "got: {line}");
    }

    #[test]
    fn bootstrap_note_includes_all_load_bearing_content() {
        let note = bootstrap_note(&fixture());
        assert!(note.contains("@alice"));
        assert!(note.contains("u_alice_123"));
        assert!(note.contains("wss://nats.klodi.4gpts.com:4222"));
        assert!(note.contains("0.2.6"));
        // Wake event catalog
        assert!(note.contains("listing.created"));
        assert!(note.contains("listing.matched"));
        assert!(note.contains("offer.created"));
        assert!(note.contains("offer.responded"));
        assert!(note.contains("channel.message"));
        // Tool catalog
        assert!(note.contains("klodi_search"));
        assert!(note.contains("klodi_watch"));
        assert!(note.contains("klodi_offer_create"));
        assert!(note.contains("klodi_channel_message"));
        assert!(note.contains("klodi_escalate_to_user"));
        assert!(note.contains("klodi_tx_confirm"));
        assert!(note.contains("klodi_list_withdraw"));
        // Approval convention — must explain BOTH the prompt shape the
        // operator will see AND the affirmation vocabulary the agent
        // expects them to type.
        assert!(
            note.contains("Plugin-gated") || note.contains("Operator approval needed"),
            "must reference the plugin-gated prompt the operator will see: {note}",
        );
        assert!(note.contains("yes"));
        assert!(note.contains("no"));
    }

    #[test]
    fn bootstrap_note_marks_gated_tools_explicitly() {
        // Agents reading the note rely on the "gated" annotation to know
        // which tools will trigger an approval prompt. Removing the
        // marker silently would re-introduce the misalignment risk the
        // approval gate is meant to close.
        let note = bootstrap_note(&fixture());
        assert!(note.contains("gated"), "must mention gated tools: {note}");
        // Every plugin-gated tool must appear in the same hardcoded
        // line so the operator and the agent see the same list.
        for tool in ["klodi_tx_confirm", "klodi_tx_cancel", "klodi_list_withdraw"] {
            assert!(
                note.contains(tool),
                "{tool} must appear in bootstrap note: {note}",
            );
        }
    }

    #[test]
    fn bootstrap_note_distinguishes_plugin_gated_from_agent_discretion() {
        // The two-tier approval model (plugin enforces irreversibles +
        // agent decides everything else from policy) needs to be
        // explicit so the operator knows which prompts come from where.
        let note = bootstrap_note(&fixture());
        assert!(note.contains("Plugin-gated"), "must label plugin-side gates: {note}");
        assert!(note.contains("Agent-discretion"), "must label agent-driven asks: {note}");
        assert!(
            note.contains("negotiation_style.md"),
            "must point operator at their policy file for agent-discretion behaviour: {note}",
        );
    }

    #[test]
    fn bootstrap_note_is_deterministic_for_same_inputs() {
        // The daemon's "skip if already posted" check relies on this.
        let a = bootstrap_note(&fixture());
        let b = bootstrap_note(&fixture());
        assert_eq!(a, b);
    }

    #[test]
    fn bootstrap_note_lists_dashboard_and_upstream_surfaces() {
        // Multi-surface model: when channels include dashboard +
        // upstream:telegram, the note explains where else klodi will
        // page the operator.
        let names = vec![
            "dedicated_session".to_string(),
            "dashboard".to_string(),
            "upstream:telegram".to_string(),
        ];
        let inputs = BootstrapInputs {
            handle: "alice",
            user_id: "u_alice_123",
            nats_url: "wss://nats.klodi.4gpts.com:4222",
            daemon_version: "0.2.9",
            browser_pair_url: None,
            channel_names: &names,
        };
        let note = bootstrap_note(&inputs);
        assert!(note.contains("Other surfaces"));
        assert!(note.contains("dashboard session"));
        assert!(note.contains("telegram"));
        // Approval-reply convention must reach the operator on this
        // surface.
        assert!(note.contains("/klodi yes:"));
        assert!(note.contains("Upstream channels"));
    }

    #[test]
    fn bootstrap_note_omits_multi_surface_section_when_only_dedicated_session() {
        // Operator hasn't enabled dashboard / upstream channels →
        // single-surface behaviour, no multi-surface section.
        let names = vec!["dedicated_session".to_string()];
        let inputs = BootstrapInputs {
            handle: "alice",
            user_id: "u_alice_123",
            nats_url: "wss://nats.klodi.4gpts.com:4222",
            daemon_version: "0.2.9",
            browser_pair_url: None,
            channel_names: &names,
        };
        let note = bootstrap_note(&inputs);
        assert!(!note.contains("Other surfaces"));
    }
}
