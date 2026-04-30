#!/usr/bin/env node
/**
 * Stamp package.json#version into every pinned-tag GitHub URL in
 * SECURITY.md and openclaw.plugin.json. Idempotent: re-running with
 * the same version is a no-op.
 *
 * Run automatically by `prepublish` ahead of the smoke gate so the
 * tarball always ships with URLs whose tag matches the published
 * version. Also safe to run standalone (`pnpm stamp-version`) after
 * a version bump to stage the URL update into the version commit.
 *
 * Scope is tight on purpose: only URLs that match the literal repo
 * `github.com/Context4GPTs/klodi-plugin/(blob|tree)/vX.Y.Z/` prefix
 * get rewritten. Anything else — unrelated GitHub links, external
 * references, npm tags — is left alone.
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
const TARGETS = ["SECURITY.md", "openclaw.plugin.json"];

// Matches the klodi-plugin repo URL followed by `blob/vX.Y.Z/` or
// `tree/vX.Y.Z/`. Capture groups preserve the ref kind and the
// trailing slash so only the version segment changes.
const URL_PATTERN =
  /(github\.com\/Context4GPTs\/klodi-plugin\/(?:blob|tree)\/)v\d+\.\d+\.\d+(\/)/g;

let anyChanged = false;
for (const rel of TARGETS) {
  const path = resolve(ROOT, rel);
  const before = readFileSync(path, "utf-8");
  const after = before.replace(URL_PATTERN, `$1${tag}$2`);
  if (after !== before) {
    writeFileSync(path, after, "utf-8");
    anyChanged = true;
    console.log(`[stamp-version] ${rel} → ${tag}`);
  }
}

if (!anyChanged) {
  console.log(`[stamp-version] already at ${tag}; no changes.`);
}
