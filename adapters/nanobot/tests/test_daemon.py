"""Daemon wake-callback tests.

Two contracts live here:

1. **Off-loop dispatch.** ``_publish_to_event_bus`` shells out to
   ``nanobot events publish`` via ``subprocess.run`` (10s timeout). Both
   consumer pull-fetches and the nats-py WS heartbeat share the daemon's
   asyncio loop, so a synchronous publish inside the wake callback would
   freeze them and the WS would die past its heartbeat budget. The publish
   MUST run off-loop (``asyncio.to_thread``).

2. **Failure disposition by class** (card
   ``audit-all-adapters-for-silent-wake-inject-failure``, ACs 1/2/3 —
   mirrors hermes ADR-0019). Today the daemon NAKs on EVERY publish failure
   with no timeout-vs-deterministic distinction (the bug): a deterministic
   misconfig burns ``max_deliver`` then drops silently, and the failure log
   drops ``proc.stdout`` (logs ``stderr`` only). The fix splits the classes:
     - deterministic (nonzero exit / missing CLI) → a DISTINCT ERROR alarm
       carrying the FULL diagnostic (incl. stdout) + ``kind`` + ``event_id``,
       then ACK (no raise) — redelivering a deterministic failure is futile;
     - transient (timeout) → raise (NAK) so JetStream redelivers.

These tests mock the SUBPROCESS BOUNDARY (``subprocess.run``), never the
``_publish_to_event_bus`` logic, and assert observable BEHAVIOR (log content
+ ACK/raise disposition) — not the private outcome type the fix introduces.
"""

from __future__ import annotations

import asyncio
import json
import logging
import subprocess
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

# Distinct, alertable ERROR event the deterministic class must emit — the
# nanobot analogue of hermes's ``wake_inject_deterministic_failure`` (the
# epic's reconciled alarm shape). Operators alert on this; it must be
# separable from the routine transient path. See the GREEN handoff.
_DETERMINISTIC_ALARM = "nanobot_publish_deterministic_failure"


def _completed(returncode: int, stdout: str = "", stderr: str = "") -> Any:
    """A ``subprocess.run`` result with the given streams."""
    return subprocess.CompletedProcess(
        args=["nanobot", "events", "publish"],
        returncode=returncode,
        stdout=stdout,
        stderr=stderr,
    )


