#!/usr/bin/env node
/**
 * Orchestrate JSON Schema + Rust codegen for the canonical klodi_*
 * tool catalog.
 *
 * Run with: pnpm --filter @klodi/tool-catalog codegen
 *
 * Emits:
 *   dist/schemas.json   — Python adapters consume directly
 *   dist/rust-types.rs  — Rust adapters compile directly
 *
 * Both files are committed so Modules C and D have no TS build
 * dependency on this package. Uses the locally-installed `tsx` binary
 * to execute the TypeBox-importing TS source without prebuilding.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const DIST_DIR = join(PKG_ROOT, "dist");
const PACKAGES_ROOT = resolve(PKG_ROOT, "..");

if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

const TSX_BIN = join(PKG_ROOT, "node_modules", ".bin", "tsx");
if (!existsSync(TSX_BIN)) {
  console.error(
    `[tool-catalog] tsx binary missing at ${TSX_BIN}.`
    + " Run 'pnpm install' from the repo root first.",
  );
  process.exit(1);
}

function runScript(scriptPath) {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn(TSX_BIN, [scriptPath], {
      cwd: PKG_ROOT,
      stdio: "inherit",
    });
    child.on("error", rejectProm);
    child.on("exit", (code) => {
      if (code === 0) resolveProm();
      else rejectProm(new Error(`${scriptPath} exited with code ${code}`));
    });
  });
}

await runScript(join(PKG_ROOT, "src", "codegen", "json-schema.ts"));
await runScript(join(PKG_ROOT, "src", "codegen", "rust-types.ts"));
await runScript(join(PKG_ROOT, "src", "codegen", "error-codes.ts"));

// Mirror dist/schemas.json into each Python package's resource dir so
// `klodi_nats_client` + `klodi_logger` see the same canonical artifact
// during dev (the wheels still ship this copy at publish time). Without
// this sync, edits to the TS catalog land in `dist/` but the Python
// halves keep reading the stale vendored copy.
const PY_TARGETS = [
  ["nats-client-py", "klodi_nats_client"],
  ["logger-py", "klodi_logger"],
];

// WHY these mirrors are the git-tracked cross-language param contract —
// NOT dist/schemas.json. In this repo checkout `dist/*` is gitignored
// (.gitignore:109 `dist`; the `!…/dist/schemas.json` re-includes below it
// are anchored to a parent-folder path and do not match from this root —
// `git check-ignore dist/schemas.json` confirms it's ignored). So after a
// schema change you must `git add` BOTH mirrors below; staging only dist/
// leaves the only tracked copy stale and adapters read an old contract.
// The check:codegen-fresh gate compares dist/ only and CANNOT catch this;
// the cross-language presence test (list-update-*-cross-language) does.
for (const [pkgDir, pyModule] of PY_TARGETS) {
  const target = join(PACKAGES_ROOT, pkgDir, "src", pyModule, "schemas.json");
  copyFileSync(join(DIST_DIR, "schemas.json"), target);
  console.log(`[tool-catalog] mirrored schemas.json → ${target}`);
}

// Mirror dist/error-codes.json into klodi_nats_client so the Python
// adapter pair (hermes + nanobot) can load the canonical R2 vocabulary
// at runtime — closing the drift gap that the round-2 test gates.
// Round 2 P2.2: full codegen of the Python module + the Rust const file
// is the future fix; for now the JSON mirror lets the Python side
// lookup-test against the source of truth.
const ERROR_CODES_TARGET = join(
  PACKAGES_ROOT,
  "nats-client-py",
  "src",
  "klodi_nats_client",
  "error_codes.json",
);
copyFileSync(join(DIST_DIR, "error-codes.json"), ERROR_CODES_TARGET);
console.log(`[tool-catalog] mirrored error-codes.json → ${ERROR_CODES_TARGET}`);

console.log("[tool-catalog] codegen complete.");
