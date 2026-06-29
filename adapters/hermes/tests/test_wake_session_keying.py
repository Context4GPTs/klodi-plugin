"""Per-key wake-session keying — Piece-2 redesign (founder-directed 2026-06-29).

The reopened defect: every marketplace wake — every channel message, offer,
listing, transaction notification, for the daemon's whole lifetime — ran in ONE
shared ``klodi-wake`` session, so history grew unbounded with no cleanup. The
redesign keys each wake to its CONVERSATION, derived from ``event.kind``, and
NAMESPACES every session under the ``klodi:`` prefix so the sibling outbound
card's active-session resolver can exclude the whole wake-session family from
``active_sessions.json`` (a bare ``search_slug`` like ``vintage-camera`` is
otherwise indistinguishable from an operator session):

  * channel.*           -> klodi:<channel_id>     (the buy/sell negotiation thread)
  * offer.* / listing.* / comment.created -> klodi:<listing_id>
  * transaction.*       -> klodi:<transaction_id>
  * search.match        -> klodi:<search_slug>
  * key field absent    -> klodi:wake-<event_id>  (ephemeral, bounded to one wake)
  * key AND event_id absent -> klodi:wake-<uuid4> (unique per wake — never a
    constant, which would re-introduce a shared session)

The retired shared session literal ``klodi-wake`` (hyphen) is DISTINCT from the
``klodi:`` namespace prefix (colon) — a namespaced key can never contain the
substring ``klodi-wake``, so the "no shared session" assertion stays meaningful.

These tests drive the REAL ``BridgeCtx`` with a stub subprocess runner and assert
the ``--session`` arg the bridge would spawn: the argv is the bridge's verifiable
keying/isolation mechanism, so no real ``hermes`` binary is needed. Event shapes
are loaded from the catalog golden fixtures
(``packages/tool-catalog/tests/golden``) so the key fields stay in lockstep with
the wire contract.

Maps to the eight Piece-2 redesign ACs in
``cards/wake-inject-failures-silent-and-lost-hermes.md`` (In Dev round 3 handoff),
plus the round-3 review P1 (``klodi:`` namespacing).
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from klodi_hermes import wake_handlers
from klodi_hermes.bridge import BridgeCtx

# The wake-session namespace prefix. This is the SPEC value (the impl must
# centralise the same literal in ONE constant — no magic-string duplication).
# The retired shared session ``klodi-wake`` uses a hyphen; this uses a colon —
# the two are deliberately distinct so a namespaced key cannot satisfy the
# "no shared session" assertion by accident.
_KLODI_NS = "klodi:"

_GOLDEN_DIR = (
    Path(__file__).resolve().parents[3]
    / "packages" / "tool-catalog" / "tests" / "golden"
)


def _golden(kind: str) -> dict[str, Any]:
    """Load the canonical wire shape for a wake ``kind`` from the catalog
    golden fixtures so the key fields never drift from the contract."""
    return json.loads((_GOLDEN_DIR / f"{kind}.json").read_text())


class _RecordingRunner:
    """Stub ``subprocess.run``: captures the spawned argv and returns a
    configurable result. No real ``hermes`` binary is ever touched."""

    def __init__(
        self, *, returncode: int = 0, stdout: str = "", stderr: str = ""
    ) -> None:
        self.calls: list[list[str]] = []
        self._returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    def __call__(self, cmd: list[str], **_kwargs: Any) -> Any:
        self.calls.append(cmd)
        return SimpleNamespace(
            returncode=self._returncode,
            stdout=self._stdout,
            stderr=self._stderr,
        )


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    """Wake handlers stash the bound ctx in a module-global. Restore the
    pre-test value so cases don't leak into each other."""
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


async def _spawned_session(
    event: dict[str, Any],
    *,
    channel_msg: bool = False,
    runner: _RecordingRunner | None = None,
) -> str:
    """Drive a wake through the real handler -> real ``BridgeCtx`` -> stub
    runner and return the ``--session`` value the bridge spawned.

    Also asserts the isolation invariant on every wake: a dedicated
    ``--session`` is present and ``--continue`` (resume the operator's
    session) is absent.
    """
    runner = runner or _RecordingRunner()
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    wake_handlers.bind_ctx(ctx)
    if channel_msg:
        await wake_handlers.handle_channel_message(event)
    else:
        await wake_handlers.handle_notification(event)
    assert len(runner.calls) == 1, f"expected exactly one inject, got {runner.calls}"
    cmd = runner.calls[0]
    assert "--continue" not in cmd, (
        "a wake must NEVER resume the operator's session (--continue)"
    )
    assert "--session" in cmd, f"inject argv is missing --session: {cmd}"
    return cmd[cmd.index("--session") + 1]


