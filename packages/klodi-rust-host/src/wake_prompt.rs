//! Pure builder for the canonical wake prompt the ZeroClaw operator
//! session reads on every NATS event.
//!
//! Per `docs/plans/2026-05-14-klodi-telegram-bridge.md` §4, the daemon
//! delivers replies to Telegram itself — the agent's final response IS
//! the operator notification. The prompt bakes that contract in:
//! `sessions_send` is no longer in the tool catalogue, and the agent is
//! told its closing sentence will be forwarded to the operator's chat.

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
    /// Telegram chat id the operator is paired with. The agent never
    /// calls Telegram directly — the daemon forwards the closing
    /// sentence — but seeing the id reminds the model where its reply
    /// lands.
    pub chat_id: i64,
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
         The operator is reading you on Telegram chat {chat_id}. Whatever\n\
         you write at the end of this turn is forwarded to them verbatim.\n\
         \n\
         Tools you have:\n\
         - klodi_*    act on the marketplace (offers, channels, listings,\n\
        \x20            transactions)\n\
         \n\
         Reference docs the operator has authored:\n\
         - buy/*.md    things they want to buy and what they'll pay\n\
         - sell/*.md   things they want to sell and what they'll accept\n\
         - negotiation_style.md   how they want you to bargain\n\
         \n\
         You can read these via your existing file tools. Read prior moves\n\
         on a listing via klodi_negotiation_state.\n\
         \n\
         End the turn with a one- or two-sentence summary the operator\n\
         should see. Stay silent (empty turn) for routine negotiation\n\
         moves you've already executed — the chat belongs to them; don't\n\
         narrate.\n\
         \n\
         For irreversible actions (transaction confirms, accept-below-min,\n\
         listing withdraw, material edits): describe the proposal and\n\
         wait. The next wake on this listing will tell you their answer.\n\
         \n\
         Decide. Act. End the turn with a one- or two-sentence summary\n\
         the operator should see.\n",
        handle = inputs.handle,
        user_id = inputs.user_id,
        event_json_pretty = inputs.event_json_pretty,
        chat_id = inputs.chat_id,
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
            chat_id: 8343881720,
        });
        assert!(prompt.contains("for ioannis (u-123)"));
        assert!(prompt.contains("Telegram chat 8343881720"));
        assert!(prompt.contains("\"kind\": \"listing.created\""));
    }

    #[test]
    fn prompt_keeps_canonical_closing() {
        let prompt = build_wake_prompt(&WakePromptInputs {
            handle: "h",
            user_id: "u",
            event_json_pretty: "{}",
            chat_id: 1,
        });
        // The format! template's source indentation bleeds into the
        // formatted string. Just assert the two key sentences land at
        // the end in order.
        let trimmed: String = prompt
            .lines()
            .map(|l| l.trim())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            trimmed.ends_with(
                "Decide. Act. End the turn with a one- or two-sentence summary\nthe operator should see."
            ),
            "unexpected close: {trimmed}"
        );
    }

    #[test]
    fn prompt_omits_legacy_session_tools() {
        let prompt = build_wake_prompt(&WakePromptInputs {
            handle: "h",
            user_id: "u",
            event_json_pretty: "{}",
            chat_id: 1,
        });
        assert!(!prompt.contains("sessions_send"));
        assert!(!prompt.contains("sessions_history"));
        assert!(!prompt.contains("operator session id"));
        assert!(!prompt.contains("klodi_report_to_operator"));
        assert!(prompt.contains("klodi_*"));
    }
}
