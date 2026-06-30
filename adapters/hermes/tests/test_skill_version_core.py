"""Version-comparison core for the version-aware skill reseed.

These tests pin the freshness primitives that drive the decision table
(see ``cards/make-skill-reseed-and-index-version-aware.md``):

    | on-disk state                         | action          |
    | target absent                         | reseed          |
    | marker absent / unparseable (legacy)  | reseed          |  <- the bug
    | on-disk  <  bundle                     | reseed          |
    | on-disk == bundle                      | no-op           |
    | on-disk  >  bundle (rollback)           | no-op           |

The primitives are stdlib-only (int-tuple compare; ``packaging.version``
is deliberately NOT used so the install path stays dependency-free) and
host-agnostic: the bundle version string is supplied by the caller, so
the same code mirrors byte-for-byte into the nanobot adapter.

Fail-safe rule under test: a missing / unparseable on-disk *or* bundle
version always resolves toward **reseed** ("NEVER ship stale").
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


_HERMES_DIR = Path(__file__).resolve().parent.parent
_SRC_DIR = _HERMES_DIR / "src"
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))
_NATS_CLIENT_SRC = _HERMES_DIR.parent.parent / "packages" / "nats-client-py" / "src"
if _NATS_CLIENT_SRC.is_dir() and str(_NATS_CLIENT_SRC) not in sys.path:
    sys.path.insert(0, str(_NATS_CLIENT_SRC))

from klodi_hermes.hermes_installer import (  # noqa: E402
    read_skill_version,
    version_is_newer,
)

_MARKER = ".klodi-skill-version"


class TestReadSkillVersion(unittest.TestCase):
    """``read_skill_version`` reads the dotfile marker stamped into a
    seeded skill tree and parses it to a comparable int-tuple."""

    def test_parses_dotted_numeric_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / _MARKER).write_text("0.3.5\n", encoding="utf-8")
            self.assertEqual(read_skill_version(target), (0, 3, 5))

    def test_absent_marker_returns_none(self) -> None:
        """A legacy warm volume (seeded before markers existed) has no
        marker — the canonical bug. ``None`` is the reseed signal."""
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(read_skill_version(Path(tmp)))

    def test_unparseable_marker_returns_none(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / _MARKER).write_text("not-a-version\n", encoding="utf-8")
            self.assertIsNone(read_skill_version(target))

    def test_partially_numeric_marker_returns_none(self) -> None:
        """A marker like ``1.2.x`` must fail safe (toward reseed), not
        parse the numeric prefix and silently compare wrong."""
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp)
            (target / _MARKER).write_text("1.2.x\n", encoding="utf-8")
            self.assertIsNone(read_skill_version(target))


class TestVersionIsNewer(unittest.TestCase):
    """``version_is_newer(bundle, ondisk)`` — bundle is a live version
    string (the wheel version); ondisk is the parsed marker tuple or
    ``None``."""

    def test_bundle_greater_is_newer(self) -> None:
        self.assertTrue(version_is_newer("0.4.0", (0, 3, 5)))

    def test_bundle_patch_greater_is_newer(self) -> None:
        self.assertTrue(version_is_newer("0.3.6", (0, 3, 5)))

    def test_bundle_equal_is_not_newer(self) -> None:
        self.assertFalse(version_is_newer("0.3.5", (0, 3, 5)))

    def test_bundle_lesser_is_not_newer(self) -> None:
        """Rollback / manually-newer on-disk: never regress."""
        self.assertFalse(version_is_newer("0.3.4", (0, 3, 5)))

    def test_ondisk_none_is_newer(self) -> None:
        """Absent/unparseable marker -> fail safe toward reseed."""
        self.assertTrue(version_is_newer("0.3.5", None))

    def test_bundle_unparseable_is_newer(self) -> None:
        """A broken wheel version (cannot confirm freshness) reseeds."""
        self.assertTrue(version_is_newer("garbage", (0, 3, 5)))

    def test_empty_bundle_is_newer(self) -> None:
        self.assertTrue(version_is_newer("", (0, 3, 5)))

    def test_both_unknown_is_newer(self) -> None:
        self.assertTrue(version_is_newer("", None))


if __name__ == "__main__":
    unittest.main()
