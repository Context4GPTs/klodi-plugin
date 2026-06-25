"""Wake event payloads — Python mirror of the TS canonical types.

Authoritative source is
``klodi-plugin/packages/tool-catalog/src/events.ts``. This module mirrors
those types as ``TypedDict`` shapes so adapter code stays strict-typed
end-to-end. A divergence here breaks the build via mypy/pyright; a
divergence on the wire is caught by the consumer parser raising
``KeyError`` against the discriminator.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

# UUID v4 — used by consumer-side dedup against ``max_deliver: 5``.
EventId = str


# ─── Channel stream events (delivered via subscribe_channels) ─────────


class _ChannelMessageBody(TypedDict):
    """Required fields present in the publisher's wire body."""

    kind: Literal["channel.message"]
    event_id: EventId
    channel_id: str
    message_id: str
    sender_user_id: str
    sender_handle: str
    content: str
    created_at: str


class ChannelMessageEvent(_ChannelMessageBody, total=False):
    """Delivered to ``subscribe_channels`` handlers.

    Published directly to ``p2p.v1.channels.<channel_id>.<sender>.msg``
    by the sender; the receiver's ``klodi-channels-<user_id>`` consumer
    delivers it as a wake.

    ``sequence`` is the one optional key: it is JetStream-injected
    post-parse from ``msg.info().stream_sequence`` and is absent from the
    publisher body, so the wire fixture omits it. Splitting it into a
    ``total=False`` subclass (rather than ``NotRequired``) keeps the key
    genuinely optional at runtime under ``from __future__ import
    annotations`` — a bare ``NotRequired`` is stringized by PEP 563 and
    silently lands in ``__required_keys__``. Mirrors Rust ``events.rs``
    ``#[serde(default)] sequence: u64``.
    """

    sequence: int


# ─── Notification stream events (delivered via subscribe_notifications) ─


class ListingStateEvent(TypedDict, total=False):
    """One of: created, relisted, withdrawn, sold, expired."""

    kind: Literal[
        "listing.created",
        "listing.relisted",
        "listing.withdrawn",
        "listing.sold",
        "listing.expired",
    ]
    event_id: EventId
    listing_id: str
    title: str  # only on created / relisted


class ListingStatusChangedEvent(TypedDict):
    kind: Literal["listing.status_changed"]
    event_id: EventId
    listing_id: str
    old_status: str
    new_status: str


class OfferProposedEvent(TypedDict):
    kind: Literal["offer.proposed"]
    event_id: EventId
    offer_id: str
    listing_id: str
    buyer_handle: str
    amount: int  # cents
    terms: dict[str, Any] | None


class OfferRespondedEvent(TypedDict, total=False):
    kind: Literal["offer.accepted", "offer.rejected"]
    event_id: EventId
    offer_id: str
    listing_id: str
    seller_handle: str
    amount: int  # only on accept
    transaction_id: str  # only on accept


class TransactionStateEvent(TypedDict, total=False):
    kind: Literal[
        "transaction.buyer_confirmed",
        "transaction.seller_confirmed",
        "transaction.completed",
        "transaction.cancelled",
    ]
    event_id: EventId
    transaction_id: str
    listing_id: str
    # Present on buyer_confirmed / seller_confirmed — handle of the
    # party that just confirmed. The recipient is the OTHER party.
    confirmed_by_handle: str
    cancelled_by_handle: str  # only on cancelled
    reason: str  # only on cancelled


class CommentPostedEvent(TypedDict):
    kind: Literal["comment.created"]
    event_id: EventId
    listing_id: str
    comment_id: str
    handle: str
    body: str
    mentions: list[str]
    created_at: str


# ─── Delivery offers (carried inside a search.match listing summary) ──
#
# Mirrors ``tool-catalog/src/delivery.ts:DeliveryOffer`` and Rust
# ``events.rs:DeliveryOffer`` field-for-field. ``method`` is the
# discriminator (``pickup`` / ``ship`` / ``digital``); the wire uses
# camelCase ``shipsTo``. Replaces the prior flat
# ``(delivery_method, location_area)`` pair — see ``delivery.ts`` header
# for the redesign rationale.


class PickupLocation(TypedDict):
    lat: float
    lng: float
    area: str


class PickupOffer(TypedDict):
    method: Literal["pickup"]
    location: PickupLocation


class ShipOrigin(TypedDict):
    country: str  # ISO 3166-1 alpha-2


# Functional TypedDict form: the wire key is ``from`` (a Python keyword),
# which the class-statement form cannot express. ``shipsTo`` keeps its
# camelCase wire spelling to mirror ``delivery.ts`` / Rust ``serde(rename)``.
ShipOffer = TypedDict(
    "ShipOffer",
    {
        "method": Literal["ship"],
        "from": ShipOrigin,
        "shipsTo": list[str],
    },
)


class DigitalOffer(TypedDict):
    method: Literal["digital"]


DeliveryOffer = Union[PickupOffer, ShipOffer, DigitalOffer]


class ListingSummary(TypedDict):
    title: str
    asking_price: int
    currency: str
    fulfillment: list[DeliveryOffer]
    seller_handle: str
    photos: list[str]


class SearchMatchEvent(TypedDict):
    kind: Literal["search.match"]
    event_id: EventId
    search_slug: str
    listing_id: str
    listing_summary: ListingSummary


class ChannelLifecycleEvent(TypedDict, total=False):
    kind: Literal["channel.opened", "channel.closed"]
    event_id: EventId
    channel_id: str
    listing_id: str
    buyer_handle: str  # only on opened
    closed_by: str  # only on closed


# Discriminated-union alias — every wake on the notifications consumer
# matches one of these shapes. ``total=False`` types accommodate
# kind-conditional optional fields without splitting each into its own
# class per kind.
NotificationEvent = Union[
    ListingStateEvent,
    ListingStatusChangedEvent,
    OfferProposedEvent,
    OfferRespondedEvent,
    TransactionStateEvent,
    CommentPostedEvent,
    SearchMatchEvent,
    ChannelLifecycleEvent,
]


__all__ = [
    "ChannelLifecycleEvent",
    "ChannelMessageEvent",
    "CommentPostedEvent",
    "DeliveryOffer",
    "DigitalOffer",
    "EventId",
    "ListingStateEvent",
    "ListingStatusChangedEvent",
    "ListingSummary",
    "NotificationEvent",
    "OfferProposedEvent",
    "OfferRespondedEvent",
    "PickupLocation",
    "PickupOffer",
    "SearchMatchEvent",
    "ShipOffer",
    "ShipOrigin",
    "TransactionStateEvent",
]
