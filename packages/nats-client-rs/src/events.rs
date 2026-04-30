//! Wake event payloads.
//!
//! Mirrors `klodi-plugin/packages/tool-catalog/src/events.ts` byte-for-byte
//! at the wire level. Internally Rust represents the discriminated union
//! as a `serde(tag = "kind")` enum so the consumer code path can
//! pattern-match on the variant.
//!
//! The TS source of truth is regenerated to `dist/rust-types.rs` for the
//! ToolName enum, but the events module is hand-written here because
//! `serde(tag)` ergonomics differ enough from the TS shape that codegen
//! adds no value over a direct Rust mapping. Any change to the TS
//! `events.ts` MUST land in this file in lockstep — the wire is the
//! contract.

use serde::{Deserialize, Serialize};

/// Channel-stream event delivered by the channels consumer.
///
/// Subject: `p2p.v1.channels.<channel_id>.<sender_user_id>.msg`.
/// Published directly by participants — no marketplace handler in the
/// data path. The marketplace's side-consumer observes for moderation +
/// history index.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename = "channel.message")]
pub struct ChannelMessageEvent {
    /// UUID v4 used by the consumer-side dedup against `max_deliver: 5`.
    pub event_id: String,
    pub channel_id: String,
    /// Server-assigned message UUID; minted client-side by the publisher.
    pub message_id: String,
    /// JetStream sequence within the channel subject.
    pub sequence: u64,
    pub sender_user_id: String,
    pub sender_handle: String,
    /// Up to 2000 chars (Channel.message schema cap).
    pub content: String,
    /// ISO 8601.
    pub created_at: String,
}

/// Public summary of a listing carried inside a `search.match` wake.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SearchMatchListingSummary {
    pub title: String,
    /// Asking price in cents.
    pub asking_price: i64,
    pub currency: String,
    pub delivery_method: String,
    pub location_area: Option<String>,
    pub seller_handle: String,
    pub photos: Vec<String>,
}

/// Notification-stream event delivered by the notifications consumer.
///
/// Subject: `p2p.v1.notifications.<recipient_user_id>`. Drained from the
/// outbox (`notification_outbox`) by the marketplace's outbox worker —
/// always atomic with the underlying state change.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind")]
pub enum NotificationEvent {
    #[serde(rename = "listing.created")]
    ListingCreated {
        event_id: String,
        listing_id: String,
        title: Option<String>,
    },
    #[serde(rename = "listing.relisted")]
    ListingRelisted {
        event_id: String,
        listing_id: String,
        title: Option<String>,
    },
    #[serde(rename = "listing.withdrawn")]
    ListingWithdrawn { event_id: String, listing_id: String },
    #[serde(rename = "listing.sold")]
    ListingSold { event_id: String, listing_id: String },
    #[serde(rename = "listing.expired")]
    ListingExpired { event_id: String, listing_id: String },
    #[serde(rename = "listing.status_changed")]
    ListingStatusChanged {
        event_id: String,
        listing_id: String,
        old_status: String,
        new_status: String,
    },
    #[serde(rename = "offer.proposed")]
    OfferProposed {
        event_id: String,
        offer_id: String,
        listing_id: String,
        buyer_handle: String,
        /// Proposed amount in cents.
        amount: i64,
        terms: Option<serde_json::Value>,
    },
    #[serde(rename = "offer.accepted")]
    OfferAccepted {
        event_id: String,
        offer_id: String,
        listing_id: String,
        seller_handle: String,
        amount: Option<i64>,
        transaction_id: Option<String>,
    },
    #[serde(rename = "offer.rejected")]
    OfferRejected {
        event_id: String,
        offer_id: String,
        listing_id: String,
        seller_handle: String,
    },
    #[serde(rename = "transaction.completed")]
    TransactionCompleted {
        event_id: String,
        transaction_id: String,
        listing_id: String,
    },
    #[serde(rename = "transaction.cancelled")]
    TransactionCancelled {
        event_id: String,
        transaction_id: String,
        listing_id: String,
        cancelled_by_handle: Option<String>,
        reason: Option<String>,
    },
    #[serde(rename = "comment.created")]
    CommentCreated {
        event_id: String,
        listing_id: String,
        comment_id: String,
        handle: String,
        body: String,
        mentions: Vec<String>,
        created_at: String,
    },
    #[serde(rename = "search.match")]
    SearchMatch {
        event_id: String,
        search_slug: String,
        listing_id: String,
        listing_summary: SearchMatchListingSummary,
    },
    #[serde(rename = "channel.opened")]
    ChannelOpened {
        event_id: String,
        channel_id: String,
        listing_id: String,
        buyer_handle: Option<String>,
    },
    #[serde(rename = "channel.closed")]
    ChannelClosed {
        event_id: String,
        channel_id: String,
        listing_id: String,
        closed_by: Option<String>,
    },
}

