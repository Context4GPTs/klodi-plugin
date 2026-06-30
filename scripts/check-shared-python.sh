#!/usr/bin/env bash
# Enforce parity between the Hermes and nanobot installer modules.
#
# The two files MUST stay in sync except for two intentional differences:
#   1. Module docstring (mentions the host name).
#   2. Logger name: `klodi_hermes.hermes_installer` vs
#      `klodi_nanobot.nanobot_installer`.
#
# We diff the files after stripping these expected variations. CI calls
# this script as part of the lint stage; non-zero exit fails the build.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES="$ROOT/adapters/hermes/src/klodi_hermes/hermes_installer.py"
NANOBOT="$ROOT/adapters/nanobot/nanobot_installer.py"

if [[ ! -f "$HERMES" || ! -f "$NANOBOT" ]]; then
    echo "check-shared-python: one of the installer files is missing" >&2
    echo "  hermes:  $HERMES" >&2
    echo "  nanobot: $NANOBOT" >&2
    exit 2
fi

normalize() {
    # Strip the leading docstring (lines until the first closing """),
    # then collapse the per-host logger name to a placeholder.
    awk '
        BEGIN { in_doc = 0; past_doc = 0 }
        !past_doc && /^"""/ { if (in_doc) { in_doc = 0; past_doc = 1 } else { in_doc = 1 } ; next }
        in_doc { next }
        { print }
    ' "$1" | sed -E 's/klodi_hermes\.hermes_installer|klodi_nanobot\.nanobot_installer/klodi_<host>.<host>_installer/g'
}

if ! diff -u <(normalize "$HERMES") <(normalize "$NANOBOT") >/dev/null; then
    echo "check-shared-python: hermes and nanobot installers diverge" >&2
    diff -u <(normalize "$HERMES") <(normalize "$NANOBOT") >&2 || true
    echo >&2
    echo "Update both files together. The only allowed differences are" >&2
    echo "the module docstring and the logger name." >&2
    exit 1
fi

echo "check-shared-python: hermes / nanobot installers in sync"
