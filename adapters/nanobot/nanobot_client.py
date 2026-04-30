"""Process-wide KlodiClient singleton for the nanobot adapter.

nanobot tool wrappers and the daemon both reach through this module
to get the same ``KlodiClient`` instance. The daemon owns connection
lifecycle (:func:`nanobot_daemon._run` opens at startup, drains on
stop); tool calls reuse the live connection.

If the daemon is not running, calling ``get_client()`` still returns a
configured client — the first ``request(...)`` will lazily connect. In
that mode wakes are silently dropped because nothing is subscribed to
the channels / notifications consumers — the daemon is expected to be
the long-running owner.
"""

from __future__ import annotations

import logging
from typing import Any

from klodi_nats_client import KlodiClient, default_klodi_home

log = logging.getLogger("klodi_nanobot.client")

_CLIENT: KlodiClient | None = None


def _on_client_error(err: BaseException, context: dict[str, Any]) -> None:
    log.warning(
        "klodi_client_error error=%s context=%s",
        str(err),
        context,
    )


def get_client() -> KlodiClient:
    """Return the singleton, creating it if necessary."""
    global _CLIENT
    if _CLIENT is None:
        klodi_home = default_klodi_home()
        _CLIENT = KlodiClient(
            creds_path=str(klodi_home / "nats.creds"),
            config_path=str(klodi_home / "config.json"),
            on_error=_on_client_error,
        )
    return _CLIENT


def set_client(client: KlodiClient) -> None:
    """Override the singleton — used by the daemon so its long-running
    connection is shared with tool calls in the same process."""
    global _CLIENT
    _CLIENT = client


def is_client_connected() -> bool:
    return _CLIENT is not None and _CLIENT.is_connected


__all__ = ["get_client", "is_client_connected", "set_client"]
