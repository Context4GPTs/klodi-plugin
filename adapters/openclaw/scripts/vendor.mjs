#!/usr/bin/env node
/**
 * Stage @4gpts/klodi for ClawHub publish — vendor workspace TS deps.
 *
 * Why this exists, in three constraints:
 *
 *   1. ClawHub's publish CLI hardcodes `node_modules/` into its ignore
 *      list (`clawhub/dist/cli/commands/packages.js`). It is stripped at
 *      upload time regardless of where it sits in the source tree, so
 *      nothing about `bundleDependencies` can reach published clients.
 *
 *   2. @klodi/nats-client and @klodi/tool-catalog are workspace-only
 *      packages (private:true, never published to npm). A normal
 *      `npm install` on a user's host cannot resolve them, so the
 *      runtime payload must include their compiled JS inline.
 *
 *   3. The Rust and Python adapters in this repo solve the same shape
 *      of problem with build-time vendor scripts (see
 *      adapters/{hermes,ironclaw,moltis,nanobot,zeroclaw}/scripts/
 *      vendor.py). Per-adapter private namespaces (`_klodi_<adapter>_
 *      <pkg>`) prevent collision when multiple klodi-* adapters install
 *      into the same env. This script ports that pattern to TS.
 *
 * Build flow:
 *   1. (caller) build deps + adapter in dependency order:
 *        cd packages/tool-catalog   && pnpm install && pnpm build
 *        cd packages/nats-client-ts && pnpm install && pnpm build
 *        cd adapters/openclaw       && pnpm install && pnpm build
 *   2. vendor.mjs (this) — stages a publish-ready tree at
 *      adapters/openclaw/.publish-stage/
 *   3. (caller) `clawhub package publish .publish-stage` for real
 *      publish, or `npm pack` from the staged dir for inspection.
 *
 * Source tree mutation: NONE. The adapter's own package.json keeps
 * the `file:` workspace deps in dependencies — they are real runtime
 * deps; the publish-time vendoring is what changes their delivery
 * mechanism, not their nature. Source resolves them via the workspace
 * symlinks pnpm sets up; the published package.json has them removed
 * from dependencies because they ride into the tarball as inlined JS
 * under dist/_vendor/. Same shape as adapters/hermes — workspace
 * deps disappear from the published manifest because the artefact
 * already contains them.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(HERE, "..");
const REPO_ROOT = resolve(ADAPTER_ROOT, "..", "..");
const STAGE = join(ADAPTER_ROOT, ".publish-stage");
const ADAPTER_SLUG = "openclaw";

// Workspace deps to vendor. Each rides into dist/_vendor/<vendorDir>/
// under a per-adapter private namespace.
const VENDOR_TARGETS = [
  {
    name: "@klodi/nats-client",
    sourceDist: join(REPO_ROOT, "packages", "nats-client-ts", "dist"),
    vendorDir: `_klodi_${ADAPTER_SLUG}_natsclient`,
  },
  {
    name: "@klodi/tool-catalog",
    sourceDist: join(REPO_ROOT, "packages", "tool-catalog", "dist"),
    vendorDir: `_klodi_${ADAPTER_SLUG}_toolcatalog`,
  },
];

const VENDOR_ROOT = join(STAGE, "dist", "_vendor");

// Top-level adapter files that ride into the published tarball. Mirrors
// package.json#files. package.json itself is written separately (stripped).
const TOP_LEVEL_FILES = ["README.md", "SECURITY.md", "LICENSE", "NOTICE", "openclaw.plugin.json"];
const TOP_LEVEL_DIRS = ["skill"];

// Workspace deps that ride into the artefact as inlined source (not as
// registry-fetchable packages). Their entries vanish from the published
// package.json#dependencies — same shape as `klodi-hermes`'s pyproject,
// where `klodi_nats_client` is not declared as a runtime dep because
// the wheel ships `_klodi_hermes_natsclient/` instead.
const VENDORED_DEP_NAMES = new Set(VENDOR_TARGETS.map((t) => t.name));

function log(msg) { console.log(`[vendor] ${msg}`); }

function fail(msg) {
  console.error(`[vendor] ${msg}`);
  process.exit(1);
}

function preflight() {
  for (const target of VENDOR_TARGETS) {
    if (!existsSync(target.sourceDist)) {
      fail(
        `${target.sourceDist} missing. Build workspace deps first:\n`
        + "  (cd packages/tool-catalog && pnpm install && pnpm build)\n"
        + "  (cd packages/nats-client-ts && pnpm install && pnpm build)",
      );
    }
  }
  const adapterDist = join(ADAPTER_ROOT, "dist");
  if (!existsSync(adapterDist)) {
    fail(`${adapterDist} missing. Run \`pnpm build\` in adapters/openclaw first.`);
  }
}

function clean() {
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
}

function copyTopLevel() {
  for (const f of TOP_LEVEL_FILES) {
    const src = join(ADAPTER_ROOT, f);
    if (!existsSync(src)) fail(`required top-level file missing: ${f}`);
    cpSync(src, join(STAGE, f));
  }
  for (const d of TOP_LEVEL_DIRS) {
    const src = join(ADAPTER_ROOT, d);
    if (!existsSync(src)) fail(`required top-level dir missing: ${d}/`);
    cpSync(src, join(STAGE, d), { recursive: true, dereference: true });
  }
  log(`copied ${[...TOP_LEVEL_FILES, ...TOP_LEVEL_DIRS.map((d) => `${d}/`)].join(", ")}`);
}

function copyAdapterDist() {
  cpSync(join(ADAPTER_ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
  log("copied adapter dist/");
}

// Only runtime JS rides into the vendored copy. .d.ts and .js.map
// files are dead weight at install time, and tool-catalog's codegen/
// subdir is dev tooling consumed by the Python and Rust adapters'
// vendor pipelines, not by openclaw runtime.
function shouldCopyVendorEntry(name, isDir) {
  if (isDir) return name !== "codegen";
  return name.endsWith(".js");
}

function copyVendorSource(target) {
  const dst = join(VENDOR_ROOT, target.vendorDir);
  mkdirSync(dst, { recursive: true });
  walkAndCopy(target.sourceDist, dst);
  log(`vendored ${target.name} → dist/_vendor/${target.vendorDir}/`);
}

function walkAndCopy(srcDir, dstDir) {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!shouldCopyVendorEntry(entry.name, entry.isDirectory())) continue;
    const s = join(srcDir, entry.name);
    const d = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(d, { recursive: true });
      walkAndCopy(s, d);
    } else {
      cpSync(s, d);
    }
  }
}

// Match string-literal module specifiers at import/export/from/require/
// dynamic-import positions. Anchored to those keywords so JSDoc and
// runtime strings that happen to contain `@klodi/...` are not touched.
const SPECIFIER_RE = new RegExp(
  "(\\bfrom\\s+|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)"
    + "(['\"])(@klodi\\/(?:nats-client|tool-catalog))(\\/[^'\"]*)?\\2",
  "g",
);

function rewriteImports() {
  let total = 0;
  for (const file of walkJs(join(STAGE, "dist"))) {
    const text = readFileSync(file, "utf8");
    const updated = text.replace(SPECIFIER_RE, (match, lead, quote, bare, sub) => {
      const target = VENDOR_TARGETS.find((t) => t.name === bare);
      if (!target) return match;
      const subPath = sub ? `${sub.slice(1)}.js` : "index.js";
      const absTarget = join(VENDOR_ROOT, target.vendorDir, subPath);
      let rel = relative(dirname(file), absTarget);
      if (sep === "\\") rel = rel.replace(/\\/g, "/");
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${lead}${quote}${rel}${quote}`;
    });
    if (updated !== text) {
      writeFileSync(file, updated);
      total += 1;
    }
  }
  log(`rewrote @klodi/* specifiers in ${total} file(s)`);
}

function* walkJs(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) yield* walkJs(p);
    else if (entry.isFile() && p.endsWith(".js")) yield p;
  }
}

function writePublishPackageJson() {
  // The publish-time projection of vendoring: workspace deps are real
  // runtime dependencies in source (declared in dependencies, resolved
  // by tsc against the workspace), but they ride into the published
  // artefact as inlined source under dist/_vendor/. Stripping them
  // from dependencies here is the encoding of that fact — npm install
  // on the user's host would 404 on the public registry if they were
  // left declared. Mirrors the hermes pyproject pattern: workspace
  // deps disappear from the consumer's manifest because the artefact
  // physically contains them.
  const original = JSON.parse(
    readFileSync(join(ADAPTER_ROOT, "package.json"), "utf8"),
  );
  const published = { ...original };
  if (published.dependencies) {
    const cleaned = {};
    for (const [name, range] of Object.entries(published.dependencies)) {
      if (VENDORED_DEP_NAMES.has(name)) continue;
      cleaned[name] = range;
    }
    published.dependencies = cleaned;
  }
  // devDependencies and scripts are not part of the runtime contract.
  delete published.devDependencies;
  delete published.scripts;
  writeFileSync(
    join(STAGE, "package.json"),
    `${JSON.stringify(published, null, 2)}\n`,
  );
  log("wrote publish package.json (vendored deps removed from dependencies)");
}

function main() {
  preflight();
  clean();
  copyTopLevel();
  copyAdapterDist();
  for (const target of VENDOR_TARGETS) copyVendorSource(target);
  rewriteImports();
  writePublishPackageJson();
  log(`staged tree ready at ${STAGE}`);
}

main();
