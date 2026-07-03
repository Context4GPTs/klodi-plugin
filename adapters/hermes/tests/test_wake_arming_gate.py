"""RED spec — the arming gate: loaded != armed (hermes parity port of ADR-0015).

Card: ``fix-first-wake-after-idle-cold-start-noop``. In-Dev RED locks (unit tier).

Root cause (solutions-architect, CONFIRMED — overturns the card's lazy-bind
hypothesis): ``klodi_hermes.register()`` arms the wake pump UNCONDITIONALLY
(``__init__.py:101-103`` -> ``start_wake_pump()``) in EVERY process that loads the
plugin through the ``hermes_agent.plugins`` entry point — the always-on
``klodi-hermes-bridge`` daemon (the only ctx that can shell a ``hermes chat``
turn) AND every ``hermes gateway run`` / ``hermes chat -q`` process, whose ctx
no-ops a wake ("no CLI reference (not available in gateway mode)"). Each pump
subscribes to the ONE shared durable ``klodi-notifications-<user>``, so a wake is
delivered to whichever subscriber pulls it; a non-bridge subscriber no-ops it,
returns normally, and the consumer ACKs -> the wake is silently dropped and
JetStream never redelivers. This is the "loaded != armed" class ADR-0015 already
fixed for openclaw; hermes never got the arming gate.

The fix (this card): arm the pump in EXACTLY ONE process — the bridge — and
load-but-don't-arm everywhere else, gated on a POSITIVE, NON-INHERITED signal (a
wake-pump-host capability marker on the bridge's ctx, or argv — NEVER an env var,
which ``BridgeCtx.inject_message`` merges into its ``{**os.environ}`` children and
would fail OPEN). Register tools/skills ALWAYS; arm the pump ONLY in the bridge.

These are the unit-tier root-cause locks:
  * AC-7 — the arming decision: a non-wake-pump-host ctx (gateway / chat) does
    NOT call ``start_wake_pump()``; the bridge's wake-pump-host ctx arms exactly
    once. Tools still register in both.  (RED today for the negative case.)
  * AC-8 — the discriminator is NOT child-inheritable: a child process whose
    environ is EXACTLY the merged ``{**os.environ}`` the bridge hands its
    ``hermes chat`` child does NOT arm — proving the signal is a ctx marker/argv,
    never an env var (the fail-OPEN trap ADR-0015 rejects).  (RED today.)
  * AC-6 — deterministic-failure policy preserved (over-correction guard): the
    arming-gate change must NOT flip ADR-0019's deterministic ``WakeInjectFailed``
    from ACK+alarm to NAK/redeliver.  (GREEN guard.)

Design note — the seam these tests lock. The arming decision is a property of the
CTX ``register(ctx)`` receives. The POSITIVE case drives the REAL ctx the bridge's
own factory produces (``Bridge._default_ctx_factory()``), so whatever marker the
fix stamps on it is exercised through the real object — the tests do NOT hardcode
the marker's name or shape, only the OBSERVABLE outcome (does ``register`` arm?).
The NEGATIVE case is a plain per-chat ctx that lacks the marker. Do NOT weaken
these to match a broken implementation — the tests are the spec.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock
from unittest.mock import AsyncMock, MagicMock

import pytest

import klodi_hermes
from klodi_hermes import wake_handlers
from klodi_hermes.bridge import Bridge, BridgeCtx


@pytest.fixture(autouse=True)
def _isolated_klodi_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """Per-test throwaway ``${KLODI_HOME}`` so the wake-completion marker store
    written by a real ``BridgeCtx.inject_message`` never touches a real home."""
    home = tmp_path / "khome"
    monkeypatch.setenv("KLODI_HOME", str(home))
    return home


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    """``register()`` / ``bind_ctx`` stash the ctx in a module-global. Restore
    the pre-test value so cases never leak into each other."""
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


class _ArmCounter:
    """Stand-in for ``start_wake_pump`` that records how many times the arming
    primitive was invoked, without opening any NATS connection."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(self, *_args: Any, **_kwargs: Any) -> None:
        self.count += 1
        return None


