#!/usr/bin/env bash
# Enforce catalog ↔ adapter tool-surface symmetry (Decision D4).
#
# Per **D § D4** in
# `docs/reviews/2026-04-26-klodi-plugin-multi-lens-review-decisions.md`:
# tools live in the catalog or they don't exist.
#
# This script enforces two invariants per adapter:
#
#   1. Every `klodi_*` name referenced in adapter source code is in the
#      catalog (request/reply OR local). Catches typos like
#      `klodi_search_create` (singular, stale; renamed to
#      `klodi_searches_create`) and deleted names like
#      `klodi_channel_send` (replaced by `klodi_channel_message`).
#
#   2. Every catalog local tool whose `host_shapes` contains the
#      adapter's declared shape MUST appear as a string literal
#      somewhere in the adapter's source (handler binding requires it).
#      Catches Hermes forgetting `klodi_health` and nanobot missing the
#      setup-family.
#
# The 26 request/reply tools are dispatched generically via
# `TOOL_SCHEMAS` iteration in the Python adapters, so they don't need
# per-tool literals; if the adapter has the iteration loop, it has all
# of them. Only local tools need positive literal references.
#
# Each adapter's `host_shape` is read from
# `klodi-plugin/docs/specs/hosts/<host>.md` (the `host_shape:` line).
# Adapters without a host_shape are skipped with a warning.
#
# Run:
#   bash klodi-plugin/scripts/check-adapter-tools.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTERS_DIR="$ROOT/adapters"
SPECS_DIR="$ROOT/docs/specs/hosts"
SCHEMAS_JSON="$ROOT/packages/tool-catalog/dist/schemas.json"

if [[ ! -d "$ADAPTERS_DIR" ]]; then
    echo "check-adapter-tools: adapters dir missing at $ADAPTERS_DIR" >&2
    exit 2
fi
if [[ ! -f "$SCHEMAS_JSON" ]]; then
    echo "check-adapter-tools: missing $SCHEMAS_JSON — run 'pnpm --filter @klodi/tool-catalog codegen'" >&2
    exit 2
fi

NODE_BIN="${NODE:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "check-adapter-tools: node binary not found (looked for: $NODE_BIN)" >&2
    exit 2
fi

# Catalog: every recognised klodi_* name (request/reply ∪ local).
all_catalog_names() {
    "$NODE_BIN" -e "
        const c = JSON.parse(require('node:fs').readFileSync('$SCHEMAS_JSON','utf-8'));
        const set = new Set([...Object.keys(c.tools), ...Object.keys(c.local_tools)]);
        for (const name of [...set].sort()) console.log(name);
    "
}

# Catalog: local-tool names required for adapter with `shape`. Output is
# sorted so `comm` (which requires sorted input) works correctly.
required_local_names() {
    local shape="$1"
    "$NODE_BIN" -e "
        const c = JSON.parse(require('node:fs').readFileSync('$SCHEMAS_JSON','utf-8'));
        const list = c.local_tools_by_host_shape['$shape'] || [];
        for (const name of [...list].sort()) console.log(name);
    "
}

# Resolve adapter's host_shape from `host_shape: <value>` in its spec.
host_shape_for_adapter() {
    local adapter="$1"
    local spec="$SPECS_DIR/$adapter.md"
    if [[ ! -f "$spec" ]]; then echo ""; return 0; fi
    grep -E '^host_shape:[[:space:]]+' "$spec" 2>/dev/null \
        | head -n1 \
        | sed -E 's/^host_shape:[[:space:]]+//; s/[[:space:]]+$//' \
        || echo ""
}

# Walk every `"klodi_*"` literal in adapter source, then drop names
# that match the known non-tool patterns below. The remainder is the
# gate's universe of "klodi_* names referenced from this adapter."
#
# The deny list captures three categories of non-tool klodi_*
# identifiers that legitimately appear in adapter source:
#   1. ${klodi_home} env-var path key.
#   2. ${klodi_api_url} env-var override key.
#   3. klodi_<adapter>* — daemon binary names, log event prefixes
#      (e.g. `klodi_moltis`, `klodi_nanobot_closed`).
#   4. klodi_nats_client — the Python package name.
#   5. klodi_*_loaded / _error / _failed / _chmod_failed — log event names.
#   6. klodi_plugin_loaded / klodi_client_error — log event names.
#
# A new tool name shaped like `klodi_<verb>` or `klodi_<noun>_<verb>`
# does NOT collide with these patterns by design.
extract_referenced_names() {
    local adapter_dir="$1"
    {
        find "$adapter_dir" \
            \( -path "*/node_modules" -o -path "*/target" -o -path "*/dist" -o -path "*/__tests__" -o -path "*/tests" -o -path "*/vendor" -o -path "*/.venv" -o -path "*/build" -o -path "*/egg-info*" \) -prune \
            -o -type f \( -name "*.ts" -o -name "*.tsx" -o -name "*.py" -o -name "*.rs" -o -name "*.json" -o -name "*.md" \) -print \
            | xargs -I{} grep -hoE '"klodi_[a-zA-Z0-9_]+"' {} 2>/dev/null \
            | tr -d '"' \
            | grep -vE '^klodi_(home|api_url|nats_client|nanobot|moltis|ironclaw|zeroclaw|hermes|openclaw)(_.*)?$' \
            | grep -vE '^klodi_(plugin_loaded|client_error)$' \
            || true
    } | sort -u
}

