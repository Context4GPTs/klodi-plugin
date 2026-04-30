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


class ChannelMessageEvent(TypedDict):
    """Delivered to ``subscribe_channels`` handlers.

    Published directly to ``p2p.v1.channels.<channel_id>.<sender>.msg``
    by the sender; the receiver's ``klodi-channels-<user_id>`` consumer
    delivers it as a wake. The ``sequence`` field is filled in by
    JetStream-side metadata, not the publisher's body.
    """

    kind: Literal["channel.message"]
    event_id: EventId
    channel_id: str
    message_id: str
    sequence: int
    sender_user_id: str
    sender_handle: str
    content: str
    created_at: str


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


class ListingSummary(TypedDict):
    title: str
    asking_price: int
    currency: str
    delivery_method: str
    location_area: str | None
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
    "EventId",
    "ListingStateEvent",
    "ListingStatusChangedEvent",
    "ListingSummary",
    "NotificationEvent",
    "OfferProposedEvent",
    "OfferRespondedEvent",
    "SearchMatchEvent",
    "TransactionStateEvent",
]
