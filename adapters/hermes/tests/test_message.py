"""RED spec — klodi_message_user outbound tool + operator-target resolver
+ reply correlation (Pieces 3 & 4).

Card: ``wake-outbound-roundtrip-message-and-correlation``. This is the
outbound half of the wake round-trip: the way a klodi escalation reaches
the operator, and the way their reply deterministically drives the right
marketplace action.

These tests pin the contract BEFORE ``klodi_hermes.message`` and the reply
read tool in ``klodi_hermes.pending_decisions`` exist. Tests are the spec.

Two host seams are mocked — and ONLY these two (the klodi logic is never
mocked):
  1. ``active_sessions.json`` registry — a real temp file under a tmp
     ``${HERMES_HOME}/runtime/`` (the fs boundary). Its schema is the
     architect's PROBE-GATED assumption (a JSON array of
     ``{session, platform, chat_id, last_active_at}``; operator sessions
     are those whose name is NOT ``klodi:``-namespaced); the real binding
     is the PR merge-gate.
  2. ``_deliver(platform, chat_id, text)`` — the turn-less delivery
     primitive (stubbed exactly as ``BridgeCtx._run`` is stubbed). It must
     NEVER run an agent turn in the operator's session.

Coverage:
  * AC-1  — active-session delivery via the turn-less seam; NO hermes-chat
            subprocess spawned (no operator turn hijacked).
  * AC-2  — no operator session → configured fallback target.
  * AC-3  — resolver excludes the whole ``klodi:`` wake-session family and
            NEVER self-addresses, even when a wake session is the single
            most-recently-active session on disk.
  * AC-4  — multi-app: most-recently-active operator wins, not telegram.
  * AC-5  — delivery failure / no target is a SURFACED failure (ADR-0011
            envelope), never a silent no-op; no pending persisted on failure.
  * AC-7  — handler persists the pending-decision keyed off the
            ``KLODI_WAKE_ENTITY_*`` env (the keystone), only AFTER delivery.
  * INV-1 — every call terminates in exactly one disposition: delivered XOR
            surfaced-failure (BR-2).
  * AC-8/9 — reply side: ``klodi_pending_decisions`` lists the open
            decision(s), each carrying entity identity + question.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from klodi_hermes import message  # noqa: E402 — after sys.path bootstrap
from klodi_hermes.message import (  # noqa: E402
    DeliveryTarget,
    handle_message_user,
    resolve_operator_target,
)
from klodi_hermes.pending_decisions import (  # noqa: E402
    handle_pending_decisions,
    open_pending,
    resolve_pending,
)

_LISTING_ID = "11111111-1111-4111-8111-111111111111"
_EVENT_ID = "a1b2c3d4-0007-4000-8000-000000000007"
_QUESTION = "Buyer @bob offered 4000c on the keyboard. Accept, counter, or pass?"


# ── Fixtures / seam helpers ───────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolated_homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Throwaway ``${KLODI_HOME}`` (pending store) and ``${HERMES_HOME}``
    (session registry) per test. Also bind the wake-entity env to a known
    keystone so the handler keys the pending-decision deterministically."""
    monkeypatch.setenv("KLODI_HOME", str(tmp_path / "klodi"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("KLODI_WAKE_ENTITY_ID", _LISTING_ID)
    monkeypatch.setenv("KLODI_WAKE_ENTITY_TYPE", "listing")
    monkeypatch.setenv("KLODI_WAKE_EVENT_ID", _EVENT_ID)
    return tmp_path


def _write_registry(hermes_home: Path, sessions: list[dict[str, Any]]) -> None:
    """Mock the host's ``active_sessions.json`` registry seam at the fs
    boundary (the architect's probe-gated assumed schema)."""
    runtime = hermes_home / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "active_sessions.json").write_text(
        json.dumps(sessions), encoding="utf-8"
    )


def _operator(
    session: str, platform: str, chat_id: str, last_active_at: str
) -> dict[str, Any]:
    return {
        "session": session,
        "platform": platform,
        "chat_id": chat_id,
        "last_active_at": last_active_at,
    }


class _RecordingDeliver:
    """Stub for the turn-less delivery seam. Records every call; optionally
    raises to simulate an unreachable sender."""

    def __init__(self, *, raises: BaseException | None = None) -> None:
        self.calls: list[tuple[str, str, str]] = []
        self._raises = raises

    def __call__(self, platform: str, chat_id: str, text: str) -> None:
        self.calls.append((platform, chat_id, text))
        if self._raises is not None:
            raise self._raises


def _install_deliver(
    monkeypatch: pytest.MonkeyPatch, deliver: _RecordingDeliver
) -> None:
    monkeypatch.setattr(message, "_deliver", deliver)


def _install_fallback(
    monkeypatch: pytest.MonkeyPatch, target: DeliveryTarget | None
) -> None:
    """The net-new hermes fallback config is a host/config seam (devops
    probe-gated). Drive it deterministically rather than depend on unset
    ambient config."""
    monkeypatch.setattr(message, "configured_fallback", lambda: target)


def _is_failure(envelope_json: str) -> bool:
    obj = json.loads(envelope_json)
    return bool(obj.get("error"))


# ── Resolver: AC-2 / AC-3 / AC-4 (pure, over the temp registry) ───────


def test_resolver_returns_most_recently_active_operator(
    _isolated_homes: Path,
) -> None:
    """AC-1 substrate: the resolver returns the most-recently-active genuine
    operator session's (platform, chat_id)."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "111", "2026-06-29T09:00:00Z"),
        _operator("tg:op", "telegram", "222", "2026-06-29T12:00:00Z"),
    ])

    target = resolve_operator_target(fallback=None)
    assert target == DeliveryTarget(platform="telegram", chat_id="222")


def test_resolver_falls_back_when_no_operator_session(_isolated_homes: Path) -> None:
    """AC-2: no active operator session → the configured fallback target."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [])
    fallback = DeliveryTarget(platform="telegram", chat_id="fallback-chat")

    assert resolve_operator_target(fallback=fallback) == fallback


def test_resolver_excludes_klodi_wake_session_family(_isolated_homes: Path) -> None:
    """AC-3: a registry containing ONLY ``klodi:``-namespaced wake sessions
    has no operator session — the resolver excludes the whole family and
    falls through to the fallback (here None)."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("klodi:" + _LISTING_ID, "telegram", "wake-1", "2026-06-29T12:00:00Z"),
        _operator("klodi:vintage-camera", "telegram", "wake-2", "2026-06-29T11:00:00Z"),
    ])

    assert resolve_operator_target(fallback=None) is None


def test_resolver_never_self_addresses_even_when_wake_is_most_recent(
    _isolated_homes: Path,
) -> None:
    """AC-3 (the highest product risk — self-addressing leak): when the
    single MOST-recently-active session on disk is an isolated wake session,
    the resolver must STILL pick the older genuine operator session and
    NEVER the wake session — otherwise the escalation is delivered into the
    bot's own transcript and the human never sees it."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T10:00:00Z"),
        # The wake session is more recent — the trap.
        _operator("klodi:" + _LISTING_ID, "telegram", "wake-chat", "2026-06-29T12:00:00Z"),
    ])

    target = resolve_operator_target(fallback=None)
    assert target == DeliveryTarget(platform="telegram", chat_id="operator-chat"), (
        "resolver self-addressed the wake session instead of the operator"
    )


