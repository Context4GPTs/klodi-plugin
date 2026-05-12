//! Parse the operator-visible `klodi_escalate_to_user` payload back
//! into a structured `Escalation`.
//!
//! The wire format is the one [`crate::channels::dashboard::render_payload`]
//! produces:
//!
//! ```text
//! ── klodi · req=<id> · klodi_escalate_to_user ──
//! <summary line>
//! <optional details, possibly multi-line>
//! Reply: …reply hint…
//! ```
//!
//! The trailing `Reply:` hint is dashboard-render boilerplate; the
//! inbox UI generates its own reply affordance, so we strip it off when
//! producing `details`. Other plugin-prefixed event kinds
//! (`offer.accepted`, `channel.opened`, …) share the same `── klodi ·`
//! frame but a different middle slot — they are rejected here so the
//! filter doesn't surface them as escalations.
//!
//! Pure data — no I/O. Tests live alongside.
//!
//! The header recognised here is the canonical wire format produced by
//! `dashboard::render_payload`. Both sides must agree; the
//! `parses_render_payload_output` regression test pins the round-trip.

/// Parsed escalation as the inbox UI consumes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Escalation {
    /// `req=<id>` correlation token. Same string the operator sees in
    /// the escalation header and that the reply attribution looks for.
    pub req_id: String,
    /// First non-empty line after the header.
    pub summary: String,
    /// Everything after the summary, with the trailing `Reply:` boiler-
    /// plate stripped. `None` when the body is header-and-summary only.
    pub details: Option<String>,
}

/// The escalation event kind the dashboard renders. We deliberately
/// match against this verbatim so the parser only recognises true
/// escalations — `offer.accepted` and friends share the `── klodi ·`
/// frame and would otherwise be mis-classified as inbox items.
const ESCALATION_EVENT_KIND: &str = "klodi_escalate_to_user";

/// Plugin-prefixed event-kind frame: every message
/// `dashboard::render_payload` emits starts with this.
const KLODI_FRAME_PREFIX: &str = "── klodi · req=";

/// Reply-hint marker the dashboard appends. Anything from this prefix
/// onward is render boilerplate, not operator-visible detail.
const REPLY_HINT_PREFIX: &str = "Reply: ";

/// Attempt to parse `content` as an escalation message. Returns `None`
/// for anything that doesn't match the escalation header (other
/// plugin-prefixed notifications, operator-typed messages, mangled
/// payloads).
pub fn parse_escalation(content: &str) -> Option<Escalation> {
    let mut lines = content.lines();
    let header = lines.next()?;
    let req_id = parse_header(header)?;

    // Body is everything after the header line. We walk lines and
    // assemble: first non-empty line is the summary; subsequent lines
    // (up to the `Reply:` boilerplate) are the details. Leading and
    // trailing blank lines around the details block are stripped so
    // round-tripping `summary + \n + details` through the wire format
    // doesn't accumulate empty lines on the card; internal blank lines
    // are preserved so multi-paragraph detail bodies render correctly.
    let mut summary: Option<String> = None;
    let mut details_lines: Vec<&str> = Vec::new();
    let mut saw_first_detail_line = false;
    for line in lines {
        if summary.is_none() {
            if line.trim().is_empty() {
                continue;
            }
            summary = Some(line.to_string());
            continue;
        }
        if line.starts_with(REPLY_HINT_PREFIX) {
            break;
        }
        if !saw_first_detail_line {
            if line.trim().is_empty() {
                // Skip blank padding between summary and details.
                continue;
            }
            saw_first_detail_line = true;
        }
        details_lines.push(line);
    }
    let summary = summary?;
    // Strip trailing blank lines so the rendered card doesn't carry
    // dead whitespace between the body and the reply textarea.
    while details_lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        details_lines.pop();
    }
    let details = if details_lines.is_empty() {
        None
    } else {
        Some(details_lines.join("\n"))
    };
    Some(Escalation {
        req_id,
        summary,
        details,
    })
}

/// Parse a `── klodi · req=<id> · <event_kind> ──` header. Returns the
/// `<id>` when the event kind is the escalation marker; `None` otherwise.
fn parse_header(line: &str) -> Option<String> {
    let rest = line.strip_prefix(KLODI_FRAME_PREFIX)?;
    let (req_id, rest) = rest.split_once(" · ")?;
    let rest = rest.strip_suffix(" ──")?;
    if rest != ESCALATION_EVENT_KIND {
        return None;
    }
    if req_id.is_empty() {
        return None;
    }
    Some(req_id.to_string())
}