class _GatewayCtx:
    """Models the NON-bridge ctx: the ``hermes gateway run`` daemon / a
    ``hermes chat -q`` per-chat subprocess. It registers tools/skills, but its
    ``inject_message`` no-ops ("no CLI reference (not available in gateway
    mode)") — it can NOT run a wake turn. It carries NO wake-pump-host marker
    (a plain object), so under the arming gate it MUST NOT arm a pump."""

    def __init__(self) -> None:
        self.tools: list[str] = []
        self.skills: list[str] = []

    def register_tool(self, **kwargs: Any) -> None:
        self.tools.append(str(kwargs.get("name")))

    def register_skill(self, name: str, _path: Path) -> None:
        self.skills.append(name)

    def inject_message(
        self, _text: str, role: str = "system", **_kwargs: Any
    ) -> None:
        # Gateway-mode no-op: no usable CLI reference, so no turn is spawned.
        return None


class _EnvRecordingRunner:
    """Stub ``subprocess.run`` capturing the ``env`` the bridge spawns its
    ``hermes chat`` child with. Returns a clean exit so no failure fires."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> Any:
        self.calls.append((cmd, kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")


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


# ── AC-7 — the arming gate: loaded != armed ───────────────────────────


def test_non_bridge_ctx_registers_tools_but_does_not_arm_pump(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-7 (negative — the root-cause lock). ``register(ctx)`` in a
    non-wake-pump-host ctx (the ``hermes gateway run`` daemon or a
    ``hermes chat -q`` subprocess) must register tools but MUST NOT call
    ``start_wake_pump()`` — a non-bridge process must never subscribe to the
    shared durable, because its ctx would no-op the wake and the consumer would
    ACK the drop.

    RED today: ``register()`` calls ``start_wake_pump()`` unconditionally, so
    the gateway/chat process arms a competing pump — the split-brain that drops
    the first-after-idle wake. DO NOT relax this to match that behaviour."""
    calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", calls)

    ctx = _GatewayCtx()
    klodi_hermes.register(ctx)

    assert calls.count == 0, (
        "a non-wake-pump-host ctx (gateway/chat) must NOT arm a wake pump — it "
        "would no-op every wake it pulls and the consumer would silently ACK "
        "the drop (the first-after-idle cold-start bug)"
    )
    assert ctx.tools, "tools must STILL register in the non-bridge process"


def test_bridge_wake_pump_host_ctx_arms_pump_exactly_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """AC-7 (positive — the fail-CLOSED guard). The bridge is the single wake-
    pump host: ``register()`` called with the ctx the running bridge actually
    passes (its own ``_default_ctx_factory()`` output) MUST arm the pump exactly
    once. A gate that fails CLOSED here would make the bridge deaf — total wake
    loss, strictly worse than today's tail."""
    calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", calls)

    bridge = Bridge(klodi_home=tmp_path / "klodi", hermes_bin="/usr/bin/hermes")
    host_ctx = bridge._default_ctx_factory()

    klodi_hermes.register(host_ctx)

    assert calls.count == 1, (
        "the bridge's wake-pump-host ctx MUST arm the pump exactly once — the "
        "arming gate must not fail CLOSED and silence the one process that can "
        "run a wake turn"
    )


