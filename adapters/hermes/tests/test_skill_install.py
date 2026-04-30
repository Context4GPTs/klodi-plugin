"""Tests for the klodi_hermes skill registration path.

The Hermes plugin SDK (v0.3.0+) exposes ``ctx.register_skill(name,
skill_md_path)`` for plugins to advertise their bundled skills. Plugins
ship their skills under ``${plugin_dir}/skills/<name>/SKILL.md`` and
the SDK namespaces them as ``<plugin>:<skill>`` — no filesystem copy
into ``${HERMES_HOME}/skills/`` is required, and Hermes prevents
collisions with built-in skills by design.

The plugin's ``register(ctx)`` must iterate the bundled skills dir and
register each skill. Without this, ``skill_view("klodi:klodi")`` fails
with an unknown-skill error and the user has to install SKILL.md by
hand via the built-in ``skill_manage`` tool — exactly the UX regression
that motivated this change.
"""

from __future__ import annotations

import importlib
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock


_HERMES_DIR = Path(__file__).resolve().parent.parent            # adapters/hermes
_SRC_DIR = _HERMES_DIR / "src"                                  # adapters/hermes/src
if str(_SRC_DIR) not in sys.path:
    sys.path.insert(0, str(_SRC_DIR))


_hermes_pkg = importlib.import_module("klodi_hermes")
_register_skills = _hermes_pkg._register_skills


def _seed_skill(plugin_dir: Path, name: str, *, with_skillmd: bool = True) -> Path:
    """Create a plugin-bundled skill subtree and return the SKILL.md path."""
    skill = plugin_dir / "skills" / name
    skill.mkdir(parents=True)
    skill_md = skill / "SKILL.md"
    if with_skillmd:
        skill_md.write_text(
            f"# {name} — agent playbook\n", encoding="utf-8"
        )
    return skill_md


class TestRegisterSkills(unittest.TestCase):
    def test_registers_single_bundled_skill(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            skill_md = _seed_skill(plugin_dir, "klodi")
            ctx = MagicMock()

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 1)
            ctx.register_skill.assert_called_once_with("klodi", skill_md)

    def test_registers_every_skill_under_skills_dir_sorted(self) -> None:
        """Every skills/<name>/SKILL.md must be registered. Order is
        deterministic (sorted) so boot logs and downstream behaviour
        stay reproducible across filesystems."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            # Seed in non-sorted order — expect the call order to be sorted.
            zz = _seed_skill(plugin_dir, "zz-last")
            aa = _seed_skill(plugin_dir, "aa-first")
            mm = _seed_skill(plugin_dir, "mm-middle")
            ctx = MagicMock()

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 3)
            names_in_order = [
                call.args[0] for call in ctx.register_skill.call_args_list
            ]
            self.assertEqual(names_in_order, ["aa-first", "mm-middle", "zz-last"])
            paths_in_order = [
                call.args[1] for call in ctx.register_skill.call_args_list
            ]
            self.assertEqual(paths_in_order, [aa, mm, zz])

    def test_skips_subdir_without_skillmd(self) -> None:
        """A broken/incomplete skill bundle (dir exists, SKILL.md
        missing) must not raise or register a phantom entry — log and
        skip. Prevents a half-packaged upload from crashing the gateway
        on boot."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            (plugin_dir / "skills" / "broken").mkdir(parents=True)
            good = _seed_skill(plugin_dir, "klodi")
            ctx = MagicMock()

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 1)
            ctx.register_skill.assert_called_once_with("klodi", good)

    def test_skips_non_directory_entries_under_skills(self) -> None:
        """Stray files under skills/ (README.md, .DS_Store, etc.) must
        be ignored — only directories are skill bundles."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            (plugin_dir / "skills").mkdir()
            (plugin_dir / "skills" / "README.md").write_text(
                "stray\n", encoding="utf-8"
            )
            skill_md = _seed_skill(plugin_dir, "klodi")
            ctx = MagicMock()

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 1)
            ctx.register_skill.assert_called_once_with("klodi", skill_md)

    def test_noop_when_skills_dir_missing(self) -> None:
        """A plugin shipped without a skills/ dir (dev setup, minimal
        adapter) must not crash plugin boot — the tool surface still
        works."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            # No skills/ subtree.
            ctx = MagicMock()

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 0)
            ctx.register_skill.assert_not_called()

    def test_swallows_register_failure_and_continues(self) -> None:
        """A raise from ctx.register_skill for one skill must not block
        the others from registering — one bad SKILL.md is a soft
        failure, not a plugin-wide outage."""
        with tempfile.TemporaryDirectory() as tmp:
            plugin_dir = Path(tmp)
            _seed_skill(plugin_dir, "broken")
            good = _seed_skill(plugin_dir, "klodi")
            ctx = MagicMock()

            def _register(name: str, path: Path) -> None:
                if name == "broken":
                    raise RuntimeError("simulated SDK reject")

            ctx.register_skill.side_effect = _register

            count = _register_skills(ctx, plugin_dir)

            self.assertEqual(count, 1)  # Only the good skill counts.
            # Both calls were attempted; only one succeeded.
            self.assertEqual(ctx.register_skill.call_count, 2)
            called_names = [c.args[0] for c in ctx.register_skill.call_args_list]
            self.assertIn("broken", called_names)
            self.assertIn("klodi", called_names)


if __name__ == "__main__":
    unittest.main()
