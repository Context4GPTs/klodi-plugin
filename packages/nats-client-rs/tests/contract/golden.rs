//! Cross-language contract test (Rust half) — Decision 7.
//!
//! Reads every fixture from the golden corpus at
//! `klodi-plugin/packages/tool-catalog/tests/golden/` and parses each
//! through `serde_json::from_str` against the canonical event types in
//! `klodi_nats_client::events`. Asserts every required field via
//! pattern-matching on the discriminator.
//!
//! Gated by the `golden` feature so plain `cargo test` doesn't load
//! the corpus from a different package directory by accident — CI
//! enables it explicitly via `cargo test --features golden`.
//!
//! If the TS shape drifts and a fixture is not updated, parsing fails
//! here in lockstep with the TS + Python halves of this contract.

#![cfg(feature = "golden")]

use std::fs;
use std::path::PathBuf;

use klodi_nats_client::events::{ChannelMessageEvent, DeliveryOffer, NotificationEvent};

fn golden_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is the package root (nats-client-rs).
    // Walk up to packages/, then into tool-catalog/tests/golden.
    let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    here.parent()
        .expect("nats-client-rs has a parent (packages/)")
        .join("tool-catalog")
        .join("tests")
        .join("golden")
}

fn load(name: &str) -> String {
    let path = golden_dir().join(name);
    fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn parse_notification(name: &str) -> NotificationEvent {
    let body = load(name);
    serde_json::from_str(&body)
        .unwrap_or_else(|e| panic!("parse {} as NotificationEvent: {}", name, e))
}

fn assert_event_id_nonempty(id: &str) {
    assert!(!id.is_empty(), "event_id must be non-empty");
}

#[test]
fn corpus_directory_resolves() {
    let dir = golden_dir();
    assert!(dir.is_dir(), "golden corpus missing at {}", dir.display());
    let count = fs::read_dir(&dir)
        .expect("read_dir")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| s == "json")
                .unwrap_or(false)
        })
        .count();
    assert!(count > 0, "no fixtures found");
}

// ─── ListingState* variants ────────────────────────────────────────────

