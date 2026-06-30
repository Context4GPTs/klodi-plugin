//! Per-conversation wake-session keying for the Rust adapters.
//!
//! Direct port of the frozen hermes scheme
//! (`adapters/hermes/src/klodi_hermes/wake_handlers.py::derive_wake_session`)
//! recorded in **ADR-0019** ("Wake session model — per-conversation,
//! `klodi:`-namespaced"). One marketplace conversation maps to exactly one
//! wake session, derived deterministically from the event entity — keyed off
//! the kind's DOMAIN prefix (see `_SESSION_KEY_FIELD_BY_DOMAIN` in the hermes
//! reference), NOT "first id present":
//!
//! | Wake kind                                           | session key            |
//! |-----------------------------------------------------|------------------------|
//! | `channel.*`                                         | `klodi:<channel_id>`   |
//! | `offer.*` · `comment.created` · `listing.*`         | `klodi:<listing_id>`   |
//! | `transaction.*`                                     | `klodi:<transaction_id>` |
//! | `search.match`                                      | `klodi:<search_slug>`  |
//! | mapped key field empty / poisoned                   | `klodi:wake-<event_id>` (or `klodi:wake-<uuid4>`) |
//!
//! Because the extraction is an EXHAUSTIVE typed match over the
//! `NotificationEvent` / `ChannelMessageEvent` enums (never dict `.get`), a new
//! event variant forces a keying decision at compile time — fail-fast, never a
//! silent fallthrough.

use crate::forwarder::WakeEvent;
use klodi_nats_client::NotificationEvent;

/// Namespace prefix on EVERY wake-session key. Lets an outbound/operator-session
/// resolver exclude the whole wake-session family by this prefix (the BR-5
/// separability contract; ADR-0019 "Why the `klodi:` namespace is load-bearing").
/// A bare entity id — especially a `search_slug` like `vintage-camera` — is
/// otherwise indistinguishable from a session a human operator owns.
pub const WAKE_SESSION_NAMESPACE: &str = "klodi:";

/// Derive the per-conversation `--session` key for a wake.
///
/// See the module docs + ADR-0019 for the frozen domain-prefix → id-field map.
/// A poisoned id (empty, contains a path separator, or starts with `.`) is
/// REFUSED at this boundary (THREAT_MODEL T5) — it never becomes the session
/// key; the safe per-wake ephemeral fallback (`klodi:wake-<event_id>`) is
/// produced instead, mirroring hermes `_reject_traversal_entity_id`.
pub fn derive_wake_session(event: &WakeEvent) -> String {
    // ADR-0019 + `_SESSION_KEY_FIELD_BY_DOMAIN` (the hermes reference,
    // `adapters/hermes/src/klodi_hermes/wake_handlers.py`): the entity id is
    // pulled by the EXHAUSTIVE typed match in `entity_id`, keyed off the kind's
    // DOMAIN — never "first id present". A poisoned or absent id folds into the
    // bounded per-wake ephemeral fallback: this `-> String` signature cannot
    // raise, so traversal refusal IS the fallback and the poisoned id never
    // reaches the output (THREAT_MODEL T5).
    if let Some(id) = entity_id(event) {
        if is_safe_entity_id(&id) {
            return format!("{WAKE_SESSION_NAMESPACE}{id}");
        }
    }
    format!("{WAKE_SESSION_NAMESPACE}{}", ephemeral_id(event.event_id()))
}

/// Bounded per-wake fallback id: `wake-<event_id>`, or `wake-<uuid4>` when the
/// wake carries no `event_id` — NEVER a shared constant (BR-3), which would
/// re-introduce the unbounded shared-session bug being fixed.
fn ephemeral_id(event_id: &str) -> String {
    if event_id.is_empty() {
        format!("wake-{}", uuid::Uuid::new_v4())
    } else {
        format!("wake-{event_id}")
    }
}

/// Refuse a marketplace-supplied id that is not a single safe path component
/// (mirrors hermes `_reject_traversal_entity_id`; THREAT_MODEL T5). Returning
/// `false` routes the wake to the safe ephemeral fallback above, so a poisoned
/// id never becomes a `--session klodi:../…` arg or a derived filename.
fn is_safe_entity_id(id: &str) -> bool {
    !id.is_empty()
        && !id.contains('/')
        && !id.contains('\\')
        && !id.starts_with('.')
}

/// The conversation entity id a wake scopes to, keyed off the event's DOMAIN
/// (ADR-0019). EXHAUSTIVE over `NotificationEvent` / `ChannelMessageEvent`: a
/// new variant forces a keying decision at compile time (fail-fast), never a
/// silent fallthrough. `None` when the mapped field is empty.
fn entity_id(event: &WakeEvent) -> Option<String> {
    match event {
        WakeEvent::ChannelMessage { payload, .. } => non_empty(&payload.channel_id),
        WakeEvent::Notification { payload, .. } => notification_entity_id(payload),
    }
}

