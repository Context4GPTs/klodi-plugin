#!/usr/bin/env python3
"""Stamp pyproject.toml#version into Hermes-side mirrors of the version.

Two places drift if we don't actively sync them:

  • plugin.yaml         — Hermes reads `version:` here when it lists
                          installed plugins. Out-of-sync versions show
                          a stale string in `hermes plugins list`.
  • README.md (etc.)    — any GitHub URL of shape
                          github.com/Context4GPTs/klodi-plugin/(blob|tree)/v<X.Y.Z>/
                          gets rewritten so docs link to the version
                          actually being shipped.

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
# plugin.yaml ships inside the package — `src/klodi_hermes/plugin.yaml`
# — so the wheel's package_data picks it up at install time. Hand-rolled
# layout knowledge here rather than globbing because the path is stable
# and a bad match would be a silent no-op (which is exactly how this
# script lost the stamp through 0.2.1).
PLUGIN_YAML = HERE / "src" / "klodi_hermes" / "plugin.yaml"

# Files scanned for versioned GitHub URLs. Add as new docs land.
URL_TARGETS = [
    HERE / "README.md",
    PLUGIN_YAML,
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


def stamp_plugin_yaml(version: str) -> bool:
    """Sync plugin.yaml's `version:` line. Returns True if file changed."""
    if not PLUGIN_YAML.exists():
        return False
    text = PLUGIN_YAML.read_text(encoding="utf-8")
    new = re.sub(
        r"^(version:\s*)\d+\.\d+\.\d+(\s*)$",
        rf"\g<1>{version}\g<2>",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if new == text:
        return False
    PLUGIN_YAML.write_text(new, encoding="utf-8")
    print(f"[stamp-version] plugin.yaml → {version}")
    return True


def stamp_urls(version: str) -> int:
    """Rewrite versioned GitHub URLs to v{version}. Returns file count changed."""
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


def main() -> int:
    version = read_version()
    yaml_changed = stamp_plugin_yaml(version)
    url_files = stamp_urls(version)
    if not yaml_changed and url_files == 0:
        print(f"[stamp-version] already at {version}; no changes.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
