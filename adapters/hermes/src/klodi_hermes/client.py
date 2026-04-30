"""Process-wide KlodiClient singleton for the Hermes adapter.

Mirrors ``klodi-plugin/adapters/openclaw/src/lib/client.ts``: a single
``KlodiClient`` instance lives for the lifetime of the Hermes daemon.
Tools fetch it via :func:`get_client` and call ``client.request(...)``.

Connection lifecycle (per 0012 § Lifecycle):

  * Open on plugin load (the Hermes daemon is long-running, so the
    connection's lifetime IS the daemon's).
  * Close on plugin unload — best-effort drain.

The Hermes daemon does not expose an explicit lifecycle hook, so we
open the connection lazily on the first ``client.request(...)`` and
keep it alive thereafter. ``connect_client`` is called explicitly from
``register(ctx)`` to bring the wake subscriptions up immediately so
queued events aren't deferred to the first tool call.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any

from klodi_nats_client import KlodiClient

from .local_tools import _config_path, _creds_path

log = logging.getLogger("klodi_hermes.client")


_CLIENT: KlodiClient | None = None
_LOOP: asyncio.AbstractEventLoop | None = None
_LOOP_THREAD: threading.Thread | None = None
_LOCK = threading.Lock()


def _ensure_loop() -> asyncio.AbstractEventLoop:
    """Run the asyncio loop on a dedicated thread.

    Hermes plugin handlers are synchronous (``is_async=False`` is the
    norm — see ``register.py``'s ``ctx.register_tool`` calls), but the
    NATS client is async. We park a loop on a daemon thread and submit
    coroutines to it via ``run_coroutine_threadsafe``. This is the
    canonical pattern for bridging sync ↔ async without inheriting any
    framework's loop ownership.
    """
    global _LOOP, _LOOP_THREAD
    with _LOCK:
        if _LOOP is not None and _LOOP.is_running():
            return _LOOP
        ready = threading.Event()
        loop_holder: dict[str, Any] = {}

        def _run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            loop_holder["loop"] = loop
            ready.set()
            try:
                loop.run_forever()
            finally:
                loop.close()

        thread = threading.Thread(
            target=_run,
            name="klodi-asyncio",
            daemon=True,
        )
        thread.start()
        ready.wait(timeout=10.0)
        loop = loop_holder.get("loop")
        if loop is None:
            raise RuntimeError(
                "klodi_hermes.client: failed to start asyncio loop thread"
            )
        _LOOP = loop
        _LOOP_THREAD = thread
        return _LOOP


def _on_client_error(err: BaseException, context: dict[str, Any]) -> None:
    log.warning(
        "klodi_client_error error=%s context=%s",
        str(err),
        context,
    )


def get_client() -> KlodiClient:
    """Return the singleton, creating it if necessary.

    Connection is NOT opened here — call :func:`connect_client` (or let
    the first ``request(...)`` open it lazily). Tool handlers should
    call this and rely on lazy connect.
    """
    global _CLIENT
    with _LOCK:
        if _CLIENT is None:
            _CLIENT = KlodiClient(
                creds_path=str(_creds_path()),
                config_path=str(_config_path()),
                on_error=_on_client_error,
            )
        return _CLIENT


def run_async(coro: Any) -> Any:
    """Submit a coroutine to the dedicated loop and block on the result.

    Hermes tool handlers are synchronous, so they bridge through this.
    ``timeout`` is intentionally absent — each NATS call already has
    its own timeout, and adding a wrapper here would just hide the
    upstream error message.
    """
    loop = _ensure_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result()


def connect_client() -> None:
    """Open the NATS-WS connection on the dedicated loop.

    Idempotent — repeated calls return immediately. Call from
    ``register(ctx)`` so wake subscriptions are live before the first
    tool call.
    """
    client = get_client()
    run_async(client.connect())


def close_client() -> None:
    """Drain and clear the singleton. Used on plugin unload."""
    global _CLIENT, _LOOP, _LOOP_THREAD
    with _LOCK:
        client = _CLIENT
        loop = _LOOP
    if client is None:
        return
    try:
        run_async(client.close())
    except BaseException as err:  # noqa: BLE001 — best-effort
        log.warning("klodi_client_close_failed error=%s", err)
    if loop is not None and loop.is_running():
        loop.call_soon_threadsafe(loop.stop)
    with _LOCK:
        _CLIENT = None
        _LOOP = None
        _LOOP_THREAD = None


__all__ = [
    "close_client",
    "connect_client",
    "get_client",
    "run_async",
]
