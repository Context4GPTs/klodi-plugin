#!/usr/bin/env bash
# Enforce openclaw manifest ↔ registered-tool symmetry.
#
# Why this gate exists: openclaw `2026.5.27 plugins doctor` rejects the klodi
# plugin unless `openclaw.plugin.json` `.contracts.tools` declares EVERY tool the
# adapter actually registers. The hand-maintained JSON list had drifted (32
# declared vs 35 registered), so three registered tools were undeclared and the
# plugin was rejected. This gate fails that drift class in-repo, on every change,
# instead of downstream on the packed tarball.
#
# The contract it enforces — set EQUALITY in BOTH directions between:
#
#   1. The "declared set": `.contracts.tools` in openclaw.plugin.json.
#   2. The "registered set": the static `name:` string literals inside
#      `api.registerTool({…})` blocks in adapters/openclaw/src/tools/*.ts —
#      the tools openclaw ACTUALLY registers, which is exactly what
#      `plugins doctor` validates the manifest against.
#
# A registered-but-undeclared tool OR a declared-but-unregistered tool fails it,
# naming the offender(s) and the direction.
#
# STATIC-LITERAL ASSUMPTION (documented in ADR-0014): every openclaw tool is
# registered with a static `name: "klodi_…"` literal — there are NO
# dynamically-named / interpolated tool names. Verified true today (35 grep hits
# == 35 runtime registrations). If a future tool is registered with a computed
# name (`name: \`klodi_${x}\``), this static gate cannot see it — but that
# omission is itself the code smell the gate surfaces (the manifest could not
# have been kept in sync with it either). Extraction is deliberately scoped to a
# small window after `registerTool({` so non-tool klodi_* tokens (log-event
# names like klodi_plugin_loaded, env-var keys like klodi_home, package names)
# are excluded BY CONSTRUCTION — no deny-list needed (unlike check-adapter-tools.sh,
# which scans all adapters for any bare klodi_* literal and so must deny-list).
#
# This gate is a sibling to scripts/check-adapter-tools.sh; it enforces a
# DIFFERENT contract (manifest-vs-registered, not adapter-source-vs-catalog) and
# never reads the tool-catalog schemas. The two distinct symmetry axes — and why
# this gate keys on src/tools/*.ts literals rather than the catalog host_shape
# slice — are recorded in docs/decisions/0014-tool-symmetry-axes.md.
# See ADR-0014.
#
# Env overrides (default to the real paths when unset):
#   MANIFEST       — abs path to the openclaw.plugin.json to read
#                    `.contracts.tools` from. Default: the real manifest.
#   TOOLS_SRC_DIR  — abs path to a dir whose *.ts files are grepped for `name:`
#                    literals inside registerTool({…}) blocks.
#                    Default: adapters/openclaw/src/tools.
#
# Run:
#   bash klodi-plugin/scripts/check-openclaw-manifest-tools.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MANIFEST="${MANIFEST:-$ROOT/adapters/openclaw/openclaw.plugin.json}"
TOOLS_SRC_DIR="${TOOLS_SRC_DIR:-$ROOT/adapters/openclaw/src/tools}"

if [[ ! -f "$MANIFEST" ]]; then
    echo "check-openclaw-manifest-tools: manifest missing at $MANIFEST" >&2
    exit 2
fi
if [[ ! -d "$TOOLS_SRC_DIR" ]]; then
    echo "check-openclaw-manifest-tools: tools source dir missing at $TOOLS_SRC_DIR" >&2
    exit 2
fi

NODE_BIN="${NODE:-node}"
if ! command -v "$NODE_BIN" >/dev/null 2>&1; then
    echo "check-openclaw-manifest-tools: node binary not found (looked for: $NODE_BIN)" >&2
    exit 2
fi

# Declared set: `.contracts.tools` from the manifest, sorted+deduped for `comm`.
declared_names() {
    "$NODE_BIN" -e "
        const m = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf-8'));
        const list = (m.contracts && m.contracts.tools) || [];
        for (const name of [...new Set(list)].sort()) console.log(name);
    " "$MANIFEST"
}

# Registered set: static `name: "klodi_…"` literals that sit within a small
# window after an `api.registerTool({` opener in any *.ts under TOOLS_SRC_DIR.
# The -A3 window is wide enough that a reordered name/label/description block
# still matches, but narrow enough that object keys deep in the execute() body
# (e.g. klodi_home:) and stray name: fields in unrelated object literals never
# leak in. Sorted+deduped for `comm`.
registered_names() {
    grep -rhA3 --include='*.ts' 'api\.registerTool({' "$TOOLS_SRC_DIR" 2>/dev/null \
        | grep -oE 'name:[[:space:]]*"klodi_[a-zA-Z0-9_]+"' \
        | grep -oE 'klodi_[a-zA-Z0-9_]+' \
        | sort -u \
        || true
}

declared_file="$(mktemp)"
registered_file="$(mktemp)"
trap 'rm -f "$declared_file" "$registered_file"' EXIT

declared_names > "$declared_file"
registered_names > "$registered_file"

# registered − declared: tools the adapter registers but the manifest omits
# (the load-rejection drift this check exists to catch).
undeclared="$(comm -13 "$declared_file" "$registered_file" || true)"
# declared − registered: tools the manifest lists that no src file registers
# (reverse drift — a stale/typo'd manifest entry).
unregistered="$(comm -23 "$declared_file" "$registered_file" || true)"

status=0

if [[ -n "$undeclared" ]]; then
    status=1
    echo "check-openclaw-manifest-tools: registered but NOT declared in .contracts.tools" >&2
    echo "  (openclaw registers these tools; the manifest must list them or plugins doctor rejects the plugin)" >&2
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        echo "  - undeclared: $line" >&2
    done <<< "$undeclared"
fi

if [[ -n "$unregistered" ]]; then
    status=1
    echo "check-openclaw-manifest-tools: declared in .contracts.tools but NOT registered" >&2
    echo "  (the manifest lists these tools; no src/tools/*.ts registerTool block registers them)" >&2
    while IFS= read -r line; do
        [[ -z "$line" ]] && continue
        echo "  - unregistered: $line" >&2
    done <<< "$unregistered"
fi

if (( status != 0 )); then
    echo >&2
    echo "check-openclaw-manifest-tools: manifest ↔ registered drift — fail." >&2
    exit 1
fi

declared_count="$(wc -l < "$declared_file" | tr -d '[:space:]')"
echo "check-openclaw-manifest-tools: .contracts.tools == registered set ($declared_count tools, in sync)"
