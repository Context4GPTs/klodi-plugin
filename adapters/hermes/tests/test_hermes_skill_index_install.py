"""Tests for ``install_hermes_skill_index`` — the legacy-pattern skill
copy that makes a Hermes plugin's bundled skill discoverable in the
agent's ``<available_skills>`` index and in ``hermes skills list``.

Why this exists (and why ``ctx.register_skill`` alone is not enough):

* Plugins register skills via ``ctx.register_skill("klodi", path)``.
  This makes the skill loadable as ``skill_view("klodi:klodi")``.
* It does NOT advertise the skill in the prompt-builder's
  ``<available_skills>`` block (``hermes/agent/prompt_builder.py``
  line 833) nor in ``hermes skills list``
  (``hermes/tools/skills_tool.py`` line 671). Both of those scan
  ``${HERMES_HOME}/skills/`` only — the SDK registration is invisible
  to them.
* Hermes' "build a plugin" docs document the legacy pattern of also
  copying the skill bundle into ``${HERMES_HOME}/skills/<name>/`` so
  it appears in both surfaces. ``install_hermes_skill_index`` is
  ``klodi-hermes-setup``'s implementation of that legacy copy.

Filesystem contract (the **version-aware** contract these tests pin):

* Source directory must exist and be a directory; otherwise the
  function logs a warning and returns ``None`` — a missing source is
  a degraded install, not a fatal one. ``${hermes_home}/skills/`` must
  NOT be created in that branch.
* The install is governed UNCONDITIONALLY by the on-disk-vs-bundle
  version (a dotfile ``.klodi-skill-version`` marker), NOT by the
  ``reseed`` flag. A stale or unmarked index is rebuilt even when
  ``reseed=False`` — a wrong deploy flag must never strand a stale
  index (the bug this card closes). The marker is stamped LAST, after
  a successful copytree.
* An index already at the same-or-newer version is left untouched and
  the existing path is returned (idempotent — no every-boot churn, no
  version regression).
* The function MUST create ``${hermes_home}/skills/`` if missing —
  Hermes only mints that directory lazily on the first
  ``skill_manage`` call, so a fresh ``HERMES_HOME`` typically has
  no ``skills/`` subdirectory yet.

Import style mirrors ``test_skill_install.py`` / ``test_register.py``:
``setup_cli`` uses relative imports, so it must be loaded as a
``klodi_hermes`` package member. ``importlib.import_module`` avoids
the ``klodi_hermes.register`` shadow trap noted in test_register.py.
"""

from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path


_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))

# Make the unvendored monorepo nats-client importable so loading
# ``klodi_hermes`` (which pulls ``.client`` -> ``klodi_nats_client``)
# does not fail in the dev tree. In an installed-from-wheel venv the
# vendored ``_klodi_hermes_natsclient`` peer covers the same import,
# so this shim is a no-op there. Mirrors the layout
# ``scripts/vendor.py`` produces at build time.
_NATS_CLIENT_SRC = (
    _HERMES_DIR.parent.parent / "packages" / "nats-client-py" / "src"
)
if _NATS_CLIENT_SRC.is_dir() and str(_NATS_CLIENT_SRC) not in sys.path:
    sys.path.insert(0, str(_NATS_CLIENT_SRC))


# Resolved at module load: same shape as test_register.py. If
# ``setup_cli`` ever stops exposing ``install_hermes_skill_index``
# this raises AttributeError on collection — the precise signal we
# want for the RED phase of TDD.
_setup_cli_mod = importlib.import_module("klodi_hermes.setup_cli")
install_hermes_skill_index = _setup_cli_mod.install_hermes_skill_index

_MARKER = ".klodi-skill-version"
_BUNDLE_VERSION = "0.3.5"
_BUNDLE_SKILL_MD = "# klodi — agent playbook\n\nFresh bundle.\n"


def _seed_bundle(source: Path) -> None:
    """Lay down a representative klodi skill bundle on disk.

    Mirrors what ``scripts/copy-skill.py`` produces inside the wheel
    at ``klodi_hermes/skills/klodi/`` — SKILL.md plus the references
    subtree the plugin advertises in its prompt. Keeping the seed
    realistic guards against a regression that copies SKILL.md but
    drops the references/ tree (the agent loads from references/ at
    every tool call, so a missing tree is silent UX rot).

    The shipped bundle carries NO version marker — the bundle version
    is the wheel version, supplied by the caller. The install stamps
    the target's ``.klodi-skill-version`` marker itself.
    """
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(_BUNDLE_SKILL_MD, encoding="utf-8")
    refs = source / "references"
    refs.mkdir()
    (refs / "tool_inventory.md").write_text(
        "# tool inventory\n",
        encoding="utf-8",
    )
    policies = source / "policies"
    policies.mkdir()
    (policies / "negotiation.md").write_text(
        "# negotiation policy\n",
        encoding="utf-8",
    )
    templates = source / "templates"
    templates.mkdir()
    (templates / "sell.md").write_text(
        "# sell template\n",
        encoding="utf-8",
    )


