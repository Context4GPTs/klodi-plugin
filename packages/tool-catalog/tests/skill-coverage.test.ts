/**
 * Skill-coverage gate: the bundled skill at
 * `skill/references/error_envelopes.md` MUST name every error code the
 * catalog exports. This is the architect's [unit] acceptance criterion
 * for "Skill documents the envelope" and the product-owner's R8
 * companion: the agent reads the skill, learns the codes, and never
 * encounters an envelope code it hasn't been documented on.
 *
 * Two failure modes the test catches:
 *   1. A new code is added to `errorCodes` but the skill doc isn't
 *      updated — the agent receives an undocumented code, no recovery
 *      action.
 *   2. The skill doc names a code that's been removed from the catalog
 *      — the agent is taught about a code that never reaches it.
 *      (Soft-fail with a warning; the harder gate is (1) above.)
 *
 * The test fails until BOTH the catalog source (`src/error-codes.ts`)
 * and the skill doc (`skill/references/error_envelopes.md`) exist with
 * matching content. Implementation lands both together as part of
 * Distillation; this test is the gate.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { errorCodes } from "../src/error-codes.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const SKILL_DOC = resolve(REPO_ROOT, "skill", "references", "error_envelopes.md");

describe("skill/references/error_envelopes.md", () => {
  it("exists at the canonical path", () => {
    // The skill bundle ships with `error_envelopes.md` next to the
    // existing `tool_inventory.md`. The bundled skill is copied into
    // each adapter's `skill/` at build time (see
    // `adapters/openclaw/copy-skill.mjs`); this is the source.
    expect(
      existsSync(SKILL_DOC),
      `skill doc missing — expected at ${SKILL_DOC}`,
    ).toBe(true);
  });

  it("names every code in the catalog `errorCodes` map", () => {
    // The architect's [unit] acceptance criterion: a grep test that
    // every code in `errorCodes` is mentioned in the skill doc.
    // Implementation: read the doc once, then assert each code's
    // literal string appears.
    if (!existsSync(SKILL_DOC)) {
      throw new Error(
        `prerequisite missing: ${SKILL_DOC} — the doc must exist before this assertion`,
      );
    }
    const doc = readFileSync(SKILL_DOC, "utf-8");
    for (const code of Object.keys(errorCodes)) {
      expect(
        doc,
        `skill coverage gap: error code "${code}" is not named in ${SKILL_DOC}`,
      ).toContain(code);
    }
  });

  it("explains every NextAction `recovery_hint.kind` variant", () => {
    // R3: the recovery_hint vocabulary is closed (cli|tool|shell|dialog).
    // The skill must teach the agent each variant — not as a single
    // sentence "see NextAction" but with at least the variant name
    // appearing literally so the agent's pattern-match path is reachable.
    if (!existsSync(SKILL_DOC)) {
      throw new Error(
        `prerequisite missing: ${SKILL_DOC}`,
      );
    }
    const doc = readFileSync(SKILL_DOC, "utf-8");
    // Only assert the variants R8 says the catalog uses today. (Shell /
    // dialog are reserved for future ADR amendments; the doc may
    // explain them or not — that's a separate matter.)
    for (const kind of ["cli", "tool"]) {
      expect(
        doc,
        `skill must teach the agent the NextAction kind="${kind}" variant`,
      ).toContain(kind);
    }
  });

  it("references the canonical envelope shape", () => {
    // The agent's first contact with the envelope is reading the skill.
    // The doc must show the four canonical key names so the agent
    // knows what to parse.
    if (!existsSync(SKILL_DOC)) {
      throw new Error(`prerequisite missing: ${SKILL_DOC}`);
    }
    const doc = readFileSync(SKILL_DOC, "utf-8");
    for (const key of ["error", "message", "details", "recovery_hint"]) {
      expect(
        doc,
        `skill must name the canonical envelope key "${key}"`,
      ).toContain(key);
    }
  });

  it("does not advertise codes the catalog no longer exports", () => {
    // Soft inverse: if the skill names a code that's not in `errorCodes`,
    // either the doc is stale or the catalog dropped a code without
    // updating the skill. The R2 stability gate already prevents
    // catalog deletions; this test catches doc/code drift.
    //
    // We only check codes that look catalog-shaped (snake_case all-lower
    // identifiers); the doc has plenty of prose so we can't reject
    // every unknown token.
    if (!existsSync(SKILL_DOC)) {
      throw new Error(`prerequisite missing: ${SKILL_DOC}`);
    }
    const doc = readFileSync(SKILL_DOC, "utf-8");
    const catalogCodes = new Set(Object.keys(errorCodes));
    // Find every snake_case identifier in the doc; intersect with codes
    // that LOOK catalog-shaped (end with _error, _missing, _failed, or
    // are well-known catalog codes).
    const candidatePattern = /\b([a-z][a-z_]{2,})\b/g;
    let m: RegExpExecArray | null;
    const orphans: string[] = [];
    const wellKnownNonCodes = new Set([
      "for", "the", "and", "with", "see", "use", "call", "run",
      "this", "that", "what", "when", "then", "when_to", "next_action",
      "nextaction", "next_step", "envelope", "envelopes", "shape",
      "shapes", "error_envelopes", "true", "false", "null", "host_specific",
      "klodi_setup_status", "klodi_register", "klodi_health",
      "kind", "command", "tool", "message", "details", "recovery_hint",
      "error", "code", "codes",
    ]);
    while ((m = candidatePattern.exec(doc)) !== null) {
      const token = m[1]!;
      if (wellKnownNonCodes.has(token)) continue;
      if (catalogCodes.has(token)) continue;
      // Heuristic: tokens that LOOK like an error code (snake_case
      // with a stem matching common code suffixes) but aren't in the
      // catalog get flagged. False positives are tolerable — the test
      // soft-warns by counting; flat-out failure happens only when a
      // genuine orphan slips through.
      if (
        token.endsWith("_error") ||
        token.endsWith("_missing") ||
        token.endsWith("_failed") ||
        token.endsWith("_request") ||
        token === "not_registered" ||
        token === "unauthorized" ||
        token === "conflict" ||
        token === "rate_limited" ||
        token === "validation_failed"
      ) {
        orphans.push(token);
      }
    }
    // Deduplicate.
    const uniqueOrphans = Array.from(new Set(orphans));
    // The soft assertion: every orphan candidate is actually in the
    // catalog. If a token looks like a code but isn't exported, the
    // skill mentions a code that doesn't exist.
    for (const orph of uniqueOrphans) {
      expect(
        catalogCodes,
        `skill mentions code-shaped token "${orph}" not exported by errorCodes`,
      ).toContain(orph);
    }
  });
});
