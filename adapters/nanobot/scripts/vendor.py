#!/usr/bin/env python3
"""Vendor klodi-nats-client into a staged copy of the nanobot adapter.

klodi-nats-client is the Python port of @klodi/nats-client and is NOT
published to PyPI as a standalone package (Private :: Do Not Upload
classifier on packages/nats-client-py/pyproject.toml). Instead, every
host adapter ships its own privately-namespaced copy so consumers
install a single self-contained wheel.

The staged copy under build/staged/ is what `python -m build` runs
against — the source tree under adapters/nanobot/ is never modified,
so local dev (`pytest`, `python -c "from klodi_nats_client import ..."`)
keeps working against the workspace dep.

Build flow (driven by the Makefile):
    1.  copy-skill.py       — copies klodi-plugin/skill/ to skills/klodi/
    2.  vendor.py (this)    — stages the adapter + vendored client
    3.  python -m build     — runs from build/staged/, emits to ./dist/

Per-adapter private namespace: `_klodi_nanobot_natsclient`. Underscore
+ adapter name prevents name collisions when two klodi-* adapters land
in the same Python environment.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
REPO_ROOT = HERE.parent.parent
SHARED_SRC = REPO_ROOT / "packages" / "nats-client-py" / "src" / "klodi_nats_client"
STAGED = HERE / "build" / "staged"

ADAPTER_SLUG = "nanobot"
VENDORED_NAME = f"_klodi_{ADAPTER_SLUG}_natsclient"

COPY_EXCLUDES = (
    "__pycache__",
    ".egg-info",
    "build",
    "dist",
    ".venv",
    ".pytest_cache",
    "node_modules",
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
    """Copy klodi_nats_client/ into the staged adapter under the private name."""
    if not SHARED_SRC.exists():
        sys.stderr.write(
            f"[vendor] missing shared client source at {SHARED_SRC}\n"
            "         — workspace layout is broken\n"
        )
        raise SystemExit(1)

    target = STAGED / VENDORED_NAME
    shutil.copytree(
        SHARED_SRC,
        target,
        ignore=shutil.ignore_patterns(*COPY_EXCLUDES),
    )
    print(f"[vendor] copied klodi_nats_client → {VENDORED_NAME}/")


def rewrite_imports() -> int:
    """Replace `klodi_nats_client` with the vendored name in every staged .py."""
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


def patch_pyproject() -> None:
    """Augment the staged pyproject.toml with the vendored package."""
    pyproject_path = STAGED / "pyproject.toml"
    text = pyproject_path.read_text(encoding="utf-8")

    # 1. Drop klodi-nats-client from [project].dependencies.
    text = re.sub(
        r'^\s*"klodi-nats-client[^"]*",?\s*\n',
        "",
        text,
        flags=re.MULTILINE,
    )

    # 2. Add the vendored package alongside py-modules.
    if "[tool.setuptools]" not in text:
        sys.stderr.write("[vendor] staged pyproject has no [tool.setuptools] table\n")
        raise SystemExit(1)
    if "packages =" in text:
        text = re.sub(
            r"(packages\s*=\s*\[)([^\]]*)\]",
            lambda m: f'{m.group(1)}{m.group(2).rstrip()}\n    "{VENDORED_NAME}",\n]',
            text,
            count=1,
        )
    else:
        text = text.replace(
            "[tool.setuptools]",
            f'[tool.setuptools]\npackages = ["{VENDORED_NAME}"]',
            1,
        )

    # 3. Bundle py.typed + schemas.json under the vendored namespace.
    package_data_block = (
        f'\n[tool.setuptools.package-data]\n'
        f'{VENDORED_NAME} = ["py.typed", "schemas.json"]\n'
    )
    if "[tool.setuptools.package-data]" in text:
        text = re.sub(
            r"\[tool\.setuptools\.package-data\][^\[]*",
            package_data_block.lstrip(),
            text,
            count=1,
        )
    else:
        text = text.rstrip() + package_data_block

    pyproject_path.write_text(text, encoding="utf-8")
    print("[vendor] patched staged pyproject.toml")
    # Round-trip TOML validation removed — would have required Python
    # 3.11+ tomllib, and the regex edits above are deterministic. Any
    # syntax breakage surfaces immediately when `python -m build` runs
    # against the staged pyproject in the next Makefile step.


def main() -> int:
    stage_adapter()
    stage_shared_client()
    rewrite_imports()
    patch_pyproject()
    print(f"[vendor] done — staged tree ready at {STAGED}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
