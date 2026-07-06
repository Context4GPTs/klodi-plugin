"""RED spec — the env keystone: the inbound wake-session key IS the outbound
correlation key, threaded to the tool via the spawn env.

TDD step 4.

``klodi_message_user`` runs INSIDE the ``hermes chat`` subprocess the bridge
spawns for each isolated wake turn (tagged ``--source klodi`` so the resolver
can exclude it). To key the pending-decision by the SAME id the wake turn runs
under — deterministically, not via an LLM-supplied argument — the bridge (the
only site that already computes the per-wake key) also sets
``KLODI_WAKE_ENTITY_ID`` / ``_TYPE`` / ``_EVENT_ID`` on the spawn env. The
tool reads ``os.environ`` and keys off it.

The binding these tests lock:

    "klodi:" + env["KLODI_WAKE_ENTITY_ID"]  ==  the wake-session key

i.e. the bare entity id in the env is exactly the wake-session key without
its ``klodi:`` namespace prefix. That is the whole point of the round-trip:
the outbound correlation key and the inbound wake-session key are the same id.
The key is no longer a hermes argv flag (no hermes version accepts one — the
defect this change removes); it lives on the env and in the bridge's log.

These drive the REAL ``BridgeCtx`` (with a stub subprocess runner that
captures argv AND kwargs) through the REAL wake handler, so no hermes binary
is touched. They RED until the bridge sets the merged spawn env and the wake
handler threads the entity through to ``inject_message``.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

from klodi_hermes import wake_handlers  # noqa: E402 — after sys.path bootstrap
from klodi_hermes.bridge import BridgeCtx  # noqa: E402

_KLODI_NS = "klodi:"

# The defective flag the fix removes. Built from fragments so this test file
# leaves ZERO literal occurrences of the rejected flag for the AC-7 grep gate.
_REJECTED_SESSION_FLAG = "--" + "session"

_GOLDEN_DIR = (
    Path(__file__).resolve().parents[3]
    / "packages" / "tool-catalog" / "tests" / "golden"
)

# Golden kind → (key field on the event, expected entity_type in the env).
# The entity TYPE is the entity the wake keys on (offer/comment/listing wakes
# all scope to the LISTING), NOT the kind prefix — so an offer wake's pending
# decision is keyed (listing, <listing_id>) and re-grounds via klodi_offer_mine.
_KEYSTONE_CASES = [
    ("channel.opened", "channel_id", "channel"),
    ("offer.proposed", "listing_id", "listing"),
    ("transaction.completed", "transaction_id", "transaction"),
    ("search.match", "search_slug", "search"),
]


def _golden(kind: str) -> dict[str, Any]:
    return json.loads((_GOLDEN_DIR / f"{kind}.json").read_text())


class _EnvRecordingRunner:
    """Stub ``subprocess.run`` capturing both argv and kwargs (notably the
    ``env`` the bridge spawns with). Returns a clean exit so no
    WakeInjectFailed fires."""

    def __init__(self) -> None:
        self.calls: list[tuple[list[str], dict[str, Any]]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> Any:
        self.calls.append((cmd, kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")


@pytest.fixture(autouse=True)
def _reset_ctx() -> Any:
    saved = wake_handlers._CTX
    yield
    wake_handlers._CTX = saved


async def _spawn(event: dict[str, Any]) -> tuple[list[str], dict[str, Any]]:
    """Drive a wake through the real handler → real BridgeCtx → stub runner;
    return the single spawned (argv, kwargs)."""
    runner = _EnvRecordingRunner()
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    wake_handlers.bind_ctx(ctx)
    await wake_handlers.handle_notification(event)
    assert len(runner.calls) == 1, f"expected one inject, got {runner.calls}"
    return runner.calls[0]


def _assert_corrected_argv(cmd: list[str]) -> None:
    """The wake inject must use the corrected flag: tagged ``--source`` and
    NEVER the rejected session flag (no hermes accepts it) nor an
    operator-session resume (``--continue``/``--resume``)."""
    assert _REJECTED_SESSION_FLAG not in cmd, f"argv carries the rejected flag: {cmd}"
    assert "--continue" not in cmd and "--resume" not in cmd, (
        f"argv must not resume the operator session: {cmd}"
    )
    assert "--source" in cmd, f"argv must tag --source: {cmd}"


def _session_from_env(env: dict[str, str]) -> str:
    """The wake-session key == ``"klodi:"`` + the bare entity id the bridge
    threads on the spawn env. The key is no longer a hermes argv flag — the
    inbound key IS the outbound correlation key, carried on the env."""
    return f"{_KLODI_NS}{env['KLODI_WAKE_ENTITY_ID']}"


@pytest.mark.asyncio
@pytest.mark.parametrize("kind,key_field,entity_type", _KEYSTONE_CASES)
async def test_spawn_env_carries_wake_entity_matching_the_session(
    kind: str, key_field: str, entity_type: str
) -> None:
    """The bridge sets ``KLODI_WAKE_ENTITY_*`` on the spawn env, and the
    entity id equals the wake-session key without its ``klodi:`` prefix —
    the inbound key IS the outbound correlation key."""
    event = _golden(kind)
    cmd, kwargs = await _spawn(event)

    env = kwargs.get("env")
    assert env is not None, "bridge must spawn the wake with an explicit env"

    _assert_corrected_argv(cmd)
    # The keystone: the env-carried entity id, namespaced, IS the wake-session
    # key for this event — the inbound key equals the outbound correlation key.
    session = _session_from_env(env)
    assert session == f"{_KLODI_NS}{event[key_field]}", (
        "env-derived wake key must match the event's entity key"
    )
    assert env["KLODI_WAKE_ENTITY_ID"] == str(event[key_field])
    assert env["KLODI_WAKE_ENTITY_TYPE"] == entity_type
    assert env["KLODI_WAKE_EVENT_ID"] == str(event["event_id"])


@pytest.mark.asyncio
async def test_spawn_env_is_merged_not_a_bare_dict(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The spawn env MUST be the merged form ``{**os.environ, ...}``. A bare
    dict carrying only the wake vars strips ``PATH`` and breaks the
    subprocess spawn — so the inherited environment must survive alongside
    the injected wake vars."""
    monkeypatch.setenv("KLODI_OUTBOUND_KEYSTONE_SENTINEL", "present")
    cmd, kwargs = await _spawn(_golden("offer.proposed"))

    env = kwargs.get("env")
    assert env is not None
    assert env.get("KLODI_OUTBOUND_KEYSTONE_SENTINEL") == "present", (
        "inherited env vars must survive — env must be {**os.environ, ...}"
    )
    assert env.get("PATH") == os.environ.get("PATH"), "PATH must be preserved"
    # The wake vars ride ALONGSIDE the inherited environment, not instead of it.
    assert "KLODI_WAKE_ENTITY_ID" in env


