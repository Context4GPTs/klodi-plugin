"""Tests for the nats-py WebSocketTransport.readline monkey-patch.

The bug: under nats-py 2.14.0, any non-binary frame (CLOSE, PING,
ERROR, CLOSING) the aiohttp WS surfaces gets returned as-is from
``readline``, then ``self.buf.extend(data)`` crashes because ``data``
is an int / None / Exception. The read loop catches generically and
breaks the connection — under field conditions, the wake pump's
long-lived JetStream consumers die on the first close/keepalive frame.

The patch swaps in a readline that:
  * Treats CLOSED / CLOSING / CLOSE as EOF (returns b"")
  * Raises ERROR's exception payload for the read loop to route
  * Skips PING/PONG (aiohttp auto-handles PING but still surfaces it)
  * Pass through BINARY / TEXT data unchanged
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import aiohttp
import pytest

from klodi_nats_client._ws_transport_patch import apply_patch


def _ws_msg(msg_type: aiohttp.WSMsgType, data: Any) -> Any:
    """Build a fake WSMessage that quacks like aiohttp's NamedTuple.

    The patch only reads ``msg.type`` and ``msg.data`` so a
    SimpleNamespace is sufficient and cheaper than constructing the
    real NamedTuple.
    """
    return SimpleNamespace(type=msg_type, data=data, extra=None)


def _make_transport_with_frames(*frames: Any) -> Any:
    """Apply the patch and instantiate a real WebSocketTransport with
    its ``_ws`` swapped for an AsyncMock that yields the scripted
    frames in order. Returns the transport.
    """
    apply_patch()
    from nats.aio.transport import WebSocketTransport

    transport = WebSocketTransport.__new__(WebSocketTransport)
    ws = MagicMock()
    ws.receive = AsyncMock(side_effect=list(frames))
    transport._ws = ws
    return transport


def test_apply_patch_is_idempotent() -> None:
    """Re-applying the patch must not chain replacements or fail."""
    apply_patch()
    from nats.aio.transport import WebSocketTransport

    first = WebSocketTransport.readline
    apply_patch()
    second = WebSocketTransport.readline
    assert first is second


def test_binary_frame_passes_through() -> None:
    """Production case — binary payload reaches the parser unchanged."""
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.BINARY, b"PING\r\n"),
    )
    result = asyncio.run(transport.readline())
    assert result == b"PING\r\n"


def test_text_frame_passes_through() -> None:
    """Some servers send protocol frames as TEXT — preserve current shape."""
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.TEXT, "INFO {}\r\n"),
    )
    result = asyncio.run(transport.readline())
    assert result == "INFO {}\r\n"


def test_close_frame_returns_eof_not_int() -> None:
    """The exact bug from the report — CLOSE has data=int (close code).

    Without the patch this returned `1000` (the close code) and the
    NATS parser tried ``self.buf.extend(1000)`` → TypeError.
    """
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.CLOSE, 1000),
    )
    result = asyncio.run(transport.readline())
    assert result == b""


def test_closing_frame_returns_eof() -> None:
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.CLOSING, None),
    )
    result = asyncio.run(transport.readline())
    assert result == b""


def test_closed_frame_returns_eof() -> None:
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.CLOSED, None),
    )
    result = asyncio.run(transport.readline())
    assert result == b""


def test_error_frame_raises_attached_exception() -> None:
    """ERROR carries the exception in ``data`` — surface it so the
    NATS read loop's error handler runs (vs. parsing garbage)."""
    boom = ConnectionResetError("edge reset")
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.ERROR, boom),
    )
    with pytest.raises(ConnectionResetError, match="edge reset"):
        asyncio.run(transport.readline())


def test_ping_frame_skipped_then_next_returned() -> None:
    """PING is not a NATS frame — skip and return the next real frame.

    aiohttp auto-replies to PING with PONG before yielding the frame
    to the consumer; the patch defensively skips anyway.
    """
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.PING, b""),
        _ws_msg(aiohttp.WSMsgType.BINARY, b"+OK\r\n"),
    )
    result = asyncio.run(transport.readline())
    assert result == b"+OK\r\n"


def test_pong_frame_skipped_then_next_returned() -> None:
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.PONG, b""),
        _ws_msg(aiohttp.WSMsgType.BINARY, b"+OK\r\n"),
    )
    result = asyncio.run(transport.readline())
    assert result == b"+OK\r\n"


def test_ping_then_close_returns_eof() -> None:
    """Real-world close sequence — peer pings, then closes."""
    transport = _make_transport_with_frames(
        _ws_msg(aiohttp.WSMsgType.PING, b""),
        _ws_msg(aiohttp.WSMsgType.CLOSE, 1000),
    )
    result = asyncio.run(transport.readline())
    assert result == b""