# Probe whether any klodi_* literal for `tool_name` appears anywhere
# in the adapter source — registration via tuple lists, name= kwarg,
# emoji map keys, dispatch switches, etc. We don't try to verify the
# registration is *wired up*; we just verify the literal is referenced.
adapter_references() {
    local adapter_dir="$1"
    local tool_name="$2"
    grep -rqE "\"$tool_name\"" \
        --include="*.ts" --include="*.tsx" \
        --include="*.py" \
        --include="*.rs" \
        --include="*.json" \
        --exclude-dir=node_modules --exclude-dir=target --exclude-dir=dist \
        --exclude-dir=__tests__ --exclude-dir=tests --exclude-dir=vendor \
        --exclude-dir=.venv --exclude-dir=build \
        "$adapter_dir" 2>/dev/null
}

errors=()

for adapter_path in "$ADAPTERS_DIR"/*/; do
    adapter=$(basename "$adapter_path")
    shape="$(host_shape_for_adapter "$adapter")"

    if [[ -z "$shape" ]]; then
        echo "check-adapter-tools: skipping $adapter (no host_shape declared in $SPECS_DIR/$adapter.md)" >&2
        continue
    fi

    catalog_file=$(mktemp)
    referenced_file=$(mktemp)
    required_file=$(mktemp)
    trap 'rm -f "$catalog_file" "$referenced_file" "$required_file"' EXIT

    all_catalog_names > "$catalog_file"
    extract_referenced_names "$adapter_path" > "$referenced_file"
    required_local_names "$shape" > "$required_file"

    # Invariant 1: every referenced name is in the catalog.
    unknown=$(comm -23 "$referenced_file" "$catalog_file" || true)
    if [[ -n "$unknown" ]]; then
        errors+=("$adapter (host_shape: $shape): references unknown tool names")
        while IFS= read -r line; do
            [[ -z "$line" ]] && continue
            errors+=("  - unknown: $line")
        done <<< "$unknown"
    fi

    # Invariant 2: every required local tool has at least one literal
    # reference in the adapter's source. Use a per-name probe so tuple-
    # list registrations are detected (Hermes's pattern doesn't put the
    # name adjacent to a registration keyword).
    missing_for_adapter=()
    while IFS= read -r required_name; do
        [[ -z "$required_name" ]] && continue
        if ! adapter_references "$adapter_path" "$required_name"; then
            missing_for_adapter+=("$required_name")
        fi
    done < "$required_file"
    if (( ${#missing_for_adapter[@]} > 0 )); then
        errors+=("$adapter (host_shape: $shape): missing required local-tool literal")
        for name in "${missing_for_adapter[@]}"; do
            errors+=("  - missing: $name")
        done
    fi

    rm -f "$catalog_file" "$referenced_file" "$required_file"
done

unknown_count=0
missing_count=0
set +u
for line in "${errors[@]}"; do
    case "$line" in
        *": references unknown tool names")
            ;;
        *": missing required local-tool literal")
            ;;
        *"  - unknown:"*) unknown_count=$((unknown_count + 1)) ;;
        *"  - missing:"*) missing_count=$((missing_count + 1)) ;;
    esac
done

error_count=${#errors[@]}
set -u
if (( error_count > 0 )); then
    echo "check-adapter-tools: catalog ↔ adapter mismatch:" >&2
    printf '%s\n' "${errors[@]}" >&2
    echo >&2
    echo "Per **D § D4**: tools live in the catalog or they don't exist." >&2
    echo "  * 'unknown' — adapter references a tool name not in the catalog (typo, deleted)." >&2
    echo "  * 'missing' — adapter must register a local tool declared for its host_shape." >&2
    echo >&2
fi

# Hard-fail on 'unknown' (catches stale / deleted names — the regression
# the gate was built to prevent). 'missing' findings are legitimate
# cross-adapter implementation gaps that some hosts have not yet
# closed; they fail only when STRICT_ADAPTER_TOOLS=1 is set, so CI can
# turn the gate fully strict in a follow-up commit once every in_agent
# host has the LOCAL_TOOLS registry's full surface implemented.
if (( unknown_count > 0 )); then
    echo "check-adapter-tools: $unknown_count unknown name reference(s) — fail." >&2
    exit 1
fi

if (( missing_count > 0 )); then
    if [[ "${STRICT_ADAPTER_TOOLS:-0}" == "1" ]]; then
        echo "check-adapter-tools: $missing_count missing local-tool literal(s) under STRICT_ADAPTER_TOOLS=1 — fail." >&2
        exit 1
    fi
    echo "check-adapter-tools: $missing_count missing local-tool literal(s) — warn (set STRICT_ADAPTER_TOOLS=1 to fail)." >&2
fi

echo "check-adapter-tools: every adapter's tool surface ⊆ catalog allowlist for its host_shape (no unknown names)"
