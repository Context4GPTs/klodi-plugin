#!/usr/bin/env bash
#
# Local smoke gate for klodi-hermes.
#
# Builds the wheel via the Makefile, installs it into a throw-away
# virtualenv with all declared deps, then exercises every install-time
# guarantee end users depend on. Exits non-zero on any breakage.
#
# Catches the things twine's metadata check and a bare `pip install`
# both miss:
#   • The wheel ships `klodi_hermes` as a real package (not flat
#     py-modules) — `import klodi_hermes` works after install.
#   • `klodi_hermes.register` is callable — Hermes can find the entry
#     point.
#   • `[project.entry-points."hermes_agent.plugins"]` is registered
#     under the group Hermes ≥ 0.11.0 actually scans (see
#     hermes_cli/plugins.py ENTRY_POINTS_GROUP) — `klodi` resolves to
#     `klodi_hermes:register`.
#   • `plugin.yaml` and the bundled skill (skills/klodi/SKILL.md) ship
#     as package data — `_register_skills` will find them at runtime.
#   • Vendored `_klodi_hermes_natsclient` imports cleanly with all its
#     re-exports (KlodiClient, KLODI_DEFAULT_API_URL).
#
# Why a venv, not the host interpreter: the host may already have an
# editable install of the workspace adapter (`pip install -e ...`),
# which would shadow the wheel under test.
#
# Why `cd /tmp` before running python: the adapter source dir contains
# `src/klodi_hermes/` and `src/_klodi_hermes_natsclient/`. CWD is on
# Python's module search path by default, so running python from the
# adapter source dir would resolve `import klodi_hermes` to the source
# tree instead of the installed wheel — masking install bugs.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ADAPTER_DIR/dist"
SMOKE_VENV="$ADAPTER_DIR/build/smoke-venv"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  [[ -d "$SMOKE_VENV" ]] && rm -rf "$SMOKE_VENV"
}
trap cleanup EXIT

# --- Prerequisites ---------------------------------------------------------

command -v python3 >/dev/null || { log "python3 not found on PATH"; exit 2; }

shopt -s nullglob
WHEELS=("$DIST_DIR"/klodi_hermes-*.whl)
shopt -u nullglob
if (( ${#WHEELS[@]} != 1 )); then
  log "expected exactly 1 wheel in $DIST_DIR, got ${#WHEELS[@]} — run \`make build\` first"
  exit 2
fi
WHEEL="${WHEELS[0]}"
log "using wheel: $(basename "$WHEEL")"

# --- Set up a clean venv ---------------------------------------------------

log "creating throw-away venv at $SMOKE_VENV"
python3 -m venv "$SMOKE_VENV"
"$SMOKE_VENV/bin/pip" install --quiet --upgrade pip

# Install with deps so import-time references to nats-py / websockets etc.
# resolve. The wheel's own deps (post-vendoring) should be just the
# external packages — klodi-nats-client must NOT appear; if it does,
# vendor.py left a dangling pin in the staged pyproject.
log "installing wheel into smoke venv (with deps)"
"$SMOKE_VENV/bin/pip" install --quiet "$WHEEL"

# --- Wheel metadata sanity -------------------------------------------------

log "checking wheel metadata"
"$SMOKE_VENV/bin/pip" show klodi-hermes >/dev/null || {
  log "klodi-hermes is not registered as installed — wheel metadata broken"
  exit 1
}

# Hard fail if klodi-nats-client snuck back in as a dep — that means
# vendor.py's pyproject patching missed an entry, OR the source
# pyproject re-introduced the dependency.
if "$SMOKE_VENV/bin/pip" show klodi-nats-client >/dev/null 2>&1; then
  log "FAIL: klodi-nats-client got installed as a separate dist — vendor flow regressed"
  exit 1
fi

# --- Run the import asserts in /tmp so source files don't shadow the wheel ---

log "running import asserts (CWD=/tmp)"
PY="$SMOKE_VENV/bin/python"

cd /tmp

# 1. Top-level package imports cleanly.
log "  import klodi_hermes"
"$PY" -c "import klodi_hermes" || {
  log "FAIL: import klodi_hermes"
  exit 1
}

# 2. register() is callable.
log "  klodi_hermes.register is callable"
"$PY" -c "import klodi_hermes; assert callable(klodi_hermes.register), 'register is not callable'" || {
  log "FAIL: klodi_hermes.register is not callable"
  exit 1
}

# 3. Hermes plugin entry point is registered. Hermes ≥ 0.11.0 scans the
# `hermes_agent.plugins` group at startup (hermes_cli/plugins.py
# ENTRY_POINTS_GROUP). This assert confirms the metadata landed in
# dist-info/entry_points.txt under that exact group.
log "  hermes_agent.plugins entry point 'klodi' is registered"
"$PY" -c "
from importlib.metadata import entry_points
eps = entry_points(group='hermes_agent.plugins')
matches = [ep for ep in eps if ep.name == 'klodi']
assert matches, f'no hermes_agent.plugins entry point named klodi (group has: {[ep.name for ep in eps]})'
ep = matches[0]
target = ep.load()
# Per pyproject.toml — entry point MUST be the module, not a function.
# Hermes does \`getattr(ep.load(), 'register', None)\` after loading; if
# the EP returns a function, getattr(function, 'register') is None and
# Hermes fails the plugin with 'no register() function'. Mirror that
# exact check here so the smoke gate matches what Hermes will actually
# do at startup.
register = getattr(target, 'register', None)
assert callable(register), (
    f'entry point loaded but no callable register() attribute: {target!r}'
)
" || {
  log "FAIL: hermes_agent.plugins entry point missing or broken"
  exit 1
}

# 4. plugin.yaml + skill bundle ship as package data.
log "  plugin.yaml + skills/klodi/SKILL.md ship as package data"
"$PY" -c "
import klodi_hermes
from pathlib import Path
pkg = Path(klodi_hermes.__file__).parent
plugin_yaml = pkg / 'plugin.yaml'
skill_md = pkg / 'skills' / 'klodi' / 'SKILL.md'
assert plugin_yaml.is_file(), f'plugin.yaml missing at {plugin_yaml}'
assert skill_md.is_file(), f'skill bundle missing at {skill_md}'
" || {
  log "FAIL: package data missing from wheel"
  exit 1
}

# 5. Vendored client imports cleanly with re-exports intact.
log "  import _klodi_hermes_natsclient"
"$PY" -c "import _klodi_hermes_natsclient" || {
  log "FAIL: vendored shared client did not import"
  exit 1
}

log "  from _klodi_hermes_natsclient import KlodiClient, KLODI_DEFAULT_API_URL"
"$PY" -c "from _klodi_hermes_natsclient import KlodiClient, KLODI_DEFAULT_API_URL" || {
  log "FAIL: vendored re-exports broken"
  exit 1
}

log "all smoke checks passed."
