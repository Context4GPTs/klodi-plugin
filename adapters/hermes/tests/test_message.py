"""Spec — klodi_message_user outbound tool + operator-target resolver
+ reply correlation (Pieces 3 & 4), bound to Hermes's host primitives.

Card: ``bind-message-user-delivery-and-operator-resolver``. This is the
outbound half of the wake round-trip: the way a klodi escalation reaches
the operator's live session turn-lessly, and the way their reply
deterministically drives the right marketplace action.

Two host boundaries are mocked — and ONLY these (the klodi logic is never
mocked). Both bind to runtime Hermes modules that ship only inside the
Hermes image (``hermes_state`` / ``gateway.*`` / ``tools.send_message_tool``),
never in the ``klodi-hermes`` wheel's own venv, so the unit suite drives
them as seams and the live stage exercises the real bindings:

  1. The session store + channel directory — ``message._list_operator_sessions``
     returns the host's own ``SessionDB.list_sessions_rich`` row dicts
     (confirmed keys: ``id``, ``source``, ``title``, ``last_active`` — a
     wake session has ``source='cli'`` and an ``id``/``title`` namespaced
     ``klodi:<entity_id>``), and ``message._resolve_chat_id`` recovers a
     deliverable ``chat_id`` for a platform from ``channel_directory``.
  2. ``_deliver(platform, chat_id, text)`` — the turn-less standalone sender
     (``tools.send_message_tool._send_to_platform``). It must NEVER run an
     agent turn in the operator's session. Stubbed wholesale here.

There is NO default fallback channel (founder decision): the target is
always a resolved live operator; a genuinely-absent operator surfaces a
loud ``no_operator_target``.

Coverage:
  * AC-1  — active-session delivery via the turn-less seam; NO hermes-chat
            subprocess spawned (no operator turn hijacked).
  * AC-2  — delivery failure is a SURFACED ``delivery_failed`` (ADR-0011
            envelope), never silent; no pending persisted on failure.
  * AC-3  — resolver excludes the whole ``klodi:`` wake-session family and
            NEVER self-addresses, even when a wake session is the single
            most-recently-active session.
  * AC-4  — multi-platform: most-recently-active operator wins (numeric
            ``last_active``, not lexical, not telegram-hardcoded), mapped to
            a deliverable ``(platform, chat_id)`` via the directory.
  * AC-5  — no operator session → surfaced ``no_operator_target``; no
            delivery attempted, nothing persisted. No default channel.
  * AC-6  — handler end-to-end: resolve → deliver → persist exactly one open
            decision keyed by the wake entity env; no-operator persists none.
  * AC-7  — handler persists the pending-decision keyed off the
            ``KLODI_WAKE_ENTITY_*`` env (the keystone), only AFTER delivery.
  * AC-8  — message.py carries no probe-gated stub / no assumed
            ``active_sessions.json`` / no ``KLODI_FALLBACK_*`` default channel.
  * INV-1 — every call terminates in exactly one disposition: delivered XOR
            surfaced-failure (BR-2).
  * AC-8/9 (reply side) — ``klodi_pending_decisions`` lists the open
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
    DeliveryError,
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
    (host data root) per test. Also bind the wake-entity env to a known
    keystone so the handler keys the pending-decision deterministically."""
    monkeypatch.setenv("KLODI_HOME", str(tmp_path / "klodi"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
    monkeypatch.setenv("KLODI_WAKE_ENTITY_ID", _LISTING_ID)
    monkeypatch.setenv("KLODI_WAKE_ENTITY_TYPE", "listing")
    monkeypatch.setenv("KLODI_WAKE_EVENT_ID", _EVENT_ID)
    return tmp_path


def _session(
    id: str, source: str, last_active: float, title: str | None = None
) -> dict[str, Any]:
    """A host-shaped session row — the subset of
    ``SessionDB.list_sessions_rich`` keys the resolver reads (confirmed
    against the staging image). ``source`` is the platform; a wake session
    has ``source='cli'`` and a ``klodi:``-namespaced ``id``/``title``."""
    return {"id": id, "source": source, "title": title, "last_active": last_active}


def _install_sessions(
    monkeypatch: pytest.MonkeyPatch, sessions: list[dict[str, Any]]
) -> None:
    """Mock the host session-store boundary (``SessionDB.list_sessions_rich``)
    — the genuine store is exercised in the live stage, not in this venv."""
    monkeypatch.setattr(message, "_list_operator_sessions", lambda: list(sessions))


def _install_directory(
    monkeypatch: pytest.MonkeyPatch, chat_ids: dict[str, str]
) -> None:
    """Mock the host channel-directory boundary — a platform → chat_id map
    mirroring ``channel_directory`` resolution. A platform absent from the
    map resolves to ``None`` (no reachable chat)."""
    monkeypatch.setattr(
        message, "_resolve_chat_id", lambda platform: chat_ids.get(platform)
    )


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


def _is_failure(envelope_json: str) -> bool:
    obj = json.loads(envelope_json)
    return bool(obj.get("error"))


# ── Resolver: AC-3 / AC-4 / AC-5 (pure logic over the host seams) ─────


def test_resolver_returns_most_recently_active_operator(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-1 substrate: the resolver returns the most-recently-active genuine
    operator session's (platform, chat_id)."""
    _install_sessions(monkeypatch, [
        _session("s-old", "telegram", 100.0),
        _session("s-new", "telegram", 200.0),
    ])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})

    assert resolve_operator_target() == DeliveryTarget(
        platform="telegram", chat_id="operator-chat"
    )


def test_resolver_returns_none_when_no_operator_session(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-5: no genuine operator session → ``None`` (→ surfaced no-target).
    There is no default fallback channel."""
    _install_sessions(monkeypatch, [])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})

    assert resolve_operator_target() is None


def test_resolver_excludes_klodi_wake_session_family(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-3: a store containing ONLY ``klodi:``-namespaced wake sessions has
    no operator session — the resolver excludes the whole family and yields
    ``None`` (no default channel to fall back to)."""
    _install_sessions(monkeypatch, [
        _session("klodi:" + _LISTING_ID, "cli", 200.0, title="klodi:" + _LISTING_ID),
        _session("klodi:vintage-camera", "cli", 150.0, title="klodi:vintage-camera"),
    ])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})

    assert resolve_operator_target() is None