def test_arming_gate_keys_off_the_published_capability_attr(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-7 (detection matrix — the hermes analog of openclaw's ADR-0015
    wake-pump-detection matrix). The arming gate keys off the PUBLISHED positive
    capability attribute the bridge exports (``bridge.WAKE_PUMP_HOST_ATTR`` — the
    class attribute ``BridgeCtx`` sets). A ctx bearing it (truthy) arms; a ctx
    lacking it does not — via the same ``register()`` entry point.

    Locks the exact non-inherited discriminator the In-Dev contract commits to.
    The constant is imported LAZILY so a not-yet-added contract fails ONLY this
    test (RED for the right reason), never file collection. Uses the exported
    constant, not a magic string, so it tracks the source of truth."""
    from klodi_hermes.bridge import WAKE_PUMP_HOST_ATTR  # RED until the fix lands

    # The bridge's own ctx class declares the capability positively.
    assert getattr(BridgeCtx, WAKE_PUMP_HOST_ATTR, False) is True, (
        "BridgeCtx must positively declare the wake-pump-host capability attr"
    )

    host_stub = SimpleNamespace(
        register_tool=lambda **_k: None,
        register_skill=lambda _n, _p: None,
        **{WAKE_PUMP_HOST_ATTR: True},
    )
    bare_stub = SimpleNamespace(
        register_tool=lambda **_k: None,
        register_skill=lambda _n, _p: None,
    )

    host_calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", host_calls)
    klodi_hermes.register(host_stub)
    assert host_calls.count == 1, "a ctx bearing the capability attr must arm"

    bare_calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", bare_calls)
    klodi_hermes.register(bare_stub)
    assert bare_calls.count == 0, "a ctx lacking the capability attr must not arm"


# ── AC-8 — the discriminator is not child-inheritable ─────────────────


def test_merged_environ_child_does_not_arm_pump(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """AC-8 (the fail-OPEN guard — root-cause lock). The bridge shells
    ``hermes chat -q`` with the merged ``{**os.environ, KLODI_WAKE_*}`` env
    (``bridge.py:252-257``). Reconstruct that child's environ EXACTLY, then run
    ``register()`` with the ctx such a child builds (a non-bridge per-chat ctx):
    it MUST NOT arm a pump.

    This is the fail-OPEN trap ADR-0015 rejects: were the arming signal an
    environment variable, it would ride the merged environ into the child and
    the child would arm a competing pump — the bug would persist silently. The
    signal must be a POSITIVE, NON-INHERITED ctx marker (or argv). Because we
    set the process environ to EXACTLY what the bridge hands its child, ANY
    env-var discriminator the bridge process carried would be present here and
    would (wrongly) arm — so this test bites precisely on that mistake.

    RED today: ``register()`` arms unconditionally regardless of ctx or env."""
    # Capture the EXACT env the bridge hands its `hermes chat` child.
    runner = _EnvRecordingRunner()
    bridge_ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    bridge_ctx.inject_message(
        "wake text",
        session="klodi:L1",
        entity_type="listing",
        entity_id="L1",
        event_id="evt-8",
    )
    assert runner.calls, "bridge must have spawned the child"
    child_env = runner.calls[0][1]["env"]
    assert "KLODI_WAKE_ENTITY_ID" in child_env, (
        "sanity: the captured dict IS the merged child env"
    )

    calls = _ArmCounter()
    monkeypatch.setattr(klodi_hermes, "start_wake_pump", calls)

    gateway_ctx = _GatewayCtx()
    # Run register() under the child's EXACT environ (clear=True so nothing but
    # the inherited/merged env is visible — the faithful child view).
    with mock.patch.dict(os.environ, child_env, clear=True):
        klodi_hermes.register(gateway_ctx)

    assert calls.count == 0, (
        "a child whose environ is the bridge's merged {**os.environ} MUST NOT "
        "arm a pump — the arming signal must be a positive, non-inherited ctx "
        "marker/argv, NEVER an env var (the fail-OPEN trap)"
    )


# ── AC-6 — deterministic-failure policy preserved (ADR-0019) ──────────


@pytest.mark.asyncio
async def test_deterministic_failure_still_acks_via_real_bridge_chain(
    caplog: Any,
) -> None:
    """AC-6 (over-correction guard). A deterministic ``WakeInjectFailed`` (a
    misconfig that fails identically every wake) must still ACK, raise the
    ``wake_inject_deterministic_failure`` operator alarm, and NOT be redelivered
    (ADR-0019). The arming-gate change must not over-correct into NAK-on-noop.

    Driven through the REAL ``BridgeCtx`` (runner exits nonzero) -> real handler
    -> real ``_dispatch_message`` so the whole inject->classify->alarm->ack chain
    is exercised end to end (distinct from the hand-rolled raising stub already
    in ``test_wake_handlers.py``). GREEN guard — it must stay green after the
    fix."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    class _NonzeroRunner:
        def __call__(self, _cmd: list[str], **_kwargs: Any) -> Any:
            return SimpleNamespace(
                returncode=1, stdout="hermes: missing model", stderr=""
            )

    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=_NonzeroRunner())
    wake_handlers.bind_ctx(ctx)

    payload = {"event_id": "evt-6", "kind": "offer.proposed", "listing_id": "L1"}
    msg = _make_msg(payload)
    errors: list[BaseException] = []
    with caplog.at_level("ERROR", logger="klodi_hermes.wake"):
        await _dispatch_message(
            msg, _EventIdLru(), wake_handlers.handle_notification, errors.append
        )

    assert msg.ack.await_count == 1, "deterministic failure must ACK (ADR-0019)"
    assert msg.nak.await_count == 0, (
        "deterministic failure must NEVER NAK — redelivery burns max_deliver and "
        "drops anyway; the alarm is the surface, not redelivery"
    )
    assert any(
        "wake_inject_deterministic_failure" in r.message for r in caplog.records
    ), "the operator alarm must fire"
    assert "evt-6" not in _completed_event_ids(), (
        "a failed inject ran no turn — it must record no completion marker"
    )
