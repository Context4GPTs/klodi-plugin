#!/usr/bin/env node
/**
 * Create and push the `v${package.json#version}` git tag.
 *
 * Idempotent — re-runs are no-ops when the tag is already in the right
 * place. Refuses to move a tag that already points elsewhere (forced
 * moves break checkouts that pulled the old pointer).
 *
 * Invoked automatically at the end of `prepublish` so every published
 * tarball has a matching tag on origin for the absolute URLs in
 * SECURITY.md and openclaw.plugin.json to resolve. Callable manually
 * (`pnpm tag`) to tag a commit without publishing.
 *
 * Requires a git worktree with an `origin` remote.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(
  readFileSync(resolve(ROOT, "package.json"), "utf-8"),
);
const version = pkg.version;
if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(
    `[tag] refusing: package.json#version is not plain semver (${version})`,
  );
  process.exit(1);
}
const tag = `v${version}`;

function run(cmd, opts = {}) {
  const out = execSync(cmd, {
    cwd: ROOT,
    encoding: "utf-8",
    ...opts,
  });
  // execSync returns null when stdio is "inherit" (no captured stdout).
  return out == null ? "" : out.toString().trim();
}

// Capture-silently wrapper; returns null on non-zero exit, empty string
// on success-with-no-stdout (git ls-remote is the common case).
function runOrNull(cmd) {
  try {
    return run(cmd, { stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

function fail(msg) {
  console.error(`[tag] ${msg}`);
  process.exit(1);
}

const headSha = run("git rev-parse HEAD");
const localTagSha = runOrNull(`git rev-parse -q --verify refs/tags/${tag}`);
const remoteLine = runOrNull(
  `git ls-remote --tags origin refs/tags/${tag}`,
);
const remoteTagSha =
  remoteLine && remoteLine.length > 0
    ? remoteLine.split(/\s+/)[0]
    : null;

if (!localTagSha) {
  console.log(`[tag] creating ${tag} at ${headSha.slice(0, 7)}`);
  run(`git tag ${tag}`, { stdio: "inherit" });
} else if (localTagSha !== headSha) {
  fail(
    `local tag ${tag} already points at ${localTagSha.slice(0, 7)}, not HEAD (${headSha.slice(0, 7)}).\n`
    + `  Refusing to move it — force-moving a tag breaks checkouts that pulled the old SHA.\n`
    + `  If that tag was never shared, delete it: git tag -d ${tag}`,
  );
} else {
  console.log(`[tag] ${tag} already at HEAD locally`);
}

if (!remoteTagSha) {
  console.log(`[tag] pushing ${tag} to origin`);
  run(`git push origin ${tag}`, { stdio: "inherit" });
} else if (remoteTagSha !== headSha) {
  fail(
    `origin's ${tag} already points at ${remoteTagSha.slice(0, 7)}, not HEAD (${headSha.slice(0, 7)}).\n`
    + `  Refusing to force-push a published tag. Resolve manually.`,
  );
} else {
  console.log(`[tag] ${tag} already on origin at HEAD`);
}

console.log(`[tag] done.`);
