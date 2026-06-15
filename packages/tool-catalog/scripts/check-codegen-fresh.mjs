#!/usr/bin/env node
/**
 * Codegen freshness gate (Decision 7).
 *
 * Runs `pnpm codegen` and fails if `dist/schemas.json` or
 * `dist/rust-types.rs` drift from the regenerated output. Catches the case
 * where someone edits TypeBox schemas but forgets to regenerate the
 * downstream artifacts that Python and Rust adapters consume.
 *
 * NOTE: dist/* is gitignored in this checkout, so this gate guards the
 * working tree, NOT git. The git-tracked param contract is the two Python
 * mirror schemas.json files (see codegen.mjs) — those are what you `git add`
 * after a schema change. The "committed artifact" wording below is dev-tree
 * freshness, not a claim that dist/ is in git.
 *
 * Strategy: snapshot the two files before regen, run codegen, compare.
 * Restore the originals on failure so the working tree is left in the
 * exact state it was in (no spurious diffs from a partial run).
 *
 * Usage:
 *   pnpm --filter @klodi/tool-catalog check:codegen-fresh
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const DIST_DIR = join(PKG_ROOT, "dist");
const TARGETS = ["schemas.json", "rust-types.rs"];

function snapshot(name) {
  const path = join(DIST_DIR, name);
  if (!existsSync(path)) {
    console.error(
      `[check-codegen] missing committed artifact: dist/${name}.`
      + " Run 'pnpm --filter @klodi/tool-catalog codegen' and commit the output.",
    );
    process.exit(2);
  }
  return readFileSync(path, "utf-8");
}

function restore(name, contents) {
  writeFileSync(join(DIST_DIR, name), contents, "utf-8");
}

const before = Object.fromEntries(TARGETS.map((n) => [n, snapshot(n)]));

await new Promise((resolveProm, rejectProm) => {
  const child = spawn("pnpm", ["codegen"], {
    cwd: PKG_ROOT,
    stdio: "inherit",
  });
  child.on("error", rejectProm);
  child.on("exit", (code) => {
    if (code === 0) resolveProm();
    else rejectProm(new Error(`pnpm codegen exited with code ${code}`));
  });
});

const drifted = [];
for (const name of TARGETS) {
  const after = readFileSync(join(DIST_DIR, name), "utf-8");
  if (after !== before[name]) drifted.push(name);
}

if (drifted.length > 0) {
  // Leave the regenerated files in place so the developer can `git diff`
  // to see what changed and commit. (Restoring would hide the drift.)
  console.error("[check-codegen] generated artifacts are stale:");
  for (const n of drifted) console.error(`  - dist/${n}`);
  console.error(
    "Run 'pnpm --filter @klodi/tool-catalog codegen' and commit the regenerated files.",
  );
  process.exit(1);
}

// No drift — restore the snapshots to keep the working tree pristine
// (codegen output may have differed in trivial whitespace that compared
// equal as strings; this is defensive).
for (const name of TARGETS) restore(name, before[name]);

console.log("[check-codegen] OK — committed artifacts match codegen output.");
