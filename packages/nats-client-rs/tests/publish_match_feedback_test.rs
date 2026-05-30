//! Publish-boundary contract tests for `publish_match_feedback` (Rust half).
//!
//! The flywheel-emit helper added by card
//! emit-standing-search-accept-dismiss-feedback (SC8). This is the Rust arm
//! of the 3-language byte-parity set (TS + Python + Rust). Moltis / IronClaw
//! / ZeroClaw are daemon hosts with an EMPTY in-agent tool surface, so they
//! do NOT register this tool — but the `nats-client-rs` crate carries the
//! helper for wire parity (same as `publish_channel_message`), so the wire
//! shape is pinned here in lockstep with the other two languages.
//!
//! RED-first: the symbols below do not exist yet. A Rust integration test
//! that references a not-yet-defined public item fails to COMPILE — that is
//! the idiomatic Rust RED signal (the exact analogue of the TS import
//! resolving to `undefined` and the Python `ImportError`). Each `tests/*.rs`
//! file compiles as its own crate, so this RED is isolated: it fails only
//! this target, leaving `cargo test --lib` and the other integration targets
//! green. Once the expert-developer adds the public `MatchFeedbackPayload`
//! struct + `validate_match_feedback` predicate to
//! `packages/nats-client-rs/src/publish.rs`, this becomes a passing
//! assertion-based test.
//!
//! Wire contract (sibling marketplace
//! `4gpts-p2p-marketplace/packages/schemas/src/match-feedback.ts`):
//!   subject  p2p.v1.searches.match_feedback   (formed in the helper)
//!   body     {search_slug, listing_id, outcome, action_on_match?}
//!   additionalProperties: false  — NO label, NO listing_summary.
//!
//! Per the `adversarial-testing` skill: NEVER weaken these asserts. The
//! single load-bearing Rust invariant: `listing_id` rides in the BODY, not a
//! subject path, so the helper MUST NOT reuse the strict UUID-v4 guard from
//! `publish_channel_message`. A non-UUID `listing_id` must be accepted.

// RED: these public items do not exist yet. The expert-developer adds them to
// src/publish.rs (mirroring the public surface of the TS/Py halves so the
// wire shape is cross-crate testable).
use klodi_nats_client::publish::{validate_match_feedback, MatchFeedbackPayload};

// A real human buy-file slug (^[a-z0-9][a-z0-9._-]{0,119}$). NOT a UUID.
const SEARCH_SLUG: &str = "vintage-camera_01";
// Deliberately NOT a UUID v4 — the marketplace accepts a bounded string here
// and re-reads the Listing row as the real gate. Copying the channel-message
// UUID guard would wrongly reject this.
const NON_UUID_LISTING_ID: &str = "listing-7f3a";

/// The serialized body must be EXACTLY the four marketplace fields, in a
/// stable order, with no `kind`/`event_id`/`label`/`listing_summary`. The
/// `event_id` is a dedup HEADER, never a body field (unlike channel.message,
/// the match-feedback body has no `kind` and no `event_id`).
#[test]
fn payload_serializes_to_the_four_fields_no_label() {
    let payload = MatchFeedbackPayload {
        search_slug: SEARCH_SLUG,
        listing_id: NON_UUID_LISTING_ID,
        outcome: "pursued",
        action_on_match: Some("notify"),
    };
    let s = serde_json::to_string(&payload).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&s).expect("parse");
    let obj = v.as_object().expect("object");

    // Closed-set trust-boundary assertion — exactly these keys.
    let keys: std::collections::BTreeSet<&str> =
        obj.keys().map(String::as_str).collect();
    let expected: std::collections::BTreeSet<&str> =
        ["search_slug", "listing_id", "outcome", "action_on_match"]
            .into_iter()
            .collect();
    assert_eq!(keys, expected, "body must carry exactly the four fields");

    assert_eq!(obj["search_slug"], serde_json::json!(SEARCH_SLUG));
    assert_eq!(obj["listing_id"], serde_json::json!(NON_UUID_LISTING_ID));
    assert_eq!(obj["outcome"], serde_json::json!("pursued"));
    assert_eq!(obj["action_on_match"], serde_json::json!("notify"));

    // The ± label is server-derived — never on the wire.
    assert!(!obj.contains_key("label"), "label must not be sent");
    assert!(
        !obj.contains_key("listing_summary"),
        "listing_summary is re-read server-side, never sent"
    );
    // No channel-message leakage.
    assert!(!obj.contains_key("kind"), "match-feedback body has no kind");
    assert!(
        !obj.contains_key("event_id"),
        "event_id is a dedup header, not a body field"
    );
}