fn notification_entity_id(payload: &NotificationEvent) -> Option<String> {
    use NotificationEvent::*;
    match payload {
        // `offer.*` · `comment.created` · `listing.*` all scope to the LISTING
        // (the negotiation's subject) — keyed off the domain prefix, NOT the
        // first id present (`offer.accepted` also carries a `transaction_id`).
        ListingCreated { listing_id, .. }
        | ListingRelisted { listing_id, .. }
        | ListingWithdrawn { listing_id, .. }
        | ListingSold { listing_id, .. }
        | ListingExpired { listing_id, .. }
        | ListingStatusChanged { listing_id, .. }
        | OfferProposed { listing_id, .. }
        | OfferAccepted { listing_id, .. }
        | OfferRejected { listing_id, .. }
        | CommentCreated { listing_id, .. } => non_empty(listing_id),
        // `transaction.*` → transaction_id (NOT the co-carried listing_id).
        TransactionCompleted { transaction_id, .. }
        | TransactionCancelled { transaction_id, .. } => non_empty(transaction_id),
        // `search.match` → search_slug.
        SearchMatch { search_slug, .. } => non_empty(search_slug),
        // `channel.*` → channel_id.
        ChannelOpened { channel_id, .. } | ChannelClosed { channel_id, .. } => {
            non_empty(channel_id)
        }
    }
}

