"""Unit tests for the KlodiClient metrics surface (P2-27).

Walks through the consumer dispatch path with mocked JetStream messages
to assert each counter ticks where it should — consume, ack, nak,
dedup_hit, redelivery accumulator, and the pending gauge.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from klodi_nats_client.consumers import _EventIdLru, _dispatch_message
from klodi_nats_client.metrics import ClientMetrics, MutableMetrics


def _msg(payload: dict[str, Any], *, num_delivered: int = 1, num_pending: int = 0) -> Any:
    """Build a mocked nats-py JetStream message."""
    msg = MagicMock()
    msg.data = json.dumps(payload).encode("utf-8")
    msg.subject = "x"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()
    metadata = MagicMock()
    metadata.num_delivered = num_delivered
    metadata.num_pending = num_pending
    type(msg).metadata = metadata
    return msg


def test_initial_snapshot_is_all_zeros() -> None:
    m = MutableMetrics()
    snap = m.snapshot()
    assert snap == ClientMetrics(
        consumed=0, acked=0, naked=0,
        dedup_hit=0, redelivery_count=0, pending_count=0,
        resubscribe=0,
    )


def test_increments_isolated() -> None:
    m = MutableMetrics()
    m.inc_consumed()
    m.inc_consumed()
    m.inc_acked()
    m.inc_naked()
    m.inc_dedup_hit()
    m.inc_resubscribe()
    snap = m.snapshot()
    assert snap.consumed == 2
    assert snap.acked == 1
    assert snap.naked == 1
    assert snap.dedup_hit == 1
    assert snap.resubscribe == 1


def test_redelivery_accumulator_ignores_zero_and_negative() -> None:
    m = MutableMetrics()
    m.add_redelivery(0)
    m.add_redelivery(2)
    m.add_redelivery(-3)
    m.add_redelivery(5)
    assert m.snapshot().redelivery_count == 7


def test_set_pending_replaces_value() -> None:
    m = MutableMetrics()
    m.set_pending(10)
    m.set_pending(2)
    m.set_pending(7)
    assert m.snapshot().pending_count == 7


def test_set_pending_refuses_negative() -> None:
    m = MutableMetrics()
    m.set_pending(5)
    m.set_pending(-3)
    assert m.snapshot().pending_count == 5


@pytest.mark.asyncio
async def test_dispatch_success_increments_consumed_and_acked() -> None:
    m = MutableMetrics()
    lru = _EventIdLru()
    handler_calls: list[Any] = []

    async def handler(payload: Any) -> None:
        handler_calls.append(payload)

    msg = _msg({"event_id": "e1", "kind": "channel.message"}, num_pending=42)
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append, m)

    snap = m.snapshot()
    assert snap.consumed == 1
    assert snap.acked == 1
    assert snap.naked == 0
    assert snap.dedup_hit == 0
    # First delivery — redelivery_count stays 0.
    assert snap.redelivery_count == 0
    # Per-message pending refresh happens on every dispatch.
    assert snap.pending_count == 42


@pytest.mark.asyncio
async def test_dispatch_handler_raises_increments_naked() -> None:
    m = MutableMetrics()
    lru = _EventIdLru()

    async def boom(_payload: Any) -> None:
        raise RuntimeError("boom")

    msg = _msg({"event_id": "e2"})
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, boom, errors.append, m)

    snap = m.snapshot()
    assert snap.consumed == 1
    assert snap.acked == 0
    assert snap.naked == 1


@pytest.mark.asyncio
async def test_dispatch_dedup_hit_increments_counter_and_acks() -> None:
    m = MutableMetrics()
    lru = _EventIdLru()
    lru.remember("dup")
    handler_calls: list[Any] = []

    async def handler(payload: Any) -> None:
        handler_calls.append(payload)

    msg = _msg({"event_id": "dup"})
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append, m)

    assert handler_calls == []
    snap = m.snapshot()
    assert snap.consumed == 1
    assert snap.acked == 1
    assert snap.dedup_hit == 1


@pytest.mark.asyncio
async def test_dispatch_redelivered_message_accumulates_counter() -> None:
    m = MutableMetrics()
    lru = _EventIdLru()

    async def handler(_payload: Any) -> None:
        return

    # num_delivered=3 → this is the second redelivery (counter += 2).
    msg = _msg({"event_id": "r1"}, num_delivered=3)
    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, handler, errors.append, m)

    assert m.snapshot().redelivery_count == 2


@pytest.mark.asyncio
async def test_dispatch_malformed_payload_acks_and_counts() -> None:
    m = MutableMetrics()
    lru = _EventIdLru()

    async def boom(_payload: Any) -> None:
        raise AssertionError("must not run on malformed payload")

    msg = MagicMock()
    msg.data = b"not json{{{"
    msg.subject = "x"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()
    metadata = MagicMock()
    metadata.num_delivered = 1
    metadata.num_pending = 0
    type(msg).metadata = metadata

    errors: list[BaseException] = []
    await _dispatch_message(msg, lru, boom, errors.append, m)

    snap = m.snapshot()
    assert snap.consumed == 1
    assert snap.acked == 1
    assert snap.naked == 0
