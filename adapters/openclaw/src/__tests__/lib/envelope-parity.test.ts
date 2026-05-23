/**
 * Cross-language envelope parity — openclaw consumer (RED).
 *
 * Loads `packages/tool-catalog/tests/fixtures/envelope-golden.json` and
 * asserts the openclaw envelope helpers produce the same shape the
 * fixture pins (after substituting per-host placeholders).
 *
 * Coverage scope: every failure mode in the golden fixture that the
 * openclaw adapter reaches (creds-not-found → `not_registered`,
 * marketplace passthrough, internal_error). The fixture is the SINGLE
 * oracle; this test verifies the TS implementation conforms.
 *
 * R8 — every assertion that pins `error` is exact-string match; every
 * assertion that pins `recovery_hint` is exact-structure match modulo
 * placeholder substitution.
 *
 * This file is QA-owned during RED. NEVER weaken these asserts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { envelopeFromError, makeEnvelope } from "../../lib/envelope.js";
import { guardCreds } from "../../lib/guards.js";
import { getConfigPath, getCredsPath } from "../../lib/paths.js";
import { createTempHome, type TempHome } from "../helpers/temp-home.js";
import { KlodiRequestError } from "../helpers/mock-nats.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(
  HERE,
  "../../../../../packages/tool-catalog/tests/fixtures/envelope-golden.json",
);

interface GoldenEntry {
  readonly _when: string;
  readonly envelope: {
    readonly error: string;
    readonly message: unknown;
    readonly details: Record<string, unknown> | null;
    readonly recovery_hint: Record<string, unknown> | null;
  };
}

function loadFixture(): Record<string, GoldenEntry> {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const all = JSON.parse(raw) as Record<string, unknown>;
  const entries: Record<string, GoldenEntry> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("_")) continue;
    entries[k] = v as GoldenEntry;
  }
  return entries;
}

function envelopeFor(key: string): GoldenEntry["envelope"] {
  const fixtures = loadFixture();
  const entry = fixtures[key];
  if (!entry) throw new Error(`fixture entry not found: ${key}`);
  return entry.envelope;
}

function substitute(s: string, subs: Record<string, string>): string {
  let out = s;
  for (const [placeholder, real] of Object.entries(subs)) {
    out = out.split(placeholder).join(real);
  }
  return out;
}

function assertEnvelopeKeys(env: unknown): void {
  expect(env).not.toBeNull();
  expect(typeof env).toBe("object");
  const keys = Object.keys(env as Record<string, unknown>).sort();
  expect(keys).toEqual(["details", "error", "message", "recovery_hint"]);
}

function assertRecoveryHintMatches(
  actual: Record<string, unknown> | null,
  expected: Record<string, unknown> | null,
  subs: Record<string, string> = {},
): void {
  if (expected === null) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  const a = actual!;
  expect(a["kind"]).toBe(expected["kind"]);
  for (const [k, expV] of Object.entries(expected)) {
    if (k === "kind") continue;
    if (expV === null) continue; // free-form field
    const actualV = a[k];
    const expectedV =
      typeof expV === "string" ? substitute(expV, subs) : expV;
    expect(actualV).toEqual(expectedV);
  }
}

let home: TempHome;

beforeEach(() => {
  home = createTempHome();
});

afterEach(() => {
  home.cleanup();
});

// ── not_registered (creds missing) ────────────────────────────────────

describe("openclaw envelope-parity — not_registered", () => {
  it("emits the fixture-shaped envelope when creds are missing", () => {
    const expected = envelopeFor("not_registered");
    const actual = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(actual).not.toBeNull();
    assertEnvelopeKeys(actual);
    expect(actual!.error).toBe(expected.error);
    assertRecoveryHintMatches(
      actual!.recovery_hint as Record<string, unknown> | null,
      expected.recovery_hint,
      { "<host>": "openclaw" },
    );
  });

  it("emits the same envelope when only config.json is missing", () => {
    writeFileSync(getCredsPath(), "fake-creds");
    const expected = envelopeFor("not_registered");
    const actual = guardCreds({ registerCli: "klodi-openclaw-register" });
    expect(actual).not.toBeNull();
    expect(actual!.error).toBe(expected.error);
  });
});

// ── marketplace passthrough ──────────────────────────────────────────

describe("openclaw envelope-parity — marketplace passthrough", () => {
  it("preserves the server code; recovery_hint stays null", () => {
    const expected = envelopeFor("marketplace_passthrough_listing_not_owned");
    const err = new KlodiRequestError({
      error: "listing_not_owned_by_caller",
      message: "Listing belongs to another user",
      details: { listing_id: "550e8400-e29b-41d4-a716-446655440000" },
    });
    const actual = envelopeFromError(err);
    assertEnvelopeKeys(actual);
    expect(actual.error).toBe(expected.error);
    expect(actual.recovery_hint).toBeNull();
  });
});

// ── internal_error ───────────────────────────────────────────────────

describe("openclaw envelope-parity — internal_error", () => {
  it("emits the fixture-shaped envelope for an uncategorised throw", () => {
    const expected = envelopeFor("internal_error_generic");
    const actual = envelopeFromError(new Error("totally unexpected"));
    assertEnvelopeKeys(actual);
    expect(actual.error).toBe(expected.error);
    expect(actual.recovery_hint).toBeNull();
    // details.exception_class is the only field the fixture pins.
    expect(actual.details).not.toBeNull();
    expect(
      (actual.details as Record<string, unknown>)["exception_class"],
    ).toBeDefined();
  });
});

// ── invalid_request (covered by guardArgs but parity-pinned here) ────

describe("openclaw envelope-parity — invalid_request", () => {
  it("missing field — envelope matches fixture template", () => {
    const expected = envelopeFor("invalid_request_missing_field");
    // Use the makeEnvelope helper directly to verify shape parity. The
    // guards-level test in `guards.test.ts` covers the production
    // emission path; this one just confirms the fixture row matches
    // what the adapter would produce.
    const actual = makeEnvelope({
      error: "invalid_request",
      message: "transaction_id is required",
      details: { field: "transaction_id", problem: "missing" },
    });
    assertEnvelopeKeys(actual);
    expect(actual.error).toBe(expected.error);
    // details.field substitution: fixture has `<field-name>`, real is
    // `transaction_id` — assert structure (field + problem keys are
    // present and `problem` is the canonical literal).
    const details = actual.details as Record<string, unknown>;
    expect(typeof details["field"]).toBe("string");
    expect(details["problem"]).toBe("missing");
    expect(actual.recovery_hint).toBeNull();
  });
});

// ── Fixture coverage (meta-test) ─────────────────────────────────────

describe("openclaw envelope-parity — fixture coverage", () => {
  it("the openclaw adapter has a parity assertion for every failure mode it can hit", () => {
    // Sanity meta-check: the openclaw adapter reaches creds-not-found,
    // marketplace passthrough, internal_error, and invalid_request.
    // (klodi_home_missing only matters for tools with on-disk side
    // effects, but the fixture row exists so we ensure the catalog
    // documents it.)
    const fixtures = loadFixture();
    const opencrawReachable = [
      "not_registered",
      "marketplace_passthrough_listing_not_owned",
      "internal_error_generic",
      "invalid_request_missing_field",
    ];
    for (const k of opencrawReachable) {
      expect(
        fixtures,
        `openclaw parity gap: fixture missing entry for ${k}`,
      ).toHaveProperty(k);
    }
  });
});
