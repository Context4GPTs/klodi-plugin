"""Unit tests for the nanobot adapter's tool surface.

Covers:
  * ``call_tool`` resolves the right NATS subject from the catalog.
  * ``publish_channel_message`` validates input + delegates to the
    KlodiClient.
  * ``handle`` returns JSON envelopes for the success and error paths
    (the nanobot tool decorator wants string output).
  * ``TOOL_DEFINITIONS`` includes ``klodi_channel_message`` and
    excludes the deleted ``klodi_channel_send``.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

import nanobot_client as client
import nanobot_tools as tools
from klodi_nats_client import KlodiRequestError


def _make_fake_client() -> Any:
    fake = MagicMock()
    fake.request = AsyncMock()
    fake.publish_channel_message = AsyncMock()
    return fake


@pytest.fixture(autouse=True)
def _reset_singleton() -> None:
    """Wipe the module-level KlodiClient between tests."""
    client._CLIENT = None  # type: ignore[attr-defined]


@pytest.fixture(autouse=True)
def _klodi_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Point ``${KLODI_HOME}`` at a temp dir with creds + config files so
    the pre-call guard chain (`guard_creds`, ADR-0011 R4) passes through
    to the production dispatch path under test. Tests that want to
    exercise the `not_registered` guard rejection get their own fixture.
    """
    monkeypatch.setenv("KLODI_HOME", str(tmp_path))
    (tmp_path / "nats.creds").write_text("fake-creds")
    (tmp_path / "config.json").write_text("{}")
    return tmp_path


# ── TOOL_DEFINITIONS shape ────────────────────────────────────────────


def test_definitions_include_channel_message() -> None:
    names = {t["name"] for t in tools.TOOL_DEFINITIONS}
    assert "klodi_channel_message" in names
    assert "klodi_whoami" in names


def test_definitions_exclude_deleted_channel_send() -> None:
    names = {t["name"] for t in tools.TOOL_DEFINITIONS}
    assert "klodi_channel_send" not in names


def test_definitions_carry_openai_function_shape() -> None:
    for entry in tools.TOOL_DEFINITIONS:
        assert "name" in entry
        assert "description" in entry
        assert "parameters" in entry
        assert entry["parameters"]["type"] == "object"


# ── call_tool ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_call_tool_routes_to_catalog_subject() -> None:
    fake = _make_fake_client()
    fake.request.return_value = {"ok": True}
    client.set_client(fake)

    result = await tools.call_tool("klodi_whoami", {})

    assert result == {"ok": True}
    fake.request.assert_awaited_once()
    args = fake.request.await_args
    assert args.args[0] == "p2p.v1.users.whoami"
    assert args.args[1] == {}


@pytest.mark.asyncio
async def test_call_tool_raises_keyerror_for_unknown() -> None:
    client.set_client(_make_fake_client())
    with pytest.raises(KeyError):
        await tools.call_tool("klodi_does_not_exist", {})


@pytest.mark.asyncio
async def test_call_tool_for_deleted_channel_send_raises_key_error() -> None:
    """``klodi_channel_send`` was removed from the catalog in 0012; it
    must surface as an unknown tool, not be silently routed."""
    client.set_client(_make_fake_client())
    with pytest.raises(KeyError):
        await tools.call_tool("klodi_channel_send", {})


# ── publish_channel_message ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_publish_channel_message_calls_client() -> None:
    fake = _make_fake_client()
    fake.publish_channel_message.return_value = {"sequence": 7}
    client.set_client(fake)

    result = await tools.publish_channel_message("ch-1", "Hi there")

    assert result == {"sequence": 7}
    fake.publish_channel_message.assert_awaited_once_with(
        "ch-1", {"content": "Hi there"}
    )


@pytest.mark.asyncio
async def test_publish_channel_message_rejects_empty_content() -> None:
    client.set_client(_make_fake_client())
    with pytest.raises(ValueError):
        await tools.publish_channel_message("ch", "")


@pytest.mark.asyncio
async def test_publish_channel_message_rejects_empty_channel() -> None:
    client.set_client(_make_fake_client())
    with pytest.raises(ValueError):
        await tools.publish_channel_message("", "x")


