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
    ChannelMessageEvent, NotificationEvent, SearchMatchListingSummary,
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
            "delivery_method": "pickup",
            "location_area": "Brooklyn, NY",
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

#[test]
fn channel_message_event_round_trips() {
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
    assert_eq!(evt.event_id, "11111111-1111-1111-1111-111111111111");
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
fn search_match_listing_summary_optional_location() {
    let body = serde_json::json!({
        "title": "Free!",
        "asking_price": 0,
        "currency": "USD",
        "delivery_method": "pickup",
        "location_area": null,
        "seller_handle": "alice",
        "photos": []
    });
    let summary: SearchMatchListingSummary =
        serde_json::from_value(body).expect("parse");
    assert_eq!(summary.location_area, None);
    assert!(summary.photos.is_empty());
}