#[test]
fn listing_created() {
    let evt = parse_notification("listing.created.json");
    match evt {
        NotificationEvent::ListingCreated {
            event_id,
            listing_id,
            title,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
            assert!(title.is_some());
            assert!(!title.unwrap().is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn listing_relisted() {
    let evt = parse_notification("listing.relisted.json");
    match evt {
        NotificationEvent::ListingRelisted {
            event_id,
            listing_id,
            title,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
            assert!(title.is_some());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn listing_withdrawn() {
    let evt = parse_notification("listing.withdrawn.json");
    match evt {
        NotificationEvent::ListingWithdrawn {
            event_id,
            listing_id,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn listing_sold() {
    let evt = parse_notification("listing.sold.json");
    match evt {
        NotificationEvent::ListingSold {
            event_id,
            listing_id,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn listing_expired() {
    let evt = parse_notification("listing.expired.json");
    match evt {
        NotificationEvent::ListingExpired {
            event_id,
            listing_id,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── ListingStatusChanged ──────────────────────────────────────────────

#[test]
fn listing_status_changed() {
    let evt = parse_notification("listing.status_changed.json");
    match evt {
        NotificationEvent::ListingStatusChanged {
            event_id,
            listing_id,
            old_status,
            new_status,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
            assert!(!old_status.is_empty());
            assert!(!new_status.is_empty());
            assert_ne!(old_status, new_status);
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── OfferProposed ─────────────────────────────────────────────────────

#[test]
fn offer_proposed() {
    let evt = parse_notification("offer.proposed.json");
    match evt {
        NotificationEvent::OfferProposed {
            event_id,
            offer_id,
            listing_id,
            buyer_handle,
            amount,
            terms,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!offer_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(!buyer_handle.is_empty());
            assert!(amount > 0, "amount must be positive cents");
            // terms is `Option<serde_json::Value>` — present here.
            let terms = terms.expect("terms present in this fixture");
            assert!(terms.is_object(), "terms must be JSON object when present");
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── OfferResponded variants ───────────────────────────────────────────

#[test]
fn offer_accepted() {
    let evt = parse_notification("offer.accepted.json");
    match evt {
        NotificationEvent::OfferAccepted {
            event_id,
            offer_id,
            listing_id,
            seller_handle,
            amount,
            transaction_id,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!offer_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(!seller_handle.is_empty());
            assert!(amount.is_some());
            assert!(transaction_id.is_some());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn offer_rejected() {
    // OfferRejected variant in the Rust enum has no amount/transaction_id
    // fields (rename = "offer.rejected" maps to a struct without them);
    // the fixture must NOT carry those keys.
    let evt = parse_notification("offer.rejected.json");
    match evt {
        NotificationEvent::OfferRejected {
            event_id,
            offer_id,
            listing_id,
            seller_handle,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!offer_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(!seller_handle.is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── TransactionState variants ─────────────────────────────────────────

#[test]
fn transaction_completed() {
    let evt = parse_notification("transaction.completed.json");
    match evt {
        NotificationEvent::TransactionCompleted {
            event_id,
            transaction_id,
            listing_id,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!transaction_id.is_empty());
            assert!(!listing_id.is_empty());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn transaction_cancelled() {
    let evt = parse_notification("transaction.cancelled.json");
    match evt {
        NotificationEvent::TransactionCancelled {
            event_id,
            transaction_id,
            listing_id,
            cancelled_by_handle,
            reason,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!transaction_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(cancelled_by_handle.is_some());
            assert!(reason.is_some());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── CommentPosted ─────────────────────────────────────────────────────

#[test]
fn comment_created() {
    let evt = parse_notification("comment.created.json");
    match evt {
        NotificationEvent::CommentCreated {
            event_id,
            listing_id,
            comment_id,
            handle,
            body,
            mentions,
            created_at,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!listing_id.is_empty());
            assert!(!comment_id.is_empty());
            assert!(!handle.is_empty());
            assert!(!body.is_empty());
            for m in &mentions {
                assert!(!m.is_empty());
            }
            assert!(created_at.ends_with('Z'));
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── SearchMatch ───────────────────────────────────────────────────────

#[test]
fn search_match() {
    let evt = parse_notification("search.match.json");
    match evt {
        NotificationEvent::SearchMatch {
            event_id,
            search_slug,
            listing_id,
            listing_summary,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!search_slug.is_empty());
            assert!(!listing_id.is_empty());
            assert!(!listing_summary.title.is_empty());
            assert!(listing_summary.asking_price >= 0);
            assert!(!listing_summary.currency.is_empty());
            // Post-redesign: fulfillment is a DeliveryOffer[] with at
            // least one entry. The legacy flat (delivery_method,
            // location_area) pair was removed in lockstep with the TS
            // schema redesign in tool-catalog/src/delivery.ts.
            assert!(
                !listing_summary.fulfillment.is_empty(),
                "fulfillment must carry at least one DeliveryOffer",
            );
            for offer in &listing_summary.fulfillment {
                match offer {
                    DeliveryOffer::Pickup { location } => {
                        assert!(!location.area.is_empty());
                    }
                    DeliveryOffer::Ship { from, ships_to } => {
                        assert!(!from.country.is_empty());
                        assert!(!ships_to.is_empty());
                    }
                    DeliveryOffer::Digital => {}
                }
            }
            assert!(!listing_summary.seller_handle.is_empty());
            for p in &listing_summary.photos {
                assert!(!p.is_empty());
            }
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── ChannelLifecycle variants ─────────────────────────────────────────

#[test]
fn channel_opened() {
    let evt = parse_notification("channel.opened.json");
    match evt {
        NotificationEvent::ChannelOpened {
            event_id,
            channel_id,
            listing_id,
            buyer_handle,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!channel_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(buyer_handle.is_some());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

#[test]
fn channel_closed() {
    let evt = parse_notification("channel.closed.json");
    match evt {
        NotificationEvent::ChannelClosed {
            event_id,
            channel_id,
            listing_id,
            closed_by,
        } => {
            assert_event_id_nonempty(&event_id);
            assert!(!channel_id.is_empty());
            assert!(!listing_id.is_empty());
            assert!(closed_by.is_some());
        }
        other => panic!("wrong variant: {:?}", other),
    }
}

// ─── ChannelMessage (channel-stream) ──────────────────────────────────

#[test]
fn channel_message() {
    let body = load("channel.message.json");
    let evt: ChannelMessageEvent = serde_json::from_str(&body)
        .expect("parse channel.message.json as ChannelMessageEvent");
    assert_event_id_nonempty(&evt.event_id);
    assert!(!evt.channel_id.is_empty());
    assert!(!evt.message_id.is_empty());
    // The publisher does NOT embed sequence in the body — JetStream
    // assigns it server-side and the consumer populates the field from
    // msg.info().stream_sequence post-parse. The fixture mirrors the
    // publisher's body, so sequence parses to its serde default (0).
    // The assertion lives in the consumer integration tests, where a
    // real JetStream message is available.
    assert_eq!(evt.sequence, 0);
    assert!(!evt.sender_user_id.is_empty());
    assert!(!evt.sender_handle.is_empty());
    assert!(!evt.content.is_empty());
    assert!(evt.content.len() <= 2000);
    assert!(evt.created_at.ends_with('Z'));
}
// qa-developer: golden-corpus-decision-7