/// Best-effort recognition of any plugin-injected user message. Used by
/// the open-escalation filter to distinguish operator-typed replies
/// from messages the daemon wrote into the session itself (escalations,
/// wake breadcrumbs, resurrection notes). All of them share the
/// `── klodi ·` frame prefix.
pub fn is_plugin_injected(content: &str) -> bool {
    content.starts_with("── klodi ·")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_well_formed_escalation_with_summary_and_details() {
        let body = "── klodi · req=cae78f10 · klodi_escalate_to_user ──\n\
                    Need your pickup preference to close deal at €120\n\
                    \n\
                    Seller @alice_bot accepted €120 in principle and asked us \
                    to lock an exact pickup spot + time before formal acceptance.\n\
                    \n\
                    Options:\n\
                    - Areas: Syntagma, Kolonaki, Monastiraki\n\
                    Reply: /klodi yes:cae78f10  to confirm   /klodi no:cae78f10  to cancel";
        let esc = parse_escalation(body).expect("parses");
        assert_eq!(esc.req_id, "cae78f10");
        assert_eq!(esc.summary, "Need your pickup preference to close deal at €120");
        let details = esc.details.expect("details present");
        assert!(details.starts_with("Seller @alice_bot accepted €120"));
        assert!(details.contains("Options:"));
        // Reply hint must be stripped — it is render boilerplate.
        assert!(!details.contains("Reply:"));
    }

    #[test]
    fn parses_header_only_escalation_as_summary_only() {
        let body = "── klodi · req=aa318e8f · klodi_escalate_to_user ──\n\
                    Need pickup spot + time to finalize €120 deal\n\
                    Reply: /klodi yes:aa318e8f  to confirm";
        let esc = parse_escalation(body).expect("parses");
        assert_eq!(esc.req_id, "aa318e8f");
        assert_eq!(esc.summary, "Need pickup spot + time to finalize €120 deal");
        assert!(esc.details.is_none());
    }

    #[test]
    fn rejects_non_escalation_klodi_frames() {
        let body = "── klodi · req=ee0a4f13 · offer.accepted ──\n\
                    Deal struck at €140";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn rejects_operator_typed_message() {
        let body = "yes go ahead and negotiate autonomously";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn rejects_mangled_header_missing_separator() {
        // Missing the ` · ` between req_id and event kind.
        let body = "── klodi · req=abc klodi_escalate_to_user ──\nsummary";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn rejects_mangled_header_missing_trailing_marker() {
        let body = "── klodi · req=abc · klodi_escalate_to_user\nsummary";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn rejects_empty_req_id() {
        let body = "── klodi · req= · klodi_escalate_to_user ──\nsummary";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn rejects_empty_input() {
        assert!(parse_escalation("").is_none());
        assert!(parse_escalation("\n\n").is_none());
    }

    #[test]
    fn rejects_header_without_summary() {
        let body = "── klodi · req=abc · klodi_escalate_to_user ──";
        assert!(parse_escalation(body).is_none());
    }

    #[test]
    fn handles_blank_lines_between_summary_and_details_idempotently() {
        // Two consecutive blank lines before details — the parser should
        // still emit them as separator-blank lines inside the details
        // body without dropping them silently.
        let body = "── klodi · req=z9 · klodi_escalate_to_user ──\n\
                    short summary\n\
                    \n\
                    one detail line\n\
                    \n\
                    another\n\
                    Reply: /klodi yes:z9";
        let esc = parse_escalation(body).unwrap();
        let details = esc.details.unwrap();
        assert!(details.contains("one detail line"));
        assert!(details.contains("another"));
    }

    #[test]
    fn is_plugin_injected_recognises_all_klodi_frames() {
        assert!(is_plugin_injected("── klodi · req=x · klodi_escalate_to_user ──\nsummary"));
        assert!(is_plugin_injected("── klodi · req=y · offer.accepted ──\nsummary"));
        assert!(is_plugin_injected("── klodi · req=z · channel.message ──\nsummary"));
        assert!(!is_plugin_injected("yes go ahead"));
        assert!(!is_plugin_injected(""));
        // Trailing whitespace ahead of the marker doesn't qualify — we
        // deliberately match `starts_with` so an operator-typed message
        // that happens to mention the marker mid-sentence isn't mis-
        // classified.
        assert!(!is_plugin_injected(" ── klodi ·"));
    }

    /// Regression: the parser must round-trip whatever
    /// `dashboard::render_payload` produces today. If either side
    /// changes the wire format independently, the inbox stops showing
    /// escalations even though the data is flowing.
    #[test]
    fn parses_render_payload_output() {
        use crate::channels::Severity;
        use crate::channels::dashboard::render_payload;
        use crate::channels::Notification;

        let payload = Notification {
            event_kind: "klodi_escalate_to_user".into(),
            summary: "Need pickup spot + time to finalize €120 deal".into(),
            details: Some(
                "Seller already accepted €120 in principle.\n\
                 Options: Syntagma, Kolonaki, Monastiraki."
                    .into(),
            ),
            severity: Severity::OperatorImportant,
            structured: None,
            correlation_id: Some("aa318e8f".into()),
            reply_hint: None,
        };
        let rendered = render_payload(&payload, "aa318e8f");
        let parsed = parse_escalation(&rendered).expect("round-trip parse");
        assert_eq!(parsed.req_id, "aa318e8f");
        assert_eq!(
            parsed.summary,
            "Need pickup spot + time to finalize €120 deal"
        );
        let details = parsed.details.expect("details present");
        assert!(details.contains("Seller already accepted"));
        assert!(details.contains("Options:"));
        assert!(!details.contains("Reply:"));
    }
}
