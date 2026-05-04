"""Daemon wake-callback tests — publish must not block the asyncio loop.

``_publish_to_event_bus`` shells out to ``nanobot events publish`` via
``subprocess.run`` (10s timeout). Both consumer pull-fetches and the
nats-py WS heartbeat share the daemon's asyncio loop, so a synchronous
publish call inside the wake callback would freeze them and the WS
would die past its heartbeat budget. The regression below proves the
publish runs off-loop: a sibling task scheduled on the same loop
still progresses while a slow publish is in flight.
"""

from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

import nanobot_daemon  # noqa: E402  (sys.path tweak above)


@pytest.fixture
def slow_publish(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Stub ``_publish_to_event_bus`` with a synchronous slow call.

    Records the thread it ran on so tests can assert the call left
    the asyncio loop's thread.
    """
    state: dict[str, Any] = {"calls": [], "threads": []}

    def _stub(channel: str, body: dict) -> bool:
        state["threads"].append(threading.get_ident())
        state["calls"].append((channel, body))
        time.sleep(0.5)
        return True

    monkeypatch.setattr(nanobot_daemon, "_publish_to_event_bus", _stub)
    return state


@pytest.mark.asyncio
async def test_on_notification_does_not_block_loop_during_slow_publish(
    slow_publish: dict[str, Any],
) -> None:
    """Regression: a slow synchronous publish must NOT freeze the
    asyncio loop. A sibling task scheduled on the same loop must run
    to completion while the publish is in flight.

    Before the fix, ``_on_notification`` called ``_publish_to_event_bus``
    directly. The 0.5s sleep below would have run on the loop thread
    and the heartbeat task would never tick — exactly the failure mode
    that kills the WebSocket consumer in production.
    """
    on_notification, _ = nanobot_daemon._make_wake_callbacks("klodi")

    ticks = 0

    async def _heartbeat() -> None:
        nonlocal ticks
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            ticks += 1

    handler_task = asyncio.create_task(
        on_notification({"event_id": "e1", "kind": "channel.opened"}),
    )
    heartbeat_task = asyncio.create_task(_heartbeat())

    await asyncio.gather(handler_task, heartbeat_task)

    assert ticks >= 5, (
        f"asyncio loop appears blocked during publish — only {ticks}"
        " heartbeat ticks observed during a 0.5s sync publish"
    )
    loop_thread = threading.get_ident()
    assert slow_publish["threads"], "publish was never invoked"
    assert all(t != loop_thread for t in slow_publish["threads"]), (
        "publish ran on the asyncio loop's thread — should have been"
        " dispatched to a worker thread via asyncio.to_thread"
    )
    assert len(slow_publish["calls"]) == 1
    channel, body = slow_publish["calls"][0]
    assert channel == "klodi"
    assert body["kind"] == "klodi.notification"


@pytest.mark.asyncio
async def test_on_channel_dispatches_off_loop_too(
    slow_publish: dict[str, Any],
) -> None:
    """Same property for the channel-message wake callback."""
    _, on_channel = nanobot_daemon._make_wake_callbacks("klodi")

    await on_channel({
        "event_id": "e1",
        "channel_id": "C1",
        "sender_handle": "bob",
        "content": "hello",
    })

    loop_thread = threading.get_ident()
    assert slow_publish["threads"]
    assert slow_publish["threads"][0] != loop_thread
    channel, body = slow_publish["calls"][0]
    assert body["kind"] == "klodi.channel_message"


@pytest.mark.asyncio
async def test_on_notification_raises_to_trigger_nak_when_publish_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Publish failure must surface as a raise so the consume loop
    naks the message and JetStream redelivers per ``max_deliver``."""
    monkeypatch.setattr(
        nanobot_daemon, "_publish_to_event_bus",
        lambda _channel, _body: False,
    )
    on_notification, _ = nanobot_daemon._make_wake_callbacks("klodi")

    with pytest.raises(RuntimeError, match="nanobot publish failed"):
        await on_notification({"event_id": "e1", "kind": "channel.opened"})