impl NotificationEvent {
    /// Stable string discriminator — useful for logs and for the
    /// host wake primitives that key on the kind.
    pub fn kind(&self) -> &'static str {
        match self {
            NotificationEvent::ListingCreated { .. } => "listing.created",
            NotificationEvent::ListingRelisted { .. } => "listing.relisted",
            NotificationEvent::ListingWithdrawn { .. } => "listing.withdrawn",
            NotificationEvent::ListingSold { .. } => "listing.sold",
            NotificationEvent::ListingExpired { .. } => "listing.expired",
            NotificationEvent::ListingStatusChanged { .. } => "listing.status_changed",
            NotificationEvent::OfferProposed { .. } => "offer.proposed",
            NotificationEvent::OfferAccepted { .. } => "offer.accepted",
            NotificationEvent::OfferRejected { .. } => "offer.rejected",
            NotificationEvent::TransactionCompleted { .. } => "transaction.completed",
            NotificationEvent::TransactionCancelled { .. } => "transaction.cancelled",
            NotificationEvent::CommentCreated { .. } => "comment.created",
            NotificationEvent::SearchMatch { .. } => "search.match",
            NotificationEvent::ChannelOpened { .. } => "channel.opened",
            NotificationEvent::ChannelClosed { .. } => "channel.closed",
        }
    }

    /// Echoes the `event_id` from the discriminated union for
    /// per-consumer dedup.
    pub fn event_id(&self) -> &str {
        match self {
            NotificationEvent::ListingCreated { event_id, .. }
            | NotificationEvent::ListingRelisted { event_id, .. }
            | NotificationEvent::ListingWithdrawn { event_id, .. }
            | NotificationEvent::ListingSold { event_id, .. }
            | NotificationEvent::ListingExpired { event_id, .. }
            | NotificationEvent::ListingStatusChanged { event_id, .. }
            | NotificationEvent::OfferProposed { event_id, .. }
            | NotificationEvent::OfferAccepted { event_id, .. }
            | NotificationEvent::OfferRejected { event_id, .. }
            | NotificationEvent::TransactionCompleted { event_id, .. }
            | NotificationEvent::TransactionCancelled { event_id, .. }
            | NotificationEvent::CommentCreated { event_id, .. }
            | NotificationEvent::SearchMatch { event_id, .. }
            | NotificationEvent::ChannelOpened { event_id, .. }
            | NotificationEvent::ChannelClosed { event_id, .. } => event_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_message_round_trips() {
        let evt = ChannelMessageEvent {
            event_id: "11111111-1111-1111-1111-111111111111".into(),
            channel_id: "ch1".into(),
            message_id: "22222222-2222-2222-2222-222222222222".into(),
            sequence: 42,
            sender_user_id: "u1".into(),
            sender_handle: "alice".into(),
            content: "hello".into(),
            created_at: "2026-04-25T10:00:00.000Z".into(),
        };
        let json = serde_json::to_string(&evt).expect("serialize");
        assert!(json.contains("\"kind\":\"channel.message\""));
        let back: ChannelMessageEvent = serde_json::from_str(&json).expect("parse");
        assert_eq!(back.sequence, 42);
        assert_eq!(back, evt);
    }

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
        assert_eq!(evt.event_id(), "11111111-1111-1111-1111-111111111111");
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
        match &evt {
            NotificationEvent::SearchMatch { listing_summary, .. } => {
                assert_eq!(listing_summary.asking_price, 9500);
                assert_eq!(listing_summary.location_area.as_deref(), Some("Brooklyn, NY"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        let back = serde_json::to_value(&evt).expect("serialize");
        assert_eq!(back, body);
    }

    #[test]
    fn unknown_kind_rejected() {
        let body = r#"{"kind":"made.up.kind","event_id":"x"}"#;
        let parsed: Result<NotificationEvent, _> = serde_json::from_str(body);
        assert!(parsed.is_err());
    }
}