def test_resolver_never_self_addresses_even_when_wake_is_most_recent(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-3 (the highest product risk — self-addressing leak, BR-4): when the
    single MOST-recently-active session is an isolated ``klodi:`` wake session,
    the resolver must STILL pick the older genuine operator session and NEVER
    the wake — otherwise the escalation lands in the bot's own transcript and
    the human never sees it."""
    _install_sessions(monkeypatch, [
        _session("op-1", "telegram", 100.0),
        # The wake session is more recent — the trap.
        _session("klodi:" + _LISTING_ID, "cli", 999.0, title="klodi:" + _LISTING_ID),
    ])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})

    assert resolve_operator_target() == DeliveryTarget(
        platform="telegram", chat_id="operator-chat"
    ), "resolver self-addressed the wake session instead of the operator"


def test_resolver_multi_app_picks_newest_operator_not_telegram(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-4: with multiple platforms, the most-recently-active operator wins
    across whatever is registered — NOT telegram-hardcoded — and is mapped to
    its platform's deliverable chat via the directory."""
    _install_sessions(monkeypatch, [
        _session("tg", "telegram", 100.0),
        _session("sig", "signal", 200.0),
    ])
    _install_directory(monkeypatch, {"telegram": "tg-chat", "signal": "sig-chat"})

    assert resolve_operator_target() == DeliveryTarget(
        platform="signal", chat_id="sig-chat"
    )


def test_resolver_ranks_by_numeric_last_active_not_lexical(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """BR-6: recency is the NUMERIC ``last_active``, not a lexical string max.
    A lexical ``max`` over the string form would pick ``"9.0" > "100.0"`` (the
    older telegram session); numeric ordering correctly picks signal."""
    _install_sessions(monkeypatch, [
        _session("tg", "telegram", 9.0),
        _session("sig", "signal", 100.0),
    ])
    _install_directory(monkeypatch, {"telegram": "tg-chat", "signal": "sig-chat"})

    assert resolve_operator_target() == DeliveryTarget(
        platform="signal", chat_id="sig-chat"
    )


def test_resolver_skips_session_without_reachable_chat_then_falls_through(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The newest operator session whose platform has NO directory entry is
    skipped, and the resolver falls through to the next session that DOES map
    to a reachable chat — never crashing, never returning a half-target."""
    _install_sessions(monkeypatch, [
        _session("tg", "telegram", 200.0),   # newest, but no telegram chat
        _session("sig", "signal", 100.0),    # older, but reachable
    ])
    _install_directory(monkeypatch, {"signal": "sig-chat"})

    assert resolve_operator_target() == DeliveryTarget(
        platform="signal", chat_id="sig-chat"
    )


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [{"id": "x"}],                                   # no source / last_active
        [{"id": "x", "source": None, "last_active": None}],
        [{"id": "x", "source": "telegram", "last_active": "not-a-number"}],
        [_session("cli-only", "cli", 100.0)],            # source has no chat
    ],
)
def test_resolver_tolerates_malformed_or_unreachable_rows(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch, rows: list[dict[str, Any]]
) -> None:
    """Adversarial: missing/None/non-numeric fields and non-messaging sources
    degrade to ``None`` — never raise. The fresh-install cold path is common
    and a crash here would strand every escalation. (The malformed-``last_active``
    row still resolves a chat, so it returns that target without crashing.)"""
    _install_sessions(monkeypatch, rows)
    _install_directory(monkeypatch, {"telegram": "operator-chat"})

    out = resolve_operator_target()
    assert out is None or isinstance(out, DeliveryTarget)


# ── Handler AC-1 / AC-7: deliver via the seam, then persist ───────────


def test_handler_delivers_to_active_operator_without_running_a_turn(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-1: with an active operator session, the handler delivers the text
    into that (platform, chat_id) via the turn-less seam — and spawns NO
    ``hermes chat`` subprocess (nothing in the operator's session is run)."""
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)

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
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    _install_deliver(monkeypatch, _RecordingDeliver())

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


# ── Handler AC-2 / AC-5 / INV-1: surfaced failure, never a silent no-op ─


def test_handler_surfaces_failure_when_no_target(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-5 (unit) + INV-1/BR-2: no operator session → the handler returns a
    structured ADR-0011 ``no_operator_target`` envelope, NEVER calls
    ``_deliver``, and persists NO pending-decision. Silence is forbidden and
    there is no default channel."""
    _install_sessions(monkeypatch, [])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)

    out = handle_message_user({"text": _QUESTION})

    obj = json.loads(out)
    assert obj.get("error") == "no_operator_target", f"must surface no-target: {out}"
    # ADR-0011 four-key envelope shape.
    assert set(obj) == {"error", "message", "details", "recovery_hint"}
    assert deliver.calls == [], "must not attempt delivery with no target"
    assert open_pending() == [], "must not persist a decision the operator never saw"


def test_handler_surfaces_failure_when_delivery_raises_and_does_not_persist(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-2 + deliver-then-persist ordering: when the sender errors, the
    handler surfaces ``delivery_failed`` and persists NO pending-decision —
    a persist-then-deliver design would leave a dangling decision the operator
    never saw."""
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    deliver = _RecordingDeliver(raises=DeliveryError("sender unreachable"))
    _install_deliver(monkeypatch, deliver)

    out = handle_message_user({"text": _QUESTION})

    obj = json.loads(out)
    assert obj.get("error") == "delivery_failed", f"must surface failure: {out}"
    assert deliver.calls, "delivery was attempted (deliver-then-persist)"
    assert open_pending() == [], "no pending-decision when delivery failed"


@pytest.mark.parametrize("delivery_works", [True, False])
def test_every_call_terminates_in_exactly_one_disposition(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch, delivery_works: bool
) -> None:
    """INV-1 (BR-2): a call ends as delivered XOR surfaced-failure — never a
    silent no-op. The return is always a non-empty JSON object that is exactly
    one of the two, and the pending store agrees with the verdict."""
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    raises = None if delivery_works else DeliveryError("boom")
    deliver = _RecordingDeliver(raises=raises)
    _install_deliver(monkeypatch, deliver)

    out = handle_message_user({"text": _QUESTION})

    assert out and out.strip(), "a no-op empty return is the forbidden outcome"
    failed = _is_failure(out)
    delivered = not failed
    assert delivered ^ failed  # exactly one disposition
    if delivered:
        assert deliver.calls and open_pending(), "delivered → sent + persisted"
    else:
        assert open_pending() == [], "failed → nothing persisted"


# ── AC-6 integration: handler end-to-end over the host seams ──────────


def test_handle_message_user_end_to_end_resolves_delivers_persists(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-6 (integration): with a populated session store + reachable directory
    and a stubbed sender, the handler resolves the operator, delivers, and
    persists exactly ONE open decision keyed by ``KLODI_WAKE_ENTITY_ID``
    (one disposition, INV-1/BR-2)."""
    _install_sessions(monkeypatch, [
        _session("klodi:" + _LISTING_ID, "cli", 999.0, title="klodi:" + _LISTING_ID),
        _session("op", "telegram", 100.0),
    ])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)

    out = handle_message_user({"text": _QUESTION})

    assert not _is_failure(out)
    assert deliver.calls == [("telegram", "operator-chat", _QUESTION)]
    open_now = open_pending()
    assert len(open_now) == 1 and open_now[0].entity_id == _LISTING_ID


def test_handle_message_user_end_to_end_no_operator_persists_nothing(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AC-6 (integration, cold path): no genuine operator session → surfaced
    ``no_operator_target``, no delivery, nothing persisted. No default channel."""
    _install_sessions(monkeypatch, [
        _session("klodi:" + _LISTING_ID, "cli", 999.0, title="klodi:" + _LISTING_ID),
    ])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    deliver = _RecordingDeliver()
    _install_deliver(monkeypatch, deliver)

    out = handle_message_user({"text": _QUESTION})

    assert json.loads(out).get("error") == "no_operator_target"
    assert deliver.calls == []
    assert open_pending() == []


# ── AC-8: no probe-gated stub / no assumed file / no default channel ──


def test_message_module_has_no_stub_or_assumed_file_or_default_channel() -> None:
    """AC-8 (scoped to message.py): the probe-gated ``not bound`` stub, the
    assumed ``active_sessions.json`` registry, and the ``KLODI_FALLBACK_*``
    default-channel path are all GONE — the binding is real."""
    source = Path(message.__file__).read_text(encoding="utf-8")
    for forbidden in (
        "not bound",
        "active_sessions",
        "KLODI_FALLBACK",
        "configured_fallback",
        "PROBE-GATED",
        "merge-gate",
        "merge gate",
    ):
        assert forbidden not in source, (
            f"message.py still contains the retired marker {forbidden!r}"
        )


# ── Reply side AC-8 / AC-9: list the open decisions for correlation ───


def test_pending_decisions_tool_lists_single_open_decision(
    _isolated_homes: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reply-side: after one escalation, ``klodi_pending_decisions`` returns
    exactly that open record; once resolved, a re-read excludes it."""
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    _install_deliver(monkeypatch, _RecordingDeliver())
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
    """Reply-side (BR-4): with MORE than one open decision, the tool returns
    BOTH, each carrying the entity identity + question — so the agent can
    disambiguate a reply on identity and never guess."""
    _install_sessions(monkeypatch, [_session("tg", "telegram", 100.0)])
    _install_directory(monkeypatch, {"telegram": "operator-chat"})
    _install_deliver(monkeypatch, _RecordingDeliver())

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