def _make_msg(payload: dict[str, Any]) -> MagicMock:
    """Fake JetStream ``Msg`` for driving ``_dispatch_message`` directly."""
    msg = MagicMock()
    msg.data = json.dumps(payload).encode("utf-8")
    msg.subject = "p2p.v1.notifications.u"
    msg.ack = AsyncMock()
    msg.nak = AsyncMock()
    return msg


# ── AC-1: channel.* -> klodi:<channel_id> ─────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["channel.opened", "channel.closed"])
async def test_channel_notification_keys_on_channel_id(kind: str) -> None:
    """AC-1: ``channel.opened`` / ``channel.closed`` run ``--session
    klodi:<channel_id>`` — the conversation thread, namespaced."""
    event = _golden(kind)
    assert await _spawned_session(event) == f"{_KLODI_NS}{event['channel_id']}"


@pytest.mark.asyncio
async def test_channel_message_keys_on_channel_id() -> None:
    """AC-1: ``channel.message`` (its own handler) also keys on channel_id,
    so the whole negotiation thread shares one namespaced session."""
    event = _golden("channel.message")
    session = await _spawned_session(event, channel_msg=True)
    assert session == f"{_KLODI_NS}{event['channel_id']}"


# ── AC-2: offer.* / listing.* / comment.created -> klodi:<listing_id> ──

_LISTING_SCOPED = [
    "offer.proposed",
    "offer.accepted",
    "offer.rejected",
    "comment.created",
    "listing.created",
    "listing.relisted",
    "listing.withdrawn",
    "listing.sold",
    "listing.expired",
    "listing.status_changed",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", _LISTING_SCOPED)
async def test_listing_scoped_kinds_key_on_listing_id(kind: str) -> None:
    """AC-2: every offer / listing / comment wake runs ``--session
    klodi:<listing_id>`` — all chatter about one listing shares a session."""
    event = _golden(kind)
    assert await _spawned_session(event) == f"{_KLODI_NS}{event['listing_id']}"


# ── AC-3: transaction.* -> klodi:<transaction_id> ─────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["transaction.completed", "transaction.cancelled"])
async def test_transaction_golden_kinds_key_on_transaction_id(kind: str) -> None:
    """AC-3: terminal transaction events (golden fixtures) key on
    transaction_id, namespaced."""
    event = _golden(kind)
    assert await _spawned_session(event) == f"{_KLODI_NS}{event['transaction_id']}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind", ["transaction.buyer_confirmed", "transaction.seller_confirmed"]
)
async def test_transaction_confirm_kinds_key_on_transaction_id(kind: str) -> None:
    """AC-3: the confirm events have no golden fixture; build them to the
    dispatch-table shape (they carry transaction_id) and assert keying."""
    event = {
        "kind": kind,
        "event_id": "a1b2c3d4-00ee-4000-8000-0000000000ee",
        "transaction_id": "33333333-3333-4333-8333-333333333333",
        "confirmed_by_handle": "bob",
    }
    assert await _spawned_session(event) == f"{_KLODI_NS}{event['transaction_id']}"


# ── AC-4: search.match -> klodi:<search_slug> ─────────────────────────


@pytest.mark.asyncio
async def test_search_match_keys_on_search_slug() -> None:
    """AC-4: a standing-search match keys on its search_slug, namespaced —
    so all hits for one saved search share a session, and the bare slug
    (e.g. ``vintage-camera``) can never be mistaken for an operator
    session."""
    event = _golden("search.match")
    assert await _spawned_session(event) == f"{_KLODI_NS}{event['search_slug']}"


# ── AC-5: distinct keys -> distinct sessions; never the shared session ─


@pytest.mark.asyncio
async def test_distinct_keys_yield_distinct_sessions() -> None:
    """AC-5: four wakes whose domain ids differ must run in four DIFFERENT
    namespaced sessions — the keying does not collapse them."""
    sessions = [
        await _spawned_session(_golden("channel.opened")),
        await _spawned_session(_golden("offer.proposed")),
        await _spawned_session(_golden("transaction.completed")),
        await _spawned_session(_golden("search.match")),
    ]
    assert len(set(sessions)) == 4, f"distinct-keyed wakes collapsed: {sessions}"
    assert all(s.startswith(_KLODI_NS) for s in sessions), sessions