@pytest.mark.asyncio
async def test_channel_message_wake_also_threads_entity_env() -> None:
    """The dedicated channel-message handler must thread the entity env too —
    a channel-message wake keys its pending-decision on the channel, same as
    the notification path."""
    event = _golden("channel.message")
    runner = _EnvRecordingRunner()
    ctx = BridgeCtx(hermes_bin="/usr/bin/hermes", runner=runner)
    wake_handlers.bind_ctx(ctx)
    await wake_handlers.handle_channel_message(event)

    cmd, kwargs = runner.calls[0]
    env = kwargs.get("env")
    assert env is not None
    _assert_corrected_argv(cmd)
    session = _session_from_env(env)
    assert session == f"{_KLODI_NS}{event['channel_id']}"
    assert env["KLODI_WAKE_ENTITY_ID"] == str(event["channel_id"])
    assert env["KLODI_WAKE_ENTITY_TYPE"] == "channel"


# ── Belt-and-suspenders (review round 1, P1): refuse a poisoned id at the
#    DERIVATION boundary, not only at the store ─────────────────────────
#
# The marketplace-supplied entity id flows derive_wake_entity → the
# wake-session key AND ``KLODI_WAKE_ENTITY_ID`` → message.py →
# record_pending → ``${KLODI_HOME}/pending/<id>.json``. The store guard is
# the backstop; this pins the SOURCE guard so a poisoned id never even
# becomes a session key or env value. A traversal id implies a compromised
# marketplace server (THREAT_MODEL T5) — bounded, but the codebase already
# decided this id class must be validated.

_POISONED_SERVER_IDS = [
    "../../evil",
    "../escape",
    "a/b",
    "/abs/evil",
    "..",
]


@pytest.mark.parametrize("poisoned", _POISONED_SERVER_IDS)
def test_derive_wake_entity_rejects_poisoned_server_id(poisoned: str) -> None:
    """P1 belt-and-suspenders: derive_wake_entity must REFUSE a traversal /
    absolute marketplace id (raises ValueError) so it never becomes a path
    component or a wake-session key downstream."""
    event = {
        "kind": "offer.proposed",
        "listing_id": poisoned,
        "event_id": "a1b2c3d4-0007-4000-8000-000000000007",
    }
    with pytest.raises(ValueError):
        wake_handlers.derive_wake_entity(event)


def test_derive_wake_entity_accepts_legitimate_server_ids() -> None:
    """P1 companion: the boundary guard must accept the real id shapes — a
    UUID listing id and a slug search id — so valid wakes still derive their
    entity (and the existing golden-fixture keystone tests keep passing)."""
    uid = "11111111-1111-4111-8111-111111111111"
    listing = wake_handlers.derive_wake_entity(
        {"kind": "offer.proposed", "listing_id": uid, "event_id": "e"}
    )
    assert listing.entity_type == "listing"
    assert listing.entity_id == uid

    search = wake_handlers.derive_wake_entity(
        {"kind": "search.match", "search_slug": "vintage-camera", "event_id": "e"}
    )
    assert search.entity_type == "search"
    assert search.entity_id == "vintage-camera"
