# shellcheck shell=bash
#
# Shared pack path for the @4gpts/klodi smoke gates. SOURCED, never run
# directly — it defines functions and expects the caller to have set
# `ROOT` (the adapter root) and defined a `log()` before sourcing.
#
# Two smoke gates exercise the SAME freshly-packed tarball against a real
# OpenClaw image, differing only in HOW they boot it:
#
#   - scripts/smoke-plugin-load.sh   — install context
#       (`openclaw plugins install <tarball>`; process.title
#       `openclaw-plugins`). Asserts the install subprocess exits cleanly
#       and the non-gateway wake-pump skip path fired.
#   - scripts/smoke-gateway-load.sh  — gateway-startup context
#       (`openclaw gateway`; process.title `openclaw-gateway`). Asserts
#       klodi appears in `gateway health --json` plugins.loaded.
#
# The bug each guards is distinct (install-subprocess-must-exit vs
# startup-activation-must-fire), but the tarball under test is identical.
# The vendor+pack+structural-assert steps are therefore factored here so a
# packaging regression is caught once, in one place, and neither gate can
# drift from the real ClawHub publish path (ADR-0009 vendoring contract).
#
# Contract for callers:
#   - set `readonly ROOT=...` (adapter root) BEFORE sourcing
#   - define `log() { ...; }` BEFORE sourcing
#   - after sourcing, call `smoke_require_pack_prereqs` then
#     `smoke_build_and_pack` (sets `TARBALL` + `STAGE_DIR` in the caller's
#     scope) then optionally `smoke_world_readable_stage`.
# Exit codes raised here mirror the gates: 1 = packaging regression,
# 2 = build/prerequisite failure.

# --- Prerequisites ----------------------------------------------------------

smoke_require_pack_prereqs() {
  command -v docker >/dev/null || {
    log "docker not found on PATH"
    exit 2
  }
  command -v pnpm >/dev/null || {
    log "pnpm not found on PATH"
    exit 2
  }
}

# --- Build + pack the plugin ------------------------------------------------
# A fresh dist/ is required; a stale one masks source regressions.
# vendor.mjs stages a publish-ready tree at .publish-stage/ with the
# workspace @klodi/* deps copied into dist/_vendor/ and import specifiers
# rewritten to relative paths. We then `npm pack` from the staged dir to
# produce the same tarball ClawHub would upload (modulo ClawHub's own
# ignore rules; both treat .publish-stage/ as the package root).
#
# Sets, in the CALLER's scope (via the global-by-default semantics of a
# sourced function): TARBALL (absolute path to the .tgz) and STAGE_DIR
# (the mktemp dir holding the tarball + room for the gate's own config).
smoke_build_and_pack() {
  log "Building @4gpts/klodi and its file: deps in topological order..."
  # Each TS package is independent (file: refs, not a pnpm workspace).
  # Build deps first so @klodi/tool-catalog and @klodi/nats-client have
  # dist/ ready by the time openclaw's tsc runs, vendor.mjs's preflight
  # checks pass, and openclaw's pnpm install resolves the file: links.
  local repo_root
  repo_root="$(cd "$ROOT/../.." && pwd)"
  local pkg
  for pkg in packages/tool-catalog packages/nats-client-ts; do
    (cd "$repo_root/$pkg" && pnpm install >/dev/null && pnpm build >/dev/null)
  done
  (cd "$ROOT" && pnpm install >/dev/null && pnpm build >/dev/null)

  log "Staging .publish-stage/ via scripts/vendor.mjs ..."
  (cd "$ROOT" && node scripts/vendor.mjs >/dev/null)

  STAGE_DIR="$(mktemp -d)"
  log "Packing plugin tarball into $STAGE_DIR ..."
  (cd "$ROOT/.publish-stage" && npm pack --pack-destination "$STAGE_DIR" >/dev/null)

  # npm pack writes exactly one .tgz into the (freshly-mktemp'd) STAGE_DIR;
  # glob it directly rather than parsing `ls` (SC2012).
  local tarballs=("$STAGE_DIR"/*.tgz)
  TARBALL="${tarballs[0]}"
  [[ -f "$TARBALL" ]] || {
    log "npm pack produced no tarball"
    exit 2
  }
  log "Tarball: $(basename "$TARBALL") ($(wc -c <"$TARBALL") bytes)"

  smoke_assert_tarball_structure "$TARBALL" "$STAGE_DIR"
}

# --- Structural asserts on the tarball --------------------------------------
# These catch packaging/vendoring regressions without needing a docker run.
# The bug the gates are about (install-hang, startup-activation) is NOT
# packaging — but a broken pack masks everything downstream, so both gates
# share this gate-keeping step.
smoke_assert_tarball_structure() {
  local tarball="$1" stage_dir="$2"
  local extract_dir="$stage_dir/inspect"
  mkdir -p "$extract_dir"
  tar -xzf "$tarball" -C "$extract_dir"

  local vendored_entry
  for vendored_entry in \
    dist/_vendor/_klodi_openclaw_natsclient/index.js \
    dist/_vendor/_klodi_openclaw_toolcatalog/index.js; do
    if [[ ! -f "$extract_dir/package/$vendored_entry" ]]; then
      log "FAIL: $vendored_entry missing from tarball."
      log "      Vendor staging didn't reach the published artefact —"
      log "      check scripts/vendor.mjs and pack:inspect output."
      exit 1
    fi
  done

  if [[ -d "$extract_dir/package/node_modules" ]] ||
    [[ -d "$extract_dir/package/dist/node_modules" ]]; then
    log "FAIL: node_modules/ shipped in tarball."
    log "      Vendor model expects no node_modules/ at all — workspace"
    log "      deps ride under dist/_vendor/ and external deps install"
    log "      via package.json#dependencies on the host."
    exit 1
  fi

  # Vendoring's publish-time projection: workspace deps are real runtime
  # deps in source, but they ride into the artefact as inlined JS under
  # dist/_vendor/, not as registry-fetchable packages. vendor.mjs strips
  # them from the published dependencies so the host's npm install does
  # not try (and fail) to resolve them against the public registry.
  local published_pkg="$extract_dir/package/package.json"
  if grep -qE '"@klodi/(nats-client|tool-catalog)"\s*:' "$published_pkg"; then
    log "FAIL: published package.json still lists @klodi/* in dependencies."
    log "      vendor.mjs's writePublishPackageJson regressed — workspace"
    log "      deps must be stripped because they ship inlined under"
    log "      dist/_vendor/ rather than via the public registry."
    exit 1
  fi

  rm -rf "$extract_dir"
  log "Structural asserts: vendored sources present, no node_modules/, clean package.json."
}

# --- World-readable staging -------------------------------------------------
# `mktemp -d` defaults to mode 0700, owned by the host runner uid. On Linux
# CI the container's `node` user (uid 1000) cannot read files inside that
# mount, even read-only. World-readable on the staging dir (mode 0755) lets
# the bind mount serve the tarball + config to any uid; the dir is ephemeral
# and never written to from the container side.
smoke_world_readable_stage() {
  local stage_dir="$1"
  chmod 0755 "$stage_dir"
  find "$stage_dir" -type f -exec chmod 0644 {} +
}
