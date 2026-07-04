"""klodi nanobot adapter.

nanobot is Python-native like Hermes; the wake contract is post-0012
identical. The package is consumed via pip (``klodi-nanobot``) and
exposes:

  * ``klodi-nanobot-setup``  — one-shot installer.
  * ``klodi-nanobot-daemon`` — long-running NATS-WS bridge that
                                forwards every wake to nanobot's
                                local event bus.

The tool surface (``klodi_list_create``, ``klodi_search``, …) is exposed
via :mod:`nanobot_tools` for nanobot's tool-decorator integration.
"""

from __future__ import annotations

__version__ = "0.3.9"


__all__: list[str] = []
