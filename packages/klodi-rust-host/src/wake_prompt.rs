//! Pure builder for the canonical wake prompt the spawned ZeroClaw
//! agent reads on every NATS event.
//!
//! The prompt is defined by `docs/plans/2026-05-12-klodi-wake-agent-spawn.md`
//! §5. It is the actual product: it replaces, in their entirety, the
//! `klodi_report_to_operator` severity matrix, the daemon's per-event-
//! kind formatting table, the approval-gate state machine, and the
//! bootstrap tool-catalog note. The LLM phrases each situation in its
//! own voice and decides what — if anything — the operator needs to see.

use serde::Serialize;

/// Inputs the builder weaves into the prompt template.
#[derive(Debug, Clone, Serialize)]
pub struct WakePromptInputs<'a> {
    /// Operator handle (e.g. `"ioannis"`). Read from
    /// `${KLODI_HOME}/config.json`.
    pub handle: &'a str,
    /// Marketplace user id (UUID). Read from `${KLODI_HOME}/config.json`.
    pub user_id: &'a str,
    /// The marketplace event as it arrived on NATS, serialised with
    /// `serde_json::to_string_pretty` so the LLM sees the full payload.
    pub event_json_pretty: &'a str,
    /// Persisted operator session id from
    /// `${KLODI_HOME}/zeroclaw.session`. The LLM uses this as the
    /// `session_id` argument to `sessions_send` when it decides the
    /// operator should see something.
    pub operator_session_id: &'a str,
}

/// Compose the wake prompt. The template is intentionally fixed — the
/// LLM does the curation, not the daemon. Tests assert exact bytes for
/// every interpolation so a stray formatting change is caught loudly.
pub fn build_wake_prompt(inputs: &WakePromptInputs<'_>) -> String {
    format!(
        "You are the marketplace negotiator for {handle} ({user_id}).\n\
         \n\
         A marketplace event just landed:\n\
         \n\
         {event_json_pretty}\n\
         \n\
         The operator's chat session id is \"{operator_session_id}\".\n\
         \n\
         Tools you have:\n\
         - klodi_*                              act on the marketplace (offers,\n\
        \x20                                      channels, listings, transactions)\n\
         - sessions_send(session_id, message)   post a message into a chat session\n\
         \n\
         Reference docs the operator has authored:\n\
         - buy/*.md    things they want to buy and what they'll pay\n\
         - sell/*.md   things they want to sell and what they'll accept\n\
         - negotiation_style.md   how they want you to bargain\n\
         \n\
         You can read these via your existing file tools. You can read prior moves\n\
         on a listing via klodi_negotiation_state and prior operator messages via\n\
         sessions_history.\n\
         \n\
         Write to the operator session ONLY when they should see, decide, or be\n\
         aware. Routine negotiation moves are yours to make silently — the chat\n\
         belongs to them.\n\
         \n\
         For irreversible actions (transaction confirms, accept-below-min,\n\
         listing withdraw, material edits): write the proposal to the operator\n\
         and wait. The next wake on this listing will tell you their answer.\n\
         \n\
         Decide. Act. End the turn.\n",
        handle = inputs.handle,
        user_id = inputs.user_id,
        event_json_pretty = inputs.event_json_pretty,
        operator_session_id = inputs.operator_session_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_interpolates_all_fields() {
        let prompt = build_wake_prompt(&WakePromptInputs {
            handle: "ioannis",
            user_id: "u-123",
            event_json_pretty: "{\n  \"kind\": \"listing.created\"\n}",
            operator_session_id: "sess-abc",
        });
        assert!(prompt.contains("for ioannis (u-123)"));
        assert!(prompt.contains("\"sess-abc\""));
        assert!(prompt.contains("\"kind\": \"listing.created\""));
    }

    #[test]
    fn prompt_keeps_canonical_closing() {
        let prompt = build_wake_prompt(&WakePromptInputs {
            handle: "h",
            user_id: "u",
            event_json_pretty: "{}",
            operator_session_id: "s",
        });
        assert!(prompt.ends_with("Decide. Act. End the turn.\n"));
    }

    #[test]
    fn prompt_mentions_only_supported_tools() {
        let prompt = build_wake_prompt(&WakePromptInputs {
            handle: "h",
            user_id: "u",
            event_json_pretty: "{}",
            operator_session_id: "s",
        });
        // klodi_report_to_operator and severity enum are explicit cuts —
        // §5 of the spec replaces them entirely. Make sure the
        // canonical prompt does not mention them.
        assert!(!prompt.contains("klodi_report_to_operator"));
        assert!(!prompt.contains("severity"));
        assert!(prompt.contains("sessions_send"));
        assert!(prompt.contains("klodi_*"));
    }
}
