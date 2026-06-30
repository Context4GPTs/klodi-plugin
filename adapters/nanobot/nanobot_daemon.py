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
import enum
import json
import logging
import os
import signal
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from klodi_nats_client import KlodiClient, default_klodi_home

from nanobot_client import set_client
from nanobot_installer import ensure_klodi_home

log = logging.getLogger("klodi_nanobot.daemon")


_CHANNEL_DEFAULT = "klodi"
_PUBLISH_TIMEOUT_SECONDS = 10

# Distinct, operator-alertable ERROR event for the deterministic publish
# class — the nanobot analogue of hermes's
# ``wake_inject_deterministic_failure`` (the epic's reconciled alarm
# shape, ADR-0019). Operators alert on this; it is separable from the
# routine transient (timeout) path, which NAKs and stays a plain log.
_DETERMINISTIC_ALARM = "nanobot_publish_deterministic_failure"


class PublishDisposition(enum.Enum):
    """How a publish attempt should be dispositioned at the consumer seam.

    ``OK`` — the publish succeeded; the callback ACKs.
    ``DETERMINISTIC`` — a misconfig that fails identically every wake
    (missing CLI, nonzero exit). Redelivery is futile (it would burn
    ``max_deliver`` then drop silently), so the callback emits the
    distinct ERROR alarm and ACKs — the alarm, not redelivery, is the
    surface.
    ``TRANSIENT`` — a recoverable failure (timeout). The callback raises
    so the consumer NAKs and JetStream redelivers.
    """

    OK = "ok"
    DETERMINISTIC = "deterministic"
    TRANSIENT = "transient"


@dataclass(frozen=True)
class PublishOutcome:
    """Typed result of one ``nanobot events publish`` attempt.

    Carries the subprocess diagnostics (``code``/``stdout``/``stderr``) so
    the callback can build a correlated alarm without re-running anything.
    ``stdout`` is captured deliberately: the CLI may write its failure
    explanation there with an empty stderr (Bug 1).
    """

    disposition: PublishDisposition
    code: int | None = None
    stdout: str = ""
    stderr: str = ""


def _creds_path(klodi_home: Path) -> Path:
    return klodi_home / "nats.creds"


def _config_path(klodi_home: Path) -> Path:
    return klodi_home / "config.json"


def _publish_to_event_bus(channel: str, body: dict[str, Any]) -> PublishOutcome:
    """Forward an event payload to nanobot's local event bus.

    Shells out to ``nanobot events publish`` and classifies the result
    into a :class:`PublishOutcome`. A missing CLI or a nonzero exit is
    DETERMINISTIC (it fails the same way on every redelivery); a timeout
    is TRANSIENT (redelivery can help). The failure log carries BOTH
    streams — ``nanobot events publish`` can write its diagnostic to
    stdout with an empty stderr, so logging stderr alone silently
    discards the explanation for the nonzero exit (Bug 1).
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
        return PublishOutcome(PublishDisposition.DETERMINISTIC)
    except subprocess.TimeoutExpired:
        log.error("nanobot_cli_timeout channel=%s", channel)
        return PublishOutcome(PublishDisposition.TRANSIENT)
    if proc.returncode != 0:
        log.error(
            "nanobot_publish_failed channel=%s code=%d stdout=%s stderr=%s",
            channel,
            proc.returncode,
            proc.stdout.strip(),
            proc.stderr.strip(),
        )
        return PublishOutcome(
            PublishDisposition.DETERMINISTIC,
            code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        )
    return PublishOutcome(PublishDisposition.OK)


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

    async def _on_notification(event: dict[str, Any]) -> None:
        body = {"kind": "klodi.notification", "event": event}
        outcome = await asyncio.to_thread(_publish_to_event_bus, channel, body)
        _dispatch_outcome(outcome, event)

    async def _on_channel(event: dict[str, Any]) -> None:
        body = {"kind": "klodi.channel_message", "event": event}
        outcome = await asyncio.to_thread(_publish_to_event_bus, channel, body)
        _dispatch_outcome(outcome, event)

    return _on_notification, _on_channel


def _dispatch_outcome(outcome: PublishOutcome, event: dict[str, Any]) -> None:
    """Apply the failure-class disposition for one wake.

    OK → ACK (return). TRANSIENT → raise so the consumer NAKs and
    JetStream redelivers. DETERMINISTIC → emit the distinct, correlated
    ERROR alarm (carrying ``event_id``/``kind``/``stdout``/``stderr``/
    ``code``) then ACK — redelivering a deterministic misconfig only burns
    ``max_deliver`` and drops silently; the alarm is the operator surface.
    Mirrors hermes's ``wake_inject_deterministic_failure``.
    """
    if outcome.disposition is PublishDisposition.OK:
        return
    if outcome.disposition is PublishDisposition.TRANSIENT:
        raise RuntimeError("nanobot publish failed (transient) — nak for retry")
    log.error(
        "%s event_id=%s kind=%s code=%s stdout=%s stderr=%s",
        _DETERMINISTIC_ALARM,
        event.get("event_id", ""),
        event.get("kind", ""),
        outcome.code,
        outcome.stdout.strip(),
        outcome.stderr.strip(),
    )


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
