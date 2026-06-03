/**
 * Schema-validation contract for `klodi_list_update.category`.
 *
 * Card: make-category-editable-in-plugin-surface-and-docs
 *   - acceptance #1 (integration): a VALID Category member is accepted on
 *     update and forwards with no client-side rejection.
 *   - acceptance #2 (unit): a `category` that is NOT a Category union member
 *     is rejected by schema validation BEFORE any wire send — the same
 *     failure shape as any other bad enum on update.
 *   - acceptance #3 (unit, structural half): category is presented as an
 *     editable optional field alongside the other update params, and the
 *     description no longer tells agents to "withdraw and relist".
 *
 * Why this also drives the description-text criterion (#3): the tool
 * `description` is part of the catalog entry and is read by agents to decide
 * the corrective flow. Asserting the stale "Cannot change category" /
 * "withdraw and relist" clause is GONE here is faithful (it tests the catalog
 * object, the single source of truth) — it is NOT a brittle prose-grep over a
 * markdown doc. The doc/skill prose criteria (#8/#9/#10) are left to the
 * expert + reviewer's `rg` sweep, per the card's Risks section.
 *
 * ── The load-bearing RED fact (verified against the live catalog) ──
 *
 * `klodi_list_update.params` is a `Type.Object` with `additionalProperties`
 * UNDEFINED → TypeBox defaults to OPEN. So BEFORE the param is added, an
 * unknown `category` key sails through `Value.Check` regardless of its value:
 * both `category: "furniture"` and `category: "not_a_real_category"` validate
 * as `true` today, because `category` is an unrecognised extra field, not a
 * validated param. The bad-enum rejection below therefore fails RED now
 * (Value.Check returns true; the spec demands false) and only passes once
 * `category: Type.Optional(Category)` makes it a real, enum-constrained param.
 *
 * The reference oracle is `condition`, already an optional enum on update:
 * `condition: "new_item"` validates, `condition: "bogus"` is rejected. After
 * this card `category` must behave identically — "same failure shape as any
 * other bad enum on update".
 *
 * Per the `adversarial-testing` skill: NEVER weaken these asserts. If the bad
 * enum is accepted, the param is missing or the object was made open — fix the
 * catalog, not this test.
 */

import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";

import { klodiTools } from "../src/index.js";

const UPDATE = klodiTools.klodi_list_update;
const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";

/** Every closed `Category` union member (schemas.ts:36-51). */
const VALID_CATEGORIES = [
  "electronics",
  "furniture",
  "vehicles",
  "clothing",
  "home_garden",
  "sports",
  "collectibles",
  "digital_goods",
  "services",
  "free",
  "other",
] as const;

const NOT_A_CATEGORY = [
  "not_a_real_category",
  "home", // the legacy/free-text value some call sites used — NOT in the union
  "ELECTRONICS", // wrong case
  "",
  "vehicle", // singular typo of `vehicles`
] as const;

interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  anyOf?: Array<{ const?: string }>;
}

function asSchema(schema: unknown): JsonSchema {
  const round = JSON.parse(JSON.stringify(schema)) as unknown;
  if (typeof round !== "object" || round === null) {
    throw new Error("schema did not round-trip to an object");
  }
  return round as JsonSchema;
}

describe("klodi_list_update.category — schema shape (acceptance #3 structural)", () => {
  it("category is a declared param on klodi_list_update (optional, alongside the other update fields)", () => {
    const params = asSchema(UPDATE.params);
    const props = new Set(Object.keys(params.properties ?? {}));
    expect(
      props,
      "klodi_list_update.params is missing the `category` param —"
      + " it must be added as Type.Optional(Category)",
    ).toContain("category");
    // Optional: present in properties but NOT in required[].
    expect(new Set(params.required ?? []).has("category")).toBe(false);
  });

  it("category is typed as the closed Category union (anyOf of the 11 members)", () => {
    const params = asSchema(UPDATE.params);
    const category = asSchema((params.properties ?? {})["category"]);
    const members = new Set(
      (category.anyOf ?? [])
        .map((m) => m.const)
        .filter((c): c is string => typeof c === "string"),
    );
    expect(members).toEqual(new Set(VALID_CATEGORIES));
  });

  it("description no longer instructs withdraw-and-relist for a category change (#3)", () => {
    const desc = UPDATE.description.toLowerCase();
    expect(
      desc,
      "the stale `Cannot change category` clause must be removed from the"
      + " klodi_list_update description",
    ).not.toContain("cannot change");
    expect(
      desc,
      "the stale `withdraw and relist` instruction must be removed from the"
      + " klodi_list_update description",
    ).not.toContain("withdraw");
  });
});

describe("klodi_list_update.category — runtime validation (acceptance #1 + #2)", () => {
  /**
   * Guard the "accepts valid category" tests from a vacuous RED-phase pass.
   * `klodi_list_update.params` is an OPEN Type.Object today, so a valid
   * category would `Value.Check` as `true` even though it is an unrecognised
   * extra field, not a validated enum. Requiring category to be a declared
   * param first means the accept-tests only pass once the param is real —
   * and the bad-enum rejection tests below confirm the enum is enforced.
   */
  function requireCategoryParam(): void {
    const params = asSchema(UPDATE.params);
    expect(
      Object.keys(params.properties ?? {}),
      "category must be a declared param before accept-validation is meaningful"
      + " (RED: open Type.Object makes any unknown category pass)",
    ).toContain("category");
  }

  it("accepts every valid Category member on update (acceptance #1)", () => {
    requireCategoryParam();
    for (const category of VALID_CATEGORIES) {
      const ok = Value.Check(UPDATE.params, {
        listing_id: VALID_ID,
        category,
      });
      expect(
        ok,
        `klodi_list_update should accept the valid category "${category}"`,
      ).toBe(true);
    }
  });

  it("rejects a category that is not a Category union member, before any wire send (acceptance #2)", () => {
    for (const bad of NOT_A_CATEGORY) {
      const ok = Value.Check(UPDATE.params, {
        listing_id: VALID_ID,
        category: bad,
      });
      expect(
        ok,
        `klodi_list_update must REJECT category="${bad}" at schema validation`
        + ` — it is not a member of the closed Category union. (RED until the`
        + ` param is added: today the open Type.Object lets it pass as an`
        + ` unknown field.)`,
      ).toBe(false);
    }
  });

  it("rejects a bad category the SAME way it rejects any other bad enum on update (parity with condition)", () => {
    // The reference oracle: `condition` is an existing optional enum.
    // A bogus condition is rejected; a bogus category must be too — same
    // failure shape, no special-casing.
    const badCondition = Value.Check(UPDATE.params, {
      listing_id: VALID_ID,
      condition: "bogus_condition",
    });
    const badCategory = Value.Check(UPDATE.params, {
      listing_id: VALID_ID,
      category: "bogus_category",
    });
    expect(badCondition, "sanity: a bogus condition is rejected today").toBe(
      false,
    );
    expect(
      badCategory,
      "a bogus category must be rejected exactly like a bogus condition",
    ).toBe(badCondition);
  });

  it("a valid category does not require any other optional field (only listing_id is mandatory)", () => {
    requireCategoryParam();
    const ok = Value.Check(UPDATE.params, {
      listing_id: VALID_ID,
      category: "furniture",
    });
    expect(ok).toBe(true);
    // And category alone cannot satisfy the schema without the id.
    const missingId = Value.Check(UPDATE.params, { category: "furniture" });
    expect(missingId, "listing_id is still required on update").toBe(false);
  });
});
