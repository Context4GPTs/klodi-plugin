"""klodi-nanobot-daemon — long-running NATS-WS connection.

Per 0012, every host adapter holds a persistent NATS-WS connection
that carries both tool calls and wakes. nanobot's plugin lifecycle
exposes long-running event consumers; the natural shape on this side
is a daemon that:

  1. Opens a single ``KlodiClient`` connection at startup.
  2. Subscribes to the per-user notifications + channels consumers.
  3. Forwards every wake to the nanobot event bus via
     ``nanobot events publish <channel> <json-body>``.
  4. Drains and closes on SIGINT / SIGTERM.

nanobot's tool surface (klodi_list_create, klodi_search, …) is exposed
separately via :mod:`nanobot_tools` — the agent calls the tools, the
tool handlers reach the same ``KlodiClient`` singleton through
:mod:`nanobot_client`.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from klodi_nats_client import KlodiClient, default_klodi_home

from nanobot_client import set_client
from nanobot_installer import ensure_klodi_home

log = logging.getLogger("klodi_nanobot.daemon")


_CHANNEL_DEFAULT = "klodi"
_PUBLISH_TIMEOUT_SECONDS = 10


def _creds_path(klodi_home: Path) -> Path:
    return klodi_home / "nats.creds"


def _config_path(klodi_home: Path) -> Path:
    return klodi_home / "config.json"


def _publish_to_event_bus(channel: str, body: dict) -> bool:
    """Forward an event payload to nanobot's local event bus.

    Returns False on any execution failure so the daemon can log + nak.
    nanobot's CLI exits non-zero on already-registered channels (which
    is fine), so we only treat ``FileNotFoundError`` and a non-zero
    exit code with a non-empty stderr as a real failure.
    """
    serialized = json.dumps(body, ensure_ascii=False)
    try:
        proc = subprocess.run(
            ["nanobot", "events", "publish", channel, serialized],
            capture_output=True,
            text=True,
            timeout=_PUBLISH_TIMEOUT_SECONDS,
        )
    except FileNotFoundError:
        log.error("nanobot_cli_missing — install nanobot CLI on PATH")
        return False
    except subprocess.TimeoutExpired:
        log.error("nanobot_cli_timeout channel=%s", channel)
        return False
    if proc.returncode != 0:
        log.error(
            "nanobot_publish_failed channel=%s code=%d stderr=%s",
            channel,
            proc.returncode,
            proc.stderr.strip(),
        )
        return False
    return True


def _make_wake_callbacks(channel: str) -> tuple[Any, Any]:
    """Build the two consumer wake callbacks closed over ``channel``.

    Both callbacks dispatch ``_publish_to_event_bus`` off the asyncio
    loop via ``asyncio.to_thread``. ``_publish_to_event_bus`` shells
    out via ``subprocess.run`` (up to 10s); the daemon's consumer
    pull-fetches and the nats-py WS heartbeat share this loop, so an
    inline call would freeze them and the WS would die past its
    heartbeat budget. The threadpool dispatch keeps the loop ticking
    while the publish is in flight.

    Factored to module scope so tests can exercise the exact closures
    the daemon hands to ``client.subscribe_*``.
    """

    async def _on_notification(event: dict) -> None:
        body = {"kind": "klodi.notification", "event": event}
        ok = await asyncio.to_thread(_publish_to_event_bus, channel, body)
        if not ok:
            raise RuntimeError("nanobot publish failed — nak for retry")

    async def _on_channel(event: dict) -> None:
        body = {"kind": "klodi.channel_message", "event": event}
        ok = await asyncio.to_thread(_publish_to_event_bus, channel, body)
        if not ok:
            raise RuntimeError("nanobot publish failed — nak for retry")

    return _on_notification, _on_channel


async def _run(channel: str, klodi_home: Path) -> int:
    """Open the connection, subscribe, wait for a stop signal."""
    client = KlodiClient(
        creds_path=str(_creds_path(klodi_home)),
        config_path=str(_config_path(klodi_home)),
        on_error=lambda err, ctx: log.warning(
            "klodi_client_error error=%s context=%s", err, ctx
        ),
    )
    # Share the daemon's connection with tool wrappers in the same
    # process so they don't open a second NATS-WS link.
    set_client(client)

    await client.connect()
    log.info("klodi_nanobot_connected channel=%s home=%s", channel, klodi_home)

    on_notification, on_channel = _make_wake_callbacks(channel)
    await client.subscribe_notifications(on_notification)
    await client.subscribe_channels(on_channel)
    log.info("klodi_nanobot_wakes_subscribed")

    stop_event = asyncio.Event()

    def _stop(signum: int, _frame: object | None = None) -> None:
        log.info("klodi_nanobot_stop_signal signum=%d", signum)
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, lambda s=sig: _stop(s, None))
        except NotImplementedError:
            # Windows — fall back to default signal handling.
            signal.signal(sig, _stop)

    await stop_event.wait()
    await client.close()
    log.info("klodi_nanobot_closed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="klodi-nanobot-daemon",
        description=(
            "Long-running klodi → nanobot bridge. Maintains a persistent"
            " NATS-WS connection to the klodi marketplace and forwards"
            " every wake (notifications, channel messages) to a nanobot"
            " event-bus channel."
        ),
    )
    parser.add_argument(
        "--channel",
        default=os.environ.get("KLODI_NANOBOT_CHANNEL", _CHANNEL_DEFAULT),
        help=(
            "nanobot event-bus channel to publish on. Defaults to"
            " 'klodi' or the KLODI_NANOBOT_CHANNEL env var."
        ),
    )
    parser.add_argument(
        "--klodi-home",
        default=None,
        help="Override ${klodi_home}. Defaults to the XDG/platform value.",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    klodi_home = (
        Path(args.klodi_home) if args.klodi_home else default_klodi_home()
    )
    ensure_klodi_home(klodi_home)

    if not _creds_path(klodi_home).exists():
        sys.stderr.write(
            f"nats.creds missing at {_creds_path(klodi_home)}.\n"
            "Run klodi-nanobot-setup, then klodi_register from the agent.\n"
        )
        return 3

    try:
        return asyncio.run(_run(args.channel, klodi_home))
    except KeyboardInterrupt:
        log.info("klodi_nanobot_interrupt")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
