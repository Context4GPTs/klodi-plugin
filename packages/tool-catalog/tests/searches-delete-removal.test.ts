/**
 * Catalog removal contract for klodi_searches_delete (the catalog DROP).
 *
 * Card: fix-klodi-searches-delete-catalog-drift.
 *
 * Discovery verdict (settled — DO NOT relitigate): DROP the
 * `klodi_searches_delete` entry from `klodiTools` (it was a ghost — declared
 * in the catalog but never registered under that name on the openclaw gateway,
 * so callTool("klodi_searches_delete") 404s). The fix removes the catalog
 * *name* but PRESERVES the NATS subject `p2p.v1.searches.delete`, which is
 * load-bearing — every host's `klodi_unwatch` composite (and the Rust host)
 * reaches it. After the drop the delete capability remains fully available
 * under its one canonical name, `klodi_unwatch`.
 *
 * This test mirrors catalog-removal.test.ts's Node-native `findOffenders`
 * walk (NOT a shell-out to rg — see that file's header for why a shelled rg
 * silently returned [] in the worktree env and passed every assertion
 * vacuously). It pins three things:
 *
 *   1. The agent-facing tool name `klodi_searches_delete` is gone repo-wide
 *      except in allowlisted surfaces (the active card body is in an
 *      IGNORED_DIRS dir, so it's skipped anyway; the test itself names the
 *      literal; ADR history may reference it post-distillation).
 *   2. The Rust enum variant `KlodiSearchesDelete` is gone — it disappears
 *      from the regenerated rust-types.rs, so its two consumers
 *      (klodi-rust-host tools.rs, nats-client-rs catalog.rs) must stop
 *      referencing it.
 *   3. The subject `p2p.v1.searches.delete` SURVIVES at its known consumer
 *      sites — a deletion of the subject would silently break the delete
 *      capability. This is the inverse of catalog-removal.test.ts: there the
 *      subject was also (mostly) removable; here the subject MUST stay.
 *
 * RED-first: the catalog still declares `klodi_searches_delete` today (and
 * the subject consumers still go through the catalog key / Rust enum variant),
 * so cases 1–2 are RED until the expert-developer lands the DROP. Case 3
 * (subject survives) is GREEN today and must STAY green — it guards against an
 * over-eager removal that deletes the subject too.
 *
 * Per the adversarial-testing skill: NEVER weaken these asserts to make broken
 * impl pass. The allowlist is a precise contract — adding an entry to silence a
 * failure (rather than reconciling the reference) is exactly the shortcut this
 * gate exists to catch.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { klodiTools, TOOL_NAMES } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");

const REMOVED_NAME = "klodi_searches_delete";
const REMOVED_RUST_VARIANT = "KlodiSearchesDelete";
/** The subject the drop must PRESERVE (not remove). */
const SURVIVING_SUBJECT = "p2p.v1.searches.delete";

/**
 * Directories never walked — build artefacts, vendor trees, VCS state, and
 * the gitignored kanban substrate (`cards/`, where the active card body
 * discusses the removed tool by name and is never shipped). Mirrors
 * catalog-removal.test.ts.
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
  ".venv",
  "__pycache__",
  "build",
  ".publish-stage",
  ".obsidian",
  ".claude",
  "cards", // gitignored kanban substrate; the active card body lives here.
]);

const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py",
  ".rs",
  ".toml", ".yaml", ".yml", ".json", ".md", ".sh",
]);

/**
 * Repo-relative paths intentionally allowed to mention `klodi_searches_delete`.
 * Every entry MUST carry a reason. New legitimate references must be added here
 * explicitly — that's the point. The DROP reconciles the four product-doc/string
 * sites the handoff names (error-codes.ts, local-tools.ts, nanobot, tool_inventory)
 * so they are NOT on this list — if any of them still names the tool, the gate
 * fires, which is correct.
 */
