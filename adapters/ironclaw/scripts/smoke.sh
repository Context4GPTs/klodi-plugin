#!/usr/bin/env bash
#
# Smoke gate for klodi-ironclaw.
#
# Builds (via Makefile, from the staged tree) → runs each declared
# [[bin]] target with `--help` → cargo package as a publish dry-run.
# Exits non-zero on any breakage.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGED="$ADAPTER_DIR/build/staged"

log() { printf '[smoke] %s\n' "$*" >&2; }

command -v cargo >/dev/null || { log "cargo not found on PATH"; exit 2; }

if [[ ! -d "$STAGED" ]]; then
  log "$STAGED missing — run \`make build\` first"
  exit 2
fi

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

log "cargo package (verifies publish would succeed)"
cd "$STAGED"
cargo package --locked >/dev/null

log "all smoke checks passed."
