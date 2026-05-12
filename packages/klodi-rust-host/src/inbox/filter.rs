//! Open-escalation filter — given the message list the gateway
//! returns for the klodi session, surface the escalations the operator
//! has not yet replied to.
//!
//! Correlation rules (from
//! `docs/plans/2026-05-12-klodi-inbox-self-hosted-ui.md` §6.3):
//!
//! 1. **Explicit:** any subsequent operator-typed message that contains
//!    the exact substring `req=<id>` is the reply for that escalation.
//! 2. **Implicit / adjacency:** the next operator-typed message after
//!    the escalation, within [`ADJACENCY_WINDOW`] (≤60s), is the reply.
//!    The window is shared with the dashboard channel's reply-bridge
//!    constant so the two surfaces agree on the same notion of
//!    "obviously the reply to the most recent escalation."
//!
//! An "operator-typed message" is any `role=user` message whose content
//! does NOT start with the `── klodi ·` plugin-injection frame
//! (see [`crate::inbox::parser::is_plugin_injected`]).
//!
//! Timestamps are parsed best-effort: we accept the gateway's
//! `created_at` ISO8601 string with optional fractional seconds and
//! either a `Z` or `+HH:MM` suffix. When parsing fails (or the gateway
//! omits the field), the implicit-adjacency rule falls back to "treat
//! the first operator-typed reply after the escalation as the reply"
//! — without a timestamp we can't do better, and a stale-closed card
//! is preferable to a stale-open one (the operator can re-issue by
//! typing again).

use crate::channels::dashboard::{ADJACENCY_WINDOW, DashboardMessage};
use crate::inbox::parser::{Escalation, is_plugin_injected, parse_escalation};

/// One open escalation, enriched with the timestamp the gateway
/// associated with the underlying message so the inbox UI can render
/// "3 min ago".
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenEscalation {
    pub escalation: Escalation,
    /// ISO8601 timestamp as the gateway returned it. `None` when the
    /// gateway omitted `created_at` for that message (older shapes).
    pub posted_at: Option<String>,
}

/// Walk `messages` chronologically and return every escalation that
/// has no correlating subsequent operator-typed reply. Plugin-injected
/// user messages (escalations, breadcrumbs, other `── klodi ·` frames)
/// are skipped when looking for the reply — they are noise from the
/// operator's perspective and would otherwise erroneously "close" an
/// open escalation.
pub fn open_escalations(messages: &[DashboardMessage]) -> Vec<OpenEscalation> {
    let mut out = Vec::new();
    for (idx, msg) in messages.iter().enumerate() {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let Some(content) = msg.content.as_deref() else {
            continue;
        };
        let Some(escalation) = parse_escalation(content) else {
            continue;
        };
        if has_reply(messages, idx, &escalation.req_id) {
            continue;
        }
        out.push(OpenEscalation {
            escalation,
            posted_at: msg.created_at.clone(),
        });
    }
    out
}

/// Did the operator reply to escalation `req_id` posted at index
/// `escalation_idx`? Explicit `req=<id>` match wins outright; otherwise
/// the next operator-typed message within `ADJACENCY_WINDOW` counts.
fn has_reply(
    messages: &[DashboardMessage],
    escalation_idx: usize,
    req_id: &str,
) -> bool {
    let escalation = &messages[escalation_idx];
    let escalation_ts = escalation.created_at.as_deref().and_then(parse_iso8601);
    let explicit_marker = format!("req={req_id}");
    let mut seen_reply_candidate = false;
    let window_secs = ADJACENCY_WINDOW.as_secs() as i64;
    for msg in &messages[escalation_idx + 1..] {
        if msg.role.as_deref() != Some("user") {
            continue;
        }
        let Some(content) = msg.content.as_deref() else {
            continue;
        };
        // Plugin-injected user messages (other escalations, channel
        // breadcrumbs, resurrection notes) are not operator replies.
        // Skip them when scanning for the operator's actual response.
        if is_plugin_injected(content) {
            continue;
        }
        // Explicit `req=<id>` substring is the strongest signal: an
        // operator reply that names the request id is definitively the
        // reply, regardless of when it landed.
        if content.contains(&explicit_marker) {
            return true;
        }
        // First operator-typed reply candidate. We only consider the
        // very next such message — later operator messages belong to
        // other threads (or to other open escalations the UI will
        // surface separately).
        if seen_reply_candidate {
            continue;
        }
        seen_reply_candidate = true;
        // Re-check the window here. If timestamps are available and the
        // candidate is outside the window, leave the escalation open —
        // without a reply within the window, the operator hasn't
        // addressed it.
        if let (Some(esc_ts), Some(reply_ts)) = (
            escalation_ts,
            msg.created_at.as_deref().and_then(parse_iso8601),
        ) {
            let delta = reply_ts - esc_ts;
            if delta >= 0 && delta <= window_secs {
                return true;
            }
            // Reply landed outside the window — escalation stays open.
            // Later messages may still close it via the explicit-match
            // branch above.
            continue;
        }
        // Timestamps missing — best-effort: count the first
        // operator-typed reply after the escalation as a match. A
        // stale closed-card is preferable to a stale open-card: the
        // operator can re-issue by typing the question again.
        return true;
    }
    false
}

