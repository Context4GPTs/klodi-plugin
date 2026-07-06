#!/usr/bin/env bash
# Enforce catalog-request/reply ↔ registered-by-name symmetry (the THIRD axis).
#
# Why this gate exists: the `klodiTools` catalog (packages/tool-catalog/src/index.ts)
# is the advertised request/reply capability surface — every name it declares is a
# promise "call this name and it resolves on the gateway". The openclaw adapter
# registers each request/reply tool INDIVIDUALLY BY NAME (`api.registerTool({name:…})`),
# so a `klodiTools` key consumed only as a `.subject` (never claimed as a registerTool
# name) is a ghost: declared in the catalog, never exposed on the gateway, 404s when
# called. The standalone searches-delete catalog tool was exactly that ghost (this
# since removed; the p2p.v1.searches.delete subject survives under klodi_unwatch).
#
# The two existing gates cannot see this axis (ADR-0014):
#   - check-openclaw-manifest-tools.sh : manifest ↔ registered  (is-declared)
#   - check-adapter-tools.sh           : referenced ⊆ catalog    (should-be-registered)
# Neither reads `klodiTools` to assert a request/reply key is registered under its
# own name. This gate closes that gap.
#
# The contract it enforces — a ONE-DIRECTIONAL subset check on the CATALOG side:
#
#   For every request/reply catalog key in `Object.keys(klodiTools)`, there MUST be
#   a matching static `name: "<key>"` literal inside an `api.registerTool({…})`
#   block in adapters/openclaw/src/tools/*.ts. A catalog key with no such
#   registration is a ghost → the gate exits non-zero and names it.
#
# The comparison is keyed on the CATALOG side deliberately. The openclaw `name:`
# literals legitimately ALSO include LOCAL-tool names (klodi_unwatch, klodi_watch,
# klodi_health, klodi_register, klodi_setup_*, klodi_match_feedback,
# klodi_channel_message) that are intentionally NOT 1:1 request/reply catalog keys.
# Those extra registered names are simply not in the compared (catalog) set, so they
# are never flagged. The only failure is a request/reply catalog key with no
# registration — never a registered local tool.
#
# CATALOG-KEY EXTRACTION: the gate reads the `klodiTools` object literal in the
# catalog source (index.ts) and takes its TOP-LEVEL keys only — lines matching
# `^  <snake_case>: {` (exactly 2-space indent + key + ": {") between the
# `export const klodiTools = {` opener and its matching close brace. Nested body
# fields (`subject:`, `params:`, `result:` at 4+ space indent) and keys of any OTHER
# const (e.g. KLODI_CATALOG_CONSTANTS) are excluded by construction — the brace-depth
# scope ends at the klodiTools close, and the 2-space-exact anchor rejects nested keys.
#
# REGISTERED-NAME EXTRACTION: identical to check-openclaw-manifest-tools.sh — static
# `name: "klodi_…"` literals within a small window after an `api.registerTool({`
# opener. Scoping to that window excludes non-tool klodi_* tokens (log-event names,
# klodi_home object keys, stray name: fields in unrelated object literals) BY
# CONSTRUCTION — no deny-list needed.
#
# STATIC-LITERAL ASSUMPTION (documented in ADR-0014): every
# openclaw tool is registered with a static `name: "klodi_…"` literal — there are NO
# dynamically-named / interpolated tool names. If a future tool were registered with
# a computed name, this static gate could not see it — but that omission is itself the
# code smell the gate surfaces.
#
# This gate is a sibling to check-openclaw-manifest-tools.sh and check-adapter-tools.sh;
# it enforces a DISTINCT contract on distinct sources and must never be merged with
# them. See docs/decisions/0014-tool-symmetry-axes.md (the third axis is added there
# during Distillation).
#
# Env overrides (default to the real paths when unset):
#   CATALOG_SRC    — abs path to the index.ts whose `klodiTools` object literal the
#                    gate extracts request/reply keys from.
#                    Default: packages/tool-catalog/src/index.ts.
#   TOOLS_SRC_DIR  — abs path to a dir whose *.ts files are grepped for `name:`
#                    literals inside registerTool({…}) blocks.
#                    Default: adapters/openclaw/src/tools.
#
# Run:
#   bash klodi-plugin/scripts/check-catalog-registered.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CATALOG_SRC="${CATALOG_SRC:-$ROOT/packages/tool-catalog/src/index.ts}"
TOOLS_SRC_DIR="${TOOLS_SRC_DIR:-$ROOT/adapters/openclaw/src/tools}"

