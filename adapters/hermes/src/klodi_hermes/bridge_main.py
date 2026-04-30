"""``klodi-hermes-bridge`` console entry point.

Wires SIGTERM/SIGINT into the bridge's stop signal, configures logging,
resolves ``${KLODI_HOME}`` and the ``hermes`` binary path, and defers
all work to :class:`klodi_hermes.bridge.Bridge`.
"""

from __future__ import annotations

import logging
import os
import shutil
import signal
import sys
from pathlib import Path

from klodi_hermes.bridge import Bridge

log = logging.getLogger("klodi_hermes.bridge_main")


def main() -> int:
    """Entry point exposed via ``[project.scripts]`` in pyproject.toml."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    klodi_home = _resolve_klodi_home()
    hermes_bin = _resolve_hermes_bin()

    bridge = Bridge(klodi_home=klodi_home, hermes_bin=hermes_bin)

    def _on_signal(signum: int, _frame: object) -> None:
        log.info("bridge_signal_received signum=%d", signum)
        bridge.request_stop()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    bridge.run()
    return 0


def _resolve_klodi_home() -> Path:
    env = os.environ.get("KLODI_HOME")
    if env:
        return Path(env)
    # Fall through to the same XDG resolver every other adapter uses
    # so the bridge agrees with the per-chat ctx on where creds live.
    from klodi_nats_client import default_klodi_home

    return default_klodi_home()


def _resolve_hermes_bin() -> str:
    """Locate the ``hermes`` CLI the bridge will spawn for wake delivery.

    Resolution order:
      1. ``KLODI_HERMES_BIN`` env override (operator-set).
      2. ``shutil.which("hermes")`` against $PATH — works on any
         install where the venv's bin is on PATH (the demo + the
         integration container both meet this).
      3. Hard fallback to the docker layout the demo + integration
         suite use, so a missing $PATH still resolves.

    Bridge boot does not validate the path exists — if hermes is
    truly missing, the first wake's ``inject_message`` will log
    ``wake_inject_nonzero`` with FileNotFoundError and the operator
    fixes the install. Validating eagerly here would just hide the
    same error behind a startup crash.
    """
    env = os.environ.get("KLODI_HERMES_BIN")
    if env:
        return env
    found = shutil.which("hermes")
    if found:
        return found
    return "/opt/hermes/.venv/bin/hermes"


if __name__ == "__main__":
    sys.exit(main())
