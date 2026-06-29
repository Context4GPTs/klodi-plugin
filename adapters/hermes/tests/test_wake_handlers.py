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
import json
import threading
import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from klodi_hermes import wake_handlers
from klodi_hermes.bridge import BridgeCtx, WakeInjectFailed


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

    def inject_message(
        self, text: str, role: str = "system", *, session: str = ""
    ) -> None:
        # Match BridgeCtx's cross-call serialization: the production
        # ctx holds a threading.Lock around its subprocess.run call.
        # ``session`` is the per-wake key threaded down from ``_inject``;
        # this stub records only the role (the session is asserted via
        # argv in test_wake_session_keying.py).
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
        def inject_message(
            self, _text: str, role: str = "system", *, session: str = ""
        ) -> None:
            raise RuntimeError("boom")

    wake_handlers.bind_ctx(_RaisingCtx())

    with caplog.at_level("WARNING", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "e1", "kind": "channel.opened"},
        )

    assert any("wake_inject_failed" in r.message for r in caplog.records)


# ── Deterministic-failure alarm (Piece 1b / Piece 2) ──────────────────


@pytest.mark.asyncio
async def test_deterministic_failure_emits_correlated_error_alarm(
    caplog: Any,
) -> None:
    """AC-1 + AC-2: when inject raises ``WakeInjectFailed`` (a fast
    deterministic nonzero exit), the handler emits exactly ONE
    operator-visible ERROR alarm — event ``wake_inject_deterministic_failure``
    carrying the stdout diagnostic plus the wake's ``kind`` and
    ``event_id`` — and returns normally (no exception propagates, so the
    consumer still acks)."""

    class _FailingCtx:
        def inject_message(
            self, _text: str, role: str = "system", *, session: str = ""
        ) -> None:
            raise WakeInjectFailed(
                returncode=1,
                stdout="hermes: unknown session 'klodi-wake'",
                stderr="",
            )

    wake_handlers.bind_ctx(_FailingCtx())

    with caplog.at_level("ERROR", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "evt-42", "kind": "offer.proposed",
             "buyer_handle": "alice", "listing_id": "L1", "amount": 100},
        )

    alarms = [
        r for r in caplog.records
        if r.levelname == "ERROR"
        and "wake_inject_deterministic_failure" in r.message
    ]
    assert len(alarms) == 1
    msg = alarms[0].message
    assert "unknown session 'klodi-wake'" in msg  # stdout reaches the alarm
    assert "offer.proposed" in msg                # kind correlation
    assert "evt-42" in msg                        # event_id correlation


