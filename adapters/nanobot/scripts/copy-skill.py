#!/usr/bin/env python3
"""Materialize the canonical klodi skill bundle into the nanobot adapter.

Sibling of ``klodi-plugin/adapters/hermes/scripts/copy-skill.py`` —
copies the authoritative ``klodi-plugin/klodi-skill/`` tree into the
nanobot adapter's ``skills/klodi/`` folder so the adapter directory
is self-contained when packaged or installed.

Idempotent: removes any stale target before copying.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent.parent / "klodi-skill"
TARGET = HERE.parent / "skills" / "klodi"


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
