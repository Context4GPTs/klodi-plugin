#!/usr/bin/env python3
"""Stamp pyproject.toml#version into nanobot-side mirrors.

Nanobot has no plugin manifest analogue to Hermes' plugin.yaml, but
the flat-layout package exposes ``__version__`` from ``__init__.py``
— `nanobot.__version__` — and that string drifts unless we sync it
explicitly here. Versioned GitHub URLs of shape
``github.com/Context4GPTs/klodi-plugin/(blob|tree)/v<X.Y.Z>/`` in
README.md (and any other doc files added later) are also rewritten.

Mirrors klodi-plugin/adapters/openclaw/scripts/stamp-version.mjs.
Idempotent: re-running with the same version is a no-op. Refuses to
stamp non-semver versions.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
PYPROJECT = HERE / "pyproject.toml"
# Flat-layout package — `__init__.py` lives next to the modules at
# the adapter root, not under a `src/<pkg>/` tree.
INIT_PY = HERE / "__init__.py"

URL_TARGETS = [
    HERE / "README.md",
]

URL_PATTERN = re.compile(
    r"(github\.com/Context4GPTs/klodi-plugin/(?:blob|tree)/)v\d+\.\d+\.\d+(/)"
)
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def read_version() -> str:
    """Pull `version = "..."` from [project] in pyproject.toml.

    Hand-rolled rather than tomllib so we work on Python 3.10 (system
    interpreter on macOS Sequoia).
    """
    section: str | None = None
    version: str | None = None
    for raw in PYPROJECT.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
            continue
        if section == "project":
            m = re.match(r'version\s*=\s*"([^"]+)"', line)
            if m:
                version = m.group(1)
                break
    if not version or not SEMVER.match(version):
        sys.stderr.write(
            f"[stamp-version] refusing to stamp non-semver version: {version!r}\n"
        )
        raise SystemExit(1)
    return version


def stamp_urls(version: str) -> int:
    tag = f"v{version}"
    changed = 0
    for path in URL_TARGETS:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        new = URL_PATTERN.sub(rf"\g<1>{tag}\g<2>", text)
        if new != text:
            path.write_text(new, encoding="utf-8")
            print(f"[stamp-version] {path.relative_to(HERE)} URLs → {tag}")
            changed += 1
    return changed


def stamp_init_py(version: str) -> bool:
    """Sync `__version__` in __init__.py. Returns True if file changed."""
    if not INIT_PY.exists():
        return False
    text = INIT_PY.read_text(encoding="utf-8")
    new = re.sub(
        r'^(__version__\s*=\s*")\d+\.\d+\.\d+(")',
        rf'\g<1>{version}\g<2>',
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if new == text:
        return False
    INIT_PY.write_text(new, encoding="utf-8")
    print(f"[stamp-version] __init__.py __version__ → {version}")
    return True


def main() -> int:
    version = read_version()
    init_changed = stamp_init_py(version)
    url_files = stamp_urls(version)
    if not init_changed and url_files == 0:
        print(f"[stamp-version] already at {version}; no changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
