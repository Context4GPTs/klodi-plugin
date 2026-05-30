//! Direct JetStream publish for channel messages.
//!
//! 0012 removes `p2p.v1.channels.send` as a request/reply tool. Instead,
//! each participant publishes a fully-formed `ChannelMessageEvent` directly
//! to:
//!
//!   `p2p.v1.channels.<channel_id>.<sender_user_id>.msg`
//!
//! The marketplace's side-consumer observes the publish for moderation +
//! history-index. The recipient's `klodi-channels-<recipient_id>` consumer
//! delivers the message as a wake.
//!
//! `event_id` and `message_id` are minted client-side here so dedup works
//! against the redelivery-on-reconnect path. JetStream's per-stream
//! `msg_id` deduplication uses the `event_id` to suppress duplicate sends.

use crate::error::KlodiError;
use async_nats::HeaderMap;
use async_nats::header::HeaderName;
use async_nats::jetstream::Context as JetStreamContext;
use serde::Serialize;
use std::str::FromStr;
use std::time::SystemTime;
use uuid::Uuid;

const MAX_CONTENT_LEN: usize = 2_000;
const NATS_MSG_ID_HEADER: &str = "Nats-Msg-Id";

/// Validate that `id` is a UUID v4 string (lowercase or uppercase hex).
/// Channel and sender IDs flow into a NATS subject — `.`-separated
/// tokens. An unvalidated id containing `\r\n`, whitespace, or wildcards
/// (`*`, `>`) could foul up the marketplace's side-consumer subject
/// parsing. Strict v4 matches `klodi_channel_create`'s output and the
/// catalog `Uuid` descriptor — see P1-11.
fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return false;
                }
            }
            14 => {
                if b != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Result of [`publish_channel_message`]. The `sequence` is JetStream's
/// stream sequence — the call returns once the message is durably stored.
#[derive(Clone, Debug)]
pub struct PublishAck {
    pub sequence: u64,
    pub event_id: String,
    pub message_id: String,
    pub created_at: String,
}

#[derive(Serialize)]
struct ChannelMessagePayload<'a> {
    kind: &'static str,
    event_id: &'a str,
    channel_id: &'a str,
    message_id: &'a str,
    sender_user_id: &'a str,
    sender_handle: &'a str,
    content: &'a str,
    created_at: &'a str,
}

/// Publish a channel message via direct JetStream publish.
///
/// `content` must be 1..=2000 chars to match the schema cap; empty or
/// over-long content is rejected without contacting the server.
pub async fn publish_channel_message(
    ctx: &JetStreamContext,
    channel_id: &str,
    sender_user_id: &str,
    sender_handle: &str,
    content: &str,
) -> Result<PublishAck, KlodiError> {
    if !is_uuid_v4(channel_id) {
        return Err(KlodiError::InvalidContent(
            "channel_id must be a UUID v4",
        ));
    }
    if !is_uuid_v4(sender_user_id) {
        return Err(KlodiError::InvalidContent(
            "sender_user_id must be a UUID v4",
        ));
    }
    if content.is_empty() {
        return Err(KlodiError::InvalidContent("content must not be empty"));
    }
    if content.chars().count() > MAX_CONTENT_LEN {
        return Err(KlodiError::InvalidContent(
            "content exceeds 2000 chars (Channel.message schema cap)",
        ));
    }

    let event_id = Uuid::new_v4().to_string();
    let message_id = Uuid::new_v4().to_string();
    let created_at = format_iso8601_now();
    let subject = format!("p2p.v1.channels.{channel_id}.{sender_user_id}.msg");

    let payload = ChannelMessagePayload {
        kind: "channel.message",
        event_id: &event_id,
        channel_id,
        message_id: &message_id,
        sender_user_id,
        sender_handle,
        content,
        created_at: &created_at,
    };
    let body = serde_json::to_vec(&payload)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_str(NATS_MSG_ID_HEADER).map_err(|err| {
            KlodiError::NatsPublish(format!("invalid msg-id header name: {err}"))
        })?,
        event_id.as_str(),
    );

    let ack_future = ctx
        .publish_with_headers(subject, headers, body.into())
        .await
        .map_err(|err| KlodiError::NatsPublish(err.to_string()))?;

    let ack = ack_future
        .await
        .map_err(|err| KlodiError::NatsPublish(format!("publish ack failed: {err}")))?;

    Ok(PublishAck {
        sequence: ack.sequence,
        event_id,
        message_id,
        created_at,
    })
}

