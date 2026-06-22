#!/usr/bin/env bash
#
# Gateway-startup load smoke gate for @4gpts/klodi.
#
# Boots a REAL `openclaw gateway` on the CURRENT pinned image (2026.5.27,
# NOT the 2026.4.15 floor the install-context sibling pins — flooring is
# exactly how this bug shipped) and asserts the freshly-packed plugin
# activates at startup, i.e. `klodi` appears in
# `openclaw gateway health --json` plugins.loaded.
#
# Why this gate exists, and why it is distinct from smoke-plugin-load.sh
# ---------------------------------------------------------------------
# OpenClaw exposes a plugin on THREE axes; only the third catches this bug:
#   1. should-be-registered (adapter-source ↔ catalog)   — static
#   2. is-registered (manifest .contracts.tools ↔ code)  — static (ADR-0014)
#   3. is-actually-loaded-at-gateway-startup             — RUNTIME (this gate)
# `plugins doctor`, `plugins list`, and the manifest↔registered gate are all
# axis-1/2 STATIC manifest lints: on 2026.5.27 they reported klodi enabled +
# linked + 35 tools in sync while the gateway booted WITHOUT klodi, because
# the manifest's `.activation` block carried no startup trigger and 2026.5.27
# treats `.activation` as an authoritative load gate. The only signal that
# observes axis 3 is a live gateway boot read via `gateway health --json`
# plugins.loaded — which is what this gate does.
#
# Forbidden load signals (would false-green this exact bug):
#   - /v1/models — serves Control-UI HTML (text/html) on 2026.5.27
#     regardless of plugin-load state, even with token auth + Accept: json.
#   - the `klodi_plugin_loaded` log marker — fires on lazy/capability
#     activation paths while klodi is still ABSENT from the startup
#     plugins.loaded set (the precise gap this gate closes).
#   - `plugins doctor` — static manifest lint (axis 2); passed clean while
#     the plugin failed to load.
# The SOLE authoritative signal is `gateway health --json` plugins.loaded.
#
# The pack path (build deps topologically → pnpm build → vendor.mjs →
# npm pack → structural asserts) is shared with smoke-plugin-load.sh via
# scripts/smoke-pack-lib.sh — the tarball under test is identical; only the
# boot differs. The bug under test is activation, not packaging.
#
# Usage:
#   scripts/smoke-gateway-load.sh                     # pinned tag (2026.5.27)
#   OPENCLAW_TAG=latest scripts/smoke-gateway-load.sh # nightly drift check
#
# Exit codes:
#   0  gateway booted on $TAG AND `klodi` ∈ gateway health --json
#      plugins.loaded — the plugin activates at startup as intended.
#   1  gateway became healthy but `klodi` ∉ plugins.loaded — THE BUG:
#      .activation never fired a startup load. The loaded set (what DID
#      load — the stock plugins) is dumped so the failure names itself.
#   2  build / docker / prerequisite failure, OR the gateway never became
#      healthy within the deadline (infra/boot failure). docker logs dumped.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
readonly ROOT
readonly IMAGE="${OPENCLAW_IMAGE:-alpine/openclaw}"
# The CURRENT pinned image — the one where the bug reproduces and where the
# startup-activation contract is enforced. NOT the 2026.4.15 floor: a gate
# on the floor is green while the current image rejects the plugin (that is
# precisely how this bug shipped). Env-overridable for a `latest` drift run.
readonly TAG="${OPENCLAW_TAG:-2026.5.27}"
readonly CONTAINER="klodi-plugin-gateway-smoke-$$"

# Gateway wiring the gate owns end-to-end: it boots the gateway, so it picks
# the port and the auth token it then presents to `gateway health`. No
# external provider/model credential is needed — this gate proves LOAD
# (presence in plugins.loaded), not model selection, so the staged config
# carries NO model block on purpose (load ≠ model selection; host spec §9).
readonly GATEWAY_PORT="${SMOKE_GATEWAY_PORT:-18789}"
readonly GATEWAY_TOKEN="${SMOKE_GATEWAY_TOKEN:-smoke}"
readonly GATEWAY_WS_URL="ws://127.0.0.1:${GATEWAY_PORT}"

# Bounded readiness poll — NEVER a fixed sleep. A fixed sleep is the classic
# flake source: too short → false red, too long → slow gate. We poll with a
# per-attempt interval and a hard total deadline; "not yet listening / command
# failed" is a retry, only deadline-with-no-healthy-response is a real failure.
readonly POLL_INTERVAL_S="${SMOKE_POLL_INTERVAL_S:-2}"
readonly POLL_DEADLINE_S="${SMOKE_POLL_DEADLINE_S:-60}"
readonly HEALTH_TIMEOUT_MS="${SMOKE_HEALTH_TIMEOUT_MS:-10000}"

readonly PLUGIN_ID="klodi"

log() { printf '[gateway-smoke] %s\n' "$*" >&2; }

# Invoked indirectly via the EXIT trap (SC2329 is a false positive here).
# shellcheck disable=SC2329
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -n "${STAGE_DIR:-}" && -d "$STAGE_DIR" ]] && rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

# Shared pack path (ADR-0009 vendoring + structural asserts). Sets TARBALL +
# STAGE_DIR. `log` and `ROOT` must be defined before sourcing (they are).
# shellcheck source=scripts/smoke-pack-lib.sh
. "$ROOT/scripts/smoke-pack-lib.sh"

# --- Prerequisites + build + pack -------------------------------------------

smoke_require_pack_prereqs
smoke_build_and_pack # sets TARBALL, STAGE_DIR