if [[ ! -f "$CATALOG_SRC" ]]; then
    echo "check-catalog-registered: catalog source missing at $CATALOG_SRC" >&2
    exit 2
fi
if [[ ! -d "$TOOLS_SRC_DIR" ]]; then
    echo "check-catalog-registered: tools source dir missing at $TOOLS_SRC_DIR" >&2
    exit 2
fi

# Catalog request/reply keys: TOP-LEVEL keys of the `klodiTools` object literal.
# Scope to the brace-balanced region from `export const klodiTools = {` to its
# matching close, then take lines that are exactly 2-space-indented `key: {`.
catalog_keys() {
    awk '
        # Enter the klodiTools object on its declaration line.
        /^export const klodiTools = \{/ { in_obj = 1; depth = 1; next }
        in_obj {
            # A top-level key sits at depth 1 — emit it BEFORE counting this
            # line is irrelevant since keys open their own brace, but the
            # exact 2-space anchor (no more, no less) is what scopes us to
            # direct klodiTools members and rejects nested body fields.
            if (depth == 1 && $0 ~ /^  [a-z][a-z0-9_]*: \{/) {
                key = $0
                sub(/^  /, "", key)
                sub(/:.*$/, "", key)
                print key
            }
            # Track brace depth so we stop at the matching close of klodiTools
            # (and never wander into a sibling const). Count braces on the line.
            line = $0
            opens = gsub(/\{/, "{", line)
            closes = gsub(/\}/, "}", line)
            depth += opens - closes
            if (depth <= 0) { in_obj = 0 }
        }
    ' "$CATALOG_SRC" | sort -u
}

# Registered set: static `name: "klodi_…"` literals within a small window after an
# `api.registerTool({` opener. Identical extraction to the manifest gate.
registered_names() {
    grep -rhA3 --include='*.ts' 'api\.registerTool({' "$TOOLS_SRC_DIR" 2>/dev/null \
        | grep -oE 'name:[[:space:]]*"klodi_[a-zA-Z0-9_]+"' \
        | grep -oE 'klodi_[a-zA-Z0-9_]+' \
        | sort -u \
        || true
}

catalog_file="$(mktemp)"
registered_file="$(mktemp)"
trap 'rm -f "$catalog_file" "$registered_file"' EXIT

catalog_keys > "$catalog_file"
registered_names > "$registered_file"

if [[ ! -s "$catalog_file" ]]; then
    echo "check-catalog-registered: extracted ZERO request/reply keys from $CATALOG_SRC" >&2
    echo "  (klodiTools object not found or extraction broke — refusing to pass vacuously)" >&2
    exit 2
fi

# catalog − registered: request/reply catalog keys with no openclaw registration.
# This is the ghost class. (registered − catalog is intentionally NOT checked:
# local-tool registrations are not request/reply keys and must not be flagged.)
ghosts="$(comm -23 "$catalog_file" "$registered_file" || true)"

if [[ -n "$ghosts" ]]; then
    echo "check-catalog-registered: request/reply catalog key NOT registered by name on the openclaw gateway" >&2
    echo "  (every klodiTools key must appear as a registerTool({name:…}) literal in $TOOLS_SRC_DIR" >&2
    echo "   — a catalog-only key is a ghost tool that 404s when an agent calls it):" >&2
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        echo "  - unregistered catalog key: $line" >&2
    done <<< "$ghosts"
    echo >&2
    echo "check-catalog-registered: catalog ↔ registered-by-name drift — fail." >&2
    exit 1
fi

catalog_count="$(wc -l < "$catalog_file" | tr -d '[:space:]')"
echo "check-catalog-registered: every request/reply catalog key ($catalog_count) is registered by name on the openclaw gateway (in sync)"
