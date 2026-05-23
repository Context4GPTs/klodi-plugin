/**
 * Cross-language envelope parity oracle — structure tests.
 *
 * `fixtures/envelope-golden.json` is the canonical wire-format oracle.
 * Every adapter's test suite (openclaw vitest, hermes/nanobot pytest,
 * klodi-rust-host cargo test) loads this same JSON document and asserts
 * the envelope it produces under matching failure modes deserialises to
 * the same shape.
 *
 * THIS file does NOT test adapters. It tests the fixture itself —
 * validating that every entry honours the R1/R2/R3 contract so a
 * careless edit doesn't silently drift away from the spec.
 *
 * - R1: every envelope carries exactly four canonical keys.
 * - R2: every `error` value is a member of the closed catalog vocabulary
 *   (with `<placeholder>` strings allowed for the marketplace-passthrough
 *   and internal_error rows, which carry server-supplied codes).
 * - R3: every `recovery_hint` is either `null` or carries `kind` in the
 *   closed NextAction discriminated union.
 *
 * Adapters consume the fixture as a READ-ONLY oracle. The `<placeholder>`
 * strings (e.g. `<host>`, `<field-name>`, `<uuid>`) document that the
 * adapter substitutes a concrete value at runtime; the parity test
 * compares the *template* of the envelope, not the substituted text.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(HERE, "fixtures/envelope-golden.json");

interface GoldenEntry {
  readonly _when: string;
  readonly envelope: {
    readonly error: string;
    readonly message: unknown;
    readonly details: Record<string, unknown> | null;
    readonly recovery_hint: Record<string, unknown> | null;
  };
}

type Golden = Record<string, GoldenEntry | string>;

// The R2 closed-vocabulary set the catalog `errorCodes` map will export.
// This list is the source-of-truth for the codes that appear as
// envelope `error` values in the fixture; the catalog test
// (`error-codes.test.ts`) asserts the corresponding `errorCodes` export
// includes every code here.
const R2_CODES = new Set([
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
]);

const R3_NEXT_ACTION_KINDS = new Set(["cli", "tool", "shell", "dialog"]);

const ENVELOPE_KEYS = ["details", "error", "message", "recovery_hint"];

function loadGolden(): Golden {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as Golden;
}

function entriesOnly(g: Golden): Array<[string, GoldenEntry]> {
  // The fixture has a top-level `_doc` string entry that explains usage;
  // skip it and any other underscore-prefixed metadata when iterating.
  return Object.entries(g)
    .filter(([k]) => !k.startsWith("_"))
    .map(([k, v]) => [k, v as GoldenEntry]);
}

describe("envelope-golden.json fixture", () => {
  it("loads as valid JSON", () => {
    const g = loadGolden();
    expect(typeof g).toBe("object");
    expect(g).not.toBeNull();
  });

  it("documents itself via a top-level `_doc` string", () => {
    // Operators reading the JSON need to know what the file is for.
    const g = loadGolden();
    expect(typeof g._doc).toBe("string");
    expect((g._doc as string).length).toBeGreaterThan(50);
  });

  it("contains at least one entry per failure-mode class named in R2", () => {
    // Each row of the R2 acceptance criteria table is a failure mode
    // the parity tests assert. The fixture must contain at least one
    // entry whose envelope.error matches each R2 code (or, for the
    // marketplace passthrough class, a `<placeholder>`-style entry).
    const g = loadGolden();
    const errorsInFixture = new Set(
      entriesOnly(g).map(([, e]) => e.envelope.error),
    );
    const required = [
      "not_registered",
      "klodi_home_missing",
      "connection_not_ready",
      "consumer_missing",
      "invalid_request",
      "marketplace_error",
      "internal_error",
    ];
    for (const code of required) {
      expect(
        errorsInFixture,
        `R2 fixture coverage gap: no entry for code ${code}`,
      ).toContain(code);
    }
  });
});

describe("every fixture envelope satisfies the R1 wire-shape", () => {
  const g = loadGolden();
  const entries = entriesOnly(g);

  for (const [name, entry] of entries) {
    it(`${name} — has exactly the four canonical keys`, () => {
      const env = entry.envelope;
      expect(Object.keys(env).sort()).toEqual(ENVELOPE_KEYS);
    });

    it(`${name} — error is a non-empty string`, () => {
      expect(typeof entry.envelope.error).toBe("string");
      expect(entry.envelope.error.length).toBeGreaterThan(0);
    });

    it(`${name} — message is null OR string (free-form prose)`, () => {
      // Adapters supply the human-readable message; the fixture uses
      // null to signal "free-form, parity tests skip this field". A
      // concrete string is also valid (some fixtures may carry a stable
      // message — defer to dev pair).
      const m = entry.envelope.message;
      expect(m === null || typeof m === "string").toBe(true);
    });

    it(`${name} — details is null OR an object (never a primitive)`, () => {
      const d = entry.envelope.details;
      expect(
        d === null || (typeof d === "object" && !Array.isArray(d)),
      ).toBe(true);
    });

    it(`${name} — recovery_hint is null OR a NextAction-shaped object`, () => {
      const h = entry.envelope.recovery_hint;
      if (h === null) return;
      expect(typeof h).toBe("object");
      expect(typeof h["kind"]).toBe("string");
      // R3 — kind ∈ closed vocabulary.
      expect(R3_NEXT_ACTION_KINDS).toContain(h["kind"] as string);
    });
  }
});

describe("R2 closed-vocabulary compliance", () => {
  const g = loadGolden();
  const entries = entriesOnly(g);

  for (const [name, entry] of entries) {
    it(`${name} — error code is in R2 vocabulary OR is a marketplace-passthrough placeholder`, () => {
      const code = entry.envelope.error;
      // Marketplace-passthrough rows carry the original server code in
      // the `error` field (the architect's R2 says marketplace_error is
      // the *coarse* code; the underlying server code is preserved in
      // details.marketplace_error_code). Some fixture rows model the
      // *raw* passthrough where the adapter never collapses (e.g.
      // listing_not_owned_by_caller). Those rows are documented by
      // their `_when` text containing "passthrough".
      const isPassthroughRow = (entry._when ?? "").includes("passthrough");
      if (isPassthroughRow) return;
      expect(
        R2_CODES,
        `R2 violation: fixture row ${name} uses non-R2 code "${code}"`,
      ).toContain(code);
    });
  }
});

describe("Templating placeholders are explicit", () => {
  const g = loadGolden();
  const entries = entriesOnly(g);

  for (const [name, entry] of entries) {
    it(`${name} — placeholders use <angle-brackets> when present`, () => {
      // Adapters substitute concrete values for `<host>`, `<field-name>`,
      // `<uuid>`, `<class-name>`, `<server-code>`. The fixture is the
      // template; the test runs against the substituted output. We
      // assert that any non-null string value in details / recovery_hint
      // either is a literal expected by R2 (e.g. `"notifications"`,
      // `"channels"`, `"missing"`, `"wrong_type"`, `"empty"`, `"cli"`,
      // `"tool"`, `"shell"`, `"dialog"`, `"klodi_setup_status"`) or is
      // a `<...>` placeholder. This catches accidental concrete strings
      // (e.g. an adapter dev pasting a real UUID into the fixture).
      const ALLOWED_LITERALS = new Set([
        "notifications",
        "channels",
        "missing",
        "wrong_type",
        "empty",
        "cli",
        "tool",
        "shell",
        "dialog",
        "klodi_setup_status",
      ]);
      const checkValue = (v: unknown, path: string): void => {
        if (typeof v !== "string") return;
        if (v.startsWith("<") && v.endsWith(">")) return;
        if (ALLOWED_LITERALS.has(v)) return;
        if (R2_CODES.has(v)) return; // a code re-used as a string value
        if (v.startsWith("klodi-") && v.endsWith("-register")) {
          // The cli command template — explicit per-host placeholder is
          // already captured by `klodi-<host>-register`. Concrete forms
          // would be `klodi-openclaw-register` etc; allowed.
          return;
        }
        throw new Error(
          `concrete string literal in fixture at ${path} → "${v}". `
          + `Use <angle-brackets> placeholder or add to ALLOWED_LITERALS.`,
        );
      };
      const walk = (v: unknown, path: string): void => {
        if (v === null) return;
        if (Array.isArray(v)) {
          v.forEach((item, i) => walk(item, `${path}[${i}]`));
          return;
        }
        if (typeof v === "object") {
          for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
            walk(val, `${path}.${k}`);
          }
          return;
        }
        checkValue(v, path);
      };
      walk(entry.envelope.details, `${name}.details`);
      walk(entry.envelope.recovery_hint, `${name}.recovery_hint`);
    });
  }
});
