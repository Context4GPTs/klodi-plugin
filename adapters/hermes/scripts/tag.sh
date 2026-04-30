#!/usr/bin/env bash
#
# Create + push the `klodi-hermes-v<version>` git tag.
#
# Mirrors klodi-plugin/adapters/openclaw/scripts/tag-version.mjs.
# Idempotent — re-runs are no-ops when the tag already points at HEAD.
# Refuses to move a tag that already points elsewhere; force-moving
# breaks checkouts that pulled the old pointer.
#
# Multi-adapter repo, so the tag is namespaced (`klodi-hermes-v…`)
# rather than the bare `v…` OpenClaw uses today. Six tag namespaces
# coexist this way without collisions.
#
# Requires a git worktree with an `origin` remote.

set -euo pipefail

ADAPTER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER_SLUG="hermes"
PACKAGE_NAME="klodi-${ADAPTER_SLUG}"

log() { printf '[tag] %s\n' "$*" >&2; }

cd "$ADAPTER_DIR"

# awk avoids the Python-3.11+ tomllib dep so this works on stock
# /usr/bin/python3 (3.10) on macOS Sequoia.
VERSION="$(awk -F'"' '/^\[project\]/{p=1;next} /^\[/{p=0} p && /^version[[:space:]]*=/{print $2;exit}' pyproject.toml)"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  log "refusing: pyproject.toml#version is not plain semver ($VERSION)"
  exit 1
fi
TAG="${PACKAGE_NAME}-v${VERSION}"

HEAD_SHA="$(git rev-parse HEAD)"

# Local tag presence + sha.
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

# Remote tag presence + sha.
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
