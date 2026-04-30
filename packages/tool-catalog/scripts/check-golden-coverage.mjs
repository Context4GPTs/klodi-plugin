#!/usr/bin/env node
/**
 * Drift gate for the golden corpus (Decision 7).
 *
 * Walks every `kind: "..."` discriminator in `src/events.ts` (the TS
 * source of truth) and confirms that `tests/golden/` contains a
 * fixture file named `<kind>.json` for each. Fails CI if any kind
 * lacks a fixture, so adding a new event variant requires adding a
 * fixture in the same change.
 *
 * Usage:
 *   pnpm --filter @klodi/tool-catalog check:golden
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const EVENTS_TS = join(PKG_ROOT, "src", "events.ts");
const GOLDEN_DIR = join(PKG_ROOT, "tests", "golden");

const source = readFileSync(EVENTS_TS, "utf-8");

// Match `kind: "<value>"` and `kind:\n    | "<value>"` forms.
// The TS `events.ts` writes both. A discriminator value never
// contains a `"` character.
const KIND_RE = /"([a-z]+(?:_[a-z]+)*\.[a-z]+(?:_[a-z]+)*)"/g;

const declaredKinds = new Set();
for (const match of source.matchAll(KIND_RE)) {
  declaredKinds.add(match[1]);
}

if (declaredKinds.size === 0) {
  console.error(
    "[check-golden] no `kind` discriminators found in src/events.ts —"
    + " refusing to declare green on an empty union."
  );
  process.exit(2);
}

const fixtureFiles = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length));
const fixtureKinds = new Set(fixtureFiles);

const missing = [];
for (const kind of declaredKinds) {
  if (!fixtureKinds.has(kind)) missing.push(kind);
}

const orphaned = [];
for (const kind of fixtureKinds) {
  if (!declaredKinds.has(kind)) orphaned.push(kind);
}

if (missing.length > 0 || orphaned.length > 0) {
  if (missing.length > 0) {
    console.error("[check-golden] missing fixtures for declared kinds:");
    for (const k of missing.sort()) console.error(`  - ${k}.json`);
  }
  if (orphaned.length > 0) {
    console.error("[check-golden] orphaned fixtures (no matching kind):");
    for (const k of orphaned.sort()) console.error(`  - ${k}.json`);
  }
  process.exit(1);
}

console.log(
  `[check-golden] OK — ${declaredKinds.size} kinds, ${fixtureKinds.size} fixtures.`,
);