# --- Stage the gateway config -----------------------------------------------
# Enables the klodi plugin entry, runs the gateway in local mode on a fixed
# port with a self-chosen static token, and carries NO model block. The klodi
# plugin reads only cfg.agents.list (src/service/wake.ts), never model keys,
# and the host parses + boots a model-less config (settled empirically — same
# as the install-context sibling). Everything rides into the container under
# /stage:ro so nothing host-side needs to be container-uid-writable.
cat >"$STAGE_DIR/openclaw.json" <<EOF
{
  "gateway": {
    "mode": "local",
    "port": ${GATEWAY_PORT},
    "auth": { "mode": "token", "token": "${GATEWAY_TOKEN}" }
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
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

smoke_world_readable_stage "$STAGE_DIR"

# --- Boot the gateway detached ----------------------------------------------
# Detached (`docker run -d`) so the script owns the lifecycle and always
# reaches teardown (the gateway is a long-lived process — foregrounding it
# would never return). The container installs the tarball, then execs the
# gateway; the install runs in-process before the gateway boot, so by the
# time the gateway is listening the plugin is installed + linked. `--bind lan`
# is required for a non-loopback listener reachable for the health probe (the
# config's gateway.mode=local + token auth still gate access).
log "Booting gateway on $IMAGE:$TAG (port $GATEWAY_PORT) with klodi installed..."
docker run -d --name "$CONTAINER" \
  -v "$STAGE_DIR:/stage:ro" \
  -e OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
  -e KLODI_HOME=/home/node/.openclaw/klodi \
  "$IMAGE:$TAG" \
  sh -c "
    set -e
    mkdir -p /home/node/.openclaw
    cp /stage/openclaw.json /home/node/.openclaw/openclaw.json
    openclaw plugins install /stage/$(basename "$TARBALL")
    exec openclaw gateway --bind lan
  " >/dev/null || {
  log "FAIL: docker run -d could not start the container."
  exit 2
}

# --- Poll gateway health --json until ready — bounded, never a fixed sleep --
# Three terminal states, never collapsed:
#   ok && klodi ∈ loaded   → 0 (pass)
#   ok && klodi ∉ loaded   → 1 (THE BUG; dump the loaded set)
#   deadline, never healthy → 2 (infra/boot failure; dump docker logs)
log "Polling 'gateway health --json' (interval ${POLL_INTERVAL_S}s, deadline ${POLL_DEADLINE_S}s)..."

readonly DEADLINE=$((SECONDS + POLL_DEADLINE_S))
health_json=""
got_healthy=0

while ((SECONDS < DEADLINE)); do
  # `health --json` exits non-zero and/or prints non-JSON while the server is
  # not yet listening — both are retry conditions, not failures. Capture
  # stdout only; route the CLI's own stderr noise away so a partial read can't
  # corrupt the JSON parse.
  set +e
  attempt="$(docker exec "$CONTAINER" \
    openclaw gateway health --json \
    --token "$GATEWAY_TOKEN" \
    --url "$GATEWAY_WS_URL" \
    --timeout "$HEALTH_TIMEOUT_MS" 2>/dev/null)"
  set -e

  if [[ -n "$attempt" ]] && printf '%s' "$attempt" | jq -e '.ok == true' >/dev/null 2>&1; then
    health_json="$attempt"
    got_healthy=1
    break
  fi

  sleep "$POLL_INTERVAL_S"
done

if ((got_healthy == 0)); then
  log "FAIL (exit 2): gateway never became healthy within ${POLL_DEADLINE_S}s."
  log "      This is an infra/boot failure, not the plugin-load bug — the"
  log "      gateway never answered 'health --json' with { ok: true }."
  log "--- docker logs ($CONTAINER) ---"
  docker logs "$CONTAINER" 2>&1 | tail -60 >&2 || true
  exit 2
fi

# --- Assert klodi ∈ plugins.loaded ------------------------------------------
# Emit the loaded set to stdout (the wrapper asserts on this output: it must
# contain the plugin id AND the literal `plugins.loaded`). Sorted for a stable,
# readable report.
loaded="$(printf '%s' "$health_json" | jq -r '.plugins.loaded | sort | join(", ")')"
log "gateway health: ok=true; plugins.loaded = [$loaded]"

if printf '%s' "$health_json" | jq -e --arg id "$PLUGIN_ID" '.plugins.loaded | index($id) != null' >/dev/null; then
  # stdout (not stderr): the proof line the wrapper keys off.
  printf 'gateway health --json plugins.loaded contains %s: [%s]\n' "$PLUGIN_ID" "$loaded"
  log "PASS (exit 0): '$PLUGIN_ID' loaded at gateway startup on $IMAGE:$TAG."
  exit 0
fi

# klodi healthy-but-absent → the bug. Dump what DID load so the failure names
# the regression (the stock plugins are present; klodi's .activation never
# fired at startup). Also surface plugins.errors in case the host rejected it
# with a reason rather than silently skipping.
errors="$(printf '%s' "$health_json" | jq -c '.plugins.errors')"
log "FAIL (exit 1): '$PLUGIN_ID' is ABSENT from gateway plugins.loaded."
log "      The gateway is healthy but klodi did not activate at startup —"
log "      its manifest .activation did not fire a load on $IMAGE:$TAG."
log "      THIS IS THE BUG this gate guards. plugins.loaded = [$loaded]"
log "      plugins.errors = $errors"
log "--- docker logs ($CONTAINER) ---"
docker logs "$CONTAINER" 2>&1 | tail -60 >&2 || true
exit 1
