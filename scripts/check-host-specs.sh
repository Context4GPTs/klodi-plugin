#!/usr/bin/env bash
# Enforce per-host spec presence (Decision 10 of the 0012 first-pass review).
#
# For every directory under klodi-plugin/adapters/, a corresponding
# klodi-plugin/docs/specs/hosts/<host>.md must exist. The spec must
# carry every section header from the template, even if the body is
# "deferred" — that way reviewers can see at a glance which questions
# the adapter author has answered.
#
# Exit non-zero if any adapter is missing its spec, or if any spec is
# missing required section headers. CI runs this in the lint stage.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTERS_DIR="$ROOT/adapters"
SPECS_DIR="$ROOT/docs/specs/hosts"
TEMPLATE="$SPECS_DIR/_template.md"

if [[ ! -d "$ADAPTERS_DIR" || ! -f "$TEMPLATE" ]]; then
    echo "check-host-specs: missing adapters dir or template" >&2
    exit 2
fi

required_sections=$(grep -E '^## [0-9]+\. ' "$TEMPLATE" | sed -E 's/^## //')

missing=()
incomplete=()

for adapter_path in "$ADAPTERS_DIR"/*/; do
    host=$(basename "$adapter_path")
    spec="$SPECS_DIR/$host.md"
    if [[ ! -f "$spec" ]]; then
        missing+=("$host")
        continue
    fi
    while IFS= read -r section; do
        if ! grep -qF "## $section" "$spec"; then
            incomplete+=("$host: missing '$section'")
        fi
    done <<<"$required_sections"
done

if (( ${#missing[@]} > 0 )); then
    echo "check-host-specs: missing per-host spec files:" >&2
    for h in "${missing[@]}"; do
        echo "  - $SPECS_DIR/$h.md (adapter at adapters/$h/)" >&2
    done
fi

if (( ${#incomplete[@]} > 0 )); then
    echo "check-host-specs: incomplete spec files:" >&2
    for entry in "${incomplete[@]}"; do
        echo "  - $entry" >&2
    done
fi

if (( ${#missing[@]} > 0 || ${#incomplete[@]} > 0 )); then
    echo >&2
    echo "Author the missing sections by copying _template.md and" >&2
    echo "filling each numbered section. Mark deferred sections explicitly" >&2
    echo "(e.g., '## 6. Skill delivery path: deferred to Phase 7')." >&2
    exit 1
fi

echo "check-host-specs: all per-host specs present and well-formed"
