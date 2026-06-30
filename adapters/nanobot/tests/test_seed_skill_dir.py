"""Parity coverage: ``seed_skill_dir`` is version-aware in the nanobot
adapter too.

``nanobot_installer.py`` is a byte-identical mirror of the Hermes
``hermes_installer.py`` (CI enforces this via
``scripts/check-shared-python.sh``). The Hermes suite owns the
exhaustive version-matrix; this file pins the load-bearing behaviours
in the nanobot copy so a future non-mirrored edit fails here as well
as at the parity gate.
"""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


_HERE = Path(__file__).resolve().parent
_NANOBOT_DIR = _HERE.parent
if str(_NANOBOT_DIR) not in sys.path:
    sys.path.insert(0, str(_NANOBOT_DIR))

from nanobot_installer import seed_skill_dir  # noqa: E402

_MARKER = ".klodi-skill-version"
_BUNDLE_VERSION = "0.3.5"
_BUNDLE_SKILL_MD = "# klodi — agent playbook\n\nCanonical bundle.\n"


def _seed_source(source: Path) -> None:
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(_BUNDLE_SKILL_MD, encoding="utf-8")


def _seed_existing_skill(skill_dir: Path, version: str | None) -> None:
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "# klodi — STALE on-disk copy\n", encoding="utf-8"
    )
    if version is not None:
        (skill_dir / _MARKER).write_text(f"{version}\n", encoding="utf-8")


class TestNanobotSeedSkillDir(unittest.TestCase):
    def test_older_marker_reseeds_even_with_no_reseed(self) -> None:
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
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertEqual(
                (klodi_home / "skill" / _MARKER).read_text(encoding="utf-8"),
                f"{_BUNDLE_VERSION}\n",
            )

    def test_same_version_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            _seed_existing_skill(klodi_home / "skill", _BUNDLE_VERSION)
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

    def test_source_missing_reports_failed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            klodi_home.mkdir()
            outcome = seed_skill_dir(
                klodi_home, root / "missing", version=_BUNDLE_VERSION
            )
            self.assertEqual(outcome, "failed")
            self.assertFalse((klodi_home / "skill").exists())


if __name__ == "__main__":
    unittest.main()
