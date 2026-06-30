"""Version-aware ``seed_skill_dir`` — the ``${KLODI_HOME}/skill/`` half.

``seed_skill_dir`` had no direct test before this card; it was only
exercised transitively through the setup CLI. These tests pin the new
**unconditional, version-aware** contract:

* The canonical bundle overwrites an older on-disk copy **even when
  ``reseed=False``** — a wrong deploy flag must never strand a stale
  skill (the bug this card closes).
* An on-disk copy at the same-or-newer version is left untouched (no
  needless clobber, no version regression, no every-boot churn).
* The user-editable sibling trees (``policies/``, ``sell/``, ``buy/``)
  live *beside* ``skill/`` and are never in scope.
* The freshness marker is stamped **last, after a successful copytree**
  (crash-safety) and is a dotfile (invisible to the runtime SKILL.md
  manifest scan).

Only the filesystem boundary is mocked (tempdirs). The installer logic
is exercised for real.
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

from klodi_hermes.hermes_installer import seed_skill_dir  # noqa: E402

_MARKER = ".klodi-skill-version"
_BUNDLE_VERSION = "0.3.5"
_BUNDLE_SKILL_MD = "# klodi — agent playbook\n\nCanonical bundle.\n"


def _seed_source(source: Path) -> None:
    """Lay down a representative canonical bundle (the wheel's
    ``skills/klodi/`` tree). The shipped bundle carries NO version
    marker — the version is the wheel version, supplied by the caller."""
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(_BUNDLE_SKILL_MD, encoding="utf-8")
    refs = source / "references"
    refs.mkdir()
    (refs / "tool_inventory.md").write_text("# tool inventory\n", encoding="utf-8")


def _seed_existing_skill(skill_dir: Path, version: str | None) -> None:
    """Create a warm ``${KLODI_HOME}/skill/`` from a *prior* install,
    optionally stamped at ``version`` (``None`` = legacy unmarked tree)."""
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "# klodi — STALE on-disk copy\n", encoding="utf-8"
    )
    if version is not None:
        (skill_dir / _MARKER).write_text(f"{version}\n", encoding="utf-8")


class TestSeedSkillDirVersionAware(unittest.TestCase):
    def test_absent_target_seeds_and_stamps_marker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            klodi_home.mkdir()
            source = root / "bundle"
            _seed_source(source)

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(outcome, "reseeded")
            skill = klodi_home / "skill"
            self.assertEqual(
                (skill / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertEqual(
                (skill / _MARKER).read_text(encoding="utf-8"), f"{_BUNDLE_VERSION}\n"
            )

    def test_older_marker_reseeds_even_with_no_reseed(self) -> None:
        """The crux of this card: ``reseed=False`` must NOT strand an
        older on-disk skill when the bundle is newer."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", "0.3.4")
            source = root / "bundle"
            _seed_source(source)

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION, reseed=False
            )

            self.assertEqual(outcome, "reseeded")
            skill = klodi_home / "skill"
            self.assertEqual(
                (skill / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertEqual(
                (skill / _MARKER).read_text(encoding="utf-8"), f"{_BUNDLE_VERSION}\n"
            )

    def test_absent_marker_reseeds(self) -> None:
        """Legacy warm volume seeded before markers existed."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", None)
            source = root / "bundle"
            _seed_source(source)

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION, reseed=False
            )

            self.assertEqual(outcome, "reseeded")
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )

    def test_same_version_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", _BUNDLE_VERSION)
            source = root / "bundle"
            _seed_source(source)

            before = (klodi_home / "skill" / "SKILL.md").stat().st_mtime_ns
            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(outcome, "already-current")
            # No clobber: the on-disk (distinct) content survives.
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — STALE on-disk copy\n",
            )
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").stat().st_mtime_ns, before
            )

    def test_newer_ondisk_is_not_regressed(self) -> None:
        """Rollback safety: an on-disk copy newer than the bundle (e.g.
        a manual hotfix) is never overwritten with the older bundle."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", "9.9.9")
            source = root / "bundle"
            _seed_source(source)

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(outcome, "already-current")
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — STALE on-disk copy\n",
            )

    def test_user_sibling_trees_preserved_on_reseed(self) -> None:
        """``policies/``, ``sell/``, ``buy/`` are siblings of ``skill/``
        — a reseed of ``skill/`` must leave them byte-identical."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", "0.3.4")
            for sibling, body in (
                ("policies", "# user policy\n"),
                ("sell", "# my listing\n"),
                ("buy", "# my want\n"),
            ):
                d = klodi_home / sibling
                d.mkdir(parents=True)
                (d / "data.md").write_text(body, encoding="utf-8")

            source = root / "bundle"
            _seed_source(source)

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION, reseed=False
            )

            self.assertEqual(outcome, "reseeded")
            self.assertEqual(
                (klodi_home / "policies" / "data.md").read_text(encoding="utf-8"),
                "# user policy\n",
            )
            self.assertEqual(
                (klodi_home / "sell" / "data.md").read_text(encoding="utf-8"),
                "# my listing\n",
            )
            self.assertEqual(
                (klodi_home / "buy" / "data.md").read_text(encoding="utf-8"),
                "# my want\n",
            )

    def test_source_missing_reports_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            klodi_home.mkdir()
            source = root / "missing"  # never created

            outcome = seed_skill_dir(
                klodi_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(outcome, "failed")
            self.assertFalse((klodi_home / "skill").exists())


if __name__ == "__main__":
    unittest.main()
