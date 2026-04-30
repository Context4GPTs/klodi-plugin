#!/usr/bin/env python3
"""Extract the consolidated CHANGELOG entry for this adapter's version.

The single source of truth for release notes across every klodi adapter
is klodi-plugin/CHANGELOG.md — every adapter moves together (per the
header of that file). This script:

  • Reads the adapter's version from pyproject.toml / Cargo.toml.
  • Locates the `## [<version>]` section in the consolidated CHANGELOG.
  • Validates it exists. Fails loud if missing.
  • With --print, writes the section body to stdout (for use as a
    GitHub Release notes file: `make release-notes > NOTES.md`).

Mirrors the inline node extractor used by OpenClaw's CI workflow at
.github/workflows/klodi-plugin-release.yml.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
KLODI_PLUGIN_ROOT = HERE.parent.parent
CHANGELOG = KLODI_PLUGIN_ROOT / "CHANGELOG.md"


def read_version() -> str:
    """Pull `version = "..."` from [project] (pyproject) or [package] (Cargo).

    Hand-rolled rather than tomllib so we work on Python 3.10 (system
    interpreter on macOS Sequoia). The fields we need are simple
    `version = "x.y.z"` lines under one of two known sections.
    """
    for manifest in (HERE / "pyproject.toml", HERE / "Cargo.toml"):
        if not manifest.exists():
            continue
        section: str | None = None
        for raw in manifest.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("[") and line.endswith("]"):
                section = line[1:-1]
                continue
            if section in ("project", "package"):
                m = re.match(r'version\s*=\s*"([^"]+)"', line)
                if m:
                    return m.group(1)
    sys.stderr.write(
        f"[changelog] no [project].version (pyproject) or "
        f"[package].version (Cargo) at {HERE}\n"
    )
    raise SystemExit(1)


def extract_entry(version: str) -> str:
    if not CHANGELOG.exists():
        sys.stderr.write(
            f"[changelog] consolidated CHANGELOG missing at {CHANGELOG}\n"
        )
        raise SystemExit(1)
    text = CHANGELOG.read_text(encoding="utf-8")
    pattern = re.compile(
        rf"## \[{re.escape(version)}\][\s\S]*?(?=\n## \[|\Z)"
    )
    match = pattern.search(text)
    if not match:
        sys.stderr.write(
            f"[changelog] no `## [{version}]` entry in {CHANGELOG}\n"
            "            add a section before publishing.\n"
        )
        raise SystemExit(1)
    return match.group(0)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument(
        "--print",
        action="store_true",
        dest="print_entry",
        help="write the entry to stdout (default: validate only)",
    )
    args = p.parse_args()

    version = read_version()
    entry = extract_entry(version)
    if args.print_entry:
        sys.stdout.write(entry)
        if not entry.endswith("\n"):
            sys.stdout.write("\n")
    else:
        sys.stderr.write(
            f"[changelog] OK — found `## [{version}]` in CHANGELOG.md\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
