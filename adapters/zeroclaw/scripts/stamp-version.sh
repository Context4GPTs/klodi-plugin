#!/usr/bin/env bash
#
# Stamp Cargo.toml#version into klodi-zeroclaw-side mirrors of the version.
# Mirrors klodi-plugin/adapters/openclaw/scripts/stamp-version.mjs.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ADAPTER_DIR"

# awk avoids the Python-3.11+ tomllib dep so this works on stock python3 (3.10).
VERSION="$(awk -F'"' '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $2;exit}' Cargo.toml)"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[stamp-version] refusing: Cargo.toml#version is not plain semver ($VERSION)" >&2
  exit 1
fi

TARGETS=("README.md")

python3 - "${TARGETS[@]}" "$VERSION" <<'PY'
import re, sys
from pathlib import Path

*paths, version = sys.argv[1:]
url_re = re.compile(
    r"(github\.com/Context4GPTs/klodi-plugin/(?:blob|tree)/)v\d+\.\d+\.\d+(/)"
)
changed = 0
for raw in paths:
    p = Path(raw)
    if not p.exists():
        continue
    text = p.read_text(encoding="utf-8")
    new = url_re.sub(rf"\g<1>v{version}\g<2>", text)
    if new != text:
        p.write_text(new, encoding="utf-8")
        print(f"[stamp-version] {p} URLs → v{version}")
        changed += 1

if changed == 0:
    print(f"[stamp-version] already at v{version}; no changes.")
PY
