"""Hermes adapter wiring for the shared ``WakePump``.

Mirrors ``klodi-plugin/adapters/openclaw/src/service/wake-pump.ts``: the
adapter holds a process-wide pump reference for ``klodi_setup_status`` /
``klodi_setup_repair`` to consult and dispose. Subscribe ownership lives
in ``klodi_nats_client.WakePump`` so the host SDK has no role in wake
delivery.
"""

from __future__ import annotations

import logging
from typing import Any

from klodi_nats_client import WakePump, create_wake_pump, load_config

from .client import connect_client, get_client, run_async
from .local_tools import _config_path
from .wake_handlers import handle_channel_message, handle_notification

log = logging.getLogger("klodi_hermes.wake_pump")

_pump: WakePump | None = None


def get_wake_pump() -> WakePump | None:
    return _pump


def start_wake_pump() -> WakePump:
    """Boot the pump against the on-disk creds.

    Idempotent — re-call returns the existing instance. Caller is
    responsible for confirming creds exist; throws on missing config.
    """
    global _pump
    if _pump is not None:
        return _pump
    connect_client()
    client = get_client()
    config = load_config(str(_config_path()))
    pump = create_wake_pump(
        client,
        config.user_id,
        handle_notification,
        handle_channel_message,
    )
    run_async(pump.start())
    _pump = pump
    log.info(
        "wake_pump_started user_id=%s handle=%s",
        config.user_id,
        config.handle,
    )
    return pump


def stop_wake_pump() -> None:
    """Drain the pump and clear the local reference. Idempotent."""
    global _pump
    if _pump is None:
        return
    current = _pump
    _pump = None
    try:
        run_async(current.stop())
        log.info("wake_pump_stopped")
    except BaseException as err:  # noqa: BLE001 — best-effort
        log.warning("wake_pump_stop_failed error=%s", err)


def wake_pump_status() -> dict[str, Any]:
    """Snapshot for ``klodi_setup_status``. Returns ``running: false``
    when no pump exists in this process.
    """
    if _pump is None:
        return {
            "running": False,
            "user_id": None,
            "notifications_last_event_at": None,
            "channels_last_event_at": None,
        }
    health = _pump.health()
    return {
        "running": health.running,
        "user_id": health.user_id,
        "notifications_last_event_at": (
            health.notifications_last_event_at.isoformat()
            if health.notifications_last_event_at is not None
            else None
        ),
        "channels_last_event_at": (
            health.channels_last_event_at.isoformat()
            if health.channels_last_event_at is not None
            else None
        ),
    }


__all__ = [
    "get_wake_pump",
    "start_wake_pump",
    "stop_wake_pump",
    "wake_pump_status",
]
