#!/usr/bin/env python3
"""Vendor klodi-nats-client into a staged copy of the Hermes adapter.

klodi-nats-client is the Python port of @klodi/nats-client and is NOT
published to PyPI as a standalone package (Private :: Do Not Upload
classifier on packages/nats-client-py/pyproject.toml). Instead, every
host adapter ships its own privately-namespaced copy so consumers
install a single self-contained wheel.

The staged copy under build/staged/ is what `python -m build` runs
against — the source tree under adapters/hermes/ is never modified, so
local dev (`pytest`, `python -c "from klodi_nats_client import ..."`)
keeps working against the workspace dep.

Build flow (driven by the Makefile):
    1.  copy-skill.py       — copies klodi-plugin/skill/ into the
                              package at src/klodi_hermes/skills/klodi/
    2.  vendor.py (this)    — stages the adapter + vendored client
    3.  python -m build     — runs from build/staged/, emits to ./dist/

Per-adapter private namespace: `_klodi_hermes_natsclient`. The leading
underscore + adapter name combination guarantees no collision when a
user installs multiple klodi-* adapters into the same environment.

The vendored copy lands at `build/staged/src/_klodi_hermes_natsclient/`
as a peer of `src/klodi_hermes/`. The staged pyproject.toml's
`[tool.setuptools.packages.find] where=["src"]` discovers both packages
without any pyproject patching.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

# Adapter root = parent of scripts/.
HERE = Path(__file__).resolve().parent.parent
# Repo root = klodi-plugin/.
REPO_ROOT = HERE.parent.parent
SHARED_SRC = REPO_ROOT / "packages" / "nats-client-py" / "src" / "klodi_nats_client"
STAGED = HERE / "build" / "staged"
STAGED_SRC = STAGED / "src"

# Vendored namespace inside the wheel. Underscore + adapter slug keeps
# multiple klodi-* adapters from clashing on import in a shared env.
ADAPTER_SLUG = "hermes"
VENDORED_NAME = f"_klodi_{ADAPTER_SLUG}_natsclient"

# Source-tree noise that should never reach the staged copy. Matches
# anywhere in the relative path; egg-info / __pycache__ / build / dist
# are local build artefacts, not adapter source.
COPY_EXCLUDES = (
    "__pycache__",
    ".egg-info",
    "build",
    "dist",
    ".venv",
    ".pytest_cache",
    "node_modules",
    # The vendored target itself, in case a previous run left it.
    VENDORED_NAME,
)


def should_skip(path: Path) -> bool:
    parts = path.parts
    return any(any(token in part for token in COPY_EXCLUDES) for part in parts)


def stage_adapter() -> None:
    """Copy adapter source into build/staged/, skipping local build noise."""
    if STAGED.exists():
        shutil.rmtree(STAGED)
    STAGED.mkdir(parents=True)

    for entry in HERE.iterdir():
        # Don't recursively copy build/ into itself.
        if entry == STAGED.parent:
            continue
        if should_skip(entry.relative_to(HERE)):
            continue
        target = STAGED / entry.name
        if entry.is_dir():
            shutil.copytree(
                entry,
                target,
                ignore=shutil.ignore_patterns(*COPY_EXCLUDES),
            )
        else:
            shutil.copy2(entry, target)
    print(f"[vendor] staged adapter at {STAGED}")


def stage_shared_client() -> None:
    """Copy klodi_nats_client/ into the staged src/ under the private name."""
    if not SHARED_SRC.exists():
        sys.stderr.write(
            f"[vendor] missing shared client source at {SHARED_SRC}\n"
            "         — workspace layout is broken\n"
        )
        raise SystemExit(1)

    target = STAGED_SRC / VENDORED_NAME
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        SHARED_SRC,
        target,
        ignore=shutil.ignore_patterns(*COPY_EXCLUDES),
    )
    print(f"[vendor] copied klodi_nats_client → src/{VENDORED_NAME}/")


def rewrite_imports() -> int:
    """Replace `klodi_nats_client` with the vendored name in every staged .py.

    Word-boundary regex catches every Python reference (import, from,
    attribute access, string literals) without matching unrelated tokens
    like `klodi-nats-client` (hyphenated, used in docstrings).

    Walks the entire staged src/ — both klodi_hermes/ (which references
    klodi_nats_client externally) and _klodi_hermes_natsclient/ itself
    (which uses absolute self-imports, see packages/nats-client-py/src/
    klodi_nats_client/__init__.py).
    """
    pattern = re.compile(r"\bklodi_nats_client\b")
    rewritten = 0
    for py in STAGED.rglob("*.py"):
        text = py.read_text(encoding="utf-8")
        new = pattern.sub(VENDORED_NAME, text)
        if new != text:
            py.write_text(new, encoding="utf-8")
            rewritten += 1
    print(f"[vendor] rewrote imports in {rewritten} file(s)")
    return rewritten


def main() -> int:
    stage_adapter()
    stage_shared_client()
    rewrite_imports()
    print(f"[vendor] done — staged tree ready at {STAGED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