def _seed_existing_index(target: Path, version: str | None) -> None:
    """Create a warm ``${hermes_home}/skills/klodi/`` from a prior
    install, optionally stamped at ``version`` (``None`` = legacy
    unmarked tree). Carries a distinct SKILL.md + a STALE.md so a
    rebuild (rmtree) vs a copy-over can be told apart."""
    target.mkdir(parents=True)
    (target / "SKILL.md").write_text("# klodi — stale on-disk\n", encoding="utf-8")
    (target / "STALE.md").write_text("# stale\n", encoding="utf-8")
    if version is not None:
        (target / _MARKER).write_text(f"{version}\n", encoding="utf-8")


class TestInstallHermesSkillIndex(unittest.TestCase):
    def test_copies_full_bundle_into_hermes_skills_dir(self) -> None:
        """Happy path (absent target): source -> ${hermes_home}/skills/
        klodi/ with the full subtree intact AND a stamped marker."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            hermes_home.mkdir()
            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            expected = hermes_home / "skills" / "klodi"
            self.assertEqual(target, expected)
            self.assertTrue(expected.is_dir())
            self.assertEqual(
                (expected / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertTrue((expected / "references" / "tool_inventory.md").is_file())
            # The freshness marker is stamped, as a dotfile.
            self.assertEqual(
                (expected / _MARKER).read_text(encoding="utf-8"),
                f"{_BUNDLE_VERSION}\n",
            )

    def test_returns_none_when_source_missing(self) -> None:
        """A missing source path is a soft failure: log a warning and
        return None. ``${hermes_home}/skills/`` must NOT be created in
        this branch — creating an empty parent dir for a no-op install
        would leave the operator a misleading footprint."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            hermes_home.mkdir()
            source = root / "missing"  # never created

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            self.assertIsNone(target)
            self.assertFalse((hermes_home / "skills").exists())

    def test_no_reseed_still_upgrades_when_bundle_newer(self) -> None:
        """Rewritten contract: ``reseed=False`` no longer refuses. When
        the bundle is newer than the on-disk index, the index is
        rebuilt even under ``--no-reseed`` — a wrong deploy flag must
        never strand a stale index in ``<available_skills>``."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            _seed_existing_index(existing, "0.3.4")  # older than bundle

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION, reseed=False
            )

            self.assertEqual(target, existing)
            # The stale index was replaced with the fresh bundle.
            self.assertEqual(
                (existing / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertFalse((existing / "STALE.md").exists())
            self.assertEqual(
                (existing / _MARKER).read_text(encoding="utf-8"),
                f"{_BUNDLE_VERSION}\n",
            )

    def test_stale_marked_index_is_rebuilt(self) -> None:
        """A marked-but-older index is removed and copied fresh.
        Pinning the *removal* matters: a copy-over without rmtree would
        leave stale files (e.g. a renamed reference) lingering and the
        agent would read inconsistent state."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            _seed_existing_index(existing, "0.3.4")

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(target, existing)
            self.assertFalse((existing / "STALE.md").exists())
            self.assertEqual(
                (existing / "SKILL.md").read_text(encoding="utf-8"),
                _BUNDLE_SKILL_MD,
            )
            self.assertTrue(
                (existing / "references" / "tool_inventory.md").is_file()
            )

    def test_unmarked_index_is_rebuilt(self) -> None:
        """A legacy warm volume (index seeded before markers existed)
        has no marker — it must be treated as older-than-any-bundle and
        rebuilt (fail-safe toward reseed)."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            _seed_existing_index(existing, None)  # no marker

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION, reseed=False
            )

            self.assertEqual(target, existing)
            self.assertFalse((existing / "STALE.md").exists())
            self.assertEqual(
                (existing / _MARKER).read_text(encoding="utf-8"),
                f"{_BUNDLE_VERSION}\n",
            )

    def test_same_version_index_left_untouched(self) -> None:
        """An index already at the bundle version is a no-op: the
        existing path is returned and the tree is not re-copied."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            _seed_existing_index(existing, _BUNDLE_VERSION)

            source = root / "bundle"
            _seed_bundle(source)

            before = (existing / "SKILL.md").stat().st_mtime_ns
            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(target, existing)
            # Untouched: the distinct on-disk content survives.
            self.assertEqual(
                (existing / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — stale on-disk\n",
            )
            self.assertTrue((existing / "STALE.md").exists())
            self.assertEqual((existing / "SKILL.md").stat().st_mtime_ns, before)

    def test_newer_ondisk_index_not_regressed(self) -> None:
        """An index newer than the bundle (rollback) is left untouched."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            _seed_existing_index(existing, "9.9.9")

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(target, existing)
            self.assertEqual(
                (existing / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — stale on-disk\n",
            )

    def test_creates_skills_parent_dir_when_missing(self) -> None:
        """A fresh HERMES_HOME has no ``skills/`` directory — Hermes
        only mints it on the first ``skill_manage`` call. The installer
        runs before any agent boot, so it MUST create the parent.
        Without this guard the copy fails or no-ops silently."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            hermes_home.mkdir()
            # Deliberately do NOT create hermes_home / "skills".
            self.assertFalse((hermes_home / "skills").exists())

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, version=_BUNDLE_VERSION
            )

            self.assertEqual(target, hermes_home / "skills" / "klodi")
            self.assertTrue((hermes_home / "skills").is_dir())
            self.assertTrue(
                (hermes_home / "skills" / "klodi" / "SKILL.md").is_file()
            )


if __name__ == "__main__":
    unittest.main()
