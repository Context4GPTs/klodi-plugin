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


__all__ = [
    "MAX_CONTENT_LENGTH",
    "PublishChannelResult",
    "publish_channel_message",
]