#[test]
fn dismiss_serializes_outcome_dismissed() {
    let payload = MatchFeedbackPayload {
        search_slug: SEARCH_SLUG,
        listing_id: NON_UUID_LISTING_ID,
        outcome: "dismissed",
        action_on_match: Some("notify"),
    };
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&payload).expect("serialize"))
            .expect("parse");
    assert_eq!(v["outcome"], serde_json::json!("dismissed"));
    assert_ne!(v["outcome"], serde_json::json!("hard_negative"));
}

#[test]
fn provenance_negotiate_is_reported_honestly() {
    // Reporting `negotiate` honestly (curation will drop it) is correct;
    // rewriting it to `notify` poisons the corpus.
    let payload = MatchFeedbackPayload {
        search_slug: SEARCH_SLUG,
        listing_id: NON_UUID_LISTING_ID,
        outcome: "pursued",
        action_on_match: Some("negotiate"),
    };
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&payload).expect("serialize"))
            .expect("parse");
    assert_eq!(v["action_on_match"], serde_json::json!("negotiate"));
}

#[test]
fn action_on_match_is_omitted_when_none() {
    // Optional provenance: `None` must serialize to an ABSENT field (the
    // marketplace defaults it), not a JSON null. The struct field must carry
    // `#[serde(skip_serializing_if = "Option::is_none")]`.
    let payload = MatchFeedbackPayload {
        search_slug: SEARCH_SLUG,
        listing_id: NON_UUID_LISTING_ID,
        outcome: "pursued",
        action_on_match: None,
    };
    let v: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&payload).expect("serialize"))
            .expect("parse");
    let obj = v.as_object().expect("object");
    assert!(
        !obj.contains_key("action_on_match"),
        "absent provenance must be omitted, not serialized as null"
    );
}

// ── Validation: body ids are slug/bounded-string, NOT UUID-v4 ──────────────

#[test]
fn validate_accepts_non_uuid_listing_id() {
    // The load-bearing card assertion: a non-UUID listing_id must NOT be
    // rejected. (Contrast `is_uuid_v4` in publish_channel_message, which
    // rejects this — that guard exists because channel ids flow into the
    // subject path; match-feedback ids ride in the body.)
    assert!(
        validate_match_feedback(SEARCH_SLUG, NON_UUID_LISTING_ID, "pursued").is_ok(),
        "a non-UUID listing_id must be accepted"
    );
}

#[test]
fn validate_accepts_slug_with_dots_dashes_underscores() {
    assert!(validate_match_feedback("a.b-c_d0", NON_UUID_LISTING_ID, "dismissed").is_ok());
}

#[test]
fn validate_rejects_out_of_set_outcome() {
    for bad in ["positive", "hard_negative", "negative", "", "PURSUED"] {
        assert!(
            validate_match_feedback(SEARCH_SLUG, NON_UUID_LISTING_ID, bad).is_err(),
            "outcome {bad:?} is out of the closed set and must be rejected"
        );
    }
}

#[test]
fn validate_rejects_bad_search_slug() {
    // Subject-injection / pattern violations. The slug pattern is
    // ^[a-z0-9][a-z0-9._-]{0,119}$ — uppercase, spaces, a leading dash, and
    // over-length all violate it.
    let over_long = "x".repeat(200);
    for bad in ["", "Has Space", "UPPER", "-leading-dash", over_long.as_str()] {
        assert!(
            validate_match_feedback(bad, NON_UUID_LISTING_ID, "pursued").is_err(),
            "search_slug {bad:?} violates the slug pattern and must be rejected"
        );
    }
}

#[test]
fn validate_rejects_empty_or_overlong_listing_id() {
    let over_long = "x".repeat(65);
    for bad in ["", over_long.as_str()] {
        assert!(
            validate_match_feedback(SEARCH_SLUG, bad, "pursued").is_err(),
            "listing_id {bad:?} (empty or >64) must be rejected"
        );
    }
}
