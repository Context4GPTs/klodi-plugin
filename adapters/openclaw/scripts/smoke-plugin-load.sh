#!/usr/bin/env bash
#
# SDK-compat smoke gate for @4gpts/klodi.
#
# Boots the same OpenClaw image the e2e suite uses (>=2026.4.15) and
# verifies a freshly-packed tarball installs and loads. .14 and earlier
# are not supported — they didn't run npm install at install time, so
# bundleDependencies couldn't materialise; we dropped that path with
# vendor-deps.mjs.
#
# Install path under test, mirroring both the local (pack-and-install)
# and ClawHub (publish-and-install) flows since the artefact is the
# same after we stopped vendoring `dist/node_modules/`:
#
#   1. `openclaw plugins install <tarball>`
#   2. host runs `npm install` in the extracted plugin dir
#   3. unpublished workspace @klodi/* packages resolve via
#      bundleDependencies (preserved at `node_modules/@klodi/<name>/`
#      in the tarball)
#   4. public-registry packages (@nats-io/*, ws, gray-matter, ...)
#      resolve via package.json#dependencies, fetched by npm install
#   5. `klodi_plugin_loaded` log marker fires from dist/index.js
#
# Pre-install structural asserts catch packaging regressions without
# needing a docker run:
#   - bundleDependencies survived → node_modules/@klodi/<name>/package.json
#     exists in the tarball
#   - vendoring stayed dropped → no dist/node_modules/ in the tarball
#     (its presence would mean someone reintroduced vendor-deps and
#     bloated the publish surface)
#
# Why a tarball install (not a bind-mount of klodi-plugin/):
# - The published tarball excludes `src/` and `src/__tests__/` per
#   `package.json#files`. OpenClaw's safety scanner walks every file
#   in the install source and refuses installs that contain dangerous
#   code patterns; test files mock `process.env` + network sends and
#   trip the scanner. Installing from a tarball mirrors what real
#   users do.
# - No host-side bind-mount of `/home/node/.openclaw` means no UID
#   mismatch between the runner (uid 1001) and the container's `node`
#   user (uid 1000). The container creates and owns its own home.
#
# Usage:
#   scripts/smoke-plugin-load.sh                     # pinned tag
#   OPENCLAW_TAG=latest scripts/smoke-plugin-load.sh # nightly drift check
#
# Exit codes:
#   0  install + load succeeded AND install subprocess exited cleanly
#   1  packaging regression (structural assert), install failure, or
#      install subprocess hung (timeout) — the latter usually means
#      register() opened a long-lived resource (NATS connection,
#      timer, etc.) that holds the verification subprocess's event
#      loop open, which would block `&& exec openclaw gateway` in
#      production startup commands.
#   2  build / docker / prerequisite failure

set -euo pipefail

readonly ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly IMAGE="${OPENCLAW_IMAGE:-alpine/openclaw}"
readonly TAG="${OPENCLAW_TAG:-2026.4.15}"
readonly CONTAINER="klodi-plugin-smoke-$$"

log() { printf '[smoke] %s\n' "$*" >&2; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
  [[ -n "${INSTALL_LOG:-}" && -f "$INSTALL_LOG" ]] && rm -f "$INSTALL_LOG"
}
trap cleanup EXIT

# --- Prerequisites ----------------------------------------------------------

command -v docker >/dev/null || { log "docker not found on PATH"; exit 2; }
command -v pnpm   >/dev/null || { log "pnpm not found on PATH";   exit 2; }

# --- Build + pack the plugin ------------------------------------------------
# A fresh dist/ is required; a stale one masks source regressions.
# pack-with-bundles.mjs materialises bundleDependencies (workspace
# @klodi/* packages, not on the public registry) into clean
# node_modules/<name>/ entries that ClawHub preserves on ingest, then
# delegates to npm pack (pnpm pack rejects bundleDependencies under
# node-linker=isolated).

log "Building @4gpts/klodi (with workspace deps)..."
# `<pkg>...` filter selects @4gpts/klodi and its workspace deps
# (@klodi/tool-catalog, @klodi/nats-client) in topological order.
# Direct `pnpm build` here would skip those, and tsc would fail on
# missing module declarations in a fresh CI tree.
( cd "$ROOT/../../.." && pnpm --filter "@4gpts/klodi..." build >/dev/null )

STAGE_DIR="$(mktemp -d)"
log "Packing plugin tarball into $STAGE_DIR ..."
( cd "$ROOT" && node scripts/pack-with-bundles.mjs --pack-destination "$STAGE_DIR" >/dev/null )

readonly TARBALL="$(ls "$STAGE_DIR"/*.tgz | head -1)"
[[ -f "$TARBALL" ]] || { log "pack-with-bundles produced no tarball"; exit 2; }
log "Tarball: $(basename "$TARBALL") ($(wc -c <"$TARBALL") bytes)"

# --- Structural asserts on the tarball --------------------------------------

readonly EXTRACT_DIR="$STAGE_DIR/inspect"
mkdir -p "$EXTRACT_DIR"
tar -xzf "$TARBALL" -C "$EXTRACT_DIR"

for bundled_pkg in @klodi/nats-client @klodi/tool-catalog; do
  if [[ ! -f "$EXTRACT_DIR/package/node_modules/$bundled_pkg/package.json" ]]; then
    log "FAIL: $bundled_pkg missing from tarball at node_modules/."
    log "      bundleDependencies didn't survive — check pack-with-bundles.mjs."
    exit 1
  fi