// ── Match-feedback publish (SC8 flywheel emit) ────────────────────────
//
// Reports an agent's pursue/dismiss verdict on a standing-search match to
// `p2p.v1.searches.match_feedback`. Byte-for-byte wire parity with the TS
// `publishMatchFeedback` and the Python `publish_match_feedback`: same field
// order, `action_on_match` omitted (not null) when absent. The body carries
// the ACTION (`outcome`), never a ± label — that is server-derived.
//
// Moltis / IronClaw / ZeroClaw are daemon hosts with an empty in-agent tool
// surface, so they do NOT register this tool — but the crate carries the
// payload + validator for cross-crate wire parity (same as the channel
// message helper). Unlike `ChannelMessagePayload` (private, in-module-tested),
// these are `pub` so the parity test in `tests/` can reach them cross-crate.
//
// The validator diverges deliberately from `is_uuid_v4`: `search_slug` /
// `listing_id` ride in the BODY, not a subject path, so a non-UUID listing id
// the marketplace accepts must be accepted here too. See the card
// emit-standing-search-accept-dismiss-feedback.

/// The match-feedback wire body. Exactly four fields — no `kind`, no
/// `event_id` (that is a dedup header), no `label`, no `listing_summary`.
/// `action_on_match` is omitted when `None` so the marketplace defaults it.
#[derive(Serialize)]
pub struct MatchFeedbackPayload<'a> {
    pub search_slug: &'a str,
    pub listing_id: &'a str,
    pub outcome: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_on_match: Option<&'a str>,
}

const MAX_LISTING_ID_LEN: usize = 64;
const MAX_SEARCH_SLUG_LEN: usize = 120;

