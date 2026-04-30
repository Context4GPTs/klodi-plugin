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

Filesystem contract (the contract these tests pin):

* Source directory must exist and be a directory; otherwise the
  function logs a warning and returns ``None`` — a missing source is
  a degraded install, not a fatal one (matches ``seed_skill_dir``'s
  posture so a curl-pipe installer keeps working when the bundle is
  shipped via a separate channel).
* When ``${hermes_home}/skills/klodi/`` already exists and
  ``reseed=False``, the existing tree must be left untouched (a user
  may have customised SKILL.md) and the function returns ``None``
  with an error log. Mirrors P3-19 Option A applied to
  ``seed_skill_dir``.
* When the target exists and ``reseed=True`` (default), the prior
  tree is removed and a fresh copy lands.
* The function MUST create ``${hermes_home}/skills/`` if missing —
  Hermes only mints that directory lazily on the first
  ``skill_manage`` call, so a fresh ``HERMES_HOME`` typically has
  no ``skills/`` subdirectory yet. Without this guard the install
  silently no-ops on first-run setups.

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


def _seed_bundle(source: Path) -> None:
    """Lay down a representative klodi skill bundle on disk.

    Mirrors what ``scripts/copy-skill.py`` produces inside the wheel
    at ``klodi_hermes/skills/klodi/`` — SKILL.md plus the references
    subtree the plugin advertises in its prompt. Keeping the seed
    realistic guards against a regression that copies SKILL.md but
    drops the references/ tree (the agent loads from references/ at
    every tool call, so a missing tree is silent UX rot).
    """
    source.mkdir(parents=True)
    (source / "SKILL.md").write_text(
        "# klodi — agent playbook\n\nFresh bundle.\n",
        encoding="utf-8",
    )
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


class TestInstallHermesSkillIndex(unittest.TestCase):
    def test_copies_full_bundle_into_hermes_skills_dir(self) -> None:
        """Happy path: source -> ${hermes_home}/skills/klodi/ with the
        full subtree (SKILL.md + references/) intact."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            hermes_home.mkdir()
            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(hermes_home, source)

            expected = hermes_home / "skills" / "klodi"
            self.assertEqual(target, expected)
            self.assertTrue(expected.is_dir())
            # SKILL.md content is byte-identical with the source.
            self.assertEqual(
                (expected / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — agent playbook\n\nFresh bundle.\n",
            )
            # The full reference subtree comes along — not just SKILL.md.
            self.assertTrue((expected / "references" / "tool_inventory.md").is_file())

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

            target = install_hermes_skill_index(hermes_home, source)

            self.assertIsNone(target)
            self.assertFalse((hermes_home / "skills").exists())

    def test_no_reseed_refuses_to_overwrite(self) -> None:
        """``reseed=False`` must preserve a user-customised
        ${hermes_home}/skills/klodi/SKILL.md. Returning None lets the
        installer surface a clear error to the operator."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            existing.mkdir(parents=True)
            user_md = existing / "SKILL.md"
            user_customised = (
                "# klodi — operator-customised\n\nDo not overwrite me.\n"
            )
            user_md.write_text(user_customised, encoding="utf-8")

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(
                hermes_home, source, reseed=False
            )

            self.assertIsNone(target)
            # The customised file is byte-for-byte unchanged.
            self.assertEqual(
                user_md.read_text(encoding="utf-8"),
                user_customised,
            )
            # And no fresh subtree was sneaked in either.
            self.assertFalse((existing / "references").exists())

    def test_reseed_true_replaces_existing(self) -> None:
        """``reseed=True`` (default) must remove the prior tree and
        copy the source fresh. Pinning the *removal* matters: if the
        implementation only copies-over without rmtree, stale files
        from the old install (e.g. a renamed reference) would linger
        and the agent would read inconsistent state."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            hermes_home = root / "hermes_home"
            existing = hermes_home / "skills" / "klodi"
            existing.mkdir(parents=True)
            stale = existing / "STALE.md"
            stale.write_text("# stale\n", encoding="utf-8")
            (existing / "SKILL.md").write_text(
                "# old version\n",
                encoding="utf-8",
            )

            source = root / "bundle"
            _seed_bundle(source)

            target = install_hermes_skill_index(hermes_home, source)

            self.assertEqual(target, existing)
            # Stale file removed.
            self.assertFalse(stale.exists())
            # SKILL.md is the new content from the source bundle.
            self.assertEqual(
                (existing / "SKILL.md").read_text(encoding="utf-8"),
                "# klodi — agent playbook\n\nFresh bundle.\n",
            )
            # The full references/ subtree is present.
            self.assertTrue(
                (existing / "references" / "tool_inventory.md").is_file()
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

            target = install_hermes_skill_index(hermes_home, source)

            self.assertEqual(target, hermes_home / "skills" / "klodi")
            self.assertTrue((hermes_home / "skills").is_dir())
            self.assertTrue(
                (hermes_home / "skills" / "klodi" / "SKILL.md").is_file()
            )


if __name__ == "__main__":
    unittest.main()