# ── handle ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_handle_routes_channel_message_to_publish() -> None:
    fake = _make_fake_client()
    fake.publish_channel_message.return_value = {"sequence": 1}
    client.set_client(fake)

    raw = await tools.handle(
        "klodi_channel_message",
        {"channel_id": "ch-1", "content": "yo"},
    )
    assert json.loads(raw) == {"sequence": 1}


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_request_error() -> None:
    # Round 2 P2.1 — marketplace codes collapse to the R2 catch-all
    # `marketplace_error`; the server's original code rides in
    # details.marketplace_error_code.
    fake = _make_fake_client()
    fake.request.side_effect = KlodiRequestError({
        "error": "VALIDATION_FAILED",
        "message": "bad",
    })
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "marketplace_error"
    assert parsed["details"]["marketplace_error_code"] == "VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_unknown_tool() -> None:
    # An unknown tool name lands in the catch-all `internal_error` arm —
    # the dispatcher no longer special-cases an `UNKNOWN_TOOL` code per
    # the closed R2 vocabulary (ADR-0011). The shape is the canonical
    # four-key envelope; the agent reads `error` + `details`.
    client.set_client(_make_fake_client())
    raw = await tools.handle("klodi_nope", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert set(parsed.keys()) == {"error", "message", "details", "recovery_hint"}


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_missing_channel_field() -> None:
    # Missing required field surfaces as the canonical R2
    # `invalid_request` envelope; `details.field` names the offending
    # arg and `details.problem` carries the reason. See ADR-0011.
    client.set_client(_make_fake_client())
    raw = await tools.handle("klodi_channel_message", {"channel_id": "x"})
    parsed = json.loads(raw)
    assert parsed["error"] == "invalid_request"
    assert parsed["details"] == {"field": "content", "problem": "missing"}
    assert parsed["recovery_hint"] is None


# ── Round 2 RED — P1.2 + P1.3 — dispatch-path contract ──────────────


@pytest.fixture
def _klodi_home_unset(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> Path:
    """Point ``${KLODI_HOME}`` at an EMPTY temp dir so the creds guard
    fires on every dispatch. Overrides the autouse `_klodi_home`
    fixture above (which writes creds + config into the shared
    `tmp_path`); we allocate a fresh empty dir via `tmp_path_factory`."""
    fresh = tmp_path_factory.mktemp("empty-klodi-home")
    monkeypatch.setenv("KLODI_HOME", str(fresh))
    return fresh


@pytest.mark.asyncio
async def test_handle_passthrough_without_creds_returns_not_registered(
    _klodi_home_unset: Path,
) -> None:
    """P1.2 + R4 + R8 — when creds are missing, the dispatcher MUST
    short-circuit BEFORE invoking `call_tool` (which touches the
    client). The agent sees `not_registered` with the per-host CLI in
    the recovery hint.

    Side-effect freedom: the client should NEVER receive a `request()`
    call when creds are absent. We pre-register a panic-on-call fake
    client to verify.
    """
    panic_client = MagicMock()
    panic_client.request = AsyncMock(
        side_effect=AssertionError(
            "guard_creds MUST short-circuit BEFORE call_tool() reaches client.request"
        ),
    )
    client.set_client(panic_client)

    raw = await tools.handle("klodi_whoami", {})

    parsed = json.loads(raw)
    assert parsed["error"] == "not_registered"
    assert parsed["recovery_hint"]["kind"] == "cli"
    # R8 — per-host CLI verbatim.
    assert parsed["recovery_hint"]["command"] == "klodi-nanobot-register"
    panic_client.request.assert_not_called()


@pytest.mark.asyncio
async def test_handle_channel_message_without_creds_returns_not_registered(
    _klodi_home_unset: Path,
) -> None:
    """P1.2 + R4 + R8 — the channel-message direct-publish path also
    fails behind the creds guard before any I/O."""
    panic_client = MagicMock()
    panic_client.publish_channel_message = AsyncMock(
        side_effect=AssertionError(
            "guard_creds MUST short-circuit BEFORE publish_channel_message is called"
        ),
    )
    client.set_client(panic_client)

    raw = await tools.handle(
        "klodi_channel_message",
        {"channel_id": "ch-1", "content": "hi"},
    )

    parsed = json.loads(raw)
    assert parsed["error"] == "not_registered"
    assert parsed["recovery_hint"]["kind"] == "cli"
    assert parsed["recovery_hint"]["command"] == "klodi-nanobot-register"
    panic_client.publish_channel_message.assert_not_called()


@pytest.mark.asyncio
async def test_handle_passthrough_runtime_error_returns_internal_error_not_connection() -> None:
    """P1.3 — a non-connection exception (e.g. `RuntimeError` from a
    future code path) MUST route to `internal_error`. The round-1 bug
    collapsed everything in the `except BaseException` arm to
    `connection_not_ready`, pointing agents at an unrelated recovery.
    """
    fake = _make_fake_client()
    fake.request.side_effect = RuntimeError("dispatcher bug")
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error", (
        "non-connection exceptions MUST route to `internal_error`, NOT "
        "`connection_not_ready` (P1.3)"
    )
    assert parsed["details"]["exception_class"] == "RuntimeError"
    assert parsed["recovery_hint"] is None


@pytest.mark.asyncio
async def test_handle_passthrough_value_error_returns_internal_error() -> None:
    """P1.3 — `ValueError` (data validation, not transport) routes to
    `internal_error`."""
    fake = _make_fake_client()
    fake.request.side_effect = ValueError("malformed payload")
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error"
    assert parsed["details"]["exception_class"] == "ValueError"


@pytest.mark.asyncio
async def test_handle_passthrough_connection_error_returns_connection_not_ready() -> None:
    """Transport errors (`ConnectionError`) continue to map to
    `connection_not_ready` with the `klodi_setup_status` recovery hint."""
    fake = _make_fake_client()
    fake.request.side_effect = ConnectionError("WS dropped")
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"
    hint = parsed["recovery_hint"]
    assert hint["kind"] == "tool"
    assert hint["tool"] == "klodi_setup_status"


@pytest.mark.asyncio
async def test_handle_passthrough_asyncio_timeout_returns_connection_not_ready() -> None:
    """`asyncio.TimeoutError` is a transport-state error → maps to
    `connection_not_ready`."""
    fake = _make_fake_client()
    fake.request.side_effect = asyncio.TimeoutError()
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"


@pytest.mark.asyncio
async def test_handle_channel_message_runtime_error_returns_internal_error() -> None:
    """P1.3 mirror — non-connection exception in the channel-publish
    path routes to `internal_error`."""
    fake = _make_fake_client()
    fake.publish_channel_message.side_effect = RuntimeError("publish bug")
    client.set_client(fake)

    raw = await tools.handle(
        "klodi_channel_message",
        {"channel_id": "ch-1", "content": "hi"},
    )
    parsed = json.loads(raw)
    assert parsed["error"] == "internal_error", (
        "non-connection exceptions on the channel path MUST route to "
        "`internal_error` (P1.3)"
    )
    assert parsed["details"]["exception_class"] == "RuntimeError"


@pytest.mark.asyncio
async def test_handle_channel_message_connection_error_returns_connection_not_ready() -> None:
    """`ConnectionError` on the channel-publish path → `connection_not_ready`."""
    fake = _make_fake_client()
    fake.publish_channel_message.side_effect = ConnectionError("WS dropped")
    client.set_client(fake)

    raw = await tools.handle(
        "klodi_channel_message",
        {"channel_id": "ch-1", "content": "hi"},
    )
    parsed = json.loads(raw)
    assert parsed["error"] == "connection_not_ready"


@pytest.mark.asyncio
async def test_handle_passthrough_every_internal_error_carries_four_envelope_keys() -> None:
    """R1 — every internal_error envelope carries exactly four keys."""
    fake = _make_fake_client()
    fake.request.side_effect = RuntimeError("boom")
    client.set_client(fake)
    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert set(parsed.keys()) == {"error", "message", "details", "recovery_hint"}
