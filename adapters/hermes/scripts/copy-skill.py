#!/usr/bin/env python3
"""Materialize the canonical klodi skill bundle into the Hermes adapter.

Per 0010 § "Repository and release topology" and the Hermes plugin SDK
canonical layout: a plugin's bundled skills live at
`${plugin_dir}/skills/<skill-name>/SKILL.md`. The klodi plugin exposes
its playbook via `ctx.register_skill("klodi", skills/klodi/SKILL.md)`
at plugin load time.

Build step: copy the authoritative `klodi-plugin/klodi-skill/` bundle into
`adapters/hermes/src/klodi_hermes/skills/klodi/` so the bundle ships as
package data inside the wheel. After `pip install klodi-hermes`,
`__init__.py`'s `_register_skills(ctx, Path(__file__).parent)` walks
this directory and registers every bundled skill with Hermes.

Idempotent: removes any stale target before copying.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent.parent / "klodi-skill"
TARGET = HERE.parent / "src" / "klodi_hermes" / "skills" / "klodi"


def main() -> int:
    if not SOURCE.exists():
        print(
            f"[copy-skill] canonical skill dir missing at {SOURCE}. "
            "klodi-plugin monorepo layout is broken — reinstall?",
            file=sys.stderr,
        )
        return 1

    if TARGET.exists():
        shutil.rmtree(TARGET)

    shutil.copytree(SOURCE, TARGET)
    print(f"[copy-skill] {SOURCE} -> {TARGET}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
