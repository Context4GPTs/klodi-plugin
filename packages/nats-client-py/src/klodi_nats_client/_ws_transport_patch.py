"""Monkey-patch for nats-py 2.14.x ``WebSocketTransport.readline``.

Upstream's ``readline`` only special-cases ``WSMsgType.CLOSED`` and
returns ``msg.data`` for everything else. ``aiohttp`` types ``msg.data``
differently per frame:

  ====================  =================================================
  ``WSMsgType``         ``msg.data``
  ====================  =================================================
  ``BINARY``            ``bytes``
  ``TEXT``              ``str``
  ``PING``              ``bytes``
  ``PONG``              ``bytes``
  ``CLOSE``             ``int``  (the close code, e.g. 1000)
  ``CLOSING``           ``None``
  ``ERROR``             the exception instance
  ``CLOSED``            ``None``
  ====================  =================================================

The downstream consumer is ``nats.protocol.parser:parse`` which calls
``self.buf.extend(data)``. ``bytearray.extend(<int>)`` raises
``TypeError: can't extend bytearray with int`` — and the read loop
catches generic ``Exception`` and breaks the connection. The result
under field conditions: every long-lived consumer (the wake pump's
JetStream subscriptions) dies on the first close / ping frame from
the edge.

This patch swaps in a ``readline`` that ignores PING/PONG, surfaces
ERROR as a raise, and treats CLOSE/CLOSING/CLOSED as EOF.

Patch is idempotent — re-applying is a no-op (sentinel attribute on
the patched callable).
"""

from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("klodi_nats_client.ws_patch")

_PATCH_SENTINEL = "_klodi_ws_readline_patched"


async def _patched_readline(self: Any) -> bytes:
    """Drop-in replacement for ``WebSocketTransport.readline``.

    Returns ``b""`` on CLOSE / CLOSING / CLOSED so the caller sees an
    EOF (the same shape upstream's CLOSED branch produced). Raises the
    exception attached to ERROR frames so the NATS read loop can route
    it through its own error path. Skips PING/PONG since aiohttp
    auto-handles PING but still surfaces the frame to subclasses; the
    NATS parser would crash on the bytes payload.
    """
    import aiohttp

    while True:
        msg = await self._ws.receive()
        msg_type = msg.type
        if msg_type in (
            aiohttp.WSMsgType.CLOSED,
            aiohttp.WSMsgType.CLOSING,
            aiohttp.WSMsgType.CLOSE,
        ):
            return b""
        if msg_type == aiohttp.WSMsgType.ERROR:
            err = msg.data
            if isinstance(err, BaseException):
                raise err
            raise RuntimeError(f"nats ws transport error: {err!r}")
        if msg_type in (aiohttp.WSMsgType.PING, aiohttp.WSMsgType.PONG):
            continue
        return msg.data


def apply_patch() -> None:
    """Replace ``nats.aio.transport.WebSocketTransport.readline`` with
    the close/ping-safe version. Idempotent.

    Safe to call before any client connect; the patch is on the class,
    not an instance.
    """
    from nats.aio.transport import WebSocketTransport

    if getattr(WebSocketTransport.readline, _PATCH_SENTINEL, False):
        return
    setattr(_patched_readline, _PATCH_SENTINEL, True)
    WebSocketTransport.readline = _patched_readline
    log.info("ws_transport_patch_applied target=nats.aio.transport.WebSocketTransport.readline")


__all__ = ["apply_patch"]