done

if [[ -d "$EXTRACT_DIR/package/dist/node_modules" ]]; then
  log "FAIL: dist/node_modules/ present in tarball."
  log "      Vendoring was dropped with .14 support; this directory should"
  log "      not exist. Someone reintroduced vendor-deps.mjs or equivalent."
  exit 1
fi

rm -rf "$EXTRACT_DIR"
log "Structural asserts: bundleDeps present, dist/node_modules/ absent."

# Stage the openclaw config alongside the tarball; everything rides
# into the container under /stage:ro so nothing on the host needs to
# be writable by the container's node uid.
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
      "model": { "primary": "openai-codex/gpt-5.3-codex" },
      "models": { "openai-codex/gpt-5.3-codex": {} },
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
# (mode 0755) lets the bind mount serve the tarball + config to any
# uid; the dir is ephemeral and never written to from the container side.
chmod 0755 "$STAGE_DIR"
find "$STAGE_DIR" -type f -exec chmod 0644 {} +

# --- Install in container ---------------------------------------------------

log "Installing plugin into $IMAGE:$TAG ..."
INSTALL_LOG="$(mktemp)"

# Enforce the install-subprocess-must-exit invariant: the real
# production command is `openclaw plugins install ... && exec
# openclaw gateway`. If the install subprocess holds the event loop
# open (e.g. an eager NATS connection from register()), the && never
# fires and the gateway never boots. 30s is generous for a tarball
# install + npm install — anything longer is the bug we're guarding.
readonly INSTALL_TIMEOUT_S="${SMOKE_INSTALL_TIMEOUT_S:-30}"
readonly TIMEOUT_RC=124

# `timeout` is GNU coreutils — present on Linux CI, missing on stock
# macOS (available as `gtimeout` if coreutils is installed). Pick the
# first one that exists; if neither is available, skip the timeout
# guard with a warning so local runs still work.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN="gtimeout"
else
  TIMEOUT_BIN=""
  log "WARN: neither timeout nor gtimeout on PATH — install-hang guard"
  log "      disabled for this run. CI / Linux runs still get coverage."
fi

set +e
if [[ -n "$TIMEOUT_BIN" ]]; then
  "$TIMEOUT_BIN" --kill-after=5 "${INSTALL_TIMEOUT_S}" docker run --rm --name "$CONTAINER" \
    -v "$STAGE_DIR:/stage:ro" \
    -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    -e KLODI_HOME=/home/node/.openclaw/klodi \
    "$IMAGE:$TAG" \
    sh -c "
      set -e
      mkdir -p /home/node/.openclaw
      cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
      exec openclaw plugins install /stage/$(basename "$TARBALL")
    " \
    >"$INSTALL_LOG" 2>&1
else
  docker run --rm --name "$CONTAINER" \
    -v "$STAGE_DIR:/stage:ro" \
    -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    -e KLODI_HOME=/home/node/.openclaw/klodi \
    "$IMAGE:$TAG" \
    sh -c "
      set -e
      mkdir -p /home/node/.openclaw
      cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
      exec openclaw plugins install /stage/$(basename "$TARBALL")
    " \
    >"$INSTALL_LOG" 2>&1
fi
DOCKER_RC=$?
set -e

if [[ -n "$TIMEOUT_BIN" && $DOCKER_RC -eq $TIMEOUT_RC ]]; then
  log "FAIL: install subprocess did not exit within ${INSTALL_TIMEOUT_S}s."
  log "      register() likely opened a long-lived resource (NATS"
  log "      connection, timer, ...) that holds the event loop open."
  log "      In production this would block '&& exec openclaw gateway'."
  log "      Fix: gate eager work behind isOpenClawCliContext()"
  log "      (see klodi-plugin/adapters/openclaw/src/service/wake-pump.ts)."
  log "--- install output (so far) ---"
  cat "$INSTALL_LOG" >&2
  exit 1
fi
if [[ $DOCKER_RC -ne 0 ]]; then
  log "docker run exited $DOCKER_RC — plugin install failed."
  log "Common causes: a runtime dep declared under devDependencies, a"
  log "workspace dep not added to bundleDependencies, or a transitive"
  log "package not reachable from package.json#dependencies."
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
# Belt-and-braces: even if the subprocess exited inside the timeout,
# the wake pump must NOT have started during install verification —
# its presence would mean the gateway-runtime gate failed open.
if grep -q 'wake_pump_started' "$INSTALL_LOG"; then
  log "FAIL: 'wake_pump_started' fired during install verification."
  log "      The pump should only start when process.title indicates"
  log "      the gateway runtime ('openclaw-gateway'), never during"
  log "      install ('openclaw-plugins')."
  log "--- install output ---"
  cat "$INSTALL_LOG" >&2
  exit 1
fi
# Positive assertion: the skip path is the contract — confirm it fired.
if ! grep -q 'wake_pump_skip_non_gateway' "$INSTALL_LOG"; then
  log "FAIL: 'wake_pump_skip_non_gateway' marker missing."
  log "      Either the gating logic regressed (pump didn't run, but"
  log "      didn't log the skip either) or the openclaw CLI changed"
  log "      its process.title scheme. Investigate the install log:"
  log "--- install output ---"
  cat "$INSTALL_LOG" >&2
  exit 1
fi

log "Plugin loaded against $IMAGE:$TAG (install exited cleanly, skip fired)."
