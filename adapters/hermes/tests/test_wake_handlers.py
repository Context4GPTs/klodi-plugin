"""Wake handler tests — async dispatch must not block the asyncio loop.

The bridge ctx's ``inject_message`` shells out to ``hermes chat
--continue`` and blocks for the agent turn's duration. Both consumer
pull-fetches and the nats-py WS heartbeat live on the same asyncio
thread (see ``client.py``), so a synchronous inject would freeze them
for ~20s and the WS connection would die mid-chat. The regression
test below proves the inject runs off-loop: a sibling task scheduled
on the same loop still progresses while a slow inject is in flight.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import pytest

from klodi_hermes import wake_handlers


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    """Wake handlers stash the bound ctx in a module-global. Restore
    the pre-test value so cases don't leak into each other."""
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


class _BlockingInjectCtx:
    """Stand-in for BridgeCtx with a synchronous, blocking inject.

    Records the thread it ran on so tests can assert the call left
    the asyncio loop's thread.
    """

    def __init__(self, *, sleep_s: float) -> None:
        self.sleep_s = sleep_s
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.threads: list[int] = []
        self._lock = threading.Lock()

    def inject_message(self, text: str, role: str = "system") -> None:
        # Match BridgeCtx's cross-call serialization: the production
        # ctx holds a threading.Lock around its subprocess.run call.
        with self._lock:
            self.threads.append(threading.get_ident())
            self.calls.append((text, {"role": role}))
            if self.sleep_s:
                time.sleep(self.sleep_s)


@pytest.mark.asyncio
async def test_handle_notification_does_not_block_loop_during_slow_inject() -> None:
    """Regression: a slow synchronous inject must NOT freeze the
    asyncio loop. A sibling task scheduled on the same loop must run
    to completion while the inject is in flight.

    Before the fix, ``_inject`` called ``ctx.inject_message`` directly
    from the async handler. The sleep below would have run on the loop
    thread and the heartbeat task would never tick — exactly the
    failure mode that killed the WebSocket consumer in production.
    """
    inject_sleep = 0.5
    ctx = _BlockingInjectCtx(sleep_s=inject_sleep)
    wake_handlers.bind_ctx(ctx)

    ticks = 0

    async def _heartbeat() -> None:
        nonlocal ticks
        # Simulate the nats-py WS heartbeat / second consumer's
        # pull-fetch loop: cooperatively yield every 50ms and count
        # how many times we got the loop while the inject is running.
        deadline = time.monotonic() + inject_sleep
        while time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            ticks += 1

    handler_task = asyncio.create_task(
        wake_handlers.handle_notification(
            {"event_id": "e1", "kind": "channel.opened",
             "buyer_handle": "alice", "listing_id": "L1"},
        ),
    )
    heartbeat_task = asyncio.create_task(_heartbeat())

    await asyncio.gather(handler_task, heartbeat_task)

    # If the loop were blocked, ticks would be 0 (or 1 if it managed
    # one yield before the sync call started). Off-loop dispatch lets
    # the heartbeat tick repeatedly during the 0.5s inject — expect
    # ~10 ticks at the 50ms cadence; require at least 5 to keep the
    # test stable on slow CI runners.
    assert ticks >= 5, (
        f"asyncio loop appears blocked during inject — only {ticks}"
        " heartbeat ticks observed during a 0.5s sync inject"
    )
    # And the inject itself ran on a worker thread, not the loop.
    loop_thread = threading.get_ident()
    assert ctx.threads, "inject was never invoked"
    assert all(t != loop_thread for t in ctx.threads), (
        "inject ran on the asyncio loop's thread — should have been"
        " dispatched to a worker thread via asyncio.to_thread"
    )
    assert len(ctx.calls) == 1
    text, kwargs = ctx.calls[0]
    assert "channel.opened" in text or "Channel opened" in text
    assert kwargs == {"role": "system"}


@pytest.mark.asyncio
async def test_handle_channel_message_dispatches_off_loop_too() -> None:
    """Same property for the channel-message consumer's handler."""
    ctx = _BlockingInjectCtx(sleep_s=0.1)
    wake_handlers.bind_ctx(ctx)

    await wake_handlers.handle_channel_message({
        "event_id": "e1",
        "channel_id": "C1",
        "sender_handle": "bob",
        "content": "hello",
    })

    loop_thread = threading.get_ident()
    assert ctx.threads and ctx.threads[0] != loop_thread


@pytest.mark.asyncio
async def test_inject_failure_is_caught_so_handler_returns_normally(
    caplog: Any,
) -> None:
    """A raise inside ``inject_message`` must be logged and swallowed
    so the consumer can ack and move on. Losing one wake is preferable
    to wedging the consumer or triggering JetStream redelivery on a
    deterministic failure."""

    class _RaisingCtx:
        def inject_message(self, _text: str, role: str = "system") -> None:
            raise RuntimeError("boom")

    wake_handlers.bind_ctx(_RaisingCtx())

    with caplog.at_level("WARNING", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "e1", "kind": "channel.opened"},
        )

    assert any("wake_inject_failed" in r.message for r in caplog.records)


@pytest.mark.asyncio
async def test_handler_with_no_bound_ctx_logs_and_returns() -> None:
    """No bound ctx (gateway-only invocation) must short-circuit
    cleanly without raising — and without spinning up a worker
    thread."""
    wake_handlers._CTX = None  # type: ignore[assignment]
    # Should not raise.
    await wake_handlers.handle_notification(
        {"event_id": "e1", "kind": "channel.opened"},
    )


@pytest.mark.asyncio
async def test_handler_with_ctx_lacking_inject_method_logs_and_returns() -> None:
    """Test harness ctxs may omit ``inject_message`` entirely."""

    class _NoInjectCtx:
        pass

    wake_handlers.bind_ctx(_NoInjectCtx())
    # Should not raise.
    await wake_handlers.handle_notification(
        {"event_id": "e1", "kind": "channel.opened"},
    )
