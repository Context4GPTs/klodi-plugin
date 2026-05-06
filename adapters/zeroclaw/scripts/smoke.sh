#!/usr/bin/env bash
#
# Smoke gate for klodi-zeroclaw.
#
# Three checks against the staged tree:
#
#   1. Each declared [[bin]] target's `--help` exits 0 from the release
#      build (catches build-time mistakes).
#   2. `cargo install --path` against a throw-away --root catches
#      install-time bin-layout drift — the same path a real user runs
#      via `cargo install klodi-zeroclaw` after publish. Mirrors the
#      "smoke against installed wheel" pattern from
#      adapters/{hermes,nanobot}/scripts/smoke.sh.
#   3. `cargo package --locked` produces a valid .crate (verifies that
#      publish-time path-dep stripping worked).

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAGED="$ADAPTER_DIR/build/staged"
SMOKE_ROOT="$ADAPTER_DIR/build/smoke-install"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  [[ -d "$SMOKE_ROOT" ]] && rm -rf "$SMOKE_ROOT"
}
trap cleanup EXIT

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

# 1. Release-build --help check.
while IFS= read -r bin; do
  exe="$STAGED/target/release/$bin"
  if [[ ! -x "$exe" ]]; then
    log "FAIL: missing release binary $exe"
    exit 1
  fi
  log "  $bin --help (release build)"
  if ! "$exe" --help >/dev/null 2>&1; then
    log "FAIL: $bin --help exited non-zero"
    "$exe" --help || true
    exit 1
  fi
done <<< "$BINS"

# 2. cargo install --path → throw-away --root → run --help on every bin
#    from the user-PATH'd binary. Catches issues that only surface
#    when the crate goes through cargo's install pipeline (rather than
#    the bare `cargo build` target) — e.g. a Cargo.toml that compiles
#    but doesn't satisfy crates.io's metadata requirements, or bin
#    paths that resolve from the workspace but not from the install
#    cache.
log "cargo install --path \"$STAGED\" --root \"$SMOKE_ROOT\" --locked"
rm -rf "$SMOKE_ROOT"
cd "$STAGED"
cargo install --path . --root "$SMOKE_ROOT" --locked --force >/dev/null

while IFS= read -r bin; do
  installed="$SMOKE_ROOT/bin/$bin"
  if [[ ! -x "$installed" ]]; then
    log "FAIL: cargo install did not produce $installed"
    exit 1
  fi
  log "  $bin --help (installed)"
  if ! "$installed" --help >/dev/null 2>&1; then
    log "FAIL: installed $bin --help exited non-zero"
    "$installed" --help || true
    exit 1
  fi
done <<< "$BINS"

# 3. cargo package — verifies metadata + that the .crate is publishable.
log "cargo package (verifies publish would succeed)"
cargo package --locked >/dev/null

log "all smoke checks passed."