def test_resolver_multi_app_picks_newest_operator_not_telegram(
    _isolated_homes: Path,
) -> None:
    """AC-4: with multiple platforms registered, the most-recently-active
    operator wins across whatever is registered — NOT telegram-hardcoded."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "tg-chat", "2026-06-29T09:00:00Z"),
        _operator("sig:op", "signal", "sig-chat", "2026-06-29T13:00:00Z"),
    ])

    target = resolve_operator_target(fallback=None)
    assert target == DeliveryTarget(platform="signal", chat_id="sig-chat")


@pytest.mark.parametrize(
    "broken",
    [None, "", "{not json", "[]extra", "{}"],
)
def test_resolver_tolerates_missing_or_malformed_registry(
    _isolated_homes: Path, broken: str | None
) -> None:
    """Adversarial: a missing / empty / malformed registry must degrade to
    the fallback (here None) — never raise. The fresh-install cold path is
    the common case, and a crash here strands every escalation."""
    home = _isolated_homes / "hermes"
    runtime = home / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    if broken is not None:
        (runtime / "active_sessions.json").write_text(broken, encoding="utf-8")
    # broken is None → file absent entirely.

    assert resolve_operator_target(fallback=None) is None


# ── Handler AC-1 / AC-7: deliver via the seam, then persist ───────────


def test_handler_delivers_to_active_operator_without_running_a_turn(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-1: with an active operator session, the handler delivers the text
    into that (platform, chat_id) via the turn-less seam — and spawns NO
    ``hermes chat`` subprocess (nothing in the operator's session is run)."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)
    _install_fallback(monkeypatch, None)

    with mock.patch("subprocess.run") as run:
        out = handle_message_user({"text": _QUESTION})

    assert not run.called, "klodi_message_user must NOT spawn a hermes-chat turn"
    assert deliver.calls == [("telegram", "operator-chat", _QUESTION)]
    assert not _is_failure(out), f"delivered call must not be a failure: {out}"


def test_handler_persists_pending_keyed_by_wake_entity_env(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-7 + keystone: on successful delivery the handler persists a
    pending-decision keyed off ``KLODI_WAKE_ENTITY_ID`` (the bridge-computed
    wake entity id), carrying entity_type/event_id from env, the question
    text, the resolved (platform, chat_id), and ``status=open``."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    _install_deliver(monkeypatch, _RecordingDeliver())
    _install_fallback(monkeypatch, None)

    handle_message_user({"text": _QUESTION})

    open_now = open_pending()
    assert len(open_now) == 1
    rec = open_now[0]
    assert rec.entity_id == _LISTING_ID, "pending key must be the wake entity id"
    assert rec.entity_type == "listing"
    assert rec.event_id == _EVENT_ID
    assert rec.question == _QUESTION
    assert rec.platform == "telegram"
    assert rec.chat_id == "operator-chat"
    assert rec.status == "open"


# ── Handler AC-5 / INV-1: surfaced failure, never a silent no-op ──────


def test_handler_surfaces_failure_when_no_target(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-5 (unit) + INV-1/BR-2: no operator session AND no fallback → the
    handler returns a structured ADR-0011 failure envelope, NEVER calls
    ``_deliver``, and persists NO pending-decision. Silence is forbidden."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [])
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)
    _install_fallback(monkeypatch, None)

    out = handle_message_user({"text": _QUESTION})

    obj = json.loads(out)
    assert obj.get("error"), f"no-target must be a surfaced failure: {out}"
    # ADR-0011 four-key envelope shape.
    assert set(obj) == {"error", "message", "details", "recovery_hint"}
    assert deliver.calls == [], "must not attempt delivery with no target"
    assert open_pending() == [], "must not persist a decision the operator never saw"


def test_handler_surfaces_failure_when_delivery_raises_and_does_not_persist(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-5 (integration) + deliver-then-persist ordering: when the sender
    errors, the handler surfaces the failure and persists NO pending-decision
    — a persist-then-deliver design would leave a dangling decision the
    operator never saw."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    deliver = _RecordingDeliver(raises=RuntimeError("sender unreachable"))
    _install_deliver(monkeypatch, deliver)
    _install_fallback(monkeypatch, None)

    out = handle_message_user({"text": _QUESTION})

    assert _is_failure(out), f"delivery error must surface as a failure: {out}"
    assert deliver.calls, "delivery was attempted (deliver-then-persist)"
    assert open_pending() == [], "no pending-decision when delivery failed"


@pytest.mark.parametrize("delivery_works", [True, False])
def test_every_call_terminates_in_exactly_one_disposition(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch, delivery_works: bool
) -> None:
    """INV-1 (BR-2): a call ends as delivered XOR surfaced-failure — never a
    silent no-op. The return is always a non-empty JSON object that is
    exactly one of the two, and the pending store agrees with the verdict."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    raises = None if delivery_works else RuntimeError("boom")
    deliver = _RecordingDeliver(raises=raises)
    _install_deliver(monkeypatch, deliver)
    _install_fallback(monkeypatch, None)

    out = handle_message_user({"text": _QUESTION})

    assert out and out.strip(), "a no-op empty return is the forbidden outcome"
    failed = _is_failure(out)
    delivered = not failed
    assert delivered ^ failed  # exactly one disposition
    if delivered:
        assert deliver.calls and open_pending(), "delivered → sent + persisted"
    else:
        assert open_pending() == [], "failed → nothing persisted"