_REPRESENTATIVE = [
    ("channel.opened", False),
    ("channel.message", True),
    ("channel.closed", False),
    ("offer.proposed", False),
    ("offer.accepted", False),
    ("comment.created", False),
    ("listing.created", False),
    ("listing.sold", False),
    ("transaction.completed", False),
    ("transaction.cancelled", False),
    ("search.match", False),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,channel_msg", _REPRESENTATIVE)
async def test_no_wake_runs_in_the_shared_klodi_wake_session(
    kind: str, channel_msg: bool
) -> None:
    """AC-5 (precise): every wake is namespaced under ``klodi:`` AND the
    retired shared session literal ``klodi-wake`` (hyphen) appears nowhere
    in the session — the colon namespace and the hyphen shared-session
    string are distinct, so a namespaced key cannot satisfy this by
    accident."""
    session = await _spawned_session(_golden(kind), channel_msg=channel_msg)
    assert session.startswith(_KLODI_NS), f"{kind} session not namespaced: {session}"
    assert session != "klodi-wake"
    assert "klodi-wake" not in session, (
        f"{kind} leaked the retired shared-session literal: {session}"
    )


# ── AC-6: missing key field -> ephemeral fallback, never shared ───────


@pytest.mark.asyncio
async def test_missing_key_field_falls_back_to_namespaced_ephemeral() -> None:
    """AC-6: a wake whose key field is absent (but event_id present) falls
    back to a per-wake ephemeral ``klodi:wake-<event_id>`` session —
    bounded to that one wake."""
    event = {"kind": "channel.opened", "event_id": "evt-orphan", "buyer_handle": "x"}
    assert await _spawned_session(event) == f"{_KLODI_NS}wake-evt-orphan"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "event",
    [
        {"kind": "channel.opened", "event_id": "e1"},
        {"kind": "offer.proposed", "event_id": "e2"},
        {"kind": "transaction.completed", "event_id": "e3"},
        {"kind": "search.match", "event_id": "e4"},
    ],
)
async def test_missing_key_never_collapses_to_a_shared_session(
    event: dict[str, Any],
) -> None:
    """AC-6 (adversarial): for any kind missing its key field, the fallback
    is ephemeral and per-wake — namespaced, never the shared session, never
    a cross-wake constant."""
    session = await _spawned_session(event)
    assert session == f"{_KLODI_NS}wake-{event['event_id']}"
    assert session != "klodi-wake"
    assert "klodi-wake" not in session


@pytest.mark.asyncio
async def test_no_id_event_falls_back_to_unique_uuid_ephemeral() -> None:
    """AC-6 (no-id edge): when BOTH the key field and event_id are absent,
    the fallback must be a UNIQUE per-wake ``klodi:wake-<uuid4>`` — never a
    constant like ``klodi:wake-`` (which would re-collapse every no-id wake
    into one shared, growing session)."""
    event = {"kind": "channel.opened"}  # no domain id, no event_id
    s1 = await _spawned_session(dict(event))
    s2 = await _spawned_session(dict(event))

    assert s1 != s2, "two no-id wakes must each get a UNIQUE ephemeral session"
    prefix = f"{_KLODI_NS}wake-"
    for s in (s1, s2):
        assert s.startswith(prefix), f"no-id fallback not namespaced: {s}"
        suffix = s[len(prefix):]
        parsed = uuid.UUID(suffix)  # raises if not a UUID at all
        assert parsed.version == 4, f"ephemeral suffix is not a uuid4: {suffix}"
        assert "klodi-wake" not in s


# ── AC-7: terminal events issue the session-drain call (integration) ──


