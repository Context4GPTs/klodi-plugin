#!/usr/bin/env bash
#
# SDK-compat smoke gate for @4gpts/klodi.
#
# Boots the same OpenClaw image the e2e suite uses, installs the plugin
# from a packed tarball — exactly the shape end users get from npm /
# ClawHub — and greps the install output for `klodi_plugin_loaded`. Fails
# loud if the plugin cannot register for any reason.
#
# Why a tarball install (not a bind-mount of klodi-plugin/):
# - The published tarball excludes `src/` and `src/__tests__/` per
#   `package.json#files`. OpenClaw's safety scanner walks every file in
#   the install source and refuses installs that contain dangerous code
#   patterns; test files mock `process.env` + network sends and trip the
#   scanner. Installing from a tarball mirrors what real users do.
# - No host-side bind-mount of `/home/node/.openclaw` means no UID
#   mismatch between the runner (uid 1001) and the container's `node`
#   user (uid 1000). The container creates and owns its own home.
#
# Why this exists: the plugin source has broken against OpenClaw host
# upgrades multiple times (umbrella import removed, entry-export contract
# changed, api.config.get replaced by a plain object tree). Unit tests
# passed in every case because the SDK is mocked against
# src/types/openclaw.d.ts. This script boots the real image, so it
# catches SDK drift the unit tier cannot.
#
# Usage:
#   scripts/smoke-plugin-load.sh                     # pinned tag
#   OPENCLAW_TAG=latest scripts/smoke-plugin-load.sh # nightly drift check
#
# Exit codes:
#   0  plugin loaded — `klodi_plugin_loaded` found in install output
#   1  plugin failed to load — install output missing the marker
#   2  build / docker / prerequisite failure

set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly IMAGE="${OPENCLAW_IMAGE:-alpine/openclaw}"
readonly TAG="${OPENCLAW_TAG:-2026.4.14}"
readonly CONTAINER_NAME="klodi-plugin-smoke-$$"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
  [[ -n "${INSTALL_LOG:-}" && -f "$INSTALL_LOG" ]] && rm -f "$INSTALL_LOG"
}
trap cleanup EXIT

# --- Prerequisites ----------------------------------------------------------

command -v docker >/dev/null || { log "docker not found on PATH"; exit 2; }
command -v pnpm   >/dev/null || { log "pnpm not found on PATH";   exit 2; }

# --- Build + pack the plugin ------------------------------------------------
# A fresh dist/ is required; a stale one masks source regressions.
# `pnpm pack` honours `package.json#files`, so the tarball contains only
# what npm publishes: dist/, skill/, openclaw.plugin.json, README, LICENSE,
# CHANGELOG, package.json. No src/, no tests, no node_modules/.

log "Building @4gpts/klodi..."
pnpm build >/dev/null

STAGE_DIR="$(mktemp -d)"
log "Packing plugin tarball into $STAGE_DIR ..."
( cd "$ROOT" && pnpm pack --pack-destination "$STAGE_DIR" >/dev/null )

readonly TARBALL_HOST="$(ls "$STAGE_DIR"/*.tgz | head -1)"
[[ -f "$TARBALL_HOST" ]] || { log "pnpm pack produced no tarball"; exit 2; }
log "Tarball: $(basename "$TARBALL_HOST") ($(wc -c <"$TARBALL_HOST") bytes)"

# Stage the openclaw config alongside the tarball; both ride into the
# container under /stage:ro so nothing on the host needs to be writable
# by the container's node uid.
cat >"$STAGE_DIR/openclaw.json" <<'EOF'
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "0.0.0.0",
    "auth": { "mode": "token", "token": "smoke" }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "model": { "primary": "anthropic/claude-sonnet-4-5" },
      "models": { "anthropic/claude-sonnet-4-5": {} },
      "heartbeat": { "target": "last" }
    }
  },
  "plugins": {
    "entries": {
      "klodi": {
        "enabled": true,
        "config": { "klodi_home": "/home/node/.openclaw/klodi" }
      }
    }
  }
}
EOF

# `mktemp -d` defaults to mode 0700, owned by the host runner uid. On
# Linux CI the container's `node` user (uid 1000) cannot read files
# inside that mount, even read-only. World-readable on the staging dir
# (mode 0755) lets the bind mount serve the tarball + config to any uid;
# the dir is ephemeral and never written to from the container side.
chmod 0755 "$STAGE_DIR"
chmod 0644 "$STAGE_DIR"/*

# --- Run the smoke ---------------------------------------------------------

log "Installing plugin into $IMAGE:$TAG ..."

# `openclaw plugins install` logs the plugin's own `api.logger.info`
# messages on registration. We grep for `klodi_plugin_loaded` — the
# marker the plugin emits in src/index.ts on successful registration,
# and the same marker e2e global-setup's waitForPluginLoaded watches for.
INSTALL_LOG="$(mktemp)"

set +e
docker run --rm --name "$CONTAINER_NAME" \
  -v "$STAGE_DIR:/stage:ro" \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  -e KLODI_HOME=/home/node/.openclaw/klodi \
  "$IMAGE:$TAG" \
  sh -c '
    set -e
    mkdir -p /home/node/.openclaw
    cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
    exec openclaw plugins install /stage/*.tgz
  ' \
  >"$INSTALL_LOG" 2>&1
DOCKER_RC=$?
set -e

if [[ $DOCKER_RC -ne 0 ]]; then
  log "docker run exited $DOCKER_RC — plugin install failed."
  log "--- install output ---"
  cat "$INSTALL_LOG" >&2
  exit 1
fi

if ! grep -q 'klodi_plugin_loaded' "$INSTALL_LOG"; then
  log "install succeeded but 'klodi_plugin_loaded' marker missing."
  log "--- install output ---"
  cat "$INSTALL_LOG" >&2
  exit 1
fi

log "Plugin loaded against $IMAGE:$TAG."
