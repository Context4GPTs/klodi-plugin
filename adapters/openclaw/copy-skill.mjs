#!/usr/bin/env node
/**
 * Materialize the canonical klodi skill bundle into this adapter's
 * root as `./klodi-skill/` ahead of build and pack. Per 0010 §
 * "Repository and release topology": several host registries copy the
 * plugin to a local cache and block path traversal outside the plugin
 * root, so we copy the bytes rather than rely on symlinks. The
 * authoritative source is `klodi-plugin/skill/` — adapter-local copies
 * are build artifacts, never edited by hand. The destination is
 * namespaced `klodi-skill/` so the host-published skill slug cannot
 * collide with other plugins that ship a generic `skill/` folder.
 *
 * Reseed semantics (per **R § P3-19**, Option A):
 *   - Default (no flag): if `./klodi-skill/` exists, log a `[reseed]`
 *     warning line BEFORE the destructive overwrite so an unexpected
 *     reseed is visible in build logs. Then overwrite.
 *   - `--no-reseed`: refuse to overwrite `./klodi-skill/` when it
 *     exists, exit 1 with a clear error. Use when the adapter's local
 *     skill copy was edited locally and must not be reset.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "..", "..", "skill");
const TARGET = resolve(HERE, "klodi-skill");

// Tiny CLI: we accept exactly --no-reseed and --help. No need for a
// dependency — this script runs at build time, before any deps are
// installed, so anything imported here would have to be a workspace
// or transitive dev-only package. Stdlib only keeps it boring.
const argv = process.argv.slice(2);

if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    "copy-skill.mjs — copy klodi-plugin/skill/ into adapters/openclaw/klodi-skill/\n"
    + "\n"
    + "Options:\n"
    + "  --no-reseed   Refuse to overwrite an existing ./klodi-skill/ directory.\n"
    + "                Default behaviour (no flag) is to log a [reseed]\n"
    + "                warning then overwrite, so existing build flows\n"
    + "                that never pass a flag continue to work.\n"
    + "  --help, -h    Print this help text.\n",
  );
  process.exit(0);
}

const RESEED = !argv.includes("--no-reseed");
const UNKNOWN = argv.filter((a) => a !== "--no-reseed");
if (UNKNOWN.length > 0) {
  console.error(
    `[copy-skill] unknown argument(s): ${UNKNOWN.join(" ")}.`
    + " Run with --help for usage.",
  );
  process.exit(2);
}

if (!existsSync(SOURCE)) {
  console.error(
    `[copy-skill] canonical skill dir missing at ${SOURCE}.`
    + " klodi-plugin monorepo layout is broken — reinstall?",
  );
  process.exit(1);
}

if (existsSync(TARGET)) {
  if (!RESEED) {
    console.error(
      `[copy-skill] ${TARGET} already exists and --no-reseed was passed.`
      + " Refusing to overwrite. Remove the directory manually or re-run"
      + " without --no-reseed to allow the destructive copy.",
    );
    process.exit(1);
  }
  console.warn(
    `[reseed] removing prior ${TARGET} (use --no-reseed to keep existing)`,
  );
  rmSync(TARGET, { recursive: true, force: true });
}

cpSync(SOURCE, TARGET, { recursive: true, dereference: true });

console.log(`[copy-skill] ${SOURCE} → ${TARGET}`);
