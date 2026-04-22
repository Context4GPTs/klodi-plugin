#!/usr/bin/env bash
#
# SDK-compat smoke gate for @4gpts/klodi.
#
# Boots the same OpenClaw image the e2e suite uses and runs TWO install
# variants against a freshly-packed tarball. Fails loud if either
# variant cannot register the plugin.
#
#   A (vendored):    `openclaw plugins install <pnpm-pack tarball>`.
#                    The tarball ships `dist/node_modules/` produced by
#                    `vendor-deps.mjs`, so every runtime import
#                    resolves from the extracted plugin dir without
#                    needing an npm install step. This is the path a
#                    bind-mounted dev install and a direct `openclaw
#                    plugins install ./some.tgz` exercise.
#
#   B (clawhub-like): same tarball with `package/dist/node_modules/`
#                    stripped before install, mirroring what the
#                    ClawHub registry ingests. Confirmed against
#                    production: `clawhub package inspect @4gpts/klodi
#                    --files` lists zero files under `dist/node_modules/`,
#                    so ClawHub drops the vendored tree during publish.
#                    With no vendored modules, Node can only resolve
#                    runtime imports through `package.json#dependencies`
#                    (materialised by the host install flow). This
#                    variant catches regressions like 0.1.11, where all
#                    seven runtime packages were declared under
#                    `devDependencies` and production installs failed
#                    with `Cannot find module '@nats-io/jetstream'`
#                    even though variant A passed.
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
# changed, api.config.get replaced by a plain object tree) and against
# publish-pipeline differences (0.1.11 devDeps regression above). Unit
# tests passed in every case because the SDK is mocked against
# src/types/openclaw.d.ts. This script boots the real image, so it
# catches both SDK drift and packaging drift the unit tier cannot.
#
# Usage:
#   scripts/smoke-plugin-load.sh                     # pinned tag
#   OPENCLAW_TAG=latest scripts/smoke-plugin-load.sh # nightly drift check
#
# Exit codes:
#   0  both variants loaded — `klodi_plugin_loaded` found in each log
#   1  at least one variant failed to load
#   2  build / docker / prerequisite failure

set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly IMAGE="${OPENCLAW_IMAGE:-alpine/openclaw}"
readonly TAG="${OPENCLAW_TAG:-2026.4.14}"
readonly CONTAINER_BASE="klodi-plugin-smoke-$$"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "${CONTAINER_BASE}-a" "${CONTAINER_BASE}-b" >/dev/null 2>&1 || true
  [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
  [[ -n "${INSTALL_LOG_A:-}" && -f "$INSTALL_LOG_A" ]] && rm -f "$INSTALL_LOG_A"
  [[ -n "${INSTALL_LOG_B:-}" && -f "$INSTALL_LOG_B" ]] && rm -f "$INSTALL_LOG_B"
}
trap cleanup EXIT

# --- Prerequisites ----------------------------------------------------------

command -v docker >/dev/null || { log "docker not found on PATH"; exit 2; }
command -v pnpm   >/dev/null || { log "pnpm not found on PATH";   exit 2; }

# --- Build + pack the plugin ------------------------------------------------
# A fresh dist/ is required; a stale one masks source regressions.
# `pnpm pack` honours `package.json#files`, so the tarball contains only
# what npm publishes: dist/, skill/, openclaw.plugin.json, README, LICENSE,
# CHANGELOG, package.json. No src/, no tests, no host-level node_modules/.

log "Building @4gpts/klodi..."
pnpm build >/dev/null

STAGE_DIR="$(mktemp -d)"
log "Packing plugin tarball into $STAGE_DIR ..."
( cd "$ROOT" && pnpm pack --pack-destination "$STAGE_DIR" >/dev/null )

readonly TARBALL_A="$(ls "$STAGE_DIR"/*.tgz | head -1)"
[[ -f "$TARBALL_A" ]] || { log "pnpm pack produced no tarball"; exit 2; }
log "Variant A tarball: $(basename "$TARBALL_A") ($(wc -c <"$TARBALL_A") bytes)"

