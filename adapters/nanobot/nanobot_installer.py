"""Shared installer primitives for the nanobot adapter.

Sibling copy of ``klodi-plugin/adapters/hermes/hermes_installer.py``. CI
enforces parity via ``klodi-plugin/scripts/check-shared-python.sh``.
"""

from __future__ import annotations

import importlib.metadata
import logging
import os
import re
import shutil
import sys
from pathlib import Path
from typing import Literal

log = logging.getLogger("klodi_nanobot.nanobot_installer")


EXIT_OK = 0
EXIT_USAGE = 2

# Dotfile sidecar stamped into a seeded skill tree recording the bundle
# version it was seeded at. A dotfile is invisible to the Hermes runtime
# manifest scan (which keys on SKILL.md only), so it is inert in both the
# ${klodi_home}/skill/ and ${hermes_home}/skills/klodi/ trees. The
# shipped bundle carries no version of its own — the caller supplies the
# host wheel version, which the bundle ships inside (zero drift).
_SKILL_VERSION_MARKER = ".klodi-skill-version"

# Outcome of a version-aware seed. Reported distinctly so an operator can
# tell a real upgrade from a no-op from a broken install (BR-6).
SeedOutcome = Literal["reseeded", "already-current", "failed"]


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


def resolve_skill_version(package: str) -> str:
    """Resolve the installed wheel version for ``package`` — the
    canonical bundle version (the bundle ships *inside* the wheel, so
    the two never drift).

    Host-agnostic: the caller names its own distribution
    (``"klodi-hermes"`` / ``"klodi-nanobot"``); this primitive never
    hardcodes one. On a broken install where the metadata is missing,
    return ``""`` — :func:`version_is_newer` treats an unparseable
    bundle version as 'always newer', so the fail-safe is to reseed
    rather than skip on a freshness we cannot determine. NEVER ship
    a stale skill.
    """
    try:
        return importlib.metadata.version(package)
    except importlib.metadata.PackageNotFoundError:
        log.warning(
            "klodi_skill_version_unresolved package=%s — cannot confirm"
            " freshness; forcing a reseed (fail-safe: never ship stale).",
            package,
        )
        return ""


def _parse_version(value: str | None) -> tuple[int, ...] | None:
    """Parse a dotted-numeric ``MAJOR.MINOR.PATCH`` string to a
    comparable int-tuple. Returns ``None`` for a missing, empty, or
    non-numeric value.

    Stdlib only — ``packaging.version`` is deliberately avoided so the
    install path inherits zero extra dependencies (it runs before the
    runtime deps are installed). A ``None`` is the fail-safe-toward-
    reseed signal, so any value we cannot fully parse (e.g. ``1.2.x``)
    must collapse to ``None`` rather than parse a numeric prefix.
    """
    if not value:
        return None
    parts = value.strip().split(".")
    out: list[int] = []
    for part in parts:
        if not (part.isascii() and part.isdigit()):
            return None
        out.append(int(part))
    return tuple(out) if out else None


def read_skill_version(target: Path) -> tuple[int, ...] | None:
    """Read the ``.klodi-skill-version`` marker from a seeded skill tree
    and parse it to a comparable int-tuple.

    Returns ``None`` when the marker is absent (a legacy warm volume
    seeded before markers existed — the canonical bug) or unparseable
    (a half-written tree). The caller treats ``None`` as 'older than
    any bundle' so the fail-safe is always to reseed. Never raises on a
    missing file.
    """
    try:
        raw = (target / _SKILL_VERSION_MARKER).read_text(encoding="utf-8")
    except OSError:
        return None
    return _parse_version(raw)


def version_is_newer(bundle: str, ondisk: tuple[int, ...] | None) -> bool:
    """True when the ``bundle`` version (the live wheel version string)
    should overwrite the ``ondisk`` marker version (the parsed tuple
    from :func:`read_skill_version`, or ``None``).

    Fail-safe toward reseed — NEVER ship stale:
      • ``ondisk is None`` (absent / unparseable marker)  -> True
      • ``bundle`` unparseable (broken wheel metadata)     -> True
      • otherwise                                          -> parsed(bundle) > ondisk

    Equal or older on-disk -> False (no needless clobber, no version
    regression on a rollback / manually-newer copy).
    """
    parsed_bundle = _parse_version(bundle)
    if parsed_bundle is None or ondisk is None:
        return True
    return parsed_bundle > ondisk


def copy_skill_tree(source: Path, target: Path, version: str) -> None:
    """Replace ``target`` with a fresh copy of ``source`` and stamp the
    version marker LAST.

    Shared 'copy + stamp marker' primitive so every seed path — the
    install-time CLI and the runtime ``klodi_setup_reseed_skill`` force
    escape hatch — leaves a correct marker. Writing the marker only
    after a successful ``copytree`` is the crash-safety guarantee: a
    half-copied tree has no/old marker and re-reseeds on the next run.

    The caller guarantees ``source`` is a directory.
    """
    if target.exists():
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, target)
    (target / _SKILL_VERSION_MARKER).write_text(f"{version}\n", encoding="utf-8")


def seed_skill_dir(
    klodi_home: Path, source: Path, *, version: str, reseed: bool = True
) -> SeedOutcome:
    """Version-aware seed of the canonical klodi skill bundle into
    ``${klodi_home}/skill/``.

    The canonical bundle is the single source of truth — per-user edits
    to the bundled skill are not supported. The user-editable trees
    (``policies/`` and the per-listing ``sell/`` / ``buy/``) are
    SIBLINGS of ``skill/`` and are never touched.

    ``version`` is the bundle version, supplied by the caller (the host
    wheel version via :func:`resolve_skill_version`) — this primitive
    is host-agnostic and never hardcodes a distribution name.

    The decision is governed UNCONDITIONALLY by the on-disk-vs-bundle
    version. The ``reseed`` flag is **accepted but inert** during the
    cross-repo ``--no-reseed`` deprecation window: it can no longer
    suppress an upgrade, because a wrong deploy flag must never strand a
    stale skill.

      • target absent ............................ reseed
      • marker absent / unparseable (legacy) ..... reseed   (fail-safe)
      • on-disk  <  bundle ....................... reseed
      • on-disk == bundle ........................ already-current (no-op)
      • on-disk  >  bundle (rollback) ............ already-current (no-op)

    Returns ``"failed"`` when the bundle source is missing,
    ``"already-current"`` when the on-disk copy is at/after the bundle,
    ``"reseeded"`` when it (re)wrote the tree.
    """
    del reseed  # accepted-but-inert: the version decision is unconditional.
    if not source.is_dir():
        log.warning(
            "klodi_skill_source_missing path=%s — skill not seeded."
            " Reinstall the adapter or pass --skill-source.",
            source,
        )
        return "failed"

    target = klodi_home / "skill"
    if target.exists() and not version_is_newer(version, read_skill_version(target)):
        log.info(
            "klodi_skill_current target=%s version=%s — already current,"
            " not reseeding.",
            target,
            version,
        )
        return "already-current"

    copy_skill_tree(source, target, version)
    log.info(
        "klodi_skill_seeded source=%s target=%s version=%s",
        source,
        target,
        version,
    )
    return "reseeded"


__all__ = [
    "EXIT_OK",
    "EXIT_USAGE",
    "SeedOutcome",
    "copy_skill_tree",
    "default_klodi_home",
    "ensure_klodi_home",
    "read_skill_version",
    "resolve_skill_version",
    "seed_skill_dir",
    "validate_host_slug",
    "version_is_newer",
]
