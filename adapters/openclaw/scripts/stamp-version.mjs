#!/usr/bin/env node
/**
 * Stamp package.json#version (the single source of version truth) into the
 * artifacts that ship alongside it. Two things get stamped, both keyed off
 * that one version:
 *
 *   1. The manifest's own top-level `"version"` field (openclaw.plugin.json
 *      only). OpenClaw and the plugin registry read this as THE plugin
 *      version; if it lags package.json the registry flags a package↔manifest
 *      drift and disables the target. See manifest-version-symmetry.test.ts.
 *   2. Every pinned-tag GitHub URL matching the literal repo
 *      `github.com/Context4GPTs/klodi-plugin/(blob|tree)/vX.Y.Z/` prefix, in
 *      both SECURITY.md and openclaw.plugin.json, so doc/threat-model links
 *      resolve to the tag that ships.
 *
 * Idempotent: re-running at the same version is a no-op.
 *
 * Run automatically by `prepublish` ahead of the smoke gate so the tarball
 * always ships a manifest version and URLs that match the published version.
 * Also safe to run standalone (`pnpm stamp-version`) after a version bump to
 * stage the changes into the version commit.
 *
 * Scope is tight on purpose: the URL rewrite only touches the literal repo
 * blob/tree prefix, and the version-field rewrite only touches the manifest's
 * top-level `"version"` key (anchored to start-of-line). Unrelated GitHub
 * links, npm tags, and the `minGatewayVersion`/`pluginApi` semantic floors in
 * package.json are left alone.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf-8"),
);
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `[stamp-version] refusing to stamp non-semver version: ${version}`,
  );
  process.exit(1);
}

const tag = `v${version}`;

// Matches the klodi-plugin repo URL followed by `blob/vX.Y.Z/` or
// `tree/vX.Y.Z/`. Capture groups preserve the ref kind and the trailing
// slash so only the version segment changes. Applied to every target.
const URL_PATTERN =
  /(github\.com\/Context4GPTs\/klodi-plugin\/(?:blob|tree)\/)v\d+\.\d+\.\d+(\/)/g;

// Matches the manifest's top-level `"version": "X.Y.Z"` field, anchored to
// the start of a line so it never catches a nested or unrelated `version`
// key. Scoped to openclaw.plugin.json only — SECURITY.md has no such field.
const MANIFEST_VERSION_PATTERN = /^(\s*"version":\s*")\d+\.\d+\.\d+(")/m;

let anyChanged = false;

function stamp(rel, transform) {
  const path = resolve(ROOT, rel);
  const before = readFileSync(path, "utf-8");
  const after = transform(before);
  if (after !== before) {
    writeFileSync(path, after, "utf-8");
    anyChanged = true;
    console.log(`[stamp-version] ${rel} → ${tag}`);
  }
}

// SECURITY.md: pinned-tag URLs only.
stamp("SECURITY.md", (s) => s.replace(URL_PATTERN, `$1${tag}$2`));

// openclaw.plugin.json: the manifest version field AND pinned-tag URLs.
stamp("openclaw.plugin.json", (s) =>
  s
    .replace(MANIFEST_VERSION_PATTERN, `$1${version}$2`)
    .replace(URL_PATTERN, `$1${tag}$2`),
);

if (!anyChanged) {
  console.log(`[stamp-version] already at ${tag}; no changes.`);
}