# --- Build the stripped (ClawHub-like) tarball ------------------------------
# Re-pack the same package contents with `package/dist/node_modules/`
# removed, matching the file set the ClawHub registry serves.

readonly EXTRACT_DIR="$STAGE_DIR/strip"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TARBALL_A" -C "$EXTRACT_DIR"
rm -rf "$EXTRACT_DIR/package/dist/node_modules"
readonly TARBALL_B="$STAGE_DIR/$(basename "${TARBALL_A%.tgz}")-stripped.tgz"
( cd "$EXTRACT_DIR" && tar -czf "$TARBALL_B" package )
rm -rf "$EXTRACT_DIR"
log "Variant B tarball: $(basename "$TARBALL_B") ($(wc -c <"$TARBALL_B") bytes, no dist/node_modules/)"

# Stage the openclaw config alongside both tarballs; everything rides
# into the container under /stage:ro so nothing on the host needs to be
# writable by the container's node uid.
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
# (mode 0755) lets the bind mount serve the tarballs + config to any
# uid; the dir is ephemeral and never written to from the container side.
chmod 0755 "$STAGE_DIR"
find "$STAGE_DIR" -type f -exec chmod 0644 {} +

# --- Run variant A: vendored tarball ---------------------------------------

log "Installing plugin (variant A: vendored) into $IMAGE:$TAG ..."
INSTALL_LOG_A="$(mktemp)"

set +e
docker run --rm --name "${CONTAINER_BASE}-a" \
  -v "$STAGE_DIR:/stage:ro" \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  -e KLODI_HOME=/home/node/.openclaw/klodi \
  "$IMAGE:$TAG" \
  sh -c "
    set -e
    mkdir -p /home/node/.openclaw
    cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
    exec openclaw plugins install /stage/$(basename "$TARBALL_A")
  " \
  >"$INSTALL_LOG_A" 2>&1
DOCKER_RC_A=$?
set -e

if [[ $DOCKER_RC_A -ne 0 ]]; then
  log "[variant A] docker run exited $DOCKER_RC_A — plugin install failed."
  log "--- install output ---"
  cat "$INSTALL_LOG_A" >&2
  exit 1
fi
if ! grep -q 'klodi_plugin_loaded' "$INSTALL_LOG_A"; then
  log "[variant A] install succeeded but 'klodi_plugin_loaded' marker missing."
  log "--- install output ---"
  cat "$INSTALL_LOG_A" >&2
  exit 1
fi
log "[variant A] plugin loaded against $IMAGE:$TAG."

# --- Run variant B: stripped tarball (ClawHub-like) ------------------------

log "Installing plugin (variant B: no vendored deps) into $IMAGE:$TAG ..."
INSTALL_LOG_B="$(mktemp)"

set +e
docker run --rm --name "${CONTAINER_BASE}-b" \
  -v "$STAGE_DIR:/stage:ro" \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  -e KLODI_HOME=/home/node/.openclaw/klodi \
  "$IMAGE:$TAG" \
  sh -c "
    set -e
    mkdir -p /home/node/.openclaw
    cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
    exec openclaw plugins install /stage/$(basename "$TARBALL_B")
  " \
  >"$INSTALL_LOG_B" 2>&1
DOCKER_RC_B=$?
set -e

if [[ $DOCKER_RC_B -ne 0 ]]; then
  log "[variant B] docker run exited $DOCKER_RC_B — plugin install failed."
  log "This is the ClawHub-like path. A failure here usually means a runtime"
  log "package is declared under devDependencies instead of dependencies,"
  log "or a transitive dep isn't reachable from package.json#dependencies."
  log "--- install output ---"
  cat "$INSTALL_LOG_B" >&2
  exit 1
fi
if ! grep -q 'klodi_plugin_loaded' "$INSTALL_LOG_B"; then
  log "[variant B] install succeeded but 'klodi_plugin_loaded' marker missing."
  log "--- install output ---"
  cat "$INSTALL_LOG_B" >&2
  exit 1
fi
log "[variant B] plugin loaded against $IMAGE:$TAG."

log "All variants passed."