const TOOL_NAME_ALLOWLIST: ReadonlySet<string> = new Set([
  // This grep gate itself names the literal to assert it is absent elsewhere.
  "packages/tool-catalog/tests/searches-delete-removal.test.ts",
  // The sibling symmetry-gate test names the dropped tool as its GHOST const —
  // the literal IS the motivating example the gate fixture exercises. It is a
  // test, not shipped surface, so naming the ghost is legitimate (mirrors this
  // test's own self-allow above).
  "packages/tool-catalog/tests/catalog-registered-symmetry.test.ts",
  // The openclaw unwatch regression test carries a WHY comment explaining that
  // registerUnwatch sources the subject from the bare literal AFTER the catalog
  // key klodiTools.klodi_searches_delete was dropped — a legitimate code
  // comment that names the dropped key to document the switch it guards.
  "adapters/openclaw/src/__tests__/tools/discovery.test.ts",
  // ADR-0014 gains the third symmetry axis during Distillation and may cite
  // the ghost by name as the motivating example.
  "docs/decisions/0014-tool-symmetry-axes.md",
  // The migration record documents the removed tool.
  "CHANGELOG.md",
]);

const RUST_VARIANT_ALLOWLIST: ReadonlySet<string> = new Set([
  "packages/tool-catalog/tests/searches-delete-removal.test.ts",
  "docs/decisions/0014-tool-symmetry-axes.md",
  "CHANGELOG.md",
]);

/**
 * The subject `p2p.v1.searches.delete` is STILL hit at these sites after the
 * drop — the subject survives, only the catalog *name* is removed. These are
 * the expected, required consumers (the bare-literal call sites + the existing
 * tests + the docs). The "subject survives" assertion checks the subject is
 * PRESENT at the load-bearing call sites; it does not forbid it elsewhere on
 * this list.
 */
const SUBJECT_REQUIRED_SITES: ReadonlyArray<string> = [
  // openclaw klodi_unwatch composite — switches from the catalog .subject to
  // the bare literal during the fix.
  "adapters/openclaw/src/tools/discovery.ts",
  // hermes + nanobot already use the bare literal (unchanged by the fix).
  "adapters/hermes/src/klodi_hermes/watch.py",
  "adapters/nanobot/nanobot_local_tools.py",
  // Rust host — switches from ToolName::KlodiSearchesDelete.subject() to the
  // bare literal during the fix.
  "packages/klodi-rust-host/src/mcp/tools.rs",
];

function isArchivePath(repoRelative: string): boolean {
  return repoRelative.startsWith("cards/done/");
}

function walk(absRoot: string): string[] {
  const out: string[] = [];
  walkInto(absRoot, absRoot, out);
  return out;
}

function walkInto(absRoot: string, current: string, out: string[]): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && !entry.name.startsWith(".github")) {
        continue;
      }
      walkInto(absRoot, join(current, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const dotIdx = entry.name.lastIndexOf(".");
    if (dotIdx === -1) continue;
    const ext = entry.name.slice(dotIdx);
    if (!SCANNED_EXTENSIONS.has(ext)) continue;
    out.push(relative(absRoot, join(current, entry.name)));
  }
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function findOffenders(needle: string, allowlist: ReadonlySet<string>): string[] {
  const paths = walk(REPO_ROOT);
  const offenders: string[] = [];
  for (const repoRelative of paths) {
    if (isArchivePath(repoRelative)) continue;
    if (allowlist.has(repoRelative)) continue;
    const abs = join(REPO_ROOT, repoRelative);
    try {
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes(needle)) offenders.push(repoRelative);
    } catch {
      // unreadable — skip silently
    }
  }
  return offenders;
}

describe("klodi_searches_delete removal — catalog source", () => {
  it("[unit] is not a key on klodiTools", () => {
    const keys = Object.keys(klodiTools as Record<string, unknown>);
    expect(keys).not.toContain(REMOVED_NAME);
  });

  it("[unit] does not appear in TOOL_NAMES", () => {
    expect(TOOL_NAMES as readonly string[]).not.toContain(REMOVED_NAME);
  });

  it("[unit] src/index.ts does not contain the tool name", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "index.ts"), "utf8");
    expect(source).not.toContain(REMOVED_NAME);
  });
});