fn non_empty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    //! card/openclaw-zeroclaw-per-conversation-wake-keying (Item 1, Rust port).
    //!
    //! Spec for `derive_wake_session`. Mirrors the hermes
    //! `test_wake_session_keying` shapes against the frozen ADR-0019 scheme.
    //! These assertions ARE the spec — never weaken one to match a partial
    //! implementation.

    use super::*;
    use crate::forwarder::WakeEvent;
    use klodi_nats_client::{ChannelMessageEvent, NotificationEvent};

    fn notif(payload: NotificationEvent) -> WakeEvent {
        WakeEvent::Notification {
            kind: payload.kind().to_string(),
            event_id: payload.event_id().to_string(),
            user_id: "u1".into(),
            payload,
        }
    }

    fn offer_on(event_id: &str, listing_id: &str) -> WakeEvent {
        notif(NotificationEvent::OfferProposed {
            event_id: event_id.into(),
            offer_id: "off-1".into(),
            listing_id: listing_id.into(),
            buyer_handle: "buyer".into(),
            amount: 1000,
            terms: None,
        })
    }

    fn channel_message(channel_id: &str) -> WakeEvent {
        WakeEvent::ChannelMessage {
            kind: "channel.message",
            event_id: "evt-chan".into(),
            user_id: "u1".into(),
            payload: ChannelMessageEvent {
                event_id: "evt-chan".into(),
                channel_id: channel_id.into(),
                message_id: "m1".into(),
                sequence: 1,
                sender_user_id: "u2".into(),
                sender_handle: "alice".into(),
                content: "hi".into(),
                created_at: "2026-06-30T00:00:00Z".into(),
            },
        }
    }

    /// BR-1 — distinct entities resolve to distinct keys, and neither is a
    /// shared/fixed constant (the round-3 unbounded-session bug being fixed).
    #[test]
    fn distinct_listings_get_distinct_keys() {
        let k1 = derive_wake_session(&offer_on("e1", "L1"));
        let k2 = derive_wake_session(&offer_on("e2", "L2"));
        assert_ne!(k1, k2, "two different listings must not share a session key");
        // Guard against re-introducing a shared default (e.g. a fixed
        // `zeroclaw.session`): the key must embed the entity id.
        assert!(k1.ends_with("L1"), "expected key for L1, got {k1}");
        assert!(k2.ends_with("L2"), "expected key for L2, got {k2}");
    }

    /// BR-1 — repeat wakes for the SAME entity resolve to the SAME key
    /// (conversation continuity).
    #[test]
    fn same_listing_gets_same_key() {
        let k1 = derive_wake_session(&offer_on("e1", "L1"));
        let k2 = derive_wake_session(&offer_on("e2", "L1"));
        assert_eq!(k1, k2, "same listing must yield one continuous session key");
    }

    /// BR-2 — `offer.accepted` carries BOTH `listing_id` and `transaction_id`;
    /// keying MUST use the domain prefix (`offer` → listing), never first-id.
    #[test]
    fn offer_accepted_keys_off_listing_not_transaction() {
        let evt = notif(NotificationEvent::OfferAccepted {
            event_id: "evt-acc".into(),
            offer_id: "off-2".into(),
            listing_id: "L9".into(),
            seller_handle: "seller".into(),
            amount: Some(1000),
            transaction_id: Some("T1".into()),
        });
        let key = derive_wake_session(&evt);
        assert_eq!(
            key, "klodi:L9",
            "offer.accepted must scope to the LISTING (domain prefix), not the \
             transaction; got {key}",
        );
        assert!(!key.contains("T1"), "must not key off transaction_id: {key}");
    }

    /// `channel.*` → `channel_id`.
    #[test]
    fn channel_message_keys_off_channel_id() {
        assert_eq!(derive_wake_session(&channel_message("C1")), "klodi:C1");
    }

    /// `transaction.*` → `transaction_id` (NOT the co-carried `listing_id`).
    #[test]
    fn transaction_keys_off_transaction_id() {
        let evt = notif(NotificationEvent::TransactionCompleted {
            event_id: "evt-txn".into(),
            transaction_id: "T5".into(),
            listing_id: "L1".into(),
        });
        let key = derive_wake_session(&evt);
        assert_eq!(key, "klodi:T5", "transaction.* must key off transaction_id");
        assert!(!key.contains("L1"), "must not key off listing_id: {key}");
    }

    /// `search.match` → `search_slug`.
    #[test]
    fn search_match_keys_off_search_slug() {
        use klodi_nats_client::SearchMatchListingSummary;
        let evt = notif(NotificationEvent::SearchMatch {
            event_id: "evt-search".into(),
            search_slug: "vintage-camera".into(),
            listing_id: "L42".into(),
            listing_summary: SearchMatchListingSummary {
                title: "Pentax".into(),
                asking_price: 9500,
                currency: "USD".into(),
                fulfillment: vec![],
                seller_handle: "seller".into(),
                photos: vec![],
            },
        });
        assert_eq!(derive_wake_session(&evt), "klodi:vintage-camera");
    }

    /// `comment.created` scopes to the LISTING (domain map, not the comment id).
    #[test]
    fn comment_created_keys_off_listing_id() {
        let evt = notif(NotificationEvent::CommentCreated {
            event_id: "evt-cmt".into(),
            listing_id: "L7".into(),
            comment_id: "cmt-1".into(),
            handle: "commenter".into(),
            body: "nice".into(),
            mentions: vec![],
            created_at: "2026-06-30T00:00:00Z".into(),
        });
        assert_eq!(derive_wake_session(&evt), "klodi:L7");
    }

    /// BR-3 — a mapped key field that is EMPTY falls back to a bounded per-wake
    /// `wake-<event_id>` key; two such wakes with different event_ids resolve to
    /// DIFFERENT keys (never a shared constant — that would re-introduce the bug).
    #[test]
    fn empty_id_falls_back_to_distinct_ephemeral_keys() {
        let k1 = derive_wake_session(&offer_on("evt-a", ""));
        let k2 = derive_wake_session(&offer_on("evt-b", ""));
        assert_eq!(k1, "klodi:wake-evt-a", "empty id → bounded ephemeral key");
        assert_eq!(k2, "klodi:wake-evt-b");
        assert_ne!(k1, k2, "ephemeral fallback must NOT collapse to one shared key");
    }

    /// BR-3 — a wake with neither a usable key field NOR an event_id gets a
    /// unique `wake-<uuid4>` key, so the fallback can never itself become shared.
    #[test]
    fn empty_id_and_empty_event_id_falls_back_to_unique_uuid() {
        let k1 = derive_wake_session(&offer_on("", ""));
        let k2 = derive_wake_session(&offer_on("", ""));
        assert!(k1.starts_with("klodi:wake-"), "expected uuid fallback, got {k1}");
        assert!(k2.starts_with("klodi:wake-"), "expected uuid fallback, got {k2}");
        assert_ne!(
            k1, k2,
            "a keyless, event_id-less wake must get a UNIQUE session each time",
        );
    }

    /// BR-4 — a poisoned marketplace id (path separator / parent ref / leading
    /// dot) is REFUSED: the derived key never contains the traversal payload and
    /// the safe ephemeral fallback is produced instead. Mirrors hermes
    /// `_reject_traversal_entity_id` (THREAT_MODEL T5). The `-> String` signature
    /// expresses refusal as fallback-to-safe-key (it cannot raise), so a poisoned
    /// id can never become a `--session klodi:../…` arg or a derived filename.
    #[test]
    fn traversal_id_is_refused_via_safe_fallback() {
        for poisoned in ["../etc/passwd", "a/b", "..\\windows", ".hidden"] {
            let key = derive_wake_session(&offer_on("evt-trav", poisoned));
            assert_eq!(
                key, "klodi:wake-evt-trav",
                "poisoned id {poisoned:?} must be refused → safe ephemeral key",
            );
            assert!(!key.contains(".."), "no parent-ref in key: {key}");
            assert!(!key.contains('/'), "no path separator in key: {key}");
            assert!(!key.contains('\\'), "no path separator in key: {key}");
        }
    }

    /// BR-5 — every key carries the `klodi:` namespace so the operator-session
    /// resolver can exclude the wake-session family. The entity segment is never
    /// empty.
    #[test]
    fn every_key_is_klodi_namespaced_and_nonempty() {
        let keys = [
            derive_wake_session(&offer_on("e1", "L1")),
            derive_wake_session(&channel_message("C1")),
        ];
        for key in keys {
            assert!(
                key.starts_with(WAKE_SESSION_NAMESPACE),
                "every wake session key must start with the klodi: namespace: {key}",
            );
            assert!(
                key.len() > WAKE_SESSION_NAMESPACE.len(),
                "entity segment must be non-empty: {key}",
            );
        }
    }
}