/// Parse the gateway's ISO8601 `created_at` value into seconds-since-
/// epoch (UTC). Tolerates:
///
/// - `YYYY-MM-DDTHH:MM:SS` (naive, treated as UTC)
/// - `YYYY-MM-DDTHH:MM:SS.fff` (fractional seconds, dropped)
/// - `YYYY-MM-DDTHH:MM:SSZ` / `YYYY-MM-DDTHH:MM:SS.fffZ` (UTC marker)
/// - `YYYY-MM-DDTHH:MM:SS+HH:MM` / `±HH:MM` (timezone offset)
///
/// Returns `None` on any parse failure — callers degrade gracefully.
fn parse_iso8601(s: &str) -> Option<i64> {
    // Date + time components are positional; strip the offset suffix
    // before splitting so the parser only ever sees `YYYY-MM-DDTHH:MM:SS`
    // or `…SS.fff`.
    let (body, offset_secs) = split_offset(s)?;
    let (date_part, time_part) = body.split_once('T')?;
    let mut date_iter = date_part.split('-');
    let year: i64 = date_iter.next()?.parse().ok()?;
    let month: u32 = date_iter.next()?.parse().ok()?;
    let day: u32 = date_iter.next()?.parse().ok()?;
    if date_iter.next().is_some() {
        return None;
    }
    // Strip fractional seconds — sub-second precision isn't useful for
    // a 60s adjacency window.
    let time_main = time_part.split('.').next()?;
    let mut time_iter = time_main.split(':');
    let hour: u32 = time_iter.next()?.parse().ok()?;
    let minute: u32 = time_iter.next()?.parse().ok()?;
    let second: u32 = time_iter.next()?.parse().ok()?;
    if time_iter.next().is_some() {
        return None;
    }
    let days = crate::inbox::civil::days_from_civil(year, month, day)?;
    let secs = days
        .checked_mul(86_400)?
        .checked_add(hour as i64 * 3600 + minute as i64 * 60 + second as i64)?;
    // Subtract the offset to land on UTC seconds. A `+02:00` offset
    // means "local time is 2h ahead of UTC," so UTC = local − offset.
    secs.checked_sub(offset_secs)
}

/// Split an ISO8601 string into `(naive body, offset seconds)`. The
/// `Z` suffix is offset 0; `+HH:MM` / `-HH:MM` are converted; no
/// suffix treats the timestamp as already-UTC. Returns `None` on any
/// recognised-but-malformed suffix.
fn split_offset(s: &str) -> Option<(&str, i64)> {
    if let Some(body) = s.strip_suffix('Z') {
        return Some((body, 0));
    }
    let bytes = s.as_bytes();
    if bytes.len() < 6 {
        return Some((s, 0));
    }
    let sep_idx = bytes.len() - 6;
    let sign = bytes[sep_idx];
    if sign != b'+' && sign != b'-' {
        return Some((s, 0));
    }
    // Expecting `±HH:MM` at the tail.
    let tail = &s[sep_idx..];
    let mut iter = tail[1..].split(':');
    let hh: i64 = iter.next()?.parse().ok()?;
    let mm: i64 = iter.next()?.parse().ok()?;
    let abs = hh * 3600 + mm * 60;
    let signed = if sign == b'-' { -abs } else { abs };
    Some((&s[..sep_idx], signed))
}


