"""Cross-platform default ``${KLODI_HOME}`` resolution — P2-14 (Python).

Mirrors ``klodi_rust_host::paths::klodi_home`` (Rust) and the OpenClaw
adapter's ``DEFAULT_KLODI_HOME`` (TS) so every host adapter resolves
the same on-disk location for klodi state. Per **R § P2-14** the prior
implementation lived in 5+ places (Hermes ``installer.py``,
``local_tools.py``, nanobot ``nanobot_installer.py``, plus the Rust
crate and OpenClaw) — each with its own platform-aware branching that
could drift.

Resolution order:

1. ``KLODI_HOME`` env override (always wins).
2. macOS  → ``~/Library/Application Support/klodi``.
3. Windows → ``${APPDATA}/klodi`` (or ``~/AppData/Roaming/klodi``).
4. Linux/Unix → ``${XDG_CONFIG_HOME}/klodi`` (or ``~/.config/klodi``).

Note on XDG: the existing TS / Rust / Hermes implementations all key
off ``XDG_CONFIG_HOME`` (config-state directory), not
``XDG_DATA_HOME`` — klodi state is configuration-shaped (creds,
config.json, policies) rather than user data. We follow the existing
convention so per-host paths stay byte-equal.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def default_klodi_home() -> Path:
    """Return the platform-canonical klodi state directory.

    Honors ``KLODI_HOME`` first, then platform default. Returns a
    :class:`pathlib.Path` — caller decides whether to create the
    directory and whether to chmod 0700 (see
    :func:`hermes_installer.ensure_klodi_home`).
    """
    env = os.environ.get("KLODI_HOME")
    if env:
        return Path(env)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "klodi"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        if appdata:
            return Path(appdata) / "klodi"
        return Path.home() / "AppData" / "Roaming" / "klodi"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg) / "klodi"
    return Path.home() / ".config" / "klodi"


def default_creds_path() -> Path:
    """``${KLODI_HOME}/nats.creds`` — written by the registration flow."""
    return default_klodi_home() / "nats.creds"


def default_config_path() -> Path:
    """``${KLODI_HOME}/config.json`` — written by the registration flow."""
    return default_klodi_home() / "config.json"


def default_api_url() -> str:
    """Return the canonical klodi marketplace API URL.

    Honors ``KLODI_API_URL`` env override; falls back to the catalog's
    ``KLODI_DEFAULT_API_URL`` (``https://klodi.4gpts.com``). Closes the
    duplication review code-quality-guardian flagged at four sites
    (``hermes/local_tools.py``, ``hermes/register.py``,
    ``nanobot/nanobot_local_tools.py`` x2).
    """
    from .constants import KLODI_DEFAULT_API_URL

    return os.environ.get("KLODI_API_URL", KLODI_DEFAULT_API_URL)


__all__ = [
    "default_api_url",
    "default_config_path",
    "default_creds_path",
    "default_klodi_home",
]