# ──────────────────────────────────────────────────────────────────────────
# Contract 1 — off-loop dispatch (regression guard, stubs the boundary).
# ──────────────────────────────────────────────────────────────────────────
@pytest.fixture
def slow_publish(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Stub ``subprocess.run`` (the boundary) with a slow SUCCESS.

    Records the thread it ran on so tests can assert the call left the
    asyncio loop's thread. Returns a clean exit so the callback ACKs.
    """
    state: dict[str, Any] = {"calls": [], "threads": []}

    def _fake_run(cmd: list[str], *_args: Any, **_kwargs: Any) -> Any:
        state["threads"].append(threading.get_ident())
        # cmd = ["nanobot", "events", "publish", <channel>, <serialized-body>]
        state["calls"].append((cmd[3], json.loads(cmd[4])))
        time.sleep(0.5)
        return _completed(0)

    monkeypatch.setattr(nanobot_daemon.subprocess, "run", _fake_run)
    return state


@pytest.mark.asyncio
async def test_on_notification_does_not_block_loop_during_slow_publish(
    slow_publish: dict[str, Any],
) -> None:
    """Regression: a slow synchronous publish must NOT freeze the asyncio
    loop. A sibling task on the same loop must run to completion while the
    publish is in flight, and the publish must run off the loop thread."""
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
    """Same off-loop property for the channel-message wake callback."""
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
    _channel, body = slow_publish["calls"][0]
    assert body["kind"] == "klodi.channel_message"


# ──────────────────────────────────────────────────────────────────────────
# Contract 2 — failure disposition by class (ACs 1/2/3).
# Replaces the old ``test_on_notification_raises_to_trigger_nak_when_publish_fails``,
# which baked in the NAK-everything bug (per CLAUDE.md: no back-compat — rewrite,
# do not preserve).
# ──────────────────────────────────────────────────────────────────────────
def test_publish_failure_log_includes_dropped_stdout_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """AC 1 (Bug 1) — when ``nanobot events publish`` exits nonzero with its
    diagnostic on STDOUT and an empty stderr, the failure log MUST include the
    stdout content. Today the daemon logs ``proc.stderr`` only and drops
    ``proc.stdout``, so the explanation for ``exit=1`` is silently discarded.

    Driven at the publish boundary directly (no raise involved) so the RED
    signal is the missing diagnostic, not the disposition.
    """
    diagnostic = "boom on stdout: channel 'klodi' is not registered"
    monkeypatch.setattr(
        nanobot_daemon.subprocess,
        "run",
        lambda *_a, **_k: _completed(1, stdout=diagnostic, stderr=""),
    )
    caplog.set_level(logging.DEBUG, logger="klodi_nanobot.daemon")

    nanobot_daemon._publish_to_event_bus("klodi", {"kind": "klodi.notification"})

    messages = "\n".join(r.getMessage() for r in caplog.records)
    assert diagnostic in messages, (
        "the failure log dropped proc.stdout — the diagnostic explaining the"
        f" nonzero exit is on stdout but never logged.\nlogged:\n{messages}"
    )


@pytest.mark.asyncio
async def test_deterministic_failure_acks_instead_of_naking(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC 2 (Bug 2 disposition) — a fast deterministic nonzero exit must be
    ACKed (the callback returns WITHOUT raising). Redelivering a deterministic
    misconfig burns ``max_deliver`` and drops silently anyway — the ERROR
    alarm, not redelivery, is the surface. Today the callback raises on every
    failure → consumer NAKs → fails RED here.
    """
    monkeypatch.setattr(
        nanobot_daemon.subprocess,
        "run",
        lambda *_a, **_k: _completed(1, stdout="hard misconfig", stderr=""),
    )
    on_notification, _ = nanobot_daemon._make_wake_callbacks("klodi")

    raised: BaseException | None = None
    try:
        await on_notification({"event_id": "e1", "kind": "channel.opened"})
    except BaseException as err:  # noqa: BLE001 — asserting the disposition
        raised = err

    assert raised is None, (
        "a deterministic failure must ACK (no raise) and surface via the ERROR"
        f" alarm — not NAK/redeliver-then-silently-drop; got raise: {raised!r}"
    )


@pytest.mark.asyncio
async def test_deterministic_failure_emits_distinct_error_alarm_with_correlation(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """AC 2 (Bug 2 alarm) — a deterministic nonzero exit must emit a DISTINCT
    ERROR alarm carrying the full diagnostic (incl. stdout) + ``kind`` +
    ``event_id``, separable from the routine transient path. Today the daemon
    logs a generic ``nanobot_publish_failed`` with stderr only and no
    correlation → fails RED on the missing distinct alarm + fields.

    Any raise is suppressed so the RED signal is the missing alarm, not the
    (separately-tested) disposition.
    """
    stdout_diag = "deterministic boom on stdout"
    monkeypatch.setattr(
        nanobot_daemon.subprocess,
        "run",
        lambda *_a, **_k: _completed(1, stdout=stdout_diag, stderr=""),
    )
    caplog.set_level(logging.DEBUG, logger="klodi_nanobot.daemon")
    on_notification, _ = nanobot_daemon._make_wake_callbacks("klodi")

    try:
        await on_notification({"event_id": "e1", "kind": "channel.opened"})
    except BaseException:  # noqa: BLE001 — disposition asserted elsewhere
        pass

    alarms = [
        r for r in caplog.records
        if r.levelno >= logging.ERROR and _DETERMINISTIC_ALARM in r.getMessage()
    ]
    assert alarms, (
        f"expected a distinct ERROR alarm '{_DETERMINISTIC_ALARM}' on a"
        " deterministic failure (the hermes wake_inject_deterministic_failure"
        " analogue).\nlogged:\n"
        + "\n".join(f"{r.levelname} {r.getMessage()}" for r in caplog.records)
    )
    alarm_text = "\n".join(r.getMessage() for r in alarms)
    assert "e1" in alarm_text, "alarm must carry the wake event_id for correlation"
    assert "channel.opened" in alarm_text, "alarm must carry the wake kind"
    assert stdout_diag in alarm_text, "alarm must carry the stdout diagnostic"


@pytest.mark.asyncio
async def test_transient_timeout_naks_and_is_not_a_deterministic_alarm(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """AC 3 (guard) — a genuine timeout is transient: the callback must RAISE
    (so the consumer NAKs and JetStream redelivers) and must NOT emit the
    deterministic ERROR alarm. Passes today and must keep passing after the
    class split lands.
    """
    def _timeout(*_a: Any, **_k: Any) -> Any:
        raise subprocess.TimeoutExpired(cmd="nanobot events publish", timeout=10)

    monkeypatch.setattr(nanobot_daemon.subprocess, "run", _timeout)
    caplog.set_level(logging.DEBUG, logger="klodi_nanobot.daemon")
    on_notification, _ = nanobot_daemon._make_wake_callbacks("klodi")

    with pytest.raises(Exception):  # noqa: B017 — any raise NAKs at the consumer
        await on_notification({"event_id": "e1", "kind": "channel.opened"})

    messages = "\n".join(r.getMessage() for r in caplog.records)
    assert _DETERMINISTIC_ALARM not in messages, (
        "a transient timeout must NOT be mis-classified as a deterministic"
        f" failure.\nlogged:\n{messages}"
    )