def test_handler_delivers_to_fallback_when_no_operator_session(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-2 (handler): no operator session → deliver to the configured
    fallback channel, and persist the decision against the fallback target."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [])
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)
    _install_fallback(
        monkeypatch, DeliveryTarget(platform="telegram", chat_id="fallback-chat")
    )

    out = handle_message_user({"text": _QUESTION})

    assert not _is_failure(out)
    assert deliver.calls == [("telegram", "fallback-chat", _QUESTION)]
    assert open_pending()[0].chat_id == "fallback-chat"


# ── Reply side AC-8 / AC-9: list the open decisions for correlation ───


def test_pending_decisions_tool_lists_single_open_decision(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-8 substrate: after one escalation, ``klodi_pending_decisions``
    returns exactly that open record; once resolved, a re-read excludes it.
    The agent re-grounds + acts (persona/e2e) — here we pin the substrate."""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    _install_deliver(monkeypatch, _RecordingDeliver())
    _install_fallback(monkeypatch, None)
    handle_message_user({"text": _QUESTION})

    listed = json.loads(handle_pending_decisions({}))
    assert isinstance(listed, list) and len(listed) == 1
    assert listed[0]["entity_id"] == _LISTING_ID
    assert listed[0]["question"] == _QUESTION

    resolve_pending(_LISTING_ID)
    assert json.loads(handle_pending_decisions({})) == []


def test_pending_decisions_tool_carries_identity_for_disambiguation(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-9 substrate (BR-4): with MORE than one open decision, the tool
    returns BOTH, each carrying the entity identity + question — so the agent
    can disambiguate on identity and never guess. (The agent's choice is
    persona/e2e; the substrate that makes disambiguation POSSIBLE is here.)"""
    home = _isolated_homes / "hermes"
    _write_registry(home, [
        _operator("tg:op", "telegram", "operator-chat", "2026-06-29T12:00:00Z"),
    ])
    _install_deliver(monkeypatch, _RecordingDeliver())
    _install_fallback(monkeypatch, None)

    handle_message_user({"text": _QUESTION})

    other_id = "33333333-3333-4333-8333-333333333333"
    monkeypatch.setenv("KLODI_WAKE_ENTITY_ID", other_id)
    monkeypatch.setenv("KLODI_WAKE_ENTITY_TYPE", "channel")
    handle_message_user({"text": "Counterparty @ada asks to meet at 5pm — ok?"})

    listed = json.loads(handle_pending_decisions({}))
    by_id = {row["entity_id"]: row for row in listed}
    assert set(by_id) == {_LISTING_ID, other_id}, "both open decisions must list"
    for row in listed:
        assert row["entity_type"] and row["entity_id"] and row["question"], (
            "each decision must carry full identity for disambiguation"
        )
