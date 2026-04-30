#!/usr/bin/env bash
#
# Smoke gate for klodi-moltis.
#
# Builds (via Makefile, from the staged tree) → runs each declared
# [[bin]] target with `--help`. Exits non-zero on any breakage.
#
# Catches the things `cargo build` alone cannot:
#   • The vendored klodi_nats_client → crate::_natsclient rewrite
#     produced a working build at every reference site (mismatched
#     paths surface as compile errors during the build, but a clean
#     build that crashes at startup needs the --help round-trip).
#   • `cargo package` would succeed (i.e. publish would not fail
#     because of a missing path-dep version, dirty target/, etc.).
#
# Why the staged tree, not the source tree: the source tree uses the
# workspace path-dep `klodi-nats-client = { path = "..." }`, which
# cargo refuses to publish. The staged tree has the dep dropped and
# the source vendored — that's what publishes.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGED="$ADAPTER_DIR/build/staged"

log() { printf '[smoke] %s\n' "$*" >&2; }

command -v cargo >/dev/null || { log "cargo not found on PATH"; exit 2; }

if [[ ! -d "$STAGED" ]]; then
  log "$STAGED missing — run \`make build\` first"
  exit 2
fi

# --- Run each declared [[bin]] with --help --------------------------------

log "discovering [[bin]] targets in staged Cargo.toml"
BINS="$(cd "$STAGED" && cargo metadata --no-deps --format-version 1 \
  | python3 -c "import json,sys; m=json.load(sys.stdin); pkg=m['packages'][0]; print('\n'.join(t['name'] for t in pkg['targets'] if 'bin' in t['kind']))")"

if [[ -z "$BINS" ]]; then
  log "no [[bin]] targets declared — nothing to smoke"
  exit 1
fi

while IFS= read -r bin; do
  exe="$STAGED/target/release/$bin"
  if [[ ! -x "$exe" ]]; then
    log "FAIL: missing release binary $exe"
    exit 1
  fi
  log "  $bin --help"
  if ! "$exe" --help >/dev/null 2>&1; then
    log "FAIL: $bin --help exited non-zero"
    "$exe" --help || true
    exit 1
  fi
done <<< "$BINS"

# --- cargo package dry-run (full publish lifecycle) -----------------------

log "cargo package (verifies publish would succeed)"
cd "$STAGED"
cargo package --locked >/dev/null

log "all smoke checks passed."