/// Whether `slug` matches the marketplace pattern
/// `^[a-z0-9][a-z0-9._-]{0,119}$` (1..=120 chars, lowercase-alnum first char,
/// then lowercase-alnum / `.` / `_` / `-`). Byte-walk to avoid a regex dep,
/// mirroring `is_uuid_v4`.
fn is_valid_search_slug(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > MAX_SEARCH_SLUG_LEN {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        let ok = match b {
            b'a'..=b'z' | b'0'..=b'9' => true,
            b'.' | b'_' | b'-' => i != 0,
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// Validate a match-feedback verdict's body ids + outcome BEFORE any wire
/// write. `search_slug` must match the marketplace slug pattern; `listing_id`
/// must be a 1..=64-char non-empty string (NOT a UUID — the marketplace
/// re-reads the Listing row as the real gate); `outcome` must be the closed
/// `{pursued, dismissed}` set.
pub fn validate_match_feedback(
    search_slug: &str,
    listing_id: &str,
    outcome: &str,
) -> Result<(), KlodiError> {
    if !is_valid_search_slug(search_slug) {
        return Err(KlodiError::InvalidContent(
            "search_slug must match ^[a-z0-9][a-z0-9._-]{0,119}$",
        ));
    }
    if listing_id.is_empty() || listing_id.len() > MAX_LISTING_ID_LEN {
        return Err(KlodiError::InvalidContent(
            "listing_id must be 1..=64 chars",
        ));
    }
    if !matches!(outcome, "pursued" | "dismissed") {
        return Err(KlodiError::InvalidContent(
            "outcome must be 'pursued' or 'dismissed'",
        ));
    }
    Ok(())
}

/// Publish a match-feedback verdict to `p2p.v1.searches.match_feedback`.
/// Stateless: each call mints a fresh `event_id` (the `Nats-Msg-Id` dedup
/// header), so a redelivered wake or a flipped verdict re-emits safely.
///
/// The daemon Rust hosts don't expose this tool today (empty in-agent
/// allowlist), but the helper is here for wire parity and any future
/// daemon-side caller.
pub async fn publish_match_feedback(
    ctx: &JetStreamContext,
    search_slug: &str,
    listing_id: &str,
    outcome: &str,
    action_on_match: Option<&str>,
) -> Result<PublishAck, KlodiError> {
    validate_match_feedback(search_slug, listing_id, outcome)?;

    let event_id = Uuid::new_v4().to_string();
    let created_at = format_iso8601_now();
    let subject = "p2p.v1.searches.match_feedback";

    let payload = MatchFeedbackPayload {
        search_slug,
        listing_id,
        outcome,
        action_on_match,
    };
    let body = serde_json::to_vec(&payload)?;

    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_str(NATS_MSG_ID_HEADER).map_err(|err| {
            KlodiError::NatsPublish(format!("invalid msg-id header name: {err}"))
        })?,
        event_id.as_str(),
    );

    let ack_future = ctx
        .publish_with_headers(subject.to_string(), headers, body.into())
        .await
        .map_err(|err| KlodiError::NatsPublish(err.to_string()))?;

    let ack = ack_future
        .await
        .map_err(|err| KlodiError::NatsPublish(format!("publish ack failed: {err}")))?;

    Ok(PublishAck {
        sequence: ack.sequence,
        event_id,
        // match-feedback has no message_id; the body carries no second id.
        message_id: String::new(),
        created_at,
    })
}

/// RFC 3339 / ISO 8601 with millisecond precision and 'Z' suffix to match
/// the TS publisher byte-for-byte. Avoids pulling chrono / time as a dep —
/// SystemTime gives us seconds + nanos directly.
fn format_iso8601_now() -> String {
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let total_secs = dur.as_secs();
    let millis = dur.subsec_millis();
    format_iso8601_from_epoch_secs(total_secs, millis)
}

fn format_iso8601_from_epoch_secs(total_secs: u64, millis: u32) -> String {
    // Days since 1970-01-01 (Thu).
    let secs_per_day: u64 = 86_400;
    let days = total_secs / secs_per_day;
    let secs_of_day = total_secs % secs_per_day;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    let (y, m, d) = days_to_ymd(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    )
}

/// Convert "days since 1970-01-01" into (year, month, day). Plain
/// civil-from-days algorithm — Howard Hinnant's date library. Six lines,
/// proves out for the calendar range we care about (1970–2300).
fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z / 146_097 } else { (z - 146_096) / 146_097 };
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { (mp + 3) as u32 } else { (mp - 9) as u32 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso8601_format_shape_matches_ts() {
        let s = format_iso8601_from_epoch_secs(1_745_481_600, 123);
        // 2025-04-24T08:00:00.123Z
        assert_eq!(s.len(), "2025-04-24T08:00:00.123Z".len());
        assert!(s.ends_with('Z'));
        assert!(s.contains('T'));
        assert!(s.contains('.'));
    }

    #[test]
    fn is_uuid_v4_accepts_canonical_form() {
        assert!(is_uuid_v4("00000000-0000-4000-8000-000000000000"));
        assert!(is_uuid_v4(&Uuid::new_v4().to_string()));
    }

    #[test]
    fn is_uuid_v4_rejects_non_v4() {
        // v1 UUID — version nibble is 1, not 4.
        assert!(!is_uuid_v4("00000000-0000-1000-8000-000000000000"));
    }

    #[test]
    fn is_uuid_v4_rejects_subject_injection() {
        // Wildcards / newlines in subject path must not pass validation.
        assert!(!is_uuid_v4("*"));
        assert!(!is_uuid_v4(">"));
        assert!(!is_uuid_v4("00000000-0000-4000-8000-00000000000\n"));
        assert!(!is_uuid_v4(""));
    }

    #[test]
    fn ymd_round_trips_known_dates() {
        // 2026-04-25 is 20568 days since epoch.
        assert_eq!(days_to_ymd(20_568), (2026, 4, 25));
        // 1970-01-01 is day 0.
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2000-02-29 (leap year) is day 11_016.
        assert_eq!(days_to_ymd(11_016), (2000, 2, 29));
    }

    #[test]
    fn payload_serializes_with_kind_first() {
        let p = ChannelMessagePayload {
            kind: "channel.message",
            event_id: "e",
            channel_id: "c",
            message_id: "m",
            sender_user_id: "u",
            sender_handle: "alice",
            content: "hi",
            created_at: "2026-04-25T00:00:00.000Z",
        };
        let s = serde_json::to_string(&p).expect("serialize");
        assert!(s.starts_with(r#"{"kind":"channel.message""#));
        assert!(s.contains(r#""sender_handle":"alice""#));
    }

    #[test]
    fn uuid_v4_accepts_canonical_lowercase() {
        assert!(is_uuid_v4("3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f"));
    }

    #[test]
    fn uuid_v4_accepts_canonical_uppercase() {
        assert!(is_uuid_v4("3B9B1D2E-4A8C-4F1D-A3F0-7C5B3A2E8C1F"));
    }

    #[test]
    fn uuid_v4_rejects_wrong_version_byte() {
        // Version byte at index 14 is `1`, not `4`.
        assert!(!is_uuid_v4("3b9b1d2e-4a8c-1f1d-93f0-7c5b3a2e8c1f"));
    }

    #[test]
    fn uuid_v4_rejects_wrong_variant_byte() {
        // Variant byte at index 19 is `c`, not in {8,9,a,b}.
        assert!(!is_uuid_v4("3b9b1d2e-4a8c-4f1d-c3f0-7c5b3a2e8c1f"));
    }

    #[test]
    fn uuid_v4_rejects_wildcards_and_whitespace() {
        assert!(!is_uuid_v4("3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1*"));
        assert!(!is_uuid_v4("3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1>"));
        assert!(!is_uuid_v4(" 3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f"));
        assert!(!is_uuid_v4("3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f\n"));
    }

    #[test]
    fn uuid_v4_rejects_wrong_length() {
        assert!(!is_uuid_v4(""));
        assert!(!is_uuid_v4("3b9b1d2e"));
        assert!(!is_uuid_v4(
            "3b9b1d2e-4a8c-4f1d-93f0-7c5b3a2e8c1f0000"
        ));
    }
}
