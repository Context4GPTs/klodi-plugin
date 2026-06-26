#!/usr/bin/env bash
#
# Smoke gate for klodi-nanobot.
#
# Builds (via Makefile) → installs the freshly-built wheel into a
# throw-away virtualenv → imports each declared py-module + the
# vendored shared client. Exits non-zero on any breakage.
#
# Catches the things twine's metadata check cannot:
#   • Vendored klodi_nats_client → _klodi_nanobot_natsclient rewrite
#     succeeded for every reference.
#   • Every adapter py-module declared in pyproject.toml is reachable
#     after install.
#   • The wheel's metadata is consistent and klodi-nats-client did not
#     leak back in as a runtime dependency.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ADAPTER_DIR/dist"
SMOKE_VENV="$ADAPTER_DIR/build/smoke-venv"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  [[ -d "$SMOKE_VENV" ]] && rm -rf "$SMOKE_VENV"
}
trap cleanup EXIT

command -v python3 >/dev/null || { log "python3 not found on PATH"; exit 2; }

shopt -s nullglob
WHEELS=("$DIST_DIR"/klodi_nanobot-*.whl)
shopt -u nullglob
if (( ${#WHEELS[@]} != 1 )); then
  log "expected exactly 1 wheel in $DIST_DIR, got ${#WHEELS[@]} — run \`make build\` first"
  exit 2
fi
WHEEL="${WHEELS[0]}"
log "using wheel: $(basename "$WHEEL")"

log "creating throw-away venv at $SMOKE_VENV"
uv venv --seed --python 3.12 "$SMOKE_VENV"

log "installing wheel into smoke venv (with deps)"
"$SMOKE_VENV/bin/pip" install --quiet "$WHEEL"

log "checking wheel metadata"
"$SMOKE_VENV/bin/pip" show klodi-nanobot >/dev/null || {
  log "klodi-nanobot is not registered as installed — wheel metadata broken"
  exit 1
}

if "$SMOKE_VENV/bin/pip" show klodi-nats-client >/dev/null 2>&1; then
  log "FAIL: klodi-nats-client got installed as a separate dist — vendor.py did not strip the dep"
  exit 1
fi

log "importing every declared py-module"
# awk avoids the Python-3.11+ tomllib dep. Walks pyproject.toml looking
# for the py-modules block and prints each "..."-quoted name on its own
# line. Multi-line list format is the only one we use; inline list form
# is intentionally not supported here.
PY_MODULES="$(awk -F'"' '
  /^py-modules/ {p=1; next}
  p && /\]/    {exit}
  p && $2      {print $2}
' "$ADAPTER_DIR/pyproject.toml")"

if [[ -z "$PY_MODULES" ]]; then
  log "pyproject.toml has no [tool.setuptools] py-modules — nothing to import"
  exit 1
fi

# CWD is on Python's module search path by default. The adapter source
# dir contains `nanobot_*.py` at the top level (flat layout), so running
# python from $ADAPTER_DIR would resolve `import nanobot_client` to the
# source tree — whose `from klodi_nats_client import …` is unrewritten —
# instead of the installed wheel's vendored copy. Run imports from /tmp
# so the smoke actually exercises the wheel.
log "running import asserts (CWD=/tmp)"
cd /tmp

while IFS= read -r mod; do
  log "  import $mod"
  "$SMOKE_VENV/bin/python" -c "import $mod" || {
    log "FAIL: import $mod"; exit 1
  }
done <<< "$PY_MODULES"

log "  import _klodi_nanobot_natsclient"
"$SMOKE_VENV/bin/python" -c "import _klodi_nanobot_natsclient" || {
  log "FAIL: vendored shared client did not import"
  exit 1
}

log "  from _klodi_nanobot_natsclient import KlodiClient, KLODI_DEFAULT_API_URL"
"$SMOKE_VENV/bin/python" -c "from _klodi_nanobot_natsclient import KlodiClient, KLODI_DEFAULT_API_URL" || {
  log "FAIL: vendored re-exports broken"
  exit 1
}

log "all smoke checks passed."
