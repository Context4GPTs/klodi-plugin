"""Integration: ``klodi-hermes-setup`` is version-aware end-to-end.

Drives the real ``main()`` against tempdir ``KLODI_HOME`` / ``HERMES_HOME``
(only the filesystem boundary is mocked). The bundle version is resolved
the same way production does — ``importlib.metadata.version("klodi-hermes")``
— so these tests track the live wheel version automatically.

These pin the headline guarantee of this card: **no deploy flag can
strand a stale skill.** ``--no-reseed`` is accepted but inert; the
canonical bundle always wins when newer; an equal/older bundle is
always a no-op; and the three outcomes (reseeded / already-current /
failed) are reported distinctly.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.metadata
import io
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

_setup_cli = importlib.import_module("klodi_hermes.setup_cli")
main = _setup_cli.main

_MARKER = ".klodi-skill-version"
_BUNDLE_VERSION = importlib.metadata.version("klodi-hermes")
_BUNDLE_SKILL_MD = "# klodi — agent playbook\n\nCanonical bundle.\n"
_STALE = "0.0.1"  # always older than any real wheel version


def _seed_source(source: Path) -> None:
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(_BUNDLE_SKILL_MD, encoding="utf-8")
    refs = source / "references"
    refs.mkdir()
    (refs / "tool_inventory.md").write_text("# tool inventory\n", encoding="utf-8")


def _seed_existing(target: Path, version: str | None) -> None:
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("# klodi — stale on-disk\n", encoding="utf-8")
    if version is not None:
        (target / _MARKER).write_text(f"{version}\n", encoding="utf-8")


def _run(argv: list[str]) -> tuple[int, str]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = main(argv)
    return code, buf.getvalue()


class TestSetupCliVersionAware(unittest.TestCase):
    def test_no_reseed_cannot_strand_a_stale_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            hermes_home = root / "hermes"
            _seed_existing(klodi_home / "skill", _STALE)
            _seed_existing(hermes_home / "skills" / "klodi", _STALE)
            source = root / "bundle"
            _seed_source(source)

            code, out = _run([
                "--klodi-home", str(klodi_home),
                "--hermes-home", str(hermes_home),
                "--skill-source", str(source),
                "--no-reseed",
            ])

            self.assertEqual(code, 0)
            # Both trees upgraded to the bundle despite --no-reseed.
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            index = hermes_home / "skills" / "klodi"
            self.assertEqual(
                (index / "SKILL.md").read_text(encoding="utf-8"), _BUNDLE_SKILL_MD
            )
            self.assertEqual(
                (index / _MARKER).read_text(encoding="utf-8"),
                f"{_BUNDLE_VERSION}\n",
            )
            # Summary is truthful: skill reseeded, index path shown (the
            # index line is neither a skip nor a failure).
            self.assertIn("reseeded", out)
            self.assertIn(f"skill index: {index}", out)
            self.assertNotIn("skill index: (skipped", out)
            self.assertNotIn("skill index: FAILED", out)

    def test_no_reseed_logs_deprecation_and_is_inert(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "bundle"
            _seed_source(source)
            with_flag = root / "with_flag"
            without_flag = root / "without_flag"

            with self.assertLogs("klodi_hermes.setup", level="WARNING") as cm:
                _run([
                    "--klodi-home", str(with_flag / "klodi"),
                    "--hermes-home", str(with_flag / "hermes"),
                    "--skill-source", str(source),
                    "--no-reseed",
                ])
            self.assertTrue(
                any("no_reseed" in m or "no-reseed" in m for m in cm.output),
                f"expected a --no-reseed deprecation log, got: {cm.output}",
            )

            _run([
                "--klodi-home", str(without_flag / "klodi"),
                "--hermes-home", str(without_flag / "hermes"),
                "--skill-source", str(source),
            ])

            # Identical on-disk result with or without the flag.
            self.assertEqual(
                (with_flag / "klodi" / "skill" / "SKILL.md").read_text(
                    encoding="utf-8"
                ),
                (without_flag / "klodi" / "skill" / "SKILL.md").read_text(
                    encoding="utf-8"
                ),
            )
            self.assertEqual(
                (with_flag / "klodi" / "skill" / _MARKER).read_text(encoding="utf-8"),
                (without_flag / "klodi" / "skill" / _MARKER).read_text(
                    encoding="utf-8"
                ),
            )

    def test_current_homes_are_not_rechurned(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            hermes_home = root / "hermes"
            _seed_existing(klodi_home / "skill", _BUNDLE_VERSION)
            _seed_existing(hermes_home / "skills" / "klodi", _BUNDLE_VERSION)
            source = root / "bundle"
            _seed_source(source)

            skill_md = klodi_home / "skill" / "SKILL.md"
            index_md = hermes_home / "skills" / "klodi" / "SKILL.md"
            before = (skill_md.stat().st_mtime_ns, index_md.stat().st_mtime_ns)

            code, out = _run([
                "--klodi-home", str(klodi_home),
                "--hermes-home", str(hermes_home),
                "--skill-source", str(source),
            ])

            self.assertEqual(code, 0)
            # Neither tree re-copied: distinct on-disk content survives.
            self.assertEqual(
                skill_md.read_text(encoding="utf-8"), "# klodi — stale on-disk\n"
            )
            self.assertEqual(
                (skill_md.stat().st_mtime_ns, index_md.stat().st_mtime_ns), before
            )
            self.assertIn("already current", out)

    def test_stale_index_rebuilt_while_current_skill_untouched(self) -> None:
        """BR-5: the skill bundle and the Hermes index are independent
        decisions. A current skill must not block an index rebuild."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            hermes_home = root / "hermes"
            _seed_existing(klodi_home / "skill", _BUNDLE_VERSION)  # current
            _seed_existing(hermes_home / "skills" / "klodi", _STALE)  # stale
            source = root / "bundle"
            _seed_source(source)

            code, _ = _run([
                "--klodi-home", str(klodi_home),
                "--hermes-home", str(hermes_home),
                "--skill-source", str(source),
            ])

            self.assertEqual(code, 0)
            # Skill untouched (still the distinct on-disk content)...
            self.assertEqual(
                (klodi_home / "skill" / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — stale on-disk\n",
            )
            # ...but the index was rebuilt to the bundle.
            self.assertEqual(
                (hermes_home / "skills" / "klodi" / "SKILL.md").read_text(
                    encoding="utf-8"
                ),
                _BUNDLE_SKILL_MD,
            )

    def test_missing_source_reported_failed_distinctly(self) -> None:
        """BR-6: a missing bundle source is reported FAILED, distinct
        from an already-current skip."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            klodi_home = root / "klodi"
            hermes_home = root / "hermes"
            missing = root / "does-not-exist"

            code, out = _run([
                "--klodi-home", str(klodi_home),
                "--hermes-home", str(hermes_home),
                "--skill-source", str(missing),
            ])

            self.assertEqual(code, 0)  # boot is not crashed; failure is reported
            self.assertNotIn("already current", out)
            # The skill bundle line names the failure distinctly.
            lowered = out.lower()
            self.assertIn("fail", lowered)
            self.assertFalse((klodi_home / "skill").exists())


if __name__ == "__main__":
    unittest.main()
