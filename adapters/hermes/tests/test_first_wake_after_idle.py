"""Integration spec — first-wake-after-idle runs a real turn; the no-silent-drop
invariant; the warm path stays unregressed.

These drive the REAL consumer dispatch seam (``klodi_nats_client.consumers.
_dispatch_message``) -> the REAL wake handler (``handle_notification``) -> the
REAL ``BridgeCtx`` with a stub subprocess runner, so no NATS, no docker, and no
``hermes`` binary is touched — only the boundaries (JetStream msg ack/nak, the
subprocess spawn, the on-disk completion marker) are stubbed. Behavior, not
implementation.

  * AC-1 — the first wake after idle, delivered to the BRIDGE (the single wake-
    pump host), spawns a ``hermes chat --source klodi`` subprocess and, on exit
    0, writes an ``event_id``-keyed completion marker; the consumer ACKs after
    the turn. The user-observable outcome the fix must restore.
  * AC-2 — the invariant: a wake is NEVER both no-op'd AND ACKed. The forbidden
    state requires an INCAPABLE ctx (gateway/chat: inject no-ops) bound to an
    ARMED consumer; the arming gate makes it unreachable by refusing to arm in
    any non-turn-capable process.
  * AC-5 — the warm (bridge) path is unregressed: an already-warmed persona's
    subsequent wakes each still run a turn and write their marker exactly as
    today.

AC-3 (the redelivery-recovers-the-wake path) is deliberately ABSENT: under the
arming-gate fix it is vacuous (the incapable process never arms, so no wake is
ever left un-ACKed for redelivery to recover). Do not write a test
for a code path that will not exist. AC-4 is [e2e] and lives cross-repo in
klodi-stage — not here.

Do NOT weaken these to make a broken implementation pass — the tests are the spec.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

import klodi_hermes
from klodi_hermes import wake_handlers
from klodi_hermes.bridge import BridgeCtx

_HERMES_BIN = "/opt/hermes/.venv/bin/hermes"


@pytest.fixture(autouse=True)
def _isolated_klodi_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Per-test throwaway ``${KLODI_HOME}`` so the wake-completion marker store
    is isolated and never touches a real home."""
    home = tmp_path / "khome"
    monkeypatch.setenv("KLODI_HOME", str(home))
    return home


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


class _RecordingRunner:
    """Stub ``subprocess.run`` capturing argv + kwargs; scripts a return code."""

    def __init__(self, *, returncode: int = 0) -> None:
        self.calls: list[dict[str, Any]] = []
        self.returncode = returncode

    def __call__(self, cmd: list[str], **kwargs: Any) -> Any:
        self.calls.append({"cmd": cmd, **kwargs})
        return SimpleNamespace(returncode=self.returncode, stdout="", stderr="")


class _GatewayCtx:
    """The NON-bridge ctx (gateway / chat): its ``inject_message`` no-ops ("no
    CLI reference (not available in gateway mode)") — it can NOT run a turn."""

    def register_tool(self, **_kwargs: Any) -> None:
        return None

    def register_skill(self, _name: str, _path: Path) -> None:
        return None

    def inject_message(
        self, _text: str, role: str = "system", **_kwargs: Any
    ) -> None:
        return None


class _ArmCounter:
    def __init__(self) -> None:
        self.count = 0

    def __call__(self, *_args: Any, **_kwargs: Any) -> None:
        self.count += 1


def _make_msg(payload: dict[str, Any]) -> Any:
    msg = MagicMock()
    msg.data = json.dumps(payload).encode("utf-8")
    msg.subject = "p2p.v1.notifications.u"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()
    return msg


def _completed_event_ids() -> list[str]:
    from klodi_hermes import wake_completions

    path = wake_completions._store_path()
    if not path.is_file():
        return []
    return [m["event_id"] for m in json.loads(path.read_text(encoding="utf-8"))]


def _offer_event(event_id: str, listing_id: str = "L1") -> dict[str, Any]:
    return {
        "event_id": event_id,
        "kind": "offer.proposed",
        "buyer_handle": "alice",
        "listing_id": listing_id,
        "amount": 100,
    }


# ── AC-1 — first wake after idle runs a real turn ─────────────────────