#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str, created_at: Option<&str>) -> DashboardMessage {
        DashboardMessage {
            role: Some(role.to_string()),
            content: Some(content.to_string()),
            created_at: created_at.map(str::to_string),
            index: None,
        }
    }

    fn escalation_body(req_id: &str, summary: &str) -> String {
        format!(
            "── klodi · req={req_id} · klodi_escalate_to_user ──\n\
             {summary}\n\
             Reply: /klodi yes:{req_id}  to confirm   /klodi no:{req_id}  to cancel"
        )
    }

    #[test]
    fn lone_escalation_with_no_reply_is_open() {
        let msgs = vec![msg(
            "user",
            &escalation_body("e1", "need pickup spot"),
            Some("2026-05-12T10:00:00Z"),
        )];
        let open = open_escalations(&msgs);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].escalation.req_id, "e1");
        assert_eq!(open[0].posted_at.as_deref(), Some("2026-05-12T10:00:00Z"));
    }

    #[test]
    fn escalation_with_explicit_req_reply_is_closed() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need pickup spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            msg("assistant", "ok, asking for spot", Some("2026-05-12T10:00:30Z")),
            // Outside the 60s window — but explicit `req=e1` wins.
            msg(
                "user",
                "req=e1 — Saturday 12:30 Kolonaki",
                Some("2026-05-12T11:00:00Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert!(open.is_empty());
    }

    #[test]
    fn escalation_with_implicit_adjacent_reply_is_closed() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need pickup spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            // 30s after — well within the 60s adjacency window.
            msg(
                "user",
                "Saturday 12:30 Kolonaki",
                Some("2026-05-12T10:00:30Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert!(open.is_empty());
    }

    #[test]
    fn escalation_with_implicit_reply_outside_window_is_still_open() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need pickup spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            // 120s after — past the 60s window. Operator probably moved
            // on; surface as still open so the UI prompts again.
            msg(
                "user",
                "by the way, can you also check vintage chairs",
                Some("2026-05-12T10:02:00Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].escalation.req_id, "e1");
    }

    #[test]
    fn two_escalations_only_first_replied_returns_second() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "first ask"),
                Some("2026-05-12T10:00:00Z"),
            ),
            msg(
                "user",
                "ok here is the answer",
                Some("2026-05-12T10:00:30Z"),
            ),
            msg(
                "user",
                &escalation_body("e2", "second ask"),
                Some("2026-05-12T10:05:00Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].escalation.req_id, "e2");
    }

    #[test]
    fn interleaved_diagnostic_wake_then_operator_reply_correctly_closes() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need pickup spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            // A diagnostic wake (channel.message) lands as another
            // `role=user` plugin-injected message between the escalation
            // and the operator's reply. It must NOT be confused for the
            // operator's reply.
            msg(
                "user",
                "── klodi · req=qqq · channel.message ──\nseller said hi",
                Some("2026-05-12T10:00:10Z"),
            ),
            msg(
                "user",
                "Saturday 12:30 Kolonaki",
                Some("2026-05-12T10:00:30Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert!(open.is_empty());
    }

    #[test]
    fn plugin_message_alone_between_escalation_and_window_keeps_open() {
        // No operator reply at all — only plugin-injected diagnostics
        // after the escalation. Escalation stays open.
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            msg(
                "user",
                "── klodi · req=q · channel.message ──\nseller said hi",
                Some("2026-05-12T10:00:30Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].escalation.req_id, "e1");
    }

    #[test]
    fn assistant_replies_do_not_close_escalations() {
        let msgs = vec![
            msg(
                "user",
                &escalation_body("e1", "need spot"),
                Some("2026-05-12T10:00:00Z"),
            ),
            // Agent's interim acknowledgement — not an operator reply.
            msg(
                "assistant",
                "Got it — we just need one exact pickup slot…",
                Some("2026-05-12T10:00:05Z"),
            ),
        ];
        let open = open_escalations(&msgs);
        assert_eq!(open.len(), 1);
    }

    #[test]
    fn missing_timestamps_falls_back_to_first_operator_reply_as_close() {
        // Gateway omitted created_at on the reply — we still close the
        // escalation under the "best-effort" branch documented in
        // has_reply.
        let msgs = vec![
            msg("user", &escalation_body("e1", "need spot"), None),
            msg("user", "ok, send the spot", None),
        ];
        let open = open_escalations(&msgs);
        assert!(open.is_empty());
    }

    #[test]
    fn parse_iso8601_accepts_z_and_offset_and_fractional() {
        let z = parse_iso8601("2026-05-12T10:00:00Z").unwrap();
        let utc = parse_iso8601("2026-05-12T10:00:00+00:00").unwrap();
        assert_eq!(z, utc);
        let plus_two = parse_iso8601("2026-05-12T12:00:00+02:00").unwrap();
        assert_eq!(plus_two, z, "+02:00 must land on same UTC instant");
        let minus_two = parse_iso8601("2026-05-12T08:00:00-02:00").unwrap();
        assert_eq!(minus_two, z, "-02:00 must land on same UTC instant");
        assert!(parse_iso8601("2026-05-12T10:00:00.123Z").is_some());
        assert!(parse_iso8601("2026-05-12T10:00:00").is_some()); // naive UTC
        assert!(parse_iso8601("2026-05-12T10:00:00.456").is_some()); // naive UTC w/ fractional
        assert!(parse_iso8601("not a timestamp").is_none());
        assert!(parse_iso8601("2026-13-01T10:00:00Z").is_none()); // bad month
        assert!(parse_iso8601("2026-02-30T10:00:00Z").is_none()); // bad day
    }

    #[test]
    fn parse_iso8601_known_epoch_anchor() {
        // 1970-01-01T00:00:00Z is the Unix epoch — sanity-check that
        // days_from_civil + the offset arithmetic agree.
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        // 2026-05-12T10:00:00Z is a fixed reference point; the math
        // here is purely deterministic so the value is stable.
        // ((2026-05-12 - 1970-01-01) in days * 86400) + 10h
        // Pinning the exact integer ensures the days_from_civil port
        // wasn't broken by a copy-paste error.
        let expected = 1778580000;
        assert_eq!(parse_iso8601("2026-05-12T10:00:00Z"), Some(expected));
    }
}