class _RecordingDrainCtx:
    """Records inject + drain calls. ``inject_message`` succeeds (returns
    ``None``); ``drain_session`` records the session it was asked to drain.

    Mirrors the real ctx contract: ``inject_message(text, role, *, session)``
    and ``drain_session(session)``.
    """

    def __init__(self) -> None:
        self.injected_sessions: list[str] = []
        self.drained: list[str] = []

    def inject_message(
        self, text: str, role: str = "system", *, session: str = ""
    ) -> None:
        self.injected_sessions.append(session)

    def drain_session(self, session: str) -> None:
        self.drained.append(session)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kind,key_field",
    [
        ("channel.closed", "channel_id"),
        ("listing.sold", "listing_id"),
        ("listing.withdrawn", "listing_id"),
        ("listing.expired", "listing_id"),
        ("transaction.completed", "transaction_id"),
        ("transaction.cancelled", "transaction_id"),
    ],
)
async def test_terminal_event_issues_drain_at_dispatch_ack_seam(
    kind: str, key_field: str
) -> None:
    """AC-7 (integration): a terminal domain event, dispatched through the
    consumer's ``_dispatch_message`` seam, issues the session-drain call for
    its NAMESPACED session key — and the message still ACKs (never NAKs).
    Hermes actually reclaiming the session is probe-gated; here we assert
    the CALL, not the reclamation."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    ctx = _RecordingDrainCtx()
    wake_handlers.bind_ctx(ctx)
    event = _golden(kind)
    msg = _make_msg(event)
    errors: list[BaseException] = []

    await _dispatch_message(
        msg, _EventIdLru(), wake_handlers.handle_notification, errors.append
    )

    assert ctx.drained == [f"{_KLODI_NS}{event[key_field]}"], (
        f"{kind} must drain its klodi:{key_field} session at the terminal seam"
    )
    assert msg.ack.await_count == 1
    assert msg.nak.await_count == 0
    assert errors == []


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["channel.opened", "offer.proposed", "listing.created"])
async def test_non_terminal_event_does_not_drain(kind: str) -> None:
    """AC-7 (guard): a non-terminal event must NOT drain its session — the
    conversation is still live."""
    from klodi_nats_client.consumers import _EventIdLru, _dispatch_message

    ctx = _RecordingDrainCtx()
    wake_handlers.bind_ctx(ctx)
    msg = _make_msg(_golden(kind))

    await _dispatch_message(
        msg, _EventIdLru(), wake_handlers.handle_notification, lambda _e: None
    )

    assert ctx.drained == []
    assert msg.ack.await_count == 1


@pytest.mark.asyncio
async def test_terminal_event_without_drain_capable_ctx_does_not_raise() -> None:
    """AC-7 (best-effort contract): the drain call is best-effort. A ctx
    that exposes no ``drain_session`` must not crash the handler on a
    terminal event (same getattr-guard convention as ``inject_message``)."""

    class _InjectOnlyCtx:
        def inject_message(
            self, text: str, role: str = "system", *, session: str = ""
        ) -> None:
            return None

    wake_handlers.bind_ctx(_InjectOnlyCtx())
    # Must not raise even though there is no drain_session on the ctx.
    await wake_handlers.handle_notification(_golden("channel.closed"))


# ── AC-8: ADR-0019 disposition preserved; alarm carries the namespaced key ─


@pytest.mark.asyncio
async def test_deterministic_failure_preserves_adr0019_and_carries_session(
    caplog: Any,
) -> None:
    """AC-8: the session change must NOT regress ADR-0019 failure
    classification. A deterministic nonzero exit still surfaces the
    ``wake_inject_deterministic_failure`` ERROR alarm carrying exit /
    stdout / kind / event_id — and the alarm now ALSO carries the resolved
    NAMESPACED session key (``klodi:<listing_id>``) for correlation."""
    runner = _RecordingRunner(
        returncode=2,
        stdout="hermes: could not open session",  # does NOT contain the key
        stderr="",
    )
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    wake_handlers.bind_ctx(ctx)
    event = _golden("offer.proposed")  # session key = klodi:<listing_id>

    with caplog.at_level("ERROR", logger="klodi_hermes.wake"):
        await wake_handlers.handle_notification(event)

    alarms = [
        r
        for r in caplog.records
        if r.levelname == "ERROR"
        and "wake_inject_deterministic_failure" in r.message
    ]
    assert len(alarms) == 1, "exactly one deterministic-failure alarm expected"
    msg = alarms[0].message
    assert f"{_KLODI_NS}{event['listing_id']}" in msg, (
        "alarm must carry the resolved NAMESPACED session key"
    )
    assert event["event_id"] in msg, "alarm must stay correlated by event_id"
    assert "offer.proposed" in msg, "alarm must stay correlated by kind"
    assert "could not open session" in msg, "stdout must still reach the alarm (Bug-1)"
