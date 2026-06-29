"""RED spec — the env keystone: the inbound wake-session key IS the outbound
correlation key, threaded to the tool via the spawn env.

Card: ``wake-outbound-roundtrip-message-and-correlation`` (In-Dev TDD step 4).

``klodi_message_user`` runs INSIDE the ``hermes chat --session klodi:<key>``
subprocess the bridge spawns for each isolated wake turn. To key the
pending-decision by the SAME id the wake turn runs under — deterministically,
not via an LLM-supplied argument — the bridge (the only site that already
computes the per-wake key for ``--session``) also sets
``KLODI_WAKE_ENTITY_ID`` / ``_TYPE`` / ``_EVENT_ID`` on the spawn env. The
tool reads ``os.environ`` and keys off it.

The binding these tests lock:

    "klodi:" + env["KLODI_WAKE_ENTITY_ID"]  ==  the spawned --session

i.e. the bare entity id in the env is exactly the wake-session key without
its ``klodi:`` namespace prefix. That is the whole point of the round-trip:
the outbound correlation key and the inbound wake-session key are the same id.

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


def _session_arg(cmd: list[str]) -> str:
    assert "--session" in cmd, f"argv missing --session: {cmd}"
    return cmd[cmd.index("--session") + 1]


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

    session = _session_arg(cmd)
    assert session == f"{_KLODI_NS}{event[key_field]}"
    # The keystone equality.
    assert f"{_KLODI_NS}{env['KLODI_WAKE_ENTITY_ID']}" == session, (
        "env entity id must equal the wake-session key minus the klodi: prefix"
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
    session = _session_arg(cmd)
    assert session == f"{_KLODI_NS}{event['channel_id']}"
    assert env["KLODI_WAKE_ENTITY_ID"] == str(event["channel_id"])
    assert env["KLODI_WAKE_ENTITY_TYPE"] == "channel"
