//! Crate-level integration tests that don't require a live NATS server.
//!
//! Live JetStream coverage is the responsibility of the cross-service
//! suite at `tests/` — see the `@klodi/tests` workspace package. These
//! tests pin the encoding contracts the wire depends on:
//!
//!   - notification + channel event JSON shapes round-trip
//!   - the catalog (subject + tool name) covers every klodi_* surface
//!   - the channel publish payload starts with `kind: "channel.message"`

use klodi_nats_client::catalog::ToolName;
use klodi_nats_client::events::{
    ChannelMessageEvent, DeliveryOffer, NotificationEvent, SearchMatchListingSummary,
};

#[test]
fn notification_offer_proposed_round_trips() {
    let body = serde_json::json!({
        "kind": "offer.proposed",
        "event_id": "11111111-1111-1111-1111-111111111111",
        "offer_id": "off1",
        "listing_id": "list1",
        "buyer_handle": "bob",
        "amount": 12500,
        "terms": null
    });
    let evt: NotificationEvent =
        serde_json::from_value(body.clone()).expect("parse");
    assert_eq!(evt.kind(), "offer.proposed");
    let back = serde_json::to_value(&evt).expect("serialize");
    assert_eq!(back, body);
}

#[test]
fn notification_search_match_round_trips() {
    let body = serde_json::json!({
        "kind": "search.match",
        "event_id": "11111111-1111-1111-1111-111111111111",
        "search_slug": "vintage-camera",
        "listing_id": "list42",
        "listing_summary": {
            "title": "Pentax K1000",
            "asking_price": 9500,
            "currency": "USD",
            "fulfillment": [
                {
                    "method": "pickup",
                    "location": {
                        "lat": 40.6782,
                        "lng": -73.9442,
                        "area": "Brooklyn, NY"
                    }
                }
            ],
            "seller_handle": "alice",
            "photos": ["https://example/1.jpg"]
        }
    });
    let evt: NotificationEvent =
        serde_json::from_value(body.clone()).expect("parse");
    assert_eq!(evt.kind(), "search.match");
    let back = serde_json::to_value(&evt).expect("serialize");
    assert_eq!(back, body);
}

/// The wire-shape parity bug (P0, 2026-05-09): the publisher emits
/// channel.message bodies WITHOUT a `sequence` field — JetStream
/// assigns the sequence server-side. Before the fix, the Rust struct
/// required the field and `serde_json::from_slice` failed, ack-with-
/// parse_failed dropped the wake, and the agent never woke. Pin the
/// successful parse here so a future regression fails loud.
#[test]
fn channel_message_parses_publisher_body_without_sequence() {
    let body = serde_json::json!({
        "kind": "channel.message",
        "event_id": "11111111-1111-1111-1111-111111111111",
        "channel_id": "ch1",
        "message_id": "22222222-2222-2222-2222-222222222222",
        "sender_user_id": "u1",
        "sender_handle": "alice",
        "content": "hello",
        "created_at": "2026-04-25T10:00:00.000Z"
    });
    let evt: ChannelMessageEvent =
        serde_json::from_value(body).expect("publisher body must parse");
    assert_eq!(evt.event_id, "11111111-1111-1111-1111-111111111111");
    // The consumer overwrites this from msg.info().stream_sequence after
    // parse — the default is the safe fallback when info() fails.
    assert_eq!(evt.sequence, 0);
}

#[test]
fn channel_message_event_round_trips_with_sequence() {
    // Once the consumer populates `sequence` from JetStream metadata,
    // re-serialization must preserve the field for downstream wake POSTs.
    let body = serde_json::json!({
        "kind": "channel.message",
        "event_id": "11111111-1111-1111-1111-111111111111",
        "channel_id": "ch1",
        "message_id": "22222222-2222-2222-2222-222222222222",
        "sequence": 42,
        "sender_user_id": "u1",
        "sender_handle": "alice",
        "content": "hello",
        "created_at": "2026-04-25T10:00:00.000Z"
    });
    let evt: ChannelMessageEvent =
        serde_json::from_value(body.clone()).expect("parse");
    assert_eq!(evt.sequence, 42);
    let back = serde_json::to_value(&evt).expect("serialize");
    assert_eq!(back, body);
}

#[test]
fn unknown_notification_kind_rejected() {
    let body = r#"{"kind":"made.up.kind","event_id":"x"}"#;
    let parsed: Result<NotificationEvent, _> = serde_json::from_str(body);
    assert!(parsed.is_err());
}

#[test]
fn catalog_subjects_use_p2p_v1_prefix() {
    let names = [
        ToolName::KlodiWhoami,
        ToolName::KlodiListCreate,
        ToolName::KlodiSearchesCreate,
        ToolName::KlodiChannelClose,
        ToolName::KlodiOfferCreate,
        ToolName::KlodiTxConfirm,
    ];
    for n in names {
        assert!(n.subject().starts_with("p2p.v1."));
    }
}

#[test]
fn search_match_listing_summary_accepts_multi_offer_fulfillment() {
    let body = serde_json::json!({
        "title": "Refurbished ThinkPad",
        "asking_price": 80000,
        "currency": "USD",
        "fulfillment": [
            { "method": "digital" },
            {
                "method": "ship",
                "from": { "country": "US" },
                "shipsTo": ["US", "CA"]
            }
        ],
        "seller_handle": "rare_finds",
        "photos": []
    });
    let summary: SearchMatchListingSummary =
        serde_json::from_value(body).expect("parse");
    assert_eq!(summary.fulfillment.len(), 2);
    assert!(matches!(summary.fulfillment[0], DeliveryOffer::Digital));
    match &summary.fulfillment[1] {
        DeliveryOffer::Ship { from, ships_to } => {
            assert_eq!(from.country, "US");
            assert_eq!(ships_to, &vec!["US".to_string(), "CA".to_string()]);
        }
        other => panic!("expected ship offer, got {other:?}"),
    }
    assert!(summary.photos.is_empty());
}
