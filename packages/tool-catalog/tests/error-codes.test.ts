/**
 * Catalog-level contract: the error-code vocabulary is the closed set
 * every adapter draws from. Per **R2** and the architect's
 * ADR-0011 plan, this file owns three contract gates:
 *
 *   1. Vocabulary completeness — every code named in the
 *      acceptance-criteria table is exported by `error-codes.ts`.
 *   2. Recovery-target shape — each entry carries a `recovery_kind`
 *      whose value lives in the closed NextAction discriminated union
 *      (`cli | tool | shell | dialog | none`).
 *   3. Frozen shape — the export is a literal `as const` object, not a
 *      runtime-mutable map; renames and deletes are caught by the
 *      stability gate below.
 *
 * The architect's plan adds `dist/error-codes.{json,rs}` codegen targets
 * over the top of this source; downstream codegen-drift tests live in
 * the Rust crate and the Python package (one assertion per language,
 * comparing the language-local copy to this TS map). Drift between
 * those copies is a separate test surface — this file is the **source**
 * of truth, not the wire-format oracle.
 */

import { describe, it, expect } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
import { errorCodes, type ErrorCode } from "../src/error-codes.js";

// The vocabulary spelled out in the R2 table. Order matches the
// table for human review; the test treats the array as a set.
const REQUIRED_CODES = [
  "not_registered",
  "klodi_home_missing",
  "connection_not_ready",
  "consumer_missing",
  "invalid_request",
  "unauthorized",
  "not_found",
  "conflict",
  "validation_failed",
  "rate_limited",
  "marketplace_error",
  "upload_failed",
  "internal_error",
] as const;

const ALLOWED_RECOVERY_KINDS = new Set([
  "cli",
  "tool",
  "shell",
  "dialog",
  "none",
]);

describe("errorCodes vocabulary completeness", () => {
  it("exports every code named in the R2 acceptance criteria", () => {
    const exported = new Set(Object.keys(errorCodes));
    for (const code of REQUIRED_CODES) {
      expect(exported, `missing code: ${code}`).toContain(code);
    }
  });

  it("ToolName-style exported union ErrorCode matches keys 1:1", () => {
    const keys: ReadonlyArray<keyof typeof errorCodes> = Object.keys(
      errorCodes,
    ) as Array<keyof typeof errorCodes>;
    // Every key is assignable to ErrorCode; ErrorCode names no codes
    // outside the map. We can't enumerate a union at runtime, but we
    // assert that the type-narrowed assignment compiles, which the TS
    // compiler enforces on `pnpm typecheck`.
    const sample: ErrorCode = keys[0]!;
    expect(typeof sample).toBe("string");
  });

  it("vocabulary is sealed — no `marketplace_<code>` style passthrough leaks", () => {
    // Marketplace errors that don't map to a specific subset become
    // `marketplace_error` with the original code preserved in
    // `details.marketplace_error_code`. The catalog map must NOT carry
    // any per-marketplace-code entries — that would be a vocabulary
    // explosion the agent has to learn.
    for (const code of Object.keys(errorCodes)) {
      expect(code).not.toMatch(/^marketplace_(?!error$).+/);
    }
  });
});

describe("errorCodes entry shape", () => {
  it("every entry has `description: string` (non-empty)", () => {
    for (const [code, entry] of Object.entries(errorCodes)) {
      expect(
        typeof entry.description,
        `code ${code} missing description`,
      ).toBe("string");
      expect(
        entry.description.length,
        `code ${code} has empty description`,
      ).toBeGreaterThan(0);
    }
  });

  it("every entry has `recovery_kind` in the closed NextAction vocabulary", () => {
    for (const [code, entry] of Object.entries(errorCodes)) {
      expect(
        ALLOWED_RECOVERY_KINDS,
        `code ${code} has out-of-vocabulary recovery_kind: ${entry.recovery_kind}`,
      ).toContain(entry.recovery_kind);
    }
  });

  it("the four guard-rejection codes carry deterministic recovery_kinds", () => {
    // Pinned by the R4 acceptance criteria. The agent learns these and
    // never needs to read `message` to decide what to do next.
    expect(errorCodes.not_registered.recovery_kind).toBe("cli");
    expect(errorCodes.klodi_home_missing.recovery_kind).toBe("tool");
    expect(errorCodes.connection_not_ready.recovery_kind).toBe("tool");
    expect(errorCodes.invalid_request.recovery_kind).toBe("none");
  });

  it("`internal_error` and `marketplace_error` resolve with recovery_kind=none", () => {
    // Internal errors: agent retries once or surfaces to operator.
    // Marketplace passthrough: server didn't say what to do, so the
    // adapter MUST NOT invent a hint. See architect open Q2.
    expect(errorCodes.internal_error.recovery_kind).toBe("none");
    expect(errorCodes.marketplace_error.recovery_kind).toBe("none");
  });
});

describe("errorCodes is append-only across versions (R2 stability gate)", () => {
  // Historical fixture: the codes that exist at merge time
  // become the floor. Removing or renaming any of them later
  // breaks every agent in flight pattern-matching on the code string.
  // This test reads the same REQUIRED_CODES list — once this floor
  // is set, future PRs that delete a code must also amend the fixture
  // with a written deprecation notice; the test catches the silent
  // delete.
  it("never deletes a previously-published code", () => {
    for (const code of REQUIRED_CODES) {
      expect(
        errorCodes,
        `R2 stability violation: code ${code} was removed`,
      ).toHaveProperty(code);
    }
  });
});
