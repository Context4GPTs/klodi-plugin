#!/usr/bin/env bash
#
# Create + push the `klodi-zeroclaw-v<version>` git tag.
# Mirrors klodi-plugin/adapters/openclaw/scripts/tag-version.mjs.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER_SLUG="zeroclaw"
PACKAGE_NAME="klodi-${ADAPTER_SLUG}"

log() { printf '[tag] %s\n' "$*" >&2; }

cd "$ADAPTER_DIR"

# awk avoids the Python-3.11+ tomllib dep so this works on stock python3 (3.10).
VERSION="$(awk -F'"' '/^\[package\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $2;exit}' Cargo.toml)"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log "refusing: Cargo.toml#version is not plain semver ($VERSION)"
  exit 1
fi
TAG="${PACKAGE_NAME}-v${VERSION}"

HEAD_SHA="$(git rev-parse HEAD)"

if LOCAL_SHA="$(git rev-parse -q --verify "refs/tags/${TAG}" 2>/dev/null)"; then
  if [[ "$LOCAL_SHA" != "$HEAD_SHA" ]]; then
    log "local tag ${TAG} points at ${LOCAL_SHA:0:7}, not HEAD (${HEAD_SHA:0:7})"
    log "  refusing to move it — that breaks checkouts pulling the old SHA"
    log "  delete it with: git tag -d ${TAG}"
    exit 1
  fi
  log "${TAG} already at HEAD locally"
else
  log "creating ${TAG} at ${HEAD_SHA:0:7}"
  git tag "$TAG"
fi

if REMOTE_LINE="$(git ls-remote --tags origin "refs/tags/${TAG}")" && [[ -n "$REMOTE_LINE" ]]; then
  REMOTE_SHA="${REMOTE_LINE%%	*}"
  if [[ "$REMOTE_SHA" != "$HEAD_SHA" ]]; then
    log "origin's ${TAG} points at ${REMOTE_SHA:0:7}, not HEAD (${HEAD_SHA:0:7})"
    log "  refusing to force-push a published tag — resolve manually"
    exit 1
  fi
  log "${TAG} already on origin at HEAD"
else
  log "pushing ${TAG} to origin"
  git push origin "$TAG"
fi

log "done."