@pytest.mark.asyncio
async def test_first_after_idle_wake_runs_real_turn_and_writes_marker() -> None:
    """AC-1. A wake delivered to the bridge spawns a ``hermes chat --source
    klodi`` subprocess and — on exit 0 — writes an ``event_id``-keyed completion
    marker; the consumer ACKs after the turn (never a NAK, never an ack-only
    no-op)."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    runner = _RecordingRunner(returncode=0)
    ctx = BridgeCtx(hermes_bin=_HERMES_BIN, runner=runner)
    wake_handlers.bind_ctx(ctx)

    event_id = "1de0aa00-0001-4000-8000-000000000001"
    msg = _make_msg(_offer_event(event_id))

    await _dispatch_message(
        msg, _EventIdLru(), wake_handlers.handle_notification, lambda _e: None
    )

    # A real turn ran: exactly one subprocess, tagged `--source klodi`.
    assert len(runner.calls) == 1, "the first-after-idle wake must spawn a turn"
    cmd = runner.calls[0]["cmd"]
    assert cmd[:3] == [_HERMES_BIN, "chat", "-q"], f"unexpected argv: {cmd}"
    assert "--source" in cmd and cmd[cmd.index("--source") + 1] == "klodi", (
        f"the wake turn must run as a fresh --source klodi session: {cmd}"
    )

    # Proof-of-turn: the marker is written, keyed by the wake's event_id.
    assert _completed_event_ids() == [event_id], (
        "exit-0 turn must write exactly one completion marker keyed by event_id"
    )

    # ACK follows the turn; the wake is never NAK'd and never ack-only-dropped.
    assert msg.ack.await_count == 1
    assert msg.nak.await_count == 0


# ── AC-2 — the invariant: never both no-op'd AND ACKed ────────────────


@pytest.mark.asyncio
async def test_invariant_never_both_noop_and_ack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-2. The no-silent-drop invariant across the multi-subscriber split-
    brain: no process both no-op's a wake AND ACKs it.

    Part 1 (the HAZARD — documents WHY the arming gate is the fix): an incapable
    ctx (gateway/chat, ``inject_message`` no-ops) bound to the consumer dispatch
    seam produces the FORBIDDEN outcome today — no turn ran (no subprocess, no
    marker) AND the wake was ACKed with no NAK. This is inherent to the seam and
    is not what the fix changes; it is the reason the incapable ctx must never be
    wired to an armed consumer in the first place.

    Part 2 (the LOCK — RED today / GREEN after the fix): the arming gate removes
    the forbidden state at its source — an incapable (non-wake-pump-host) process
    does NOT arm a wake consumer at ``register()`` time, so the Part-1 hazard can
    never occur in production."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    # Part 1 — the hazard, exercised through the real dispatch seam.
    wake_handlers.bind_ctx(_GatewayCtx())
    msg = _make_msg(_offer_event("evt-2"))
    await _dispatch_message(
        msg, _EventIdLru(), wake_handlers.handle_notification, lambda _e: None
    )
    no_turn_ran = "evt-2" not in _completed_event_ids()
    acked_and_not_naked = msg.ack.await_count == 1 and msg.nak.await_count == 0
    assert no_turn_ran and acked_and_not_naked, (
        "characterization: today an incapable ctx no-op's a wake AND ACKs it — "
        "this is the silent-drop hazard the arming gate must make unreachable"
    )

    # Part 2 — the fix: the incapable process must never arm a wake consumer.
    calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", calls)
    klodi_hermes.register(_GatewayCtx())
    assert calls.count == 0, (
        "the invariant: an incapable (no-op) ctx must NEVER arm a wake consumer "
        "— otherwise its process both no-op's AND ACKs the first-after-idle wake"
    )


# ── AC-5 — the warm (bridge) path is unregressed ──────────────────────


@pytest.mark.asyncio
async def test_warm_path_subsequent_wakes_still_run_and_write_markers() -> None:
    """AC-5 (regression guard). An already-warmed bridge ctx's subsequent wakes
    each still spawn a turn and write their own ``event_id``-keyed marker exactly
    as today — the arming gate must not slow or regress the warm path."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    runner = _RecordingRunner(returncode=0)
    ctx = BridgeCtx(hermes_bin=_HERMES_BIN, runner=runner)
    wake_handlers.bind_ctx(ctx)

    lru = _EventIdLru()
    event_ids = ["warm-a", "warm-b", "warm-c"]
    for i, event_id in enumerate(event_ids):
        msg = _make_msg(_offer_event(event_id, listing_id=f"L{i}"))
        await _dispatch_message(
            msg, lru, wake_handlers.handle_notification, lambda _e: None
        )
        assert msg.ack.await_count == 1, f"warm wake {event_id} must ACK"
        assert msg.nak.await_count == 0, f"warm wake {event_id} must not NAK"

    assert len(runner.calls) == len(event_ids), (
        "each warm wake must spawn its own turn — no regression on the warm path"
    )
    assert set(_completed_event_ids()) == set(event_ids), (
        "each warm wake must write its own completion marker"
    )
