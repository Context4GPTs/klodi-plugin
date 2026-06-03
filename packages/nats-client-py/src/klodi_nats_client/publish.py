"""Direct JetStream publish for channel messages.

0012 removes ``p2p.v1.channels.send`` as a request/reply tool. Instead,
each participant publishes a fully-formed ``ChannelMessageEvent``
directly to:

  ``p2p.v1.channels.<channel_id>.<sender_user_id>.msg``

The marketplace's side-consumer observes the publish for moderation
and history-index. The recipient's ``klodi-channels-<recipient_id>``
consumer delivers the message as a wake.

Both ``event_id`` and ``message_id`` are minted client-side here so
dedup works against the redelivery-on-reconnect path.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from nats.js import JetStreamContext

MAX_CONTENT_LENGTH = 2000

# UUID v4 regex (case-insensitive). Channel and sender IDs flow into a
# NATS subject — ``.``-separated tokens. An unvalidated id containing
# ``\r\n``, whitespace, or wildcards (``*``, ``>``) could foul up the
# marketplace's side-consumer subject parsing. Strict v4 matches the
# ``klodi_channel_create`` output shape and the catalog ``Uuid``
# descriptor — see P1-11.
_UUID_V4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _assert_uuid_v4(value: str, field: str) -> None:
    if not isinstance(value, str) or not _UUID_V4_RE.fullmatch(value):
        raise ValueError(
            f"publish_channel_message: {field} must be a UUID v4 (got {value!r})"
        )


@dataclass(frozen=True)
class PublishChannelResult:
    """Returned by :func:`publish_channel_message`."""

    sequence: int
    event_id: str
    message_id: str
    created_at: str


def _now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


async def publish_channel_message(
    *,
    js: JetStreamContext,
    channel_id: str,
    sender_user_id: str,
    sender_handle: str,
    content: str,
) -> PublishChannelResult:
    """Publish a channel message. Returns the JetStream sequence as
    proof of durability — the message is now in ``P2P_CHANNELS`` storage
    and will fan out to the recipient's consumer (or queue for
    redelivery).

    Mirrors the TS ``publishChannelMessage`` in
    ``packages/nats-client-ts/src/publish.ts`` byte-for-byte on the wire
    so the marketplace's side-consumer keys off the same shape.
    """
    _assert_uuid_v4(channel_id, "channel_id")
    _assert_uuid_v4(sender_user_id, "sender_user_id")
    if not content:
        raise ValueError("publish_channel_message: content must not be empty")
    if len(content) > MAX_CONTENT_LENGTH:
        raise ValueError(
            f"publish_channel_message: content exceeds"
            f" {MAX_CONTENT_LENGTH} chars"
        )

    event_id = str(uuid.uuid4())
    message_id = str(uuid.uuid4())
    created_at = _now_iso()
    subject = f"p2p.v1.channels.{channel_id}.{sender_user_id}.msg"

    body = {
        "kind": "channel.message",
        "event_id": event_id,
        "channel_id": channel_id,
        "message_id": message_id,
        "sender_user_id": sender_user_id,
        "sender_handle": sender_handle,
        "content": content,
        "created_at": created_at,
    }

    # Pass ``msg_id`` (Nats-Msg-Id header) for JetStream-side dedup
    # against rare double-publishes from the same client.
    ack = await js.publish(
        subject,
        json.dumps(body).encode("utf-8"),
        headers={"Nats-Msg-Id": event_id},
    )

    return PublishChannelResult(
        sequence=ack.seq,
        event_id=event_id,
        message_id=message_id,
        created_at=created_at,
    )


# ── Match-feedback publish (SC8 flywheel emit) ────────────────────────
#
# Reports an agent's pursue/dismiss verdict on a standing-search match to
# ``p2p.v1.searches.match_feedback``. Byte-for-byte wire parity with the TS
# ``publishMatchFeedback`` and the Rust ``MatchFeedbackPayload``: same field
# order, ``Nats-Msg-Id`` dedup header = the minted ``event_id``,
# ``action_on_match`` omitted (not null) when absent. The body carries the
# ACTION (``outcome``), never a ± label — that is server-derived. Validation
# diverges deliberately from ``publish_channel_message``: ``search_slug`` /
# ``listing_id`` ride in the body, not a subject path, so the strict UUID-v4
# guard is NOT reused — a non-UUID listing id must be accepted. See ADR-0013.

#: The closed outcome set — matches the marketplace's ``labelForOutcome``.
_MATCH_FEEDBACK_OUTCOMES: frozenset[str] = frozenset({"pursued", "dismissed"})

#: Subject the marketplace's SC8a capture-consumer drains.
_MATCH_FEEDBACK_SUBJECT = "p2p.v1.searches.match_feedback"

#: Marketplace slug pattern (``^[a-z0-9][a-z0-9._-]{0,119}$``).
_MATCH_FEEDBACK_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,119}$")

_MAX_LISTING_ID_LENGTH = 64


@dataclass(frozen=True)
class PublishMatchFeedbackResult:
    """Returned by :func:`publish_match_feedback`."""

    sequence: int
    event_id: str


async def publish_match_feedback(
    *,
    js: JetStreamContext,
    search_slug: str,
    listing_id: str,
    outcome: str,
    action_on_match: str | None = None,
) -> PublishMatchFeedbackResult:
    """Publish a match-feedback verdict to the searches domain.

    Stateless: each call mints a fresh ``event_id`` (the ``Nats-Msg-Id``
    dedup header), so a redelivered wake or a flipped verdict re-emits
    safely — the marketplace upsert is idempotent per (user, search,
    listing). The body is EXACTLY ``{search_slug, listing_id, outcome,
    action_on_match?}`` — no ± label, no ``listing_summary``.

    Raises ``ValueError`` (before any wire write) on a bad slug, an
    empty/over-long ``listing_id``, or an out-of-set ``outcome``.
    """
    if not isinstance(search_slug, str) or not _MATCH_FEEDBACK_SLUG_RE.fullmatch(
        search_slug
    ):
        raise ValueError(
            f"publish_match_feedback: search_slug must match"
            f" {_MATCH_FEEDBACK_SLUG_RE.pattern} (got {search_slug!r})"
        )
    if (
        not isinstance(listing_id, str)
        or not listing_id
        or len(listing_id) > _MAX_LISTING_ID_LENGTH
    ):
        raise ValueError(
            f"publish_match_feedback: listing_id must be 1..{_MAX_LISTING_ID_LENGTH}"
            f" chars (got {listing_id!r})"
        )
    if outcome not in _MATCH_FEEDBACK_OUTCOMES:
        raise ValueError(
            f"publish_match_feedback: outcome must be one of"
            f" {sorted(_MATCH_FEEDBACK_OUTCOMES)} (got {outcome!r})"
        )

    event_id = str(uuid.uuid4())

    # Field order matches the TS/Rust halves. Optional provenance is OMITTED
    # entirely when absent — never serialized as null.
    body: dict[str, str] = {
        "search_slug": search_slug,
        "listing_id": listing_id,
        "outcome": outcome,
    }
    if action_on_match is not None:
        body["action_on_match"] = action_on_match

    ack = await js.publish(
        _MATCH_FEEDBACK_SUBJECT,
        json.dumps(body).encode("utf-8"),
        headers={"Nats-Msg-Id": event_id},
    )

    return PublishMatchFeedbackResult(sequence=ack.seq, event_id=event_id)


__all__ = [
    "MAX_CONTENT_LENGTH",
    "PublishChannelResult",
    "PublishMatchFeedbackResult",
    "publish_channel_message",
    "publish_match_feedback",
]
