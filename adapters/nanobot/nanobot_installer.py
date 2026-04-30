"""Shared installer primitives for the nanobot adapter.

Sibling copy of ``klodi-plugin/adapters/hermes/hermes_installer.py``. CI
enforces parity via ``klodi-plugin/scripts/check-shared-python.sh``.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sys
from pathlib import Path

log = logging.getLogger("klodi_nanobot.nanobot_installer")


EXIT_OK = 0
EXIT_USAGE = 2


# ── Input validation ─────────────────────────────────────────────────


_HOST_SLUG_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
_HOST_SLUG_MAX_LENGTH = 64


def validate_host_slug(value: str) -> str:
    """Return the slug unchanged if valid; raise ValueError otherwise.

    Kept for setup-CLI ergonomics — the host slug appears in
    operational logs on the marketplace side, so a bad slug should
    fail fast on the install side instead of after the round-trip.
    """
    if not isinstance(value, str) or len(value) == 0:
        raise ValueError("host_slug must be a non-empty string")
    if len(value) > _HOST_SLUG_MAX_LENGTH:
        raise ValueError(
            f"host_slug must be at most {_HOST_SLUG_MAX_LENGTH} chars"
        )
    if not _HOST_SLUG_PATTERN.fullmatch(value):
        raise ValueError(
            "host_slug must match [a-z0-9][a-z0-9._-]* — lowercase"
            " alphanumerics plus '.', '_', '-'"
        )
    return value


def default_klodi_home() -> Path:
    """Platform-appropriate ``${klodi_home}``.

    Honors KLODI_HOME, then platform default. Mirrors the path
    resolution in the TS adapter so tools share state.
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


def ensure_klodi_home(path: Path) -> None:
    """Create ``${klodi_home}`` at 0700 if missing."""
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError as err:
        log.warning("klodi_home_chmod_failed path=%s error=%s", path, err)


def seed_skill_dir(klodi_home: Path, source: Path, *, reseed: bool = True) -> bool:
    """Copy the canonical klodi skill bundle to ``${klodi_home}/skill/``.

    The canonical bundle is the source of truth and per-user edits to
    the plugin's bundled skill are not supported. User-editable files
    live under ``policies/`` and the per-listing ``sell/`` / ``buy/``
    trees, all of which are preserved.

    Reseed semantics (per **R § P3-19**, Option A):
      • ``reseed=True`` (default, backward-compat with installers that
        don't pass the flag): emit a ``[reseed]`` warning line BEFORE
        the destructive overwrite so an unexpected re-seed is visible
        in operator install logs.
      • ``reseed=False``: refuse to overwrite an existing target and
        return False so the caller can surface a user-facing error.
        Use when the user has manually customised SKILL.md and wants
        the installer to leave it alone.

    Returns True on success, False when the source is missing OR when
    ``reseed=False`` and the target already exists.
    """
    if not source.is_dir():
        log.warning(
            "klodi_skill_source_missing path=%s — skill not seeded."
            " Reinstall the adapter or pass --skill-source.",
            source,
        )
        return False

    target = klodi_home / "skill"
    if target.exists():
        if not reseed:
            log.error(
                "[reseed] target exists at %s — pass --reseed (default) to"
                " overwrite, or remove the directory manually. Skill bundle"
                " left untouched.",
                target,
            )
            return False
        log.warning(
            "[reseed] removing prior %s (use --no-reseed to keep existing)",
            target,
        )
        shutil.rmtree(target)
    shutil.copytree(source, target)
    log.info("klodi_skill_seeded source=%s target=%s", source, target)
    return True


__all__ = [
    "EXIT_OK",
    "EXIT_USAGE",
    "default_klodi_home",
    "ensure_klodi_home",
    "seed_skill_dir",
    "validate_host_slug",
]
