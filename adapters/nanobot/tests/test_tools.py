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
    fake = _make_fake_client()
    fake.request.side_effect = KlodiRequestError({
        "error": "VALIDATION_FAILED",
        "message": "bad",
    })
    client.set_client(fake)

    raw = await tools.handle("klodi_whoami", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_unknown_tool() -> None:
    client.set_client(_make_fake_client())
    raw = await tools.handle("klodi_nope", {})
    parsed = json.loads(raw)
    assert parsed["error"] == "UNKNOWN_TOOL"


@pytest.mark.asyncio
async def test_handle_returns_envelope_on_missing_channel_field() -> None:
    client.set_client(_make_fake_client())
    raw = await tools.handle("klodi_channel_message", {"channel_id": "x"})
    parsed = json.loads(raw)
    assert parsed["error"] == "INVALID_REQUEST"