@pytest.mark.asyncio
async def test_deterministic_failure_distinct_from_timeout_swallow(
    caplog: Any,
) -> None:
    """AC-3: a timeout is swallowed in the bridge (inject_message returns
    None after its own WARNING). The handler must NOT escalate that to the
    deterministic-failure ERROR alarm — the two failure classes stay
    distinct, which is the whole point of the timeout/deterministic
    split."""

    class _TimeoutSwallowCtx:
        # Mirrors BridgeCtx on TimeoutExpired: it logs + returns None,
        # so from the handler's view inject simply completed.
        def inject_message(
            self, _text: str, role: str = "system", *, session: str = ""
        ) -> None:
            return None

    wake_handlers.bind_ctx(_TimeoutSwallowCtx())

    with caplog.at_level("WARNING", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "e1", "kind": "channel.opened"},
        )

    assert not any(
        "wake_inject_deterministic_failure" in r.message
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_dispatch_acks_deterministic_failure_and_never_naks(
    caplog: Any,
) -> None:
    """AC-2 (integration): wiring the handler into the consumer's
    ``_dispatch_message``, a deterministic inject failure must ACK
    (surfaced-but-not-redelivered) and NEVER NAK. Re-delivering a
    deterministic failure would just burn ``max_deliver`` and drop anyway
    — the ERROR alarm is the operator surface, not redelivery.

    Load-bearing guard: a future change re-raising into the NAK path the
    product-owner explicitly rejected must fail here."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    class _FailingCtx:
        def inject_message(
            self, _text: str, role: str = "system", *, session: str = ""
        ) -> None:
            raise WakeInjectFailed(returncode=1, stdout="boom-diag", stderr="")

    wake_handlers.bind_ctx(_FailingCtx())

    payload = {"event_id": "e1", "kind": "offer.proposed"}
    msg = MagicMock()
    msg.data = json.dumps(payload).encode("utf-8")
    msg.subject = "p2p.v1.notifications.u"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()

    lru = _EventIdLru()
    errors: list[BaseException] = []
    with caplog.at_level("ERROR", logger="klodi_hermes.wake"):
        await _dispatch_message(
            msg, lru, wake_handlers.handle_notification, errors.append,
        )

    assert msg.ack.await_count == 1
    assert msg.nak.await_count == 0
    assert any(
        "wake_inject_deterministic_failure" in r.message
        for r in caplog.records
    )


@pytest.mark.asyncio
async def test_wake_session_unhealthy_surfaces_via_real_bridge_ctx(
    caplog: Any,
) -> None:
    """AC-5: when the dedicated ``klodi-wake`` session can't be opened
    (``hermes chat --session`` exits nonzero with the session named on
    stdout), ``handle_notification`` surfaces the AC-2 ERROR alarm
    carrying that stdout + the event_id — driven through a REAL
    ``BridgeCtx`` so the bridge→handler stdout→alarm plumbing is
    exercised end to end (not a hand-rolled raising stub)."""

    class _Runner:
        def __call__(self, _cmd: list[str], **_kwargs: Any) -> Any:
            return SimpleNamespace(
                returncode=1,
                stdout="hermes: unknown session 'klodi-wake'",
                stderr="",
            )

    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=_Runner())
    wake_handlers.bind_ctx(ctx)

    with caplog.at_level("ERROR", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "evt-77", "kind": "offer.accepted",
             "seller_handle": "bob", "listing_id": "L9"},
        )

    alarms = [
        r for r in caplog.records
        if "wake_inject_deterministic_failure" in r.message
    ]
    assert len(alarms) == 1
    assert "unknown session 'klodi-wake'" in alarms[0].message
    assert "evt-77" in alarms[0].message


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


@pytest.mark.asyncio
async def test_inject_calls_session_less_ctx_without_session_kwarg(
    caplog: Any,
) -> None:
    """P3 (review round 3) — duck-typed boundary: ``inject_message`` is a
    SHARED contract reached via ``getattr`` and also implemented by the
    in-process per-chat ctx, whose signature is ``inject_message(text,
    role)`` — NO ``session`` kwarg. ``_inject`` must introspect and OMIT
    ``session`` for such a ctx rather than passing it blindly and
    TypeError-ing into the swallow path. The session-less ctx must still be
    invoked, the wake must not be logged as a failure.

    A naive impl that always passes ``session=`` fails here (the call
    TypeErrors, gets swallowed to ``wake_inject_failed``, and the recorded
    call list stays empty)."""

    class _SessionLessCtx:
        def __init__(self) -> None:
            self.calls: list[tuple[str, str]] = []

        def inject_message(self, text: str, role: str = "system") -> None:
            self.calls.append((text, role))

    ctx = _SessionLessCtx()
    wake_handlers.bind_ctx(ctx)

    with caplog.at_level("WARNING", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(
            {"event_id": "e1", "kind": "channel.opened", "channel_id": "C1"},
        )

    assert len(ctx.calls) == 1, "session-less ctx must still be invoked"
    assert ctx.calls[0][1] == "system"
    assert not any("wake_inject_failed" in r.message for r in caplog.records), (
        "passing session= to a session-less ctx must NOT crash into the"
        " swallow path"
    )