describe("klodi_searches_delete removal — generated artifacts", () => {
  // The generated/vendored JSON mirrors regenerate from the catalog via
  // `pnpm --filter @klodi/tool-catalog codegen`. After the drop none may carry
  // the key. (dist/ is gitignored + walked-out; the tracked Python mirrors are
  // the artifacts that matter — see [[cross-language-param-contract-is-schemas-json]].)
  const generatedMirrors = [
    "packages/nats-client-py/src/klodi_nats_client/schemas.json",
    "packages/logger-py/src/klodi_logger/schemas.json",
    "packages/nats-client-py/src/klodi_nats_client/error_codes.json",
  ] as const;

  for (const mirror of generatedMirrors) {
    it(`[unit] generated mirror ${mirror} contains no klodi_searches_delete key`, () => {
      const abs = join(REPO_ROOT, mirror);
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        // If the mirror is absent in this checkout the regen hasn't run; that
        // is a real failure to surface, not a pass to skip.
        throw new Error(
          `generated mirror missing at ${mirror} — run`
            + " `pnpm --filter @klodi/tool-catalog codegen` so the drop"
            + " propagates to the Python consumers.",
        );
      }
      expect(
        text.includes(REMOVED_NAME),
        `${mirror} still declares ${REMOVED_NAME} — regenerate after the`
          + " catalog drop so Python consumers stop advertising the ghost.",
      ).toBe(false);
    });
  }
});

describe("klodi_searches_delete removal — repo-wide grep", () => {
  // Node-native walk (no shell-out) — see catalog-removal.test.ts header.

  it("[unit] no shipped file contains the agent-facing tool name", () => {
    const offenders = findOffenders(REMOVED_NAME, TOOL_NAME_ALLOWLIST);
    expect(
      offenders,
      "every reference to the dropped tool name must be reconciled (descriptions"
        + " should cite klodi_unwatch / the subject, not the removed name).",
    ).toEqual([]);
  });

  it("[unit] no file references the Rust enum variant KlodiSearchesDelete", () => {
    const offenders = findOffenders(REMOVED_RUST_VARIANT, RUST_VARIANT_ALLOWLIST);
    expect(
      offenders,
      "the regenerated rust-types.rs drops the variant; its consumers"
        + " (klodi-rust-host tools.rs, nats-client-rs catalog.rs) must switch"
        + " off it (e.g. to the bare subject literal).",
    ).toEqual([]);
  });
});

describe("klodi_searches_delete removal — subject MUST survive", () => {
  // The subject p2p.v1.searches.delete is load-bearing: it backs every host's
  // klodi_unwatch composite. The drop removes only the catalog name; deleting
  // the subject would silently break the delete capability.
  //
  // RED/GREEN split today:
  //   - hermes/nanobot already use the BARE literal → GREEN today, must STAY
  //     green (regression guard against an over-eager subject deletion).
  //   - openclaw discovery.ts + Rust tools.rs reach the subject via the catalog
  //     key (klodiTools.klodi_searches_delete.subject) / Rust enum variant
  //     (ToolName::KlodiSearchesDelete.subject()) today, so the bare literal is
  //     ABSENT → RED until the expert switches them to the literal. These cases
  //     assert the POST-fix state: the subject survives via the bare literal.

  for (const site of SUBJECT_REQUIRED_SITES) {
    it(`[unit] subject ${SURVIVING_SUBJECT} is still present at ${site}`, () => {
      const abs = join(REPO_ROOT, site);
      const text = readFileSync(abs, "utf8");
      expect(
        text.includes(SURVIVING_SUBJECT),
        `${site} must still reach the surviving subject ${SURVIVING_SUBJECT}`
          + " — the delete capability must remain fully available after the drop.",
      ).toBe(true);
    });
  }
});
